import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import { RuleTriggered } from '../risk/entities/risk-score.entity';
import { LoginContext, LoginOutcome } from './entities/login-context.entity';
import { GeoConfig } from './geo-config';
import { evaluateGeoRules } from './geo-rules';
import { GEO_CONFIG, GeoService } from './geo.service';
import { ipHash, ipPrefix, normalizeIp } from './ip-privacy';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface LoginReport {
  idUser: string;
  sessionId?: string | null;
  ip: string;
  outcome: LoginOutcome;
  occurredAt?: Date;
}

/**
 * Contexto de red de cada inicio de sesión: geolocaliza la IP en memoria,
 * guarda solo prefijo + huella + país, evalúa las reglas geográficas y las deja
 * listas para sumarse a las transacciones de ese cliente. Purga diaria.
 */
@Injectable()
export class LoginContextsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LoginContextsService.name);
  private purgeTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectRepository(LoginContext) private readonly contexts: Repository<LoginContext>,
    private readonly geo: GeoService,
    @Inject(GEO_CONFIG) private readonly config: GeoConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.autoUpdate) return;
    void this.purge();
    this.purgeTimer = setInterval(() => void this.purge(), DAY_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /** Registra un inicio de sesión. Sin FRAUD_IP_HASH_SECRET no guarda nada. Nunca registra la IP en los logs. */
  async record(report: LoginReport): Promise<{ stored: boolean; rules: string[] }> {
    const ip = normalizeIp(report.ip);
    if (!ip || !this.config.hashSecret) return { stored: false, rules: [] };

    const occurredAt = report.occurredAt ?? new Date();
    const geo = this.geo.lookup(ip);

    let rules: RuleTriggered[] = [];
    if (report.outcome === 'success') {
      const previous = await this.contexts.find({
        where: {
          idUser: report.idUser,
          outcome: 'success',
          occurredAt: Between(new Date(occurredAt.getTime() - this.config.retentionDays * DAY_MS), occurredAt),
        },
        order: { occurredAt: 'DESC' },
        take: 200,
      });
      rules = evaluateGeoRules(
        { country: geo.country, isTor: geo.isTor, occurredAt },
        previous.map((p) => ({ country: p.country, occurredAt: p.occurredAt })),
        this.config.rules,
      );
    }

    await this.contexts.save(
      this.contexts.create({
        idUser: report.idUser,
        sessionId: report.sessionId ?? null,
        outcome: report.outcome,
        occurredAt,
        ipPrefix: ipPrefix(ip),
        ipHash: ipHash(ip, this.config.hashSecret),
        country: geo.country,
        isTor: geo.isTor,
        geoStatus: geo.status,
        rulesTriggered: rules,
      }),
    );
    if (rules.length) {
      this.logger.warn(
        `Inicio de sesión de ${report.idUser} con reglas geográficas: ${rules.map((r) => r.rule).join(', ')}.`,
      );
    }
    return { stored: true, rules: rules.map((r) => r.rule) };
  }

  /**
   * Reglas geográficas del último inicio de sesión exitoso del cliente, si fue
   * dentro de FRAUD_GEO_SESSION_HOURS antes de la transacción. Se suman al
   * puntaje de sus transacciones de salida.
   */
  async geoRulesForTransaction(idUser: string, occurredAt: Date): Promise<RuleTriggered[]> {
    const last = await this.contexts.findOne({
      where: {
        idUser,
        outcome: 'success',
        occurredAt: Between(new Date(occurredAt.getTime() - this.config.sessionHours * HOUR_MS), occurredAt),
      },
      order: { occurredAt: 'DESC' },
    });
    return last?.rulesTriggered ?? [];
  }

  /** Para el panel (cumplimiento y administrador): sin la huella. */
  async listForUser(idUser: string, limit = 20) {
    const rows = await this.contexts.find({ where: { idUser }, order: { occurredAt: 'DESC' }, take: limit });
    return rows.map((r) => ({
      occurredAt: r.occurredAt,
      outcome: r.outcome,
      ipPrefix: r.ipPrefix,
      country: r.country,
      isTor: r.isTor,
      geoStatus: r.geoStatus,
      rulesTriggered: r.rulesTriggered,
    }));
  }

  /** Borra los contextos de más de FRAUD_GEO_RETENTION_DAYS días (90 por defecto). */
  async purge(now = new Date()): Promise<number> {
    try {
      const result = await this.contexts.delete({
        occurredAt: LessThan(new Date(now.getTime() - this.config.retentionDays * DAY_MS)),
      });
      if (result.affected) this.logger.log(`Purga: ${result.affected} contexto(s) de inicio de sesión borrados.`);
      return result.affected ?? 0;
    } catch (err) {
      this.logger.error(`La purga de contextos de inicio de sesión falló: ${(err as Error).message}`);
      return 0;
    }
  }
}
