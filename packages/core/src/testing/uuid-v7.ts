/** Canonical UUIDv7: version nibble 7, variant bits 10, lowercase hex. */
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Does this string look like a UUIDv7 (AD-8)? */
export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
