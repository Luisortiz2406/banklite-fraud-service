import { createHmac } from 'crypto';
import { isIP } from 'net';

/**
 * Lo único que se guarda de una IP: su red recortada (/24 en IPv4, /48 en IPv6)
 * y una huella HMAC-SHA256 con FRAUD_IP_HASH_SECRET, que sirve para comparar
 * "misma IP" pero no para recuperarla. La IP completa solo vive en memoria.
 */

/** Expande una IPv6 a sus 8 grupos de 4 dígitos. */
function expandIpv6(ip: string): string[] {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((g) => g.padStart(4, '0'));
}

/** Quita el prefijo IPv4-mapeado (::ffff:1.2.3.4) y valida. null si no es una IP. */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

/** Red recortada: /24 en IPv4 y /48 en IPv6. */
export function ipPrefix(ip: string): string {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  return `${expandIpv6(ip).slice(0, 3).join(':')}::/48`;
}

/** Huella irreversible de la IP (HMAC-SHA256 en hex). */
export function ipHash(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/** Redes privadas, locales o reservadas: no tienen país (p. ej. el docker-compose local). */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const first = expandIpv6(ip)[0];
  return ip === '::1' || ip === '::' || /^f[cd]/.test(first) || /^fe[89ab]/.test(first);
}
