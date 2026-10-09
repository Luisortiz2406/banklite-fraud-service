import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FraudOutbox } from './fraud-outbox.entity';
import { EventPublisherService } from './event-publisher.service';

const RELAY_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;

/**
 * Publica en RabbitMQ los eventos guardados en fraud_outbox (`fraud.alert`).
 * Se ejecuta justo después de cada operación y, además, cada pocos segundos
 * para recuperar lo que quedó pendiente (RabbitMQ caído, reinicio del
 * servicio, etc.). Entrega at-least-once: notification-service y
 * compliance-service deduplican por occurredAt.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FraudOutbox');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisherService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), RELAY_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Se llama dentro de la transacción que crea el flagged_transactions. */
  async enqueue(manager: EntityManager, routingKey: string, payloads: Record<string, unknown>[]) {
    if (!payloads.length) return;
    const occurredAt = new Date();
    await manager.save(
      FraudOutbox,
      payloads.map((payload) => manager.create(FraudOutbox, { routingKey, payload, occurredAt })),
    );
  }

  async flush() {
    if (this.running || !this.publisher.isReady()) return;
    this.running = true;
    try {
      let more = true;
      while (more) {
        more = await this.dataSource.transaction(async (manager) => {
          // SKIP LOCKED: si hay varias réplicas, cada fila la publica solo una.
          const rows = await manager
            .createQueryBuilder(FraudOutbox, 'outbox')
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .where('outbox.published_at IS NULL')
            .orderBy('outbox.created_at', 'ASC')
            .limit(BATCH_SIZE)
            .getMany();

          for (const row of rows) {
            try {
              await this.publisher.publish(row.routingKey, {
                event: row.routingKey,
                occurredAt: row.occurredAt.toISOString(),
                data: row.payload,
              });
              row.publishedAt = new Date();
              await manager.save(row);
            } catch (error) {
              row.attempts += 1;
              row.lastError = (error as Error).message.slice(0, 500);
              await manager.save(row);
              this.logger.warn(`No se pudo publicar el evento ${row.id}; se reintentará: ${row.lastError}`);
              return false;
            }
          }
          return rows.length === BATCH_SIZE;
        });
      }
    } catch (error) {
      this.logger.error(`Error procesando el outbox: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
