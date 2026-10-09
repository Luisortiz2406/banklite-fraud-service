import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Proyección propia del Ledger (igual que `identity_verifications` en
 * account-service, sección 4.10 del documento: ningún servicio lee
 * directamente la base de otro). Una fila por (transactionId, accountId):
 * el mismo `transaction.completed` puede llegar una vez por titular afectado
 * (emisor y receptor), así que la combinación identifica el movimiento desde
 * el punto de vista de ESA cuenta. Es la base de datos sobre la que corren
 * las reglas de riesgo (velocidad, volumen acumulado, fraccionamiento).
 */
@Entity('fraud_transaction_log')
@Index('idx_fraud_tx_log_unique', ['transactionId', 'accountId'], { unique: true })
@Index('idx_fraud_tx_log_account_time', ['accountId', 'occurredAt'])
export class FraudTransactionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'id_user', type: 'varchar' })
  idUser: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar' })
  direction: 'in' | 'out';

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
