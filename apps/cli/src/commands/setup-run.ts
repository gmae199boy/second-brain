import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { requireConfirmation } from '../envelope.js';
import type { InstallFlags } from '../install/flow.js';

/**
 * `brain setup run`: the installer, as a command. Standalone, for the same
 * reason the installer lives outside the dispatcher — it is what writes the
 * configuration, so a dispatcher that read the configuration first would answer
 * `CONFIG_MISSING` to the one command that fixes that.
 *
 * It is the same flow, in the same order, on the same flags as the installer
 * (AD-19): a re-configuration that differed from an install would be two
 * installers to keep in step.
 */

export interface SetupRunData {
  /** Every line the flow printed, so `--json` loses nothing. */
  lines: string[];
}

export const setupRun: CommandSpec<SetupRunData> = {
  ns: 'setup',
  verb: 'run',
  nsDescription: '설치하고, 다시 설정하고, 하네스를 연결합니다',
  description: '이미 있는 것을 지키면서 설치기를 다시 실행합니다',
  standalone: true,
  options: [
    { flags: '--store-path <path>', description: '데이터베이스 파일의 절대 경로' },
    { flags: '--mirror-path <path>', description: '미러 폴더의 절대 경로' },
    { flags: '--connect <harness...>', description: '이 하네스들을 이름으로 연결합니다' },
    { flags: '-y, --yes', description: '설치가 해야 할 일에 미리 동의합니다' },
  ],

  async run(context: StandaloneCommandContext) {
    const json = context.options['json'] === true;
    const lines: string[] = [];

    // In text mode the lines go out as they happen: this flow asks questions
    // and then migrates, and output the dispatcher printed at the end would
    // arrive after the questions it belongs to. Under `--json` they are the
    // envelope's data instead and nothing is printed early.
    const log = (line: string): void => {
      lines.push(line);
      if (!json) process.stdout.write(`${line}\n`);
    };

    // Imported here, not at the top: the installer's own graph is the terminal
    // prompt library, the migration runner and a module that checks whether
    // node was pointed at it, and every other command — a hook on a harness
    // turn above all — would otherwise load all of it to not use it (AD-3, AD-6).
    const { runInstallerWithFlags, systemInstallDeps } = await import('../install.js');

    const deps = systemInstallDeps();
    const exit = await runInstallerWithFlags(toFlags(context.options), context.env, {
      ...deps,
      log,
      // `--json` means nobody is watching, so nothing may be asked (AD-19).
      isTTY: json ? false : deps.isTTY,
    });

    // Exit 3 is "somebody has to agree to this first", which is a question for
    // the person and not a mistake of the caller's. The gate is Core's, so the
    // shape of the answer — above all `retry`, the same call with the consent
    // added — is the one every gated verb will use (Conventions).
    if (exit === 3) {
      const message = consentMessage(lines);
      const gate = requireConfirmation(
        { ns: 'setup', verb: 'run', args: givenArgs(context.options) },
        message,
      );
      // The flow answers 3 only where nothing gave consent, so the gate is
      // closed; the fallback is there so a later change cannot turn a 3 into a
      // silent success.
      return { ok: false as const, ...(gate ?? { code: 'CONFIRMATION_REQUIRED', message }) };
    }

    // Exit 2 is "could not run at all", which is an error envelope and not a
    // result: the flow's own last line says which flag was missing.
    if (exit === 2) {
      const said = reason(lines);
      return { ok: false as const, code: said.code, message: said.message, exit: 2 as const };
    }
    return {
      ok: true as const,
      data: { lines },
      // Already printed above in text mode; handing them over as well would
      // print every line twice.
      text: [],
      failed: exit === 1,
    };
  },
};

/** A line the flow wrote as `CODE: the rest of it`. */
const CODED_LINE = /^([A-Z][A-Z0-9_]*): (.+)$/;

/**
 * Why the flow could not run, as a code and one line, for the error envelope.
 * The last line the flow printed is often an indented continuation of the one
 * that said what was wrong — the flag list under "say what to do with flags" —
 * so the last line that starts a sentence is the one worth carrying.
 *
 * A reason the flow already named, such as `CONFIG_INVALID: …` for a relative
 * store or mirror path, keeps its own code: calling that a `USAGE` would tell
 * the caller the command was invoked wrongly when the value was the problem.
 */
function reason(lines: readonly string[]): { code: string; message: string } {
  const said = [...lines].reverse().find((line) => line !== '' && !line.startsWith(' '));
  if (said === undefined) return { code: 'USAGE', message: '설치기를 실행할 수 없었습니다' };
  const coded = CODED_LINE.exec(said);
  if (coded?.[1] === undefined || coded[2] === undefined) {
    return { code: 'USAGE', message: said };
  }
  return { code: coded[1], message: coded[2] };
}

/**
 * What the flow said about the consent it needs, as one line for the envelope.
 * It is the flow's own sentence rather than a second one written here: the two
 * would drift, and the flow is what knows why it could ask nothing. The
 * trailing colon goes — it introduced the flag list, which `hint` and
 * `retry_argv` now carry instead.
 */
function consentMessage(lines: readonly string[]): string {
  return reason(lines).message.replace(/:$/, '');
}

/**
 * The arguments the user actually gave, as `error.retry` carries them: not the
 * defaults the flow would fall back to, not `--json`, and not `--yes` — the
 * consent travels as `confirm`, which is the one name it has on every surface
 * (Conventions). So a retry asks for this very install, not a wider one.
 */
function givenArgs(options: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const storePath = options['storePath'];
  if (typeof storePath === 'string') args['storePath'] = storePath;
  const mirrorPath = options['mirrorPath'];
  if (typeof mirrorPath === 'string') args['mirrorPath'] = mirrorPath;
  const connect = options['connect'];
  if (Array.isArray(connect)) {
    const named = connect.filter((name): name is string => typeof name === 'string');
    if (named.length > 0) args['connect'] = named;
  }
  return args;
}

/** Commander's options, as the flags the flow takes. */
function toFlags(options: Record<string, unknown>): InstallFlags {
  const connect = options['connect'];
  return {
    storePath: typeof options['storePath'] === 'string' ? options['storePath'] : undefined,
    mirrorPath: typeof options['mirrorPath'] === 'string' ? options['mirrorPath'] : undefined,
    connect: Array.isArray(connect)
      ? connect.filter((name): name is string => typeof name === 'string')
      : [],
    yes: options['yes'] === true,
    // `brain setup run --help` is commander's own; it never reaches the flow.
    help: false,
  };
}
