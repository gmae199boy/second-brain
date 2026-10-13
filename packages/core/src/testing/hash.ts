/**
 * FNV-1a over the UTF-16 code units, as 8 lowercase hex characters. It is here
 * because the in-memory fakes need a stable fingerprint and Core may not reach
 * for `node:crypto` (AD-1). It is a test helper, not a security primitive.
 */
export function smallHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
