import { DataSource, IsNull } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { FraudOutbox } from './fraud-outbox.entity';
import { EventPublisherService } from './event-publisher.service';
import { OutboxService } from './outbox.service';

/**
 * Outbox: el evento se guarda con la operación y luego se publica en RabbitMQ. Lo que
 * importa: nunca se pierde un evento, uno que falla se reintenta y no bloquea a los
 * demás, y lo ya publicado no sale dos veces.
 */
describeWithDb('OutboxService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let outbox: OutboxService;
  const publisher = { isReady: jest.fn(), publish: jest.fn() };
  const repo = () => dataSource.getRepository(FraudOutbox);

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('fraud_outbox', [FraudOutbox]));
    outbox = new OutboxService(dataSource, publisher as unknown as EventPublisherService);
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    publisher.isReady.mockReset().mockReturnValue(true);
    publisher.publish.mockReset().mockResolvedValue(undefined);
  });

  const enqueue = (count: number) =>
    dataSource.transaction((manager) =>
      outbox.enqueue(
        manager,
        'fraud.alert',
        Array.from({ length: count }, (_, i) => ({ idUser: 'u1', n: i })),
      ),
    );

  it('guardar una lista vacía no escribe nada', async () => {
    await enqueue(0);
    expect(await repo().count()).toBe(0);
  });

  it('publica lo pendiente con su clave de ruteo y marca la hora de publicación', async () => {
    await enqueue(2);
    await outbox.flush();

    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish).toHaveBeenCalledWith(
      'fraud.alert',
      expect.objectContaining({ event: 'fraud.alert', data: expect.objectContaining({ idUser: 'u1' }) }),
    );
    expect((await repo().find()).every((row) => row.publishedAt instanceof Date)).toBe(true);
  });

  it('lo ya publicado no se vuelve a publicar', async () => {
    await enqueue(1);
    await outbox.flush();
    await outbox.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('sin conexión a RabbitMQ no publica y deja todo pendiente', async () => {
    publisher.isReady.mockReturnValue(false);
    await enqueue(3);
    await outbox.flush();

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(await repo().count({ where: { publishedAt: IsNull() } })).toBe(3);
  });

  it('si un evento falla, queda pendiente con el error y el intento, y se reintenta después', async () => {
    await enqueue(1);
    publisher.publish.mockRejectedValueOnce(new Error('x'.repeat(600)));
    await outbox.flush();

    const [fallido] = await repo().find();
    expect(fallido.publishedAt).toBeNull();
    expect(fallido.attempts).toBe(1);
    expect(fallido.lastError).toHaveLength(500);

    await outbox.flush();
    expect((await repo().find())[0].publishedAt).toBeInstanceOf(Date);
  });

  it('un fallo no se traga los que ya salieron: los anteriores quedan publicados', async () => {
    await enqueue(3);
    publisher.publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('broker caído'));
    await outbox.flush();

    const rows = await repo().find({ order: { createdAt: 'ASC', id: 'ASC' } });
    expect(rows.filter((row) => row.publishedAt)).toHaveLength(1);
    expect(rows.filter((row) => !row.publishedAt)).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.attempts, 0)).toBe(1);
  });

  it('procesa más de un lote (50) en una sola pasada', async () => {
    await enqueue(120);
    await outbox.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(120);
  });

  it('dos flush a la vez no publican dos veces el mismo evento', async () => {
    await enqueue(5);
    await Promise.all([outbox.flush(), outbox.flush()]);
    expect(publisher.publish).toHaveBeenCalledTimes(5);
  });

  it('un error de la base se registra y no tumba el relay', async () => {
    await enqueue(1);
    const spy = jest.spyOn(dataSource, 'transaction').mockRejectedValueOnce(new Error('base caída'));
    await expect(outbox.flush()).resolves.toBeUndefined();
    spy.mockRestore();

    await outbox.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('el relay se programa al iniciar el módulo y se detiene al cerrarlo', () => {
    jest.useFakeTimers();
    try {
      const flush = jest.spyOn(outbox, 'flush').mockResolvedValue(undefined);
      outbox.onModuleInit();
      jest.advanceTimersByTime(5_000);
      expect(flush).toHaveBeenCalledTimes(1);

      outbox.onModuleDestroy();
      jest.advanceTimersByTime(20_000);
      expect(flush).toHaveBeenCalledTimes(1);
      flush.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
