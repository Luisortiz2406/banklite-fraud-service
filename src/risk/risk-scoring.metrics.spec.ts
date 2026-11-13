import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import { DataSource } from 'typeorm';
import { OutboxService } from '../events/outbox.service';
import { LoginContextsService } from '../geo/login-contexts.service';
import { FraudMetrics } from '../metrics/fraud-metrics';
import { MetricsService } from '../metrics/metrics.service';
import { FlaggedTransaction } from './entities/flagged-transaction.entity';
import { FraudTransactionLog } from './entities/fraud-transaction-log.entity';
import { RiskScore } from './entities/risk-score.entity';
import { RiskScoringService, TransactionCompletedPayload } from './risk-scoring.service';

/**
 * Cuándo se cuenta una alerta de fraude (fraud_alerts_total, base y servicios simulados): solo cuando la
 * transacción de la base se confirmó y la evaluación pasó el umbral de revisión; no en las reentregas, no
 * por debajo del umbral y no si la transacción se revierte. Contar nunca rompe la evaluación.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-13T15:00:00.000Z');

const payload = (over: Partial<TransactionCompletedPayload> = {}): TransactionCompletedPayload => ({
  idUser: USER,
  direction: 'out',
  transactionId: '33333333-3333-4333-8333-333333333333',
  type: 'transfer',
  sourceAccountId: ACCOUNT,
  destinationAccountId: null,
  amount: 1_000,
  currency: 'COP',
  createdAt: NOW.toISOString(),
  ...over,
});
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const out = (amount: number, minutes: number) => ({
  amount: String(amount),
  direction: 'out',
  occurredAt: minutesAgo(minutes),
});

function setup(history: Array<Record<string, unknown>> = [], existing: unknown = null) {
  const saved: Record<string, unknown[]> = { log: [], score: [], flag: [] };
  const logRepo = {
    findOne: jest.fn(async () => existing),
    find: jest.fn(async () => history),
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (row: unknown) => (saved.log.push(row), row)),
  };
  const scoreRepo = {
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (row: unknown) => (saved.score.push(row), row)),
  };
  const flagRepo = {
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (row: unknown) => (saved.flag.push(row), row)),
  };
  const repos = new Map<unknown, unknown>([
    [FraudTransactionLog, logRepo],
    [RiskScore, scoreRepo],
    [FlaggedTransaction, flagRepo],
  ]);
  const manager = { getRepository: (entity: unknown) => repos.get(entity) };
  const dataSource = { transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const logins = { geoRulesForTransaction: jest.fn().mockResolvedValue([]) };
  const metricsService = new MetricsService(new ConfigService({}));
  const metrics = new FraudMetrics(metricsService);
  const service = new RiskScoringService(
    dataSource as unknown as DataSource,
    new ConfigService({}),
    outbox as unknown as OutboxService,
    logins as unknown as LoginContextsService,
    metrics,
  );
  const counter = metricsService.registry.getSingleMetric('fraud_alerts_total') as Counter;
  const counted = async () => {
    const { values } = await counter.get();
    return Object.fromEntries(
      values.filter((v) => v.value > 0).map((v) => [`${v.labels.level}:${v.labels.decision}`, v.value]),
    );
  };
  return { service, dataSource, outbox, saved, counter, counted, metricsService };
}

// 25 M de salida + 6 M de historial → 31 M en 24 h: monto alto (40) + volumen diario (25) = 65 → medium.
const MEDIUM = { payload: () => payload({ amount: 25_000_000 }), history: () => [out(6_000_000, 120)] };
// 25 M + 4 salidas recientes de 2 M → monto alto (40) + velocidad (30) + volumen diario (25) = 95 → high.
const HIGH = {
  payload: () => payload({ amount: 25_000_000 }),
  history: () => [out(2_000_000, 1), out(2_000_000, 2), out(2_000_000, 3), out(2_000_000, 4)],
};

describe('fraud_alerts_total en la evaluación de transacciones', () => {
  it('una alerta de nivel medium se cuenta como medium:review, después de guardarse', async () => {
    const { service, saved, counted, outbox } = setup(MEDIUM.history());

    await service.handleTransactionCompleted(MEDIUM.payload());

    expect(saved.flag).toHaveLength(1);
    expect(outbox.enqueue).toHaveBeenCalled();
    expect(await counted()).toEqual({ 'medium:review': 1 });
  });

  it('una alerta de nivel high (95 puntos) se cuenta como high:review', async () => {
    const { service, saved, counted } = setup(HIGH.history());

    await service.handleTransactionCompleted(HIGH.payload());

    expect((saved.score[0] as { score: number }).score).toBe(95);
    expect(await counted()).toEqual({ 'high:review': 1 });
  });

  it('por debajo del umbral de revisión no hay alerta y no se cuenta', async () => {
    const { service, saved, counted } = setup([]);

    await service.handleTransactionCompleted(payload({ amount: 1_000 }));

    expect(saved.score).toHaveLength(1);
    expect(saved.flag).toHaveLength(0);
    expect(await counted()).toEqual({});
  });

  it('una reentrega de una transacción ya procesada no genera ni cuenta otra alerta', async () => {
    const { service, saved, counted } = setup(MEDIUM.history(), { id: 'ya-existe' });

    await service.handleTransactionCompleted(MEDIUM.payload());

    expect(saved.flag).toHaveLength(0);
    expect(await counted()).toEqual({});
  });

  it('un evento sin cuenta para su dirección se descarta sin contar', async () => {
    const { service, dataSource, counted } = setup();

    await service.handleTransactionCompleted(payload({ sourceAccountId: null }));

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(await counted()).toEqual({});
  });

  it('si la transacción se revierte (falla al encolar el evento), no queda una alerta contada', async () => {
    const { service, outbox, counted } = setup(MEDIUM.history());
    outbox.enqueue.mockRejectedValueOnce(new Error('outbox caído'));

    await expect(service.handleTransactionCompleted(MEDIUM.payload())).rejects.toThrow('outbox caído');

    expect(await counted()).toEqual({});
  });

  it('el reintento tras esa falla sí cuenta la alerta, una sola vez', async () => {
    const { service, outbox, counted } = setup(MEDIUM.history());
    outbox.enqueue.mockRejectedValueOnce(new Error('outbox caído'));
    await expect(service.handleTransactionCompleted(MEDIUM.payload())).rejects.toThrow();

    await service.handleTransactionCompleted(MEDIUM.payload());

    expect(await counted()).toEqual({ 'medium:review': 1 });
  });

  it('si contar lanza, la alerta queda guardada y la evaluación termina sin error', async () => {
    const { service, saved, counter } = setup(HIGH.history());
    jest.spyOn(counter, 'inc').mockImplementation(() => {
      throw new Error('prom-client roto');
    });

    await expect(service.handleTransactionCompleted(HIGH.payload())).resolves.toBeUndefined();

    expect(saved.flag).toHaveLength(1);
  });

  it('las etiquetas publicadas no llevan ids, cuentas, montos, puntajes ni el texto de las reglas', async () => {
    const { service, metricsService } = setup(HIGH.history());
    await service.handleTransactionCompleted(HIGH.payload());

    const text = await metricsService.registry.metrics();
    const lineas = text.split('\n').filter((l) => l.startsWith('fraud_alerts_total'));
    const etiquetas = lineas.map((l) => l.slice(l.indexOf('{'), l.indexOf('}') + 1)).join(' ');

    expect(lineas).toHaveLength(6);
    for (const dato of [USER, ACCOUNT, '3333', '25000000', '25.000.000', '95', 'Monto', 'umbral']) {
      expect(etiquetas).not.toContain(dato);
    }
    for (const m of etiquetas.matchAll(/level="([^"]+)"/g)) expect(['medium', 'high']).toContain(m[1]);
    for (const m of etiquetas.matchAll(/decision="([^"]+)"/g))
      expect(['review', 'confirmed', 'dismissed']).toContain(m[1]);
  });
});
