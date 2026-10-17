import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import type { InstallFlags, InstallReport } from '../install/flow.js';

/**
 * `brain setup run`: the installer, as a command. Standalone, for the same
 * reason the installer lives outside the dispatcher — it is what writes the
 * configuration, so a dispatcher that read the configuration first would answer
 * `CONFIG_MISSING` to the one command that fixes that.
 *
 * It is the same flow, in the same order, on the same flags as the installer
 * (AD-19): a re-configuration that differed from an install would be two
 * installers to keep in step.
 *
 * The flow answers with a value — the report, or the failure, and the warnings
 * either way — so this command translates and nothing more (AD-5). It used to
 * read the flow's own log lines backwards to find out what had happened, which
 * is how a run that exited 1 came back as `ok: true` (F6).
 */

/** The install's structured report. The shape is `InstallReport`. */
export type SetupRunData = InstallReport;

export const setupRun: CommandSpec<SetupRunData> = {
  ns: 'setup',
  verb: 'run',
  nsDescription: '설치하고, 다시 설정하고, 하네스를 연결합니다',
  usedFor: '이미 있는 것을 지키면서 설치기를 다시 실행합니다',
  required: [],
  examples: [
    'brain setup run',
    'brain setup run --yes',
    'brain setup run --store-path /Volumes/notes/brain.db --yes',
  ],
  output:
    '설치 보고: `home`, `config_path`, `store`, `owner`, `files`, `mirror_path`, `shim`, `harnesses`, `checks`, `summary`, `update`, `installed`',
  risk: 'write',
  hook: false,
  dryRun: false,
  standalone: true,
  options: [
    { flags: '--store-path <path>', description: '데이터베이스 파일의 절대 경로' },
    { flags: '--mirror-path <path>', description: '미러 폴더의 절대 경로' },
    {
      flags: '--plugin-root <path>',
      description: '이 설치를 시작한 플러그인 폴더의 절대 경로',
    },
    { flags: '--connect <harness...>', description: '이 하네스들을 이름으로 연결합니다' },
    { flags: '-y, --yes', description: '설치가 해야 할 일에 미리 동의합니다' },
  ],

  async run(context: StandaloneCommandContext) {
    const json = context.options['json'] === true;

    // In text mode the lines go out as they happen: this flow asks questions
    // and then migrates, and output the dispatcher printed at the end would
    // arrive after the questions it belongs to. Under `--json` the result is
    // the envelope's `data` and nothing is printed at all.
    const log = (line: string): void => {
      if (!json) process.stdout.write(`${line}\n`);
    };

    // Imported here, not at the top: the installer's own graph is the terminal
    // prompt library, the migration runner and a module that checks whether
    // node was pointed at it, and every other command — a hook on a harness
    // turn above all — would otherwise load all of it to not use it (AD-3, AD-6).
    const { runInstallerWithFlags, systemInstallDeps } = await import('../install.js');

    const deps = systemInstallDeps();
    const result = await runInstallerWithFlags(toFlags(context.options), context.env, {
      ...deps,
      log,
      // `--json` means nobody is watching, so nothing may be asked (AD-19).
      isTTY: json ? false : deps.isTTY,
    });

    // The failure, whole, including the `retry` the consent gate built: the
    // dispatcher fills the exit code, the retryability and the hint in from the
    // code table and renders `retry_argv` (Conventions).
    if (!result.ok) {
      return { ok: false as const, ...result.failure, warnings: result.warnings };
    }
    return {
      ok: true as const,
      data: result.report,
      warnings: result.warnings,
      // Already printed above in text mode; handing them over as well would
      // print every line twice.
      text: [],
    };
  },
};

/** Commander's options, as the flags the flow takes. */
function toFlags(options: Record<string, unknown>): InstallFlags {
  const connect = options['connect'];
  return {
    storePath: typeof options['storePath'] === 'string' ? options['storePath'] : undefined,
    mirrorPath: typeof options['mirrorPath'] === 'string' ? options['mirrorPath'] : undefined,
    pluginRoot: typeof options['pluginRoot'] === 'string' ? options['pluginRoot'] : undefined,
    connect: Array.isArray(connect)
      ? connect.filter((name): name is string => typeof name === 'string')
      : [],
    yes: options['yes'] === true,
    // `brain setup run --help` is commander's own; it never reaches the flow.
    help: false,
  };
}
