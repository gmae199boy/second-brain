/**
 * The one shape an instant takes once it leaves memory (AD-13). SQLite has no
 * date type, so every stored instant is text, and text only agrees with itself
 * when there is exactly one spelling of it: UTC, milliseconds always present,
 * `Z` always the zone. Anything else — a `+09:00` offset, a bare date, a
 * second-precision stamp — sorts and compares wrong against the rest, so the
 * codec refuses it at the boundary rather than letting it in and losing later.
 *
 * Both directions are values, never exceptions: a store that meets a bad row
 * has to report it, and `parseInstant` runs on data a human may have edited.
 */

/** The canonical form, and the only one `parseInstant` accepts. */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The one code either direction of the codec can fail with. */
export type InstantFailure = {
  ok: false;
  code: 'INVALID_INSTANT';
  message: string;
};

export type FormatInstantResult = { ok: true; value: string } | InstantFailure;

export type ParseInstantResult = { ok: true; value: Date } | InstantFailure;

/**
 * The canonical text for an instant. An `Invalid Date` fails, and so does a
 * year outside four digits: `toISOString` spells those `+275760-09-13T…`, which
 * is 27 characters and would not round-trip through a column other code sorts
 * on.
 */
export function formatInstant(instant: Date): FormatInstantResult {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return {
      ok: false,
      code: 'INVALID_INSTANT',
      message: 'an instant must be a valid Date',
    };
  }

  const value = instant.toISOString();
  if (!INSTANT_PATTERN.test(value)) {
    return {
      ok: false,
      code: 'INVALID_INSTANT',
      message: `${value} is not a canonical instant: expected YYYY-MM-DDTHH:MM:SS.mmmZ`,
    };
  }
  return { ok: true, value };
}

/**
 * The instant a canonical string names. The round-trip check is the real test:
 * the pattern alone would accept `2026-13-45T00:00:00.000Z`, which `Date` is
 * happy to roll over into another day.
 */
export function parseInstant(text: string): ParseInstantResult {
  if (typeof text !== 'string' || !INSTANT_PATTERN.test(text)) {
    return {
      ok: false,
      code: 'INVALID_INSTANT',
      message: `${describe(text)} is not a canonical instant: expected YYYY-MM-DDTHH:MM:SS.mmmZ`,
    };
  }

  const value = new Date(text);
  if (Number.isNaN(value.getTime()) || value.toISOString() !== text) {
    return {
      ok: false,
      code: 'INVALID_INSTANT',
      message: `${text} is not a real instant`,
    };
  }
  return { ok: true, value };
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
