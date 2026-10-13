/**
 * The warning codes of the Conventions table, in one place so every surface
 * uses the same vocabulary and the compiler rejects an invented code. A
 * degraded-but-successful result must carry one of these in `warnings[]`; there
 * is no silent failure (NFR-2).
 *
 * Core owns the list because both the SDK and the CLI envelope speak it, and
 * because a code that no one can spell twice is the same as no code at all.
 */
export const WARNING_CODES = [
  /** A write went to the spool instead of the database (epic 2). */
  'SPOOLED',
  /** The database could not be reached. */
  'DB_UNAVAILABLE',
  /** The stored schema version differs from the one this code expects (AD-20). */
  'SCHEMA_MISMATCH',
  /** Reranking was asked for and failed; the unreranked order stands. */
  'RERANK_FAILED',
  /** The rows were built with another index config than the one in use. */
  'INDEX_CONFIG_MISMATCH',
  /** Part of the searched material has no embedding yet. */
  'UNINDEXED',
  /** The result was cut to fit a size limit. */
  'RESULT_TRUNCATED',
  /** A rule was included without being verified. */
  'RULE_UNVERIFIED',
  /** The parser read a transcript from the start because the cursor was lost. */
  'CURSOR_RESET',
  /**
   * The configuration file holds a key this version does not know. It is never
   * dropped in silence: the command runs and says which key it ignored (AD-18).
   */
  'CONFIG_UNKNOWN_KEY',
] as const;

/** One of the codes above. The only thing `warnings[]` may contain. */
export type WarningCode = (typeof WARNING_CODES)[number];

const KNOWN = new Set<string>(WARNING_CODES);

/**
 * Narrow a string that came from outside — a store's own warning, a check code,
 * a parsed envelope — to a warning code.
 */
export function isWarningCode(value: string): value is WarningCode {
  return KNOWN.has(value);
}
