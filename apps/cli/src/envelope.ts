import type { Envelope, EnvelopeError, VerbCall } from 'second_brain';
import { CONFIRM_ARG } from 'second_brain';

/**
 * The envelope, as the CLI prints it: Core's codec, reused whole, plus the one
 * thing only a command line can say.
 *
 * Nothing here re-implements the shape — the SDK, the daemon socket and this
 * surface all answer with Core's `Envelope`, and a second rendering of it is
 * how two of them come to disagree (AD-5). `retry_argv` is the exception that
 * proves the rule: `error.retry` is the call, and the argv that runs it is the
 * CLI's business and no other surface's.
 */
export {
  CONFIRM_ARG,
  errorEnvelope,
  isoWithOffset,
  okEnvelope,
  requireConfirmation,
} from 'second_brain';
export type {
  Envelope,
  EnvelopeError,
  EnvelopeMeta,
  Failure,
  VerbCall,
} from 'second_brain';

/** The flag that switches the agent-readable output on, on every command. */
export const JSON_FLAG = '--json';

/** The flag that carries `confirm: true` on a command line (Conventions). */
export const YES_FLAG = '--yes';

/** `error` of the envelope the CLI prints: Core's, plus the argv to run. */
export interface CliEnvelopeError extends EnvelopeError {
  /**
   * The whole command line that runs `error.retry`, so the caller has
   * something to show a person rather than a shape to re-render itself. Present
   * exactly when `retry` is.
   */
  retry_argv?: string[];
}

/** The envelope the CLI prints. */
export interface CliEnvelope<T> extends Envelope<T> {
  error?: CliEnvelopeError;
}

/**
 * The command line that runs one `VerbCall`.
 *
 * `positional` is the command's declared `arguments`, in commander's own
 * syntax, because which keys of `args` are positional and which are flags is
 * the registry's fact and not the envelope's: `<harness>` means the value goes
 * in bare, and everything else is `--kebab-case value`. `confirm` is the one
 * key with a name of its own on a command line, `--yes` (Conventions).
 *
 * `json` carries the caller's own output choice through, so an agent that was
 * reading envelopes keeps reading envelopes after the retry.
 */
export function retryArgv(
  retry: VerbCall,
  positional: readonly string[] = [],
  json = false,
): string[] {
  const argv = ['brain', retry.ns, retry.verb];

  // Positional first, in the order the command declared them: that is the only
  // order commander will accept them back in.
  const placed = new Set<string>();
  for (const declared of positional) {
    const name = argumentName(declared);
    const value = retry.args[name];
    if (value === undefined || value === null) continue;
    placed.add(name);
    for (const word of words(value)) argv.push(word);
  }

  for (const [key, value] of Object.entries(retry.args)) {
    if (placed.has(key)) continue;
    if (key === CONFIRM_ARG) {
      if (value === true) argv.push(YES_FLAG);
      continue;
    }
    // A flag nobody passed, or passed as false, is spelled by being absent.
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${kebabCase(key)}`;
    if (value === true) {
      argv.push(flag);
      continue;
    }
    // Repeated rather than joined: a value with a comma in it stays one value.
    for (const word of words(value)) argv.push(flag, word);
  }

  if (json) argv.push(JSON_FLAG);
  return argv;
}

/**
 * The name behind one declared argument: `<harness>` and `[harness]` are both
 * `harness`, `<names...>` is `names`, and a dashed name is the camelCase key
 * the rest of the CLI uses, as commander itself would spell it.
 */
export function argumentName(declared: string): string {
  const bare = declared.replace(/^[<[]/, '').replace(/[>\]]$/, '').replace(/\.\.\.$/, '');
  return bare.replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

/** `storePath` as `store-path`, which is how every flag of this CLI is spelled. */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

/** One value as the words it takes on a command line. */
function words(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}
