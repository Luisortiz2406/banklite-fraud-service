import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export interface RuleTriggered {
  rule: string;
  points: number;
  detail: string;
}

/** Calificación de riesgo de CADA transacción evaluada, la haya marcado o no para revisión. */
@Entity('risk_scores')
@Index('idx_risk_scores_account_time', ['accountId', 'createdAt'])
export class RiskScore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ type: 'int' })
  score: number;

  @Column({ name: 'model_version', type: 'varchar', default: 'rules-v1' })
  modelVersion: string;

  @Column({ name: 'rules_triggered', type: 'jsonb' })
  rulesTriggered: RuleTriggered[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
