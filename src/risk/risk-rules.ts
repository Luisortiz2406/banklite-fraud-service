import { RuleTriggered } from './entities/risk-score.entity';

export type Direction = 'in' | 'out';

export interface CurrentTransaction {
  amount: number;
  direction: Direction;
  occurredAt: Date;
}

export interface RecentTransaction {
  amount: number;
  direction: Direction;
  occurredAt: Date;
}

export interface RiskThresholds {
  highAmount: number;
  velocityMaxTx: number;
  velocityWindowMin: number;
  dailyOutflowThreshold: number;
}

const MAX_SCORE = 100;
const VELOCITY_RULE = 'velocity';
const HIGH_AMOUNT_RULE = 'high_amount';
const DAILY_OUTFLOW_RULE = 'daily_outflow';
const STRUCTURING_RULE = 'structuring';

const STRUCTURING_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const STRUCTURING_MIN_COUNT = 3;

function money(value: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(value);
}

/**
 * Motor de reglas de Fraud Service: funciones puras, sin acceso a base de
 * datos ni a la red, para que sean fáciles de probar y de sustentar. Cada
 * regla suma puntos de forma independiente; el total se limita a 100.
 *
 * `recent` debe traer el historial de la MISMA cuenta de las últimas 24h,
 * sin incluir la transacción que se está evaluando.
 */
export function evaluateRules(
  current: CurrentTransaction,
  recent: RecentTransaction[],
  thresholds: RiskThresholds,
): { score: number; rulesTriggered: RuleTriggered[] } {
  const rulesTriggered: RuleTriggered[] = [];

  // 1. Monto alto: una sola operación ya es significativa por su tamaño.
  if (current.amount > thresholds.highAmount) {
    rulesTriggered.push({
      rule: HIGH_AMOUNT_RULE,
      points: 40,
      detail: `Monto de ${money(current.amount)} supera el umbral de ${money(thresholds.highAmount)}.`,
    });
  }

  // 2. Velocidad: varias salidas en poco tiempo (posible toma de control de la cuenta).
  const velocityWindowStart = current.occurredAt.getTime() - thresholds.velocityWindowMin * 60 * 1000;
  const recentOutInWindow = recent.filter(
    (tx) => tx.direction === 'out' && tx.occurredAt.getTime() >= velocityWindowStart,
  );
  const velocityCount = recentOutInWindow.length + (current.direction === 'out' ? 1 : 0);
  if (velocityCount >= thresholds.velocityMaxTx) {
    rulesTriggered.push({
      rule: VELOCITY_RULE,
      points: 30,
      detail: `${velocityCount} transacciones salientes en los últimos ${thresholds.velocityWindowMin} minutos.`,
    });
  }

  // 3. Volumen acumulado: salidas de las últimas 24h (recent ya viene acotado a esa ventana).
  const dailyOutflow =
    recent.filter((tx) => tx.direction === 'out').reduce((sum, tx) => sum + tx.amount, 0) +
    (current.direction === 'out' ? current.amount : 0);
  if (dailyOutflow > thresholds.dailyOutflowThreshold) {
    rulesTriggered.push({
      rule: DAILY_OUTFLOW_RULE,
      points: 25,
      detail: `Salidas acumuladas de ${money(dailyOutflow)} en 24h superan el umbral de ${money(thresholds.dailyOutflowThreshold)}.`,
    });
  }

  // 4. Posible fraccionamiento ("structuring"): el mismo monto exacto repetido varias veces en poco tiempo.
  const structuringWindowStart = current.occurredAt.getTime() - STRUCTURING_WINDOW_MS;
  const sameAmountCount =
    recent.filter((tx) => tx.amount === current.amount && tx.occurredAt.getTime() >= structuringWindowStart).length + 1; // +1 por la transacción actual
  if (sameAmountCount >= STRUCTURING_MIN_COUNT) {
    rulesTriggered.push({
      rule: STRUCTURING_RULE,
      points: 20,
      detail: `${sameAmountCount} transacciones por el mismo monto exacto (${money(current.amount)}) en la última hora.`,
    });
  }

  const score = Math.min(
    MAX_SCORE,
    rulesTriggered.reduce((sum, rule) => sum + rule.points, 0),
  );
  return { score, rulesTriggered };
}
