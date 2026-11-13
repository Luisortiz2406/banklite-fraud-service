import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { EventPublisherService } from './event-publisher.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Publicador de eventos (RabbitMQ simulado): sin RabbitMQ el servicio sigue arriba y
 * los eventos esperan en el outbox; publicar espera la confirmación del broker, y si no
 * llega lanza un error para que el outbox reintente.
 */
function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = {
    connection: {},
    channel: {},
  };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}

describe('EventPublisherService', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventPublisherService(new ConfigService(env));

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
  });
  afterEach(() => jest.useRealTimers());

  it('sin RABBITMQ_URL no conecta y no está listo (los eventos quedan en el outbox)', async () => {
    const publisher = build({});

    await publisher.onModuleInit();

    expect(connect).not.toHaveBeenCalled();
    expect(publisher.isReady()).toBe(false);
  });

  it('al conectar declara el exchange durable y queda listo', async () => {
    const publisher = build();

    await publisher.onModuleInit();

    expect(publisher.isReady()).toBe(true);
    expect(broker.channel.assertExchange).toHaveBeenCalledWith('banklite.events', 'topic', { durable: true });
  });

  it('publica persistente y espera la confirmación del broker', async () => {
    const publisher = build({ RABBITMQ_URL: 'amqp://rabbit', RABBITMQ_EXCHANGE: 'otro.exchange' });
    await publisher.onModuleInit();

    await publisher.publish('transaction.completed', { event: 'transaction.completed', data: { a: 1 } });

    const [exchange, routingKey, content, options] = broker.channel.publish.mock.calls[0];
    expect(exchange).toBe('otro.exchange');
    expect(routingKey).toBe('transaction.completed');
    expect(JSON.parse(content.toString())).toEqual({ event: 'transaction.completed', data: { a: 1 } });
    expect(options).toMatchObject({ persistent: true, contentType: 'application/json' });
    expect(broker.channel.waitForConfirms).toHaveBeenCalled();
  });

  it('sin conexión, publicar lanza para que el outbox lo reintente; si el broker no confirma, también', async () => {
    const publisher = build();
    await expect(publisher.publish('x', {})).rejects.toThrow('RabbitMQ no está conectado');

    await publisher.onModuleInit();
    broker.channel.waitForConfirms.mockRejectedValueOnce(new Error('sin confirmación'));
    await expect(publisher.publish('x', {})).rejects.toThrow('sin confirmación');
  });

  it('si RabbitMQ no está disponible reintenta a los 5 s sin tumbar el servicio', async () => {
    jest.useFakeTimers();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const publisher = build();

    await publisher.onModuleInit();
    expect(publisher.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(publisher.isReady()).toBe(true);
  });

  it('si el canal no se puede abrir, cierra la conexión para no dejarla colgada y reintenta', async () => {
    jest.useFakeTimers();
    broker.connection.createConfirmChannel.mockRejectedValueOnce(new Error('canal'));
    const publisher = build();

    await publisher.onModuleInit();

    expect(broker.connection.close).toHaveBeenCalled();
    expect(publisher.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(publisher.isReady()).toBe(true);
  });

  it('si la conexión se cae después de arrancar, deja de estar listo y vuelve a conectar', async () => {
    jest.useFakeTimers();
    const publisher = build();
    await publisher.onModuleInit();

    broker.handlers.connection.close();
    expect(publisher.isReady()).toBe(false);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(publisher.isReady()).toBe(true);
  });

  it('los errores de la conexión y del canal solo se registran; si el canal se cierra, cierra la conexión', async () => {
    await build().onModuleInit();

    expect(() => broker.handlers.connection.error(new Error('conexión'))).not.toThrow();
    expect(() => broker.handlers.channel.error(new Error('canal'))).not.toThrow();
    broker.handlers.channel.close();
    expect(broker.connection.close).toHaveBeenCalled();
  });

  it('cerrar el módulo cierra el canal y la conexión y cancela el reintento pendiente', async () => {
    jest.useFakeTimers();
    const publisher = build();
    await publisher.onModuleInit();
    await publisher.onModuleDestroy();
    expect(broker.channel.close).toHaveBeenCalled();
    expect(broker.connection.close).toHaveBeenCalled();

    connect.mockRejectedValueOnce(new Error('caído'));
    const second = build();
    await second.onModuleInit();
    await second.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
