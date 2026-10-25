import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Copia de la base GeoLite2 en la propia base de fraud-service. En Railway el
 * disco no sobrevive a un reinicio: guardarla aquí (y la hora del último
 * intento de descarga) evita descargar en cada arranque y respeta el límite
 * diario de descargas de MaxMind aunque el servicio se reinicie muchas veces.
 */
@Entity('geo_databases')
export class GeoDatabase {
  // GeoLite2-Country
  @PrimaryColumn({ type: 'varchar', length: 40 })
  edition: string;

  @Column({ type: 'bytea', nullable: true })
  data: Buffer | null;

  @Column({ type: 'char', length: 64, nullable: true })
  sha256: string | null;

  @Column({ name: 'downloaded_at', type: 'timestamptz', nullable: true })
  downloadedAt: Date | null;

  // Último intento de descarga, exitoso o no: como mucho uno cada 24 h.
  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  // Motivo del último fallo (sin llaves ni URLs firmadas).
  @Column({ name: 'last_error', type: 'varchar', length: 200, nullable: true })
  lastError: string | null;
}
