import { evaluateGeoRules, GeoRuleConfig } from './geo-rules';
import { ipHash, ipPrefix, isPrivateIp, normalizeIp } from './ip-privacy';

const config: GeoRuleConfig = { newCountryPoints: 20, impossibleTravelPoints: 30, torPoints: 40, travelWindowMin: 120 };
const at = (iso: string) => new Date(iso);
const rules = (r: { rule: string }[]) => r.map((x) => x.rule).sort();

describe('Reglas geográficas', () => {
  const now = at('2026-10-25T20:00:00Z');

  it('un inicio de sesión normal desde el país de siempre no activa nada', () => {
    const result = evaluateGeoRules(
      { country: 'CO', isTor: false, occurredAt: now },
      [
        { country: 'CO', occurredAt: at('2026-10-25T08:00:00Z') },
        { country: 'CO', occurredAt: at('2026-10-20T08:00:00Z') },
      ],
      config,
    );
    expect(result).toEqual([]);
  });

  it('país nuevo: no aparece en el historial del cliente', () => {
    const result = evaluateGeoRules(
      { country: 'US', isTor: false, occurredAt: now },
      [{ country: 'CO', occurredAt: at('2026-10-24T08:00:00Z') }],
      config,
    );
    expect(rules(result)).toEqual(['geo_new_country']);
    expect(result[0].points).toBe(20);
  });

  it('el primer inicio de sesión del cliente no cuenta como país nuevo', () => {
    expect(evaluateGeoRules({ country: 'US', isTor: false, occurredAt: now }, [], config)).toEqual([]);
  });

  it('viaje imposible: otro país hace menos de 120 min (119 sí, 121 no)', () => {
    const previous = (minutesAgo: number) => [
      { country: 'CO', occurredAt: new Date(now.getTime() - minutesAgo * 60_000) },
      { country: 'US', occurredAt: at('2026-09-01T00:00:00Z') },
    ];
    expect(rules(evaluateGeoRules({ country: 'US', isTor: false, occurredAt: now }, previous(119), config))).toEqual([
      'geo_impossible_travel',
    ]);
    expect(evaluateGeoRules({ country: 'US', isTor: false, occurredAt: now }, previous(121), config)).toEqual([]);
  });

  it('Tor: suma por sí sola; con país nuevo y viaje imposible llega a 90', () => {
    const result = evaluateGeoRules(
      { country: 'DE', isTor: true, occurredAt: now },
      [{ country: 'CO', occurredAt: new Date(now.getTime() - 30 * 60_000) }],
      config,
    );
    expect(rules(result)).toEqual(['geo_impossible_travel', 'geo_new_country', 'geo_tor']);
    expect(result.reduce((sum, r) => sum + r.points, 0)).toBe(90);
  });

  it('sin datos (base o lista de Tor no disponibles) no suma puntos', () => {
    const previous = [{ country: 'CO', occurredAt: new Date(now.getTime() - 10 * 60_000) }];
    expect(evaluateGeoRules({ country: null, isTor: null, occurredAt: now }, previous, config)).toEqual([]);
  });

  it('el detalle de las reglas nunca incluye la IP', () => {
    const result = evaluateGeoRules(
      { country: 'DE', isTor: true, occurredAt: now },
      [{ country: 'CO', occurredAt: new Date(now.getTime() - 30 * 60_000) }],
      config,
    );
    expect(JSON.stringify(result)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('Privacidad de la IP', () => {
  it('recorta a /24 en IPv4 y a /48 en IPv6', () => {
    expect(ipPrefix('190.60.37.10')).toBe('190.60.37.0/24');
    expect(ipPrefix('2800:e2:4a80:1234::7')).toBe('2800:00e2:4a80::/48');
  });

  it('la huella es estable con el mismo secreto, distinta con otro y no contiene la IP', () => {
    const secret = 'a'.repeat(64);
    expect(ipHash('190.60.37.10', secret)).toBe(ipHash('190.60.37.10', secret));
    expect(ipHash('190.60.37.10', secret)).not.toBe(ipHash('190.60.37.10', 'b'.repeat(64)));
    expect(ipHash('190.60.37.10', secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normaliza ::ffff: y reconoce redes privadas', () => {
    expect(normalizeIp('::ffff:190.60.37.10')).toBe('190.60.37.10');
    expect(normalizeIp('no-es-ip')).toBeNull();
    for (const ip of ['10.1.2.3', '172.18.0.4', '192.168.1.1', '127.0.0.1', '100.64.0.2', '::1', 'fd00::1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp('190.60.37.10')).toBe(false);
    expect(isPrivateIp('2800:e2:4a80::1')).toBe(false);
  });
});
