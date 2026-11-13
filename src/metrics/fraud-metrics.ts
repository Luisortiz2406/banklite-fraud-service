import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from './metrics.service';

/** Puntaje (0-100) desde el cual una alerta es de nivel `high`; por debajo, `medium`. */
export const HIGH_RISK_SCORE = 80;

/** Niveles de riesgo de una alerta: lista CERRADA (solo se alerta desde el umbral de revisión, 60 por defecto). */
export const FRAUD_LEVELS = ['medium', 'high'] as const;
export type FraudLevel = (typeof FRAUD_LEVELS)[number];

/**
 * Decisiones sobre una alerta: lista CERRADA.
 *   - review: el motor de reglas la marcó y queda para revisión manual (fraud-service nunca bloquea
 *     cuentas ni reversa dinero por sí mismo).
 *   - confirmed / dismissed: lo que decidió después el personal de soporte o cumplimiento.
 */
export const FRAUD_DECISIONS = ['review', 'confirmed', 'dismissed'] as const;
export type FraudDecision = (typeof FRAUD_DECISIONS)[number];

/** Nivel de riesgo según el puntaje. */
export function riskLevel(score: number): FraudLevel {
  return score >= HIGH_RISK_SCORE ? 'high' : 'medium';
}

/**
 * fraud_alerts_total{level,decision}: alertas de fraude por nivel de riesgo y decisión. Cada alerta
 * cuenta una vez con decision="review" cuando se genera y, cuando el personal la resuelve, una vez más
 * con decision="confirmed" o "dismissed" (mismo nivel). Las alertas GENERADAS son decision="review".
 *
 * Las etiquetas son de lista cerrada: nunca llevan ids de usuario, de cuenta ni de transacción, montos,
 * puntajes, motivos (el texto de las reglas) ni nombres del personal.
 *
 * CONTAR NUNCA ROMPE EL FLUJO: ni el constructor ni los métodos lanzan jamás; si prom-client falla se
 * deja un aviso en el log y la evaluación de la transacción (o la resolución de la alerta) sigue igual.
 */
@Injectable()
export class FraudMetrics {
  private readonly logger = new Logger('FraudMetrics');
  private alerts: Counter<'level' | 'decision'> | null = null;

  constructor(metrics: MetricsService) {
    try {
      const counter = new Counter({
        name: 'fraud_alerts_total',
        help: 'Alertas de fraude por nivel de riesgo y decisión (review = generada; confirmed/dismissed = resuelta).',
        labelNames: ['level', 'decision'],
        registers: [metrics.registry],
      });
      // Todas las series existen desde el arranque (en 0): así increase() y rate() ven el primer evento.
      for (const level of FRAUD_LEVELS) {
        for (const decision of FRAUD_DECISIONS) counter.inc({ level, decision }, 0);
      }
      this.alerts = counter;
    } catch (error) {
      this.logger.warn(`No se pudo crear fraud_alerts_total: ${(error as Error).message}`);
    }
  }

  /** Una alerta recién generada (queda para revisión manual). */
  raised(score: number) {
    this.count(riskLevel(score), 'review');
  }

  /** El personal resolvió una alerta. */
  resolved(score: number, decision: Exclude<FraudDecision, 'review'>) {
    this.count(riskLevel(score), decision);
  }

  /** Suma 1; si prom-client falla, solo avisa en el log (nunca lanza). */
  private count(level: FraudLevel, decision: FraudDecision) {
    try {
      this.alerts?.inc({ level, decision });
    } catch (error) {
      this.logger.warn(`No se pudo contar la alerta de fraude (${decision}): ${(error as Error).message}`);
    }
  }
}
