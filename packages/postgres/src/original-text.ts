/** 원문 TEXT 쌍을 복원하고 디코딩할 수 없는 바이트는 명시적으로 보존한다. */
export function datasetRef(value: string): string {
  if (!value.includes('\0') && !value.startsWith('~dataset1:')) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64url');
  return '~dataset1:' + encoded + '='.repeat((4 - encoded.length % 4) % 4);
}
export function projectText(value: string | null): [string | null, Buffer | null, string | null] {
  if (value === null) return [null, null, null];
  const bytes = Buffer.from(value, 'utf8');
  if (new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes) !== value) throw Error('IMPORT_INVALID');
  return value.includes('\0') ? [value.replaceAll('\0','�'), bytes, 'utf-8'] : [value, null, null];
}
export function originalText(display: unknown, raw: unknown, encoding: unknown): unknown {
  if (raw == null) {
    if (encoding != null || (display != null && (typeof display !== 'string' || display.includes('\0')))) throw Error('IMPORT_INVALID');
    return display;
  }
  if (!Buffer.isBuffer(raw) || typeof display !== 'string' || !['utf-8', 'utf-16le', 'utf-16be'].includes(String(encoding))) throw Error('IMPORT_INVALID');
  const label = String(encoding);
  const rendered = new TextDecoder(label, { fatal: false, ignoreBOM: true }).decode(raw).replaceAll('\0', '�');
  if (rendered !== display) throw Error('IMPORT_INVALID');
  try { return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { return { type: 'invalid-text', encoding: label, base64: raw.toString('base64') }; }
}

export function originalJson(display: unknown, raw: unknown, encoding: unknown): unknown {
  if (raw == null) { if (encoding != null) throw Error('IMPORT_INVALID'); return display; }
  if (!Buffer.isBuffer(raw) || !['utf-8', 'utf-16le', 'utf-16be'].includes(String(encoding))) throw Error('IMPORT_INVALID');
  let decoded: string;
  try { decoded = new TextDecoder(String(encoding), { fatal: true, ignoreBOM: true }).decode(raw); }
  catch {
    if (JSON.stringify(display) !== '{}') throw Error('IMPORT_INVALID');
    return { type: 'invalid-text', encoding: String(encoding), base64: raw.toString('base64') };
  }
  let value: unknown;
  try { value = JSON.parse(decoded); } catch { value = undefined; }
  if (value === null || typeof value !== 'object') {
    if (JSON.stringify(display) !== '{}') throw Error('IMPORT_INVALID');
    return { type: 'invalid-json', text: decoded };
  }
  const unsafeString = (s: string): boolean => s.includes('\0') || !s.isWellFormed();
  const containsNul = (x: unknown): boolean => typeof x === 'string' ? unsafeString(x) : Array.isArray(x) ? x.some(containsNul) : x !== null && typeof x === 'object' ? Object.entries(x).some(([k, v]) => unsafeString(k) || containsNul(v)) : false;
  const stable = (x: unknown): string => JSON.stringify(x, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
  const expected = containsNul(value) ? (Array.isArray(value) ? [] : {}) : value;
  if (stable(expected) !== stable(display)) throw Error('IMPORT_INVALID');
  return value;
}
