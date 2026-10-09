import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type FlaggedStatus = 'pending' | 'confirmed' | 'dismissed';

/**
 * Transacciones que superaron el umbral de riesgo: quedan para revisión
 * manual de soporte/cumplimiento desde el panel admin. Fraud Service nunca
 * bloquea cuentas ni reversa dinero por sí mismo (decisión de alcance).
 */
@Entity('flagged_transactions')
@Index('idx_flagged_tx_status_time', ['status', 'createdAt'])
export class FlaggedTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Index()
  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'id_user', type: 'varchar' })
  idUser: string;

  @Column({ type: 'int' })
  score: number;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: FlaggedStatus;

  @Column({ name: 'reviewed_by', type: 'varchar', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'resolution_note', type: 'varchar', length: 300, nullable: true })
  resolutionNote: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}
