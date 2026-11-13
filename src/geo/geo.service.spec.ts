import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { FraudOutbox } from '../events/fraud-outbox.entity';
import { OutboxService } from '../events/outbox.service';
import { EventPublisherService } from '../events/event-publisher.service';
import { FlaggedTransaction } from '../risk/entities/flagged-transaction.entity';
import { FraudTransactionLog } from '../risk/entities/fraud-transaction-log.entity';
import { RiskScore } from '../risk/entities/risk-score.entity';
import { FraudMetrics } from '../metrics/fraud-metrics';
import { MetricsService } from '../metrics/metrics.service';
import { RiskScoringService } from '../risk/risk-scoring.service';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { GeoDatabase } from './entities/geo-database.entity';
import { LoginContext } from './entities/login-context.entity';
import { GeoConfig, readGeoConfig } from './geo-config';
import { GeoService } from './geo.service';
import { LoginContextsService } from './login-contexts.service';
import { extractMmdb } from './mmdb-archive';

/**
 * Geolocalización contra un PostgreSQL real y la base de PRUEBA de MaxMind
 * (test/fixtures/GeoIP2-Country-Test.mmdb, del repositorio MaxMind-DB): en ella
 * 216.160.83.56 es US, 81.2.69.160 es GB y 89.160.20.112 es SE. Nada sale a
 * internet: fetch se simula.
 */
const TEST_MMDB = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'GeoIP2-Country-Test.mmdb'));
const US_IP = '216.160.83.56';
const GB_TOR_IP = '81.2.69.160';
const SE_IP = '89.160.20.112';
const TOR_LIST = [GB_TOR_IP, ...Array.from({ length: 150 }, (_, i) => `198.51.100.${i}`)];
const HASH_SECRET = 'f'.repeat(64);

/** Un .tar.gz como el de MaxMind con la base de prueba adentro. */
function tarGz(mmdb: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write('GeoLite2-Country_20261020/GeoLite2-Country.mmdb', 0);
  header.write('0000644\0', 100);
  header.write(mmdb.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  const body = Buffer.concat([mmdb, Buffer.alloc((512 - (mmdb.length % 512)) % 512)]);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

const ARCHIVE = tarGz(TEST_MMDB);
const ARCHIVE_SHA = createHash('sha256').update(ARCHIVE).digest('hex');

const geoConfig = (overrides: Record<string, string> = {}): GeoConfig =>
  readGeoConfig({
    MAXMIND_ACCOUNT_ID: '123456',
    MAXMIND_LICENSE_KEY: 'llave-de-prueba-0123456789abcdefghij',
    FRAUD_IP_HASH_SECRET: HASH_SECRET,
    GEO_AUTO_UPDATE: 'false',
    ...overrides,
  });

describe('Archivo de MaxMind', () => {
  it('saca el .mmdb del .tar.gz', () => {
    expect(extractMmdb(ARCHIVE).equals(TEST_MMDB)).toBe(true);
  });

  it('readGeoConfig no arranca con un secreto de huella débil, y sin llaves sí', () => {
    expect(() => readGeoConfig({ FRAUD_IP_HASH_SECRET: 'corto' })).toThrow(/FRAUD_IP_HASH_SECRET/);
    expect(readGeoConfig({}).hashSecret).toBeNull();
  });
});

describeWithDb('Geolocalización por IP (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let databases: Repository<GeoDatabase>;
  let contexts: Repository<LoginContext>;
  let fetchMock: jest.SpyInstance;

  // fetch simulado: MaxMind (tar.gz y su sha256) y la lista de Tor.
  let maxmindStatus = 200;
  let shaOverride: string | null = null;
  const calls = () => fetchMock.mock.calls.map(([url]) => String(url));

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('fraud', [
      GeoDatabase,
      LoginContext,
      FraudTransactionLog,
      RiskScore,
      FlaggedTransaction,
      FraudOutbox,
    ]));
    databases = dataSource.getRepository(GeoDatabase);
    contexts = dataSource.getRepository(LoginContext);
  });

  afterAll(async () => {
    await drop?.();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    maxmindStatus = 200;
    shaOverride = null;
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('torbulkexitlist')) return new Response(TOR_LIST.join('\n'));
      if (maxmindStatus !== 200) return new Response('error', { status: maxmindStatus });
      if (url.endsWith('suffix=tar.gz.sha256')) {
        return new Response(`${shaOverride ?? ARCHIVE_SHA}  GeoLite2-Country_20261020.tar.gz\n`);
      }
      return new Response(new Uint8Array(ARCHIVE));
    });
  });

  afterEach(() => fetchMock.mockRestore());

  const newGeo = (config = geoConfig()) => new GeoService(databases, config);

  describe('descarga de GeoLite2 (límite de MaxMind)', () => {
    it('sin llaves no descarga nada y /health dice degradada', async () => {
      const geo = newGeo(geoConfig({ MAXMIND_ACCOUNT_ID: '', MAXMIND_LICENSE_KEY: '' }));
      await geo.refreshDatabase();
      expect(calls().filter((u) => u.includes('maxmind'))).toEqual([]);
      expect(geo.health()).toEqual({ geo: 'degradada', motivos: ['sin_llave', 'sin_base', 'sin_lista_tor'] });
    });

    it('descarga, verifica el SHA256, guarda en fraud_db y geolocaliza', async () => {
      const geo = newGeo();
      await geo.refresh();
      expect(geo.lookup(US_IP)).toEqual({ country: 'US', isTor: false, status: 'ok' });
      expect(geo.lookup(GB_TOR_IP)).toEqual({ country: 'GB', isTor: true, status: 'ok' });
      expect(geo.health()).toEqual({ geo: 'ok' });
      const stored = await databases.findOneByOrFail({ edition: 'GeoLite2-Country' });
      expect(stored.data?.length).toBe(TEST_MMDB.length);
    });

    it('reiniciar NO vuelve a descargar: usa la copia de fraud_db', async () => {
      await newGeo().refreshDatabase();
      const downloads = calls().filter((u) => u.includes('maxmind')).length;

      // "Reinicio": servicio nuevo, misma base de datos.
      const restarted = newGeo();
      await restarted.loadStoredDatabase();
      await restarted.refreshDatabase();
      await newGeo().refreshDatabase();
      expect(calls().filter((u) => u.includes('maxmind')).length).toBe(downloads);
      expect(restarted.lookup(SE_IP).country).toBe('SE');
    });

    it('si la descarga falla, como mucho un intento cada 24 h aunque se reinicie, y queda degradada', async () => {
      maxmindStatus = 500;
      const now = new Date('2026-10-25T12:00:00Z');
      const geo = newGeo();
      await geo.refreshDatabase(now);
      // Varios "reinicios" en la misma hora: ninguno vuelve a llamar a MaxMind.
      for (let i = 0; i < 5; i++) await newGeo().refreshDatabase(new Date(now.getTime() + i * 60_000));
      expect(calls().filter((u) => u.includes('maxmind')).length).toBe(1);
      expect(geo.health().motivos).toContain('sin_base');
      expect((await databases.findOneByOrFail({ edition: 'GeoLite2-Country' })).lastError).toContain('500');

      // 25 h después sí se reintenta.
      maxmindStatus = 200;
      const later = newGeo();
      await later.refreshDatabase(new Date(now.getTime() + 25 * 60 * 60 * 1000));
      expect(later.lookup(US_IP).country).toBe('US');
    });

    it('un SHA256 que no coincide se rechaza', async () => {
      shaOverride = '0'.repeat(64);
      const geo = newGeo();
      await geo.refreshDatabase();
      expect(geo.lookup(US_IP).status).toBe('no_disponible');
      expect((await databases.findOneByOrFail({ edition: 'GeoLite2-Country' })).lastError).toContain('SHA256');
    });
  });

  describe('contextos de inicio de sesión', () => {
    let geo: GeoService;
    let logins: LoginContextsService;
    const user = () => randomUUID();
    const minutesAfter = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);
    const t0 = new Date('2026-10-25T10:00:00Z');

    beforeEach(() => {
      geo = newGeo();
      geo.useDatabase(TEST_MMDB, new Date());
      geo.useTorList(TOR_LIST);
      logins = new LoginContextsService(contexts, geo, geoConfig());
    });

    it('guarda prefijo, huella y país, NUNCA la IP completa', async () => {
      const idUser = user();
      await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
      const [row] = await contexts.find();
      expect(row).toMatchObject({ ipPrefix: '216.160.83.0/24', country: 'US', isTor: false, geoStatus: 'ok' });
      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(US_IP);
    });

    it('sin FRAUD_IP_HASH_SECRET no guarda nada', async () => {
      const noSecret = new LoginContextsService(contexts, geo, geoConfig({ FRAUD_IP_HASH_SECRET: '' }));
      expect(await noSecret.record({ idUser: user(), ip: US_IP, outcome: 'success' })).toEqual({
        stored: false,
        rules: [],
      });
      expect(await contexts.count()).toBe(0);
    });

    it('Tor desde otro país 30 min después: país nuevo + viaje imposible + Tor', async () => {
      const idUser = user();
      await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
      const result = await logins.record({
        idUser,
        ip: GB_TOR_IP,
        outcome: 'success',
        occurredAt: minutesAfter(t0, 30),
      });
      expect(result.rules.sort()).toEqual(['geo_impossible_travel', 'geo_new_country', 'geo_tor']);
    });

    it('un inicio de sesión fallido se guarda pero no suma ni cuenta como historial', async () => {
      const idUser = user();
      await logins.record({ idUser, ip: SE_IP, outcome: 'failed', occurredAt: t0 });
      const first = await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: minutesAfter(t0, 5) });
      expect(first.rules).toEqual([]);
      expect(await contexts.count()).toBe(2);
    });

    it('las reglas del inicio de sesión cuentan para transacciones de las 12 h siguientes', async () => {
      const idUser = user();
      await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
      await logins.record({ idUser, ip: GB_TOR_IP, outcome: 'success', occurredAt: minutesAfter(t0, 30) });
      expect((await logins.geoRulesForTransaction(idUser, minutesAfter(t0, 45))).length).toBe(3);
      expect(await logins.geoRulesForTransaction(idUser, minutesAfter(t0, 30 + 13 * 60))).toEqual([]);
    });

    it('la purga borra lo de más de 90 días', async () => {
      const idUser = user();
      await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: new Date('2026-07-01T00:00:00Z') });
      await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: new Date('2026-10-20T00:00:00Z') });
      expect(await logins.purge(new Date('2026-10-25T00:00:00Z'))).toBe(1);
      expect(await contexts.count()).toBe(1);
    });

    describe('calificación de transacciones', () => {
      let scoring: RiskScoringService;
      const transfer = (idUser: string, occurredAt: Date) => ({
        idUser,
        direction: 'out' as const,
        transactionId: randomUUID(),
        type: 'transfer',
        sourceAccountId: randomUUID(),
        destinationAccountId: randomUUID(),
        amount: 50_000,
        currency: 'COP',
        createdAt: occurredAt.toISOString(),
      });

      beforeEach(() => {
        const publisher = { isReady: () => false } as unknown as EventPublisherService;
        scoring = new RiskScoringService(
          dataSource,
          new ConfigService({}),
          new OutboxService(dataSource, publisher),
          logins,
          new FraudMetrics(new MetricsService(new ConfigService({}))),
        );
      });

      it('transferencia después de entrar por Tor desde otro país: alerta con las reglas geo', async () => {
        const idUser = user();
        await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
        await logins.record({ idUser, ip: GB_TOR_IP, outcome: 'success', occurredAt: minutesAfter(t0, 30) });
        const tx = transfer(idUser, minutesAfter(t0, 40));
        await scoring.handleTransactionCompleted(tx);

        const score = await dataSource.getRepository(RiskScore).findOneByOrFail({ transactionId: tx.transactionId });
        expect(score.score).toBe(90);
        expect(score.modelVersion).toBe('rules-v2-geo');
        const flag = await dataSource
          .getRepository(FlaggedTransaction)
          .findOneByOrFail({ transactionId: tx.transactionId });
        expect(flag.reason).toContain('Tor');
        expect(await dataSource.getRepository(FraudOutbox).count()).toBe(1);
      });

      it('transferencia después de un inicio de sesión normal: sin alerta', async () => {
        const idUser = user();
        await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
        await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: minutesAfter(t0, 600) });
        const tx = transfer(idUser, minutesAfter(t0, 610));
        await scoring.handleTransactionCompleted(tx);

        const score = await dataSource.getRepository(RiskScore).findOneByOrFail({ transactionId: tx.transactionId });
        expect(score).toMatchObject({ score: 0, modelVersion: 'rules-v1' });
        expect(await dataSource.getRepository(FlaggedTransaction).count()).toBe(0);
      });

      it('las entradas de dinero no suman reglas geo', async () => {
        const idUser = user();
        await logins.record({ idUser, ip: US_IP, outcome: 'success', occurredAt: t0 });
        await logins.record({ idUser, ip: GB_TOR_IP, outcome: 'success', occurredAt: minutesAfter(t0, 30) });
        const tx = { ...transfer(idUser, minutesAfter(t0, 40)), direction: 'in' as const };
        await scoring.handleTransactionCompleted(tx);
        const score = await dataSource.getRepository(RiskScore).findOneByOrFail({ transactionId: tx.transactionId });
        expect(score.score).toBe(0);
      });
    });
  });
});
