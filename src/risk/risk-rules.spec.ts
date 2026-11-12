import { evaluateRules, RecentTransaction, RiskThresholds } from './risk-rules';

/**
 * Reglas de puntaje (funciones puras): monto alto, velocidad, volumen del día y
 * fraccionamiento. Cada una suma de forma independiente y el total nunca pasa de 100.
 */
const thresholds: RiskThresholds = {
  highAmount: 20_000_000,
  velocityMaxTx: 5,
  velocityWindowMin: 10,
  dailyOutflowThreshold: 30_000_000,
};
const NOW = new Date('2026-11-11T15:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const tx = (overrides: Partial<RecentTransaction> = {}): RecentTransaction => ({
  amount: 100_000,
  direction: 'out',
  occurredAt: minutesAgo(1),
  ...overrides,
});
const current = (overrides: Partial<RecentTransaction> = {}) => ({
  amount: 100_000,
  direction: 'out' as const,
  occurredAt: NOW,
  ...overrides,
});
const rulesOf = (result: ReturnType<typeof evaluateRules>) => result.rulesTriggered.map((r) => r.rule);

describe('evaluateRules', () => {
  it('una transacción normal no suma puntos', () => {
    expect(evaluateRules(current(), [], thresholds)).toEqual({ score: 0, rulesTriggered: [] });
  });

  describe('monto alto (40 puntos)', () => {
    it('solo se activa por encima del umbral, no en el umbral', () => {
      expect(rulesOf(evaluateRules(current({ amount: 20_000_000 }), [], thresholds))).toEqual([]);
      const result = evaluateRules(current({ amount: 20_000_001 }), [], thresholds);
      expect(result.score).toBe(40);
      expect(result.rulesTriggered[0]).toMatchObject({ rule: 'high_amount', points: 40 });
      expect(result.rulesTriggered[0].detail).toContain('supera el umbral');
    });

    it('cuenta también para las entradas de dinero', () => {
      expect(evaluateRules(current({ amount: 25_000_000, direction: 'in' }), [], thresholds).score).toBe(40);
    });
  });

  describe('velocidad (30 puntos)', () => {
    const outgoing = (count: number, minutes = 3) =>
      Array.from({ length: count }, (_, i) => tx({ amount: 1_000 + i, occurredAt: minutesAgo(minutes) }));

    it('cuenta la actual: 4 salidas previas + la actual = 5 dispara; 3 previas no', () => {
      expect(rulesOf(evaluateRules(current(), outgoing(3), thresholds))).not.toContain('velocity');
      const result = evaluateRules(current(), outgoing(4), thresholds);
      expect(rulesOf(result)).toContain('velocity');
      expect(result.rulesTriggered.find((r) => r.rule === 'velocity')?.detail).toContain('5 transacciones salientes');
    });

    it('las salidas fuera de la ventana de 10 minutos no cuentan', () => {
      expect(rulesOf(evaluateRules(current(), outgoing(4, 11), thresholds))).not.toContain('velocity');
      expect(rulesOf(evaluateRules(current(), outgoing(4, 10), thresholds))).toContain('velocity'); // justo en el borde
    });

    it('las entradas no cuentan, ni la actual si es una entrada', () => {
      const incoming = Array.from({ length: 4 }, (_, i) => tx({ amount: 1_000 + i, direction: 'in' }));
      expect(rulesOf(evaluateRules(current(), incoming, thresholds))).not.toContain('velocity');
      expect(rulesOf(evaluateRules(current({ direction: 'in' }), outgoing(4), thresholds))).not.toContain('velocity');
    });
  });

  describe('volumen del día (25 puntos)', () => {
    it('suma las salidas previas y la actual contra el umbral diario', () => {
      const previous = [
        tx({ amount: 15_000_000, occurredAt: minutesAgo(600) }),
        tx({ amount: 14_500_000, occurredAt: minutesAgo(300) }),
      ];

      expect(rulesOf(evaluateRules(current({ amount: 1_000_000 }), previous, thresholds))).toEqual(['daily_outflow']);
      expect(rulesOf(evaluateRules(current({ amount: 1_000_000 }), previous.slice(0, 1), thresholds))).toEqual([]);
    });

    it('el umbral exacto no dispara, y las entradas no suman', () => {
      const previous = [
        tx({ amount: 29_000_000, occurredAt: minutesAgo(300) }),
        tx({ amount: 50_000_000, direction: 'in', occurredAt: minutesAgo(300) }),
      ];

      expect(rulesOf(evaluateRules(current({ amount: 1_000_000 }), previous, thresholds))).toEqual([]);
      expect(rulesOf(evaluateRules(current({ amount: 1_000_001 }), previous, thresholds))).toEqual(['daily_outflow']);
    });

    it('una entrada actual no suma a las salidas del día', () => {
      const previous = [tx({ amount: 29_500_000, occurredAt: minutesAgo(300) })];
      expect(rulesOf(evaluateRules(current({ amount: 1_000_000, direction: 'in' }), previous, thresholds))).toEqual([]);
    });
  });

  describe('fraccionamiento (20 puntos)', () => {
    it('el mismo monto exacto 3 veces en una hora (la actual cuenta) dispara', () => {
      const same = (minutes: number) => tx({ amount: 9_900_000, occurredAt: minutesAgo(minutes) });

      expect(rulesOf(evaluateRules(current({ amount: 9_900_000 }), [same(5), same(20)], thresholds))).toContain(
        'structuring',
      );
      expect(rulesOf(evaluateRules(current({ amount: 9_900_000 }), [same(5)], thresholds))).not.toContain(
        'structuring',
      );
    });

    it('montos distintos o fuera de la hora no cuentan', () => {
      const old = tx({ amount: 9_900_000, occurredAt: minutesAgo(61) });
      const different = tx({ amount: 9_900_001, occurredAt: minutesAgo(5) });

      expect(
        rulesOf(evaluateRules(current({ amount: 9_900_000 }), [old, old, different, different], thresholds)),
      ).not.toContain('structuring');
    });

    it('cuenta entradas y salidas (el monto repetido es la señal)', () => {
      const same = (direction: 'in' | 'out') => tx({ amount: 500_000, direction, occurredAt: minutesAgo(5) });
      expect(rulesOf(evaluateRules(current({ amount: 500_000 }), [same('in'), same('in')], thresholds))).toContain(
        'structuring',
      );
    });
  });

  it('las reglas suman de forma independiente y el total se limita a 100', () => {
    const recent = Array.from({ length: 6 }, () => tx({ amount: 25_000_000, occurredAt: minutesAgo(2) }));

    const result = evaluateRules(current({ amount: 25_000_000 }), recent, thresholds);

    expect(rulesOf(result).sort()).toEqual(['daily_outflow', 'high_amount', 'structuring', 'velocity']);
    expect(result.rulesTriggered.reduce((sum, r) => sum + r.points, 0)).toBe(115);
    expect(result.score).toBe(100);
  });

  it('dos reglas suman sus puntos: monto alto + volumen = 65', () => {
    const result = evaluateRules(
      current({ amount: 25_000_000 }),
      [tx({ amount: 6_000_000, occurredAt: minutesAgo(300) })],
      thresholds,
    );
    expect(result.score).toBe(65);
  });
});
