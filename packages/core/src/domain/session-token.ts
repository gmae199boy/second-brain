/**
 * The session key a harness gives us. Inside Brain a session also has a UUIDv7
 * `id`, but that id never crosses a process boundary (AD-8).
 */
export interface SessionKey {
  /** Neutral harness name, e.g. the connector's own `harness` (AD-4). */
  harness: string;
  harnessSessionId: string;
}

/**
 * `harness:harness_session_id`. The only session identifier that travels
 * between processes (AD-8): hook environment variables, `--session`, search
 * results, mirror file names.
 */
export type SessionToken = string;

/** Separator of the two halves of a session token. */
export const SESSION_TOKEN_SEPARATOR = ':';

/** Parsing a token back into its key. A malformed token fails as a value. */
export type ParseSessionTokenResult =
  | { ok: true; key: SessionKey }
  | { ok: false; code: 'SESSION_TOKEN_INVALID'; message: string };

/**
 * Build the token for a key. A harness name that is empty or carries the
 * separator cannot round-trip, which is a bug in the connector, not an expected
 * failure, so this throws (Conventions).
 */
export function formatSessionToken(key: SessionKey): SessionToken {
  if (key.harness === '') {
    throw new TypeError('a session key needs a harness name');
  }
  if (key.harness.includes(SESSION_TOKEN_SEPARATOR)) {
    throw new TypeError(
      `a harness name cannot contain "${SESSION_TOKEN_SEPARATOR}": ${key.harness}`,
    );
  }
  if (key.harnessSessionId === '') {
    throw new TypeError('a session key needs a harness session id');
  }
  return `${key.harness}${SESSION_TOKEN_SEPARATOR}${key.harnessSessionId}`;
}

/**
 * Read a token that came from outside this process. The harness name is the
 * part before the first separator; everything after it is the harness session
 * id, so an id that carries separators survives the round trip.
 */
export function parseSessionToken(token: string): ParseSessionTokenResult {
  const cut = token.indexOf(SESSION_TOKEN_SEPARATOR);
  if (cut < 0) {
    return {
      ok: false,
      code: 'SESSION_TOKEN_INVALID',
      message: `세션 토큰은 "harness${SESSION_TOKEN_SEPARATOR}id" 모양이어야 합니다. 받은 값: ${token}`,
    };
  }
  const harness = token.slice(0, cut);
  const harnessSessionId = token.slice(cut + SESSION_TOKEN_SEPARATOR.length);
  if (harness === '' || harnessSessionId === '') {
    return {
      ok: false,
      code: 'SESSION_TOKEN_INVALID',
      message: `세션 토큰의 두 쪽 모두 값이 있어야 합니다. 받은 값: ${token}`,
    };
  }
  return { ok: true, key: { harness, harnessSessionId } };
}
