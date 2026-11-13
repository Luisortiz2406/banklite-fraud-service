import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RuleTriggered } from '../../risk/entities/risk-score.entity';

export type LoginOutcome = 'success' | 'failed';
// ok: geolocalizada · no_disponible: sin base GeoLite2 · privada: IP de red privada/local.
export type GeoStatus = 'ok' | 'no_disponible' | 'privada';

/**
 * Contexto de red de un inicio de sesión (lo manda auth-service). NUNCA guarda
 * la IP completa: solo la red recortada (/24 o /48) y su huella HMAC. Se borra
 * a los FRAUD_GEO_RETENTION_DAYS días (90 por defecto).
 */
@Entity('login_contexts')
@Index('idx_login_contexts_user_time', ['idUser', 'occurredAt'])
@Index('idx_login_contexts_time', ['occurredAt'])
export class LoginContext {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 10 })
  outcome: LoginOutcome;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  // 181.52.33.0/24 o 2800:00e2:4a80::/48
  @Column({ name: 'ip_prefix', type: 'varchar', length: 50 })
  ipPrefix: string;

  // HMAC-SHA256(ip, FRAUD_IP_HASH_SECRET) en hex.
  @Column({ name: 'ip_hash', type: 'char', length: 64 })
  ipHash: string;

  // ISO 3166-1 alfa-2 (CO, US...). null si no se pudo geolocalizar.
  @Column({ type: 'varchar', length: 2, nullable: true })
  country: string | null;

  // null: la lista de nodos de Tor no estaba disponible.
  @Column({ name: 'is_tor', type: 'boolean', nullable: true })
  isTor: boolean | null;

  @Column({ name: 'geo_status', type: 'varchar', length: 15 })
  geoStatus: GeoStatus;

  @Column({ name: 'rules_triggered', type: 'jsonb', default: () => "'[]'" })
  rulesTriggered: RuleTriggered[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
