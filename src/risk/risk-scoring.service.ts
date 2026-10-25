import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThanOrEqual } from 'typeorm';
import { OutboxService } from '../events/outbox.service';
import { LoginContextsService } from '../geo/login-contexts.service';
import { FlaggedTransaction } from './entities/flagged-transaction.entity';
import { FraudTransactionLog } from './entities/fraud-transaction-log.entity';
import { RiskScore } from './entities/risk-score.entity';
import { evaluateRules, RiskThresholds } from './risk-rules';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCORE = 100;
const FRAUD_ALERT_EVENT = 'fraud.alert';

/** Payload tal como lo publica ledger-service en `transaction.completed` (ver eventPayload() en ledger.service.ts). */
export interface TransactionCompletedPayload {
  idUser: string;
  direction: 'in' | 'out';
  transactionId: string;
  type: string;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  amount: number;
  currency: string;
  createdAt: string;
}

@Injectable()
export class RiskScoringService {
  private readonly logger = new Logger('RiskScoringService');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    private readonly logins: LoginContextsService,
  ) {}

  private thresholds(): RiskThresholds {
    return {
      highAmount: Number(this.config.get('FRAUD_HIGH_AMOUNT_THRESHOLD', '20000000')),
      velocityMaxTx: Number(this.config.get('FRAUD_VELOCITY_MAX_TX', '5')),
      velocityWindowMin: Number(this.config.get('FRAUD_VELOCITY_WINDOW_MIN', '10')),
      dailyOutflowThreshold: Number(this.config.get('FRAUD_DAILY_OUTFLOW_THRESHOLD', '30000000')),
    };
  }

  private reviewThreshold(): number {
    return Number(this.config.get('FRAUD_REVIEW_THRESHOLD', '60'));
  }

  /**
   * Procesa un `transaction.completed`. Es idempotente ante reentregas
   * (at-least-once): si ya existe la fila (transactionId, accountId) en el
   * log, no se vuelve a calificar ni a generar una alerta duplicada.
   */
  async handleTransactionCompleted(payload: TransactionCompletedPayload) {
    const accountId = payload.direction === 'out' ? payload.sourceAccountId : payload.destinationAccountId;
    if (!accountId) {
      this.logger.warn(
        `transaction.completed sin cuenta para la dirección '${payload.direction}' (transactionId=${payload.transactionId}), descartado.`,
      );
      return;
    }
    const occurredAt = new Date(payload.createdAt);
    const amount = Number(payload.amount);

    await this.dataSource.transaction(async (manager) => {
      const logRepo = manager.getRepository(FraudTransactionLog);

      const existing = await logRepo.findOne({ where: { transactionId: payload.transactionId, accountId } });
      if (existing) {
        this.logger.debug(
          `transactionId=${payload.transactionId} accountId=${accountId} ya procesado, se ignora la reentrega.`,
        );
        return;
      }

      // Historial de la cuenta en las últimas 24h, ANTES de insertar la actual.
      const windowStart = new Date(occurredAt.getTime() - DAY_MS);
      const history = await logRepo.find({
        where: { accountId, occurredAt: MoreThanOrEqual(windowStart) },
        order: { occurredAt: 'DESC' },
        take: 500,
      });
      const recent = history.map((row) => ({
        amount: Number(row.amount),
        direction: row.direction,
        occurredAt: row.occurredAt,
      }));

      await logRepo.save(
        logRepo.create({
          transactionId: payload.transactionId,
          accountId,
          idUser: payload.idUser,
          type: payload.type,
          direction: payload.direction,
          amount: String(amount),
          currency: payload.currency,
          occurredAt,
        }),
      );

      const evaluated = evaluateRules({ amount, direction: payload.direction, occurredAt }, recent, this.thresholds());
      // Reglas geográficas del último inicio de sesión del cliente (país nuevo, viaje
      // imposible, Tor): solo cuentan para las salidas de dinero.
      const geoRules =
        payload.direction === 'out' ? await this.logins.geoRulesForTransaction(payload.idUser, occurredAt) : [];
      const rulesTriggered = [...evaluated.rulesTriggered, ...geoRules];
      const score = Math.min(MAX_SCORE, evaluated.score + geoRules.reduce((sum, rule) => sum + rule.points, 0));

      const scoreRepo = manager.getRepository(RiskScore);
      await scoreRepo.save(
        scoreRepo.create({
          transactionId: payload.transactionId,
          accountId,
          score,
          modelVersion: geoRules.length ? 'rules-v2-geo' : 'rules-v1',
          rulesTriggered,
        }),
      );

      if (score < this.reviewThreshold()) return;

      const reason = rulesTriggered.map((r) => r.detail).join(' ');
      const flagRepo = manager.getRepository(FlaggedTransaction);
      await flagRepo.save(
        flagRepo.create({
          transactionId: payload.transactionId,
          accountId,
          idUser: payload.idUser,
          score,
          reason,
          status: 'pending',
        }),
      );

      await this.outbox.enqueue(manager, FRAUD_ALERT_EVENT, [
        { idUser: payload.idUser, accountId, transactionId: payload.transactionId, score, reason },
      ]);

      this.logger.warn(`Transacción ${payload.transactionId} marcada para revisión (score=${score}): ${reason}`);
    });
  }
}
