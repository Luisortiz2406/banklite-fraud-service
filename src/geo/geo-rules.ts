import { RuleTriggered } from '../risk/entities/risk-score.entity';

export const GEO_NEW_COUNTRY_RULE = 'geo_new_country';
export const GEO_IMPOSSIBLE_TRAVEL_RULE = 'geo_impossible_travel';
export const GEO_TOR_RULE = 'geo_tor';

export interface GeoRuleConfig {
  newCountryPoints: number;
  impossibleTravelPoints: number;
  torPoints: number;
  // Dos países distintos en menos de estos minutos = viaje imposible.
  travelWindowMin: number;
}

/** Inicio de sesión que se está evaluando (ya geolocalizado). */
export interface CurrentLogin {
  country: string | null;
  isTor: boolean | null;
  occurredAt: Date;
}

/** Inicios de sesión EXITOSOS anteriores del cliente (ventana de historial), del más reciente al más viejo. */
export interface PreviousLogin {
  country: string | null;
  occurredAt: Date;
}

/**
 * Reglas geográficas de un inicio de sesión exitoso. Solo suman con datos
 * conocidos: un país desconocido (base no disponible, IP privada) no activa
 * nada, y la de Tor solo si la lista de nodos de salida está cargada.
 */
export function evaluateGeoRules(
  current: CurrentLogin,
  previous: PreviousLogin[],
  config: GeoRuleConfig,
): RuleTriggered[] {
  const rules: RuleTriggered[] = [];

  if (current.isTor === true) {
    rules.push({
      rule: GEO_TOR_RULE,
      points: config.torPoints,
      detail: 'Inicio de sesión desde un nodo de salida de la red Tor.',
    });
  }

  if (current.country) {
    const knownCountries = new Set(previous.map((p) => p.country).filter(Boolean));
    // El primer inicio de sesión con país conocido no es "nuevo": no hay contra qué comparar.
    if (knownCountries.size > 0 && !knownCountries.has(current.country)) {
      rules.push({
        rule: GEO_NEW_COUNTRY_RULE,
        points: config.newCountryPoints,
        detail: `Inicio de sesión desde un país nuevo para el cliente (${current.country}).`,
      });
    }

    const last = previous.find((p) => p.country);
    if (last && last.country !== current.country) {
      const minutes = (current.occurredAt.getTime() - last.occurredAt.getTime()) / 60_000;
      if (minutes >= 0 && minutes < config.travelWindowMin) {
        rules.push({
          rule: GEO_IMPOSSIBLE_TRAVEL_RULE,
          points: config.impossibleTravelPoints,
          detail: `Viaje imposible: inicio de sesión desde ${last.country} y luego desde ${current.country} en ${Math.round(minutes)} min.`,
        });
      }
    }
  }

  return rules;
}
