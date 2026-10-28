/** PostgreSQL text excludes U+0000; keep original UTF-8 beside its searchable text. */
export function pgText(value: string | null): { text: string | null; raw: Buffer | null } {
  return value?.includes('\u0000')
    ? { text: value.replaceAll('\u0000', '\ufffd'), raw: Buffer.from(value, 'utf8') }
    : { text: value, raw: null };
}

/** Decode paired columns before comparing identities or returning port values. */
export function originalText<T>(row: T): T {
  const decoded = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(decoded)) {
    if (key.endsWith('_raw') && Buffer.isBuffer(value)) {
      decoded[key.slice(0, -4)] = value.toString('utf8');
    }
  }
  return decoded as T;
}
