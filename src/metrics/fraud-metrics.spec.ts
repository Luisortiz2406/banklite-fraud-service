import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import { FRAUD_DECISIONS, FRAUD_LEVELS, FraudMetrics, HIGH_RISK_SCORE, riskLevel } from './fraud-metrics';
import { MetricsService } from './metrics.service';

/**
 * fraud_alerts_total{level,decision}: nivel de riesgo y decisión, ambos de lista cerrada, y sin que contar
 * pueda romper la evaluación de una transacción ni la resolución de una alerta.
 */
function build() {
  const metricsService = new MetricsService(new ConfigService({}));
  const metrics = new FraudMetrics(metricsService);
  const counter = metricsService.registry.getSingleMetric('fraud_alerts_total') as Counter;
  return { metricsService, metrics, counter };
}
async function counted(counter: Counter) {
  const { values } = await counter.get();
  return Object.fromEntries(
    values.filter((v) => v.value > 0).map((v) => [`${v.labels.level}:${v.labels.decision}`, v.value]),
  );
}

describe('riskLevel', () => {
  it('desde 80 puntos es high; por debajo (desde el umbral de revisión, 60) es medium', () => {
    expect(HIGH_RISK_SCORE).toBe(80);
    expect(riskLevel(60)).toBe('medium');
    expect(riskLevel(79)).toBe('medium');
    expect(riskLevel(80)).toBe('high');
    expect(riskLevel(100)).toBe('high');
  });
});

describe('FraudMetrics', () => {
  it('una alerta generada cuenta como decision="review" con su nivel', async () => {
    const { metrics, counter } = build();
    metrics.raised(65);
    metrics.raised(95);
    metrics.raised(95);

    expect(await counted(counter)).toEqual({ 'medium:review': 1, 'high:review': 2 });
  });

  it('una alerta resuelta por el personal cuenta como confirmed o dismissed, con el nivel de su puntaje', async () => {
    const { metrics, counter } = build();
    metrics.resolved(85, 'confirmed');
    metrics.resolved(62, 'dismissed');

    expect(await counted(counter)).toEqual({ 'high:confirmed': 1, 'medium:dismissed': 1 });
  });

  it('las 6 series (2 niveles × 3 decisiones) existen desde el arranque en 0, y solo hay level y decision', async () => {
    const { counter } = build();
    const { values } = await counter.get();

    expect(values).toHaveLength(FRAUD_LEVELS.length * FRAUD_DECISIONS.length);
    for (const v of values) {
      expect(Object.keys(v.labels).sort()).toEqual(['decision', 'level']);
      expect(FRAUD_LEVELS).toContain(v.labels.level);
      expect(FRAUD_DECISIONS).toContain(v.labels.decision);
      expect(v.value).toBe(0);
    }
  });

  it('las etiquetas no dependen del contenido de la alerta: un puntaje inesperado solo cambia el nivel', async () => {
    const { metrics, metricsService } = build();
    metrics.raised(Number.NaN);
    metrics.raised(-5);
    metrics.raised(1e9);

    const text = await metricsService.registry.metrics();
    const etiquetas = [...text.matchAll(/fraud_alerts_total\{([^}]*)\}/g)].map((m) => m[1]).join(' | ');
    expect(etiquetas).not.toMatch(/NaN|1000000000|-5/);
  });

  it('contar nunca lanza: si prom-client falla, solo avisa en el log', () => {
    const { metrics, counter } = build();
    jest.spyOn(counter, 'inc').mockImplementation(() => {
      throw new Error('prom-client roto');
    });
    const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(() => metrics.raised(90)).not.toThrow();
    expect(() => metrics.resolved(90, 'confirmed')).not.toThrow();

    expect(aviso).toHaveBeenCalledTimes(2);
    aviso.mockRestore();
  });

  it('si la métrica no se pudo crear (nombre duplicado), el servicio arranca y contar no hace nada', () => {
    const metricsService = new MetricsService(new ConfigService({}));
    new FraudMetrics(metricsService);

    const segunda = new FraudMetrics(metricsService); // fraud_alerts_total ya estaba registrada

    expect(() => segunda.raised(90)).not.toThrow();
    expect(() => segunda.resolved(90, 'dismissed')).not.toThrow();
  });
});
