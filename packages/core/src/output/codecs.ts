import { errorEnvelope, okEnvelope } from '../envelope.js';
import type { Clock } from '../ports/clock.js';
import { maskOutputText, maskOutputValue } from './mask.js';

/**
 * Every way text leaves Brain, in one registry (AD-11, change D1).
 *
 * The rule the registry exists for is "no path out without masking". It is
 * not a rule a reviewer can keep: a surface is a few lines in a command, and
 * the thirtieth command is written by somebody who never read this file. So
 * the paths are listed here, the contract test walks the list, and a new way
 * out that nobody registered is a failing test rather than a leak
 * (`apps/cli/test/output-codecs.test.ts`).
 *
 * Three are here. The mirror renderer, the export writer, the replica payload
 * and the embedding request are registered by the epics that build them.
 */

/** One way out, and how to make it produce something a test can read. */
export interface OutputCodec {
  /** Stable name. The sink table of the contract test names these. */
  name: string;
  /**
   * The probe, through this codec's real functions, as one string. Whatever a
   * secret would look like coming out of this path, it looks like that here.
   */
  render: (probe: OutputProbe) => string;
}

/**
 * The sample one `render` is handed: the texts of a stored session.
 *
 * `texts` holds the message bodies as they are stored and the tool note
 * targets already through `toolNoteForOutput` — which is the order a read does
 * it in, because the shell rule runs over that column alone (Decision
 * 2026-10-19).
 */
export interface OutputProbe {
  texts: readonly string[];
}

/** A fixed instant, so a codec's output is a function of the probe alone. */
const probeClock: Clock = {
  now: () => new Date('2026-01-02T03:04:05.000Z'),
};

/**
 * A hook's one line of JSON on stdout, masked value by value.
 *
 * Nothing calls it yet. The start-context injection of epic 3 is what writes
 * this line, and it is here now so that story finds the path already covered
 * by the registry rather than having to remember it.
 */
export function encodeHookOutput(output: unknown): string {
  return JSON.stringify(maskOutputValue(output));
}

/** One line of a hook's stderr — the only thing a hook may say (AD-6). */
export function encodeHookLine(text: string): string {
  return maskOutputText(text);
}

/** One line of ordinary human-readable stdout or stderr. */
export function encodeTextLine(line: string): string {
  return maskOutputText(line);
}

export const OUTPUT_CODECS: readonly OutputCodec[] = [
  {
    // Every surface that answers with an envelope: `brain … --json`, the
    // daemon socket, the MCP server. It is masked where it is *built* and not
    // where it is written, which is what makes a new command covered by
    // existing — `okEnvelope` and `errorEnvelope` are the one point all three
    // share. Masking the finished JSON string instead would run the patterns
    // over escape sequences and key names, which is a different text than the
    // one anybody reads.
    name: 'envelope',
    render: (probe) => {
      const ok = okEnvelope(
        probeClock,
        { texts: [...probe.texts] },
        [],
        { hint: probe.texts.join(' ') },
      );
      // The failure half too, `retry.args` included: that is where a caller's
      // own input comes back out, and it is the one part of an envelope that
      // is made of what somebody typed.
      const failed = errorEnvelope(probeClock, {
        code: 'INVALID_ARGUMENT',
        message: probe.texts.join(' '),
        hint: probe.texts.join(' '),
        retry: { ns: 'sessions', verb: 'ingest', args: { note: probe.texts.join(' ') } },
      });
      return `${JSON.stringify(ok)}\n${JSON.stringify(failed)}`;
    },
  },
  {
    name: 'hook',
    render: (probe) =>
      [
        encodeHookOutput({ systemMessage: probe.texts.join('\n') }),
        ...probe.texts.map((text) => encodeHookLine(text)),
      ].join('\n'),
  },
  {
    name: 'text',
    render: (probe) => probe.texts.map((text) => encodeTextLine(text)).join('\n'),
  },
];
