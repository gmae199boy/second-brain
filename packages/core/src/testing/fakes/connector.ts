import {
  BRAIN_MARKER,
  type ConnectInput,
  type ConnectResult,
  type Connector,
} from '../../ports/connector.js';
import { memoryParser } from './parser.js';

export interface MemoryConnectorOptions {
  /** Neutral harness name. Defaults to `demo`. */
  harness?: string;
  /** What to call it in a question. Defaults to the harness name. */
  label?: string;
  /** What `detect()` answers. Defaults to true. */
  detected?: boolean;
  /** The file the entries pretend to live in. */
  target?: string;
  /** Make `connect` fail as a value instead of writing. */
  failure?: { code: string; message: string };
}

export interface MemoryConnector extends Connector {
  /** Every entry of the target, in the order the harness holds them. */
  entries(): readonly string[];
  /** Entries Brain wrote, which is the only thing `connect` may ever touch. */
  marked(): readonly string[];
  /** Put an entry nobody from Brain wrote into the target. */
  addForeignEntry(entry: string): void;
}

/**
 * A connector over an in-memory target: the harness file is an array of entry
 * lines, and a Brain entry is one that carries `BRAIN_MARKER`. It exists so the
 * connector contract can run with no harness, no filesystem and no Node API in
 * Core (AD-1), and so the CLI's `setup connect` can be driven from a test
 * without the real Claude Code on the machine (epic 2 brings that one).
 */
export function memoryConnector(options: MemoryConnectorOptions = {}): MemoryConnector {
  const { harness = 'demo', detected = true, target = `/memory/${harness}/settings.json` } =
    options;
  const label = options.label ?? harness;
  const entries: string[] = [];

  /** The one line this connector would write for a given shim. */
  const entryFor = (shimPath: string): string => `${BRAIN_MARKER} hook -> ${shimPath}`;
  const isMarked = (entry: string): boolean => entry.includes(BRAIN_MARKER);

  return {
    harness,
    label,
    parser: memoryParser({ harness }),

    async detect(): Promise<boolean> {
      return detected;
    },

    async connect(input: ConnectInput): Promise<ConnectResult> {
      if (options.failure !== undefined) {
        return { ok: false, code: options.failure.code, message: options.failure.message };
      }

      const wanted = entryFor(input.shimPath);
      const index = entries.findIndex(isMarked);
      // An entry that already says the same thing is left exactly as it is, so
      // a second connect writes nothing at all. One that says something else —
      // another node path, another home — is replaced rather than added beside,
      // or the harness would end up calling two brains.
      if (index === -1) {
        entries.push(wanted);
        return { ok: true, target, changed: true };
      }
      if (entries[index] === wanted) return { ok: true, target, changed: false };
      entries[index] = wanted;
      return { ok: true, target, changed: true };
    },

    entries: () => [...entries],
    marked: () => entries.filter(isMarked),
    addForeignEntry: (entry: string): void => {
      entries.push(entry);
    },
  };
}
