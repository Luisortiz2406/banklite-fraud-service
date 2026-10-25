import { GeoRuleConfig } from './geo-rules';

/**
 * Configuración de la geolocalización por IP. Todo es opcional: sin las llaves
 * de MaxMind o sin FRAUD_IP_HASH_SECRET el servicio arranca igual, con la
 * geolocalización degradada. Lo que sí impide arrancar es un secreto de huella
 * débil o de ejemplo (mismo criterio que env.validation.ts).
 */
export interface GeoConfig {
  maxmindAccountId: string | null;
  maxmindLicenseKey: string | null;
  hashSecret: string | null;
  rules: GeoRuleConfig;
  // Las reglas del último inicio de sesión cuentan para las transacciones de las siguientes N horas.
  sessionHours: number;
  // Historial para "país nuevo" y retención de los contextos (purga diaria).
  retentionDays: number;
  // Descarga automática de la base y de la lista de Tor (false en pruebas).
  autoUpdate: boolean;
}

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /cambiar|reemplazar|replace|changeme|example|ejemplo|secreto/i;

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readGeoConfig(env: Record<string, unknown>): GeoConfig {
  const hashSecret = text(env.FRAUD_IP_HASH_SECRET);
  if (hashSecret && (hashSecret.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(hashSecret))) {
    throw new Error(
      `Configuración insegura, el servicio no arranca:\n - FRAUD_IP_HASH_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres aleatorios.`,
    );
  }
  return {
    maxmindAccountId: text(env.MAXMIND_ACCOUNT_ID),
    maxmindLicenseKey: text(env.MAXMIND_LICENSE_KEY),
    hashSecret,
    rules: {
      newCountryPoints: positive(env.FRAUD_GEO_NEW_COUNTRY_POINTS, 20),
      impossibleTravelPoints: positive(env.FRAUD_GEO_IMPOSSIBLE_TRAVEL_POINTS, 30),
      torPoints: positive(env.FRAUD_GEO_TOR_POINTS, 40),
      travelWindowMin: positive(env.FRAUD_GEO_TRAVEL_WINDOW_MIN, 120),
    },
    sessionHours: positive(env.FRAUD_GEO_SESSION_HOURS, 12),
    retentionDays: positive(env.FRAUD_GEO_RETENTION_DAYS, 90),
    autoUpdate: env.GEO_AUTO_UPDATE !== 'false',
  };
}
