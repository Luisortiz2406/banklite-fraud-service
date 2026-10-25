import { gunzipSync } from 'zlib';

/**
 * Saca el archivo .mmdb de un .tar.gz de MaxMind (GeoLite2-Country_AAAAMMDD/
 * GeoLite2-Country.mmdb). Lector de tar mínimo (cabeceras de 512 bytes,
 * formato ustar), para no agregar otra dependencia.
 */
export function extractMmdb(tarGz: Buffer): Buffer {
  const tar = gunzipSync(tarGz);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // fin del archivo
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const start = offset + 512;
    if ((type === '0' || type === '') && fullName.endsWith('.mmdb')) {
      return Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('El archivo descargado no contiene una base .mmdb.');
}
