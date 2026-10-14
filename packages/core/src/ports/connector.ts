import type { Parser } from './parser.js';

/**
 * The mark every entry Brain writes into a harness's own configuration carries,
 * and the only thing "is it already connected?" is ever decided by (AD-19). A
 * connector puts it in a field it owns — a name, a label, a comment of its own
 * line — never by searching the file's free text, and it touches no entry that
 * does not carry it: everything else in that file is the user's.
 */
export const BRAIN_MARKER = 'second-brain';

/** What `connect` is given. The shim is the only thing a hook ever calls. */
export interface ConnectInput {
  /**
   * Absolute path of the shim the installer wrote (`<home>/bin/brain`). It
   * carries the node path and the configuration folder of this install, so a
   * hook started with none of the user's shell environment still finds both
   * (AD-19).
   */
  shimPath: string;
}

/**
 * What one `connect` did. `changed` is false when the harness already held
 * exactly this entry, which is what makes re-running the installer free.
 */
export type ConnectResult =
  | {
      ok: true;
      /** The file the entry lives in, for the line the command prints. */
      target: string;
      /** False when nothing had to be written. */
      changed: boolean;
    }
  | {
      ok: false;
      /** SCREAMING_SNAKE, as everywhere else. The connector names its own. */
      code: string;
      message: string;
    };

/**
 * One harness, as the installer and `brain setup connect` see it. The parser is
 * the required half (AD-4); `connect` is the one place a harness's own
 * configuration is ever written (AD-19), so neither the installer nor the
 * command knows the shape of any harness file.
 */
export interface Connector {
  /**
   * Neutral harness name, and the word the user types after
   * `brain setup connect`. Always the parser's, so one harness cannot answer to
   * two names (AD-8).
   */
  readonly harness: string;
  /** What to call this harness in a question or a line of output. */
  readonly label: string;
  readonly parser: Parser;
  /** Whether this harness is installed on this machine. Never writes. */
  detect(): Promise<boolean>;
  /**
   * Register the shim with this harness, idempotently: the entry carries
   * `BRAIN_MARKER`, an entry that already says the same thing is left alone,
   * and nothing without the marker is touched.
   */
  connect(input: ConnectInput): Promise<ConnectResult>;
}
