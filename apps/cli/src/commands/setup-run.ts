import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
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
  nsDescription: 'install, re-configure and connect harnesses',
  description: 'run the installer again, keeping what is already there',
  standalone: true,
  options: [
    { flags: '--database-url <url>', description: 'use this Postgres instead of asking' },
    { flags: '--docker', description: 'make a local Postgres container instead of asking' },
    { flags: '--mirror-path <path>', description: 'absolute path for the mirror folder' },
    { flags: '--connect <harness...>', description: 'connect these harnesses, by name' },
    { flags: '-y, --yes', description: 'agree in advance to what the chosen path has to do' },
  ],

  async run(context: StandaloneCommandContext) {
    const json = context.options['json'] === true;
    const lines: string[] = [];

    // In text mode the lines go out as they happen: this flow asks questions
    // and waits on Docker, and output the dispatcher printed at the end would
    // arrive after the questions it belongs to. Under `--json` they are the
    // envelope's data instead and nothing is printed early.
    const log = (line: string): void => {
      lines.push(line);
      if (!json) process.stdout.write(`${line}\n`);
    };

    // Imported here, not at the top: the installer's own graph is the terminal
    // prompt library and a module that checks whether node was pointed at it,
    // and every other command — a hook on a harness turn above all — would
    // otherwise load all of it to not use it (AD-3, AD-6).
    const { runInstallerWithFlags, systemInstallDeps } = await import('../install.js');

    const deps = systemInstallDeps();
    const exit = await runInstallerWithFlags(toFlags(context.options), context.env, {
      ...deps,
      log,
      // `--json` means nobody is watching, so nothing may be asked (AD-19).
      isTTY: json ? false : deps.isTTY,
    });

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
 * mirror path, keeps its own code: calling that a `USAGE` would tell the caller
 * the command was invoked wrongly when the value was the problem.
 */
function reason(lines: readonly string[]): { code: string; message: string } {
  const said = [...lines].reverse().find((line) => line !== '' && !line.startsWith(' '));
  if (said === undefined) return { code: 'USAGE', message: 'the installer could not run' };
  const coded = CODED_LINE.exec(said);
  if (coded?.[1] === undefined || coded[2] === undefined) {
    return { code: 'USAGE', message: said };
  }
  return { code: coded[1], message: coded[2] };
}

/** Commander's options, as the flags the flow takes. */
function toFlags(options: Record<string, unknown>): InstallFlags {
  const connect = options['connect'];
  return {
    databaseUrl: typeof options['databaseUrl'] === 'string' ? options['databaseUrl'] : undefined,
    docker: options['docker'] === true,
    mirrorPath: typeof options['mirrorPath'] === 'string' ? options['mirrorPath'] : undefined,
    connect: Array.isArray(connect)
      ? connect.filter((name): name is string => typeof name === 'string')
      : [],
    yes: options['yes'] === true,
    // `brain setup run --help` is commander's own; it never reaches the flow.
    help: false,
  };
}
