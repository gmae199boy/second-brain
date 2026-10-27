import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { configHome } from '../config/paths.js';
import { runDaemon } from '../daemon/run.js';
import { uuidV7IdGen } from '../runtime/id-gen.js';

/**
 * `brain daemon run`: stay, and work the backlog over and over (AD-25).
 *
 * It is the one command of this build that is a process rather than a call.
 * Everything else answers and exits; this one takes `<home>/run/daemon.pid`,
 * keeps `<home>/run/heartbeat` fresh, writes `<home>/log/daemon.log`, and
 * drains until a `SIGTERM` arrives. launchd registration is story 9.2's; for
 * now a person or a test starts it.
 *
 * `envelope: false`, so the dispatcher writes nothing at all to stdout — under
 * `--json` as much as without it. A caller that waited for an envelope from a
 * process designed never to return would wait for ever, and a `--json` reader
 * handed one at the end would be handed it a week late.
 *
 * `standalone: true`, which is the design note of this story: the dispatcher's
 * database path opens one store for the length of a command and sees the write
 * guard once. A resident process has to open a store and look at the schema
 * again every round — after a repair, after a migration — so it reads the
 * configuration and assembles itself, and only the assembly is shared with the
 * dispatcher (`assembly.ts`).
 *
 * The signal handlers live here and not in `runDaemon`, because signals belong
 * to the process: a module that attached its own could not be run twice from
 * one test, and `runDaemon` takes an `AbortSignal` instead.
 */

/** Nothing. There is no envelope to carry a result in (`envelope: false`). */
export type DaemonRunData = null;

export const daemonRunCommand: CommandSpec<DaemonRunData> = {
  ns: 'daemon',
  verb: 'run',
  nsDescription: '상주하면서 밀린 일을 처리합니다',
  usedFor: '상주하면서 밀린 일감을 되풀이해 처리합니다. 멈추려면 SIGTERM을 보내세요',
  required: [],
  examples: ['brain daemon run'],
  output:
    '아무것도 내지 않습니다 — 상태는 `run/daemon.pid`·`run/heartbeat`, 기록은 `log/daemon.log`에 있습니다',
  risk: 'write',
  hook: false,
  dryRun: false,
  standalone: true,
  envelope: false,

  async run(context: StandaloneCommandContext) {
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    try {
      const result = await runDaemon({
        home: configHome(context.env),
        env: context.env,
        clock: context.clock,
        // The daemon mints its own, as every other surface does (AD-8). It is
        // built here rather than in the loop so that `runDaemon` stays a
        // function a test can drive with ids of its own.
        idGen: uuidV7IdGen(),
        signal: controller.signal,
      });

      if (result.ok) return { ok: true as const, data: null };
      return {
        ok: false as const,
        code: result.code,
        message: result.message,
        exit: result.exit,
      };
    } finally {
      // Taken off again, so a `runDaemon` that returned leaves the process as
      // it found it: a handler left behind would swallow the next signal.
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  },
};
