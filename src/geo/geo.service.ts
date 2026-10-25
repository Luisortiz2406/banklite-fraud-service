import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { CountryResponse, Reader } from 'maxmind';
import { Repository } from 'typeorm';
import { GeoDatabase } from './entities/geo-database.entity';
import { GeoConfig } from './geo-config';
import { extractMmdb } from './mmdb-archive';
import { isPrivateIp } from './ip-privacy';

export const GEO_CONFIG = Symbol('GEO_CONFIG');

const EDITION = 'GeoLite2-Country';
const DOWNLOAD_URL = `https://download.maxmind.com/geoip/databases/${EDITION}/download`;
const TOR_EXIT_LIST_URL = 'https://check.torproject.org/torbulkexitlist';

const HOUR_MS = 60 * 60 * 1000;
// La base se renueva cada 7 días; MaxMind publica cambios cada semana.
const REFRESH_AFTER_MS = 7 * 24 * HOUR_MS;
// Como mucho un intento de descarga cada 24 h (exitoso o no), aunque el servicio se reinicie.
const MIN_ATTEMPT_INTERVAL_MS = 24 * HOUR_MS;
// Una base de más de 30 días se sigue usando, pero /health avisa.
const STALE_AFTER_MS = 30 * 24 * HOUR_MS;
// Lista de nodos de salida de Tor: se renueva cada 6 h y deja de usarse si pasa 24 h sin renovarse.
const TOR_REFRESH_MS = 6 * HOUR_MS;
const TOR_MAX_AGE_MS = 24 * HOUR_MS;
const CHECK_EVERY_MS = 6 * HOUR_MS;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TOR_TIMEOUT_MS = 15_000;

export interface GeoLookup {
  country: string | null;
  // null: no se sabe (lista de Tor no disponible).
  isTor: boolean | null;
  status: 'ok' | 'no_disponible' | 'privada';
}

export type GeoDegradedReason = 'sin_llave' | 'sin_base' | 'base_desactualizada' | 'sin_lista_tor' | 'sin_secreto_hash';

/**
 * Geolocalización por IP con GeoLite2-Country LOCAL (la IP nunca sale de
 * BankLite) y la lista pública de nodos de salida de Tor. Si algo falta, el
 * servicio sigue funcionando: las consultas devuelven "no disponible" y las
 * reglas de IP no suman puntos.
 */
@Injectable()
export class GeoService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GeoService.name);
  private reader: Reader<CountryResponse> | null = null;
  private databaseDate: Date | null = null;
  private torExits: Set<string> | null = null;
  private torLoadedAt: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(
    @InjectRepository(GeoDatabase) private readonly databases: Repository<GeoDatabase>,
    @Inject(GEO_CONFIG) private readonly config: GeoConfig,
  ) {}

  async onApplicationBootstrap() {
    await this.loadStoredDatabase();
    if (!this.config.autoUpdate) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** País y Tor de una IP. Nunca registra la IP. */
  lookup(ip: string): GeoLookup {
    if (isPrivateIp(ip)) return { country: null, isTor: false, status: 'privada' };
    const isTor = this.torAvailable() ? this.torExits!.has(ip) : null;
    if (!this.reader) return { country: null, isTor, status: 'no_disponible' };
    let country: string | null;
    try {
      country = this.reader.get(ip)?.country?.iso_code ?? null;
    } catch {
      country = null;
    }
    return { country, isTor, status: 'ok' };
  }

  /** Estado para /health: "ok" o "degradada" con los motivos. */
  health(): { geo: 'ok' | 'degradada'; motivos?: GeoDegradedReason[] } {
    const motivos: GeoDegradedReason[] = [];
    if (!this.hasCredentials()) motivos.push('sin_llave');
    if (!this.reader) motivos.push('sin_base');
    else if (this.databaseDate && Date.now() - this.databaseDate.getTime() > STALE_AFTER_MS) {
      motivos.push('base_desactualizada');
    }
    if (!this.torAvailable()) motivos.push('sin_lista_tor');
    if (!this.config.hashSecret) motivos.push('sin_secreto_hash');
    return motivos.length ? { geo: 'degradada', motivos } : { geo: 'ok' };
  }

  /** Revisa la base y la lista de Tor; una vuelta a la vez. */
  async refresh(now = new Date()) {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.refreshDatabase(now);
      if (!this.torLoadedAt || now.getTime() - this.torLoadedAt >= TOR_REFRESH_MS) await this.refreshTorList(now);
    } finally {
      this.checking = false;
    }
  }

  /** Carga la base guardada en fraud_db (no descarga nada). */
  async loadStoredDatabase() {
    const stored = await this.databases.findOne({ where: { edition: EDITION } });
    if (!stored?.data) {
      this.logger.warn('No hay base GeoLite2 guardada todavía: geolocalización degradada.');
      return;
    }
    try {
      this.useDatabase(stored.data, stored.downloadedAt);
      this.logger.log(`Base GeoLite2 cargada desde fraud_db (descargada ${stored.downloadedAt?.toISOString()}).`);
    } catch (err) {
      this.logger.error(`La base GeoLite2 guardada no es válida: ${(err as Error).message}`);
    }
  }

  /**
   * Descarga una base nueva solo si la guardada tiene más de 7 días (o no hay)
   * y el último intento fue hace más de 24 h. El intento se "reclama" con un
   * UPDATE condicional en fraud_db, así que se respeta aunque el servicio se
   * reinicie muchas veces.
   */
  async refreshDatabase(now = new Date()) {
    if (!this.hasCredentials()) return;
    await this.databases
      .createQueryBuilder()
      .insert()
      .into(GeoDatabase)
      .values({ edition: EDITION })
      .orIgnore()
      .execute();
    const stored = await this.databases.findOne({ where: { edition: EDITION } });
    if (stored?.data && stored.downloadedAt && now.getTime() - stored.downloadedAt.getTime() < REFRESH_AFTER_MS) {
      return;
    }
    const claimed = await this.databases
      .createQueryBuilder()
      .update(GeoDatabase)
      .set({ lastAttemptAt: now })
      .where('edition = :edition', { edition: EDITION })
      .andWhere('(last_attempt_at IS NULL OR last_attempt_at < :limit)', {
        limit: new Date(now.getTime() - MIN_ATTEMPT_INTERVAL_MS),
      })
      .execute();
    if (!claimed.affected) return; // ya hubo un intento en las últimas 24 h

    try {
      const data = await this.download();
      this.useDatabase(data, now);
      await this.databases.update(
        { edition: EDITION },
        { data, sha256: createHash('sha256').update(data).digest('hex'), downloadedAt: now, lastError: null },
      );
      this.logger.log('Base GeoLite2-Country descargada y guardada.');
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      await this.databases.update({ edition: EDITION }, { lastError: message });
      this.logger.warn(`No se pudo descargar GeoLite2 (${message}); se reintenta en 24 h.`);
    }
  }

  async refreshTorList(now = new Date()) {
    try {
      const res = await fetch(TOR_EXIT_LIST_URL, { signal: AbortSignal.timeout(TOR_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ips = (await res.text())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f.:]+$/i.test(line));
      if (ips.length < 100) throw new Error('lista incompleta');
      this.torExits = new Set(ips);
      this.torLoadedAt = now.getTime();
    } catch (err) {
      this.logger.warn(`No se pudo actualizar la lista de nodos de Tor (${(err as Error).message}).`);
    }
  }

  /** Usa una base .mmdb (la guardada, la recién descargada o, en pruebas, una de prueba). */
  useDatabase(mmdb: Buffer, downloadedAt: Date | null) {
    const reader = new Reader<CountryResponse>(mmdb);
    if (!/Country/i.test(reader.metadata.databaseType)) {
      throw new Error(`Tipo de base inesperado: ${reader.metadata.databaseType}`);
    }
    this.reader = reader;
    this.databaseDate = downloadedAt;
  }

  useTorList(ips: string[], loadedAt = Date.now()) {
    this.torExits = new Set(ips);
    this.torLoadedAt = loadedAt;
  }

  private torAvailable(): boolean {
    return !!this.torExits && !!this.torLoadedAt && Date.now() - this.torLoadedAt < TOR_MAX_AGE_MS;
  }

  private hasCredentials(): boolean {
    return !!this.config.maxmindAccountId && !!this.config.maxmindLicenseKey;
  }

  /** Descarga el .tar.gz (Basic Auth con cuenta y llave), verifica su SHA256 y saca el .mmdb. */
  private async download(): Promise<Buffer> {
    const auth = Buffer.from(`${this.config.maxmindAccountId}:${this.config.maxmindLicenseKey}`).toString('base64');
    const get = async (suffix: string) => {
      // fetch sigue la redirección de MaxMind y no reenvía el Authorization a otro dominio.
      const res = await fetch(`${DOWNLOAD_URL}?suffix=${suffix}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (res.status === 401) throw new Error('MaxMind rechazó la cuenta o la llave (401)');
      if (res.status === 429) throw new Error('MaxMind limitó las descargas (429)');
      if (!res.ok) throw new Error(`MaxMind respondió ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
    const archive = await get('tar.gz');
    const expected = (await get('tar.gz.sha256')).toString('utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash('sha256').update(archive).digest('hex');
    if (!expected || expected !== actual) throw new Error('El SHA256 de la descarga no coincide');
    return extractMmdb(archive);
  }
}
