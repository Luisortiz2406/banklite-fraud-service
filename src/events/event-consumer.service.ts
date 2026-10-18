import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { RiskScoringService } from '../risk/risk-scoring.service';
import {
  assertRetryQueues,
  handleFailure,
  peekDeadLetters,
  queueStats,
  requeueDeadLetters,
  PoisonMessageError,
} from './retry-policy';

const RECONNECT_DELAY_MS = 5000;

/**
 * Se suscribe a 'transaction.completed', publicado por Ledger Service por
 * cada titular afectado (sección 3.6/3.7 del documento: Fraud Service "se
 * suscribe a transfer.completed y card.transaction.authorized"; en el
 * sistema real ambos quedaron unificados en un solo evento del Ledger, ver
 * ledger.service.ts `eventPayload()`).
 *
 * Si RabbitMQ no está disponible al iniciar, o se cae después, reintenta en
 * segundo plano sin bloquear el arranque del servicio ni sus endpoints REST.
 * Si un evento falla al procesarse, se reintenta varias veces con espera y,
 * si sigue fallando, queda en la DLQ (<cola>.dlq) en lugar de perderse.
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[fraud-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private queue: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly risk: RiskScoringService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.logger.warn('Conexión con RabbitMQ cerrada.');
        this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      this.connection = connection;
      this.channel = channel;

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>('RABBITMQ_QUEUE', 'fraud-service.transaction-completed');

      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, exchange, 'transaction.completed');
      await assertRetryQueues(channel, queue);
      this.queue = queue;

      await channel.consume(queue, (msg) => this.handleMessage(channel, queue, msg), { noAck: false });

      this.logger.log(`Escuchando 'transaction.completed' en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // Se usa el canal por el que llegó el mensaje: el ack debe ir por ese mismo canal.
  private async handleMessage(channel: amqplib.Channel, queue: string, msg: amqplib.ConsumeMessage | null) {
    if (!msg) return;
    try {
      let content: any;
      try {
        content = JSON.parse(msg.content.toString());
      } catch {
        throw new PoisonMessageError('El mensaje no es JSON válido.');
      }
      const data = content?.data;
      if (!data?.idUser || !data?.transactionId) {
        this.logger.warn('Evento transaction.completed sin idUser o transactionId, descartado.');
        channel.ack(msg);
        return;
      }

      await this.risk.handleTransactionCompleted(data);
      // Ledger publica un evento por titular afectado: la misma transactionId puede
      // llegar dos veces (emisor y receptor), cada una con una cuenta y una dirección
      // distintas, así que no es una reentrega.
      this.logger.log(
        `transaction.completed procesado (transactionId=${data.transactionId}, direction=${data.direction})`,
      );
      channel.ack(msg);
    } catch (err) {
      handleFailure(channel, queue, msg, err as Error, this.logger);
    }
  }

  /** Panel administrativo: estado de la cola, sus reintentos y su DLQ. */
  async deadLetterStats() {
    if (!this.channel || !this.queue) return { connected: false };
    return { connected: true, ...(await queueStats(this.channel, this.queue)) };
  }

  async peekDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return peekDeadLetters(this.channel, this.queue, max);
  }

  async requeueDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return requeueDeadLetters(this.channel, this.queue, max);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
