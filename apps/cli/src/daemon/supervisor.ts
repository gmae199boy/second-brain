import { fileURLToPath } from 'node:url';
import { runSupervisor, PROCESS_ABI_ENV, type ProcessInspector, type ProcessLauncher } from 'second_brain';
import { openBrainStore } from '../runtime/brain-store.js';
import { systemProcessInspector } from '../runtime/process-inspector.js';
import { systemProcessLauncher } from '../runtime/process-group.js';
import { systemTimer } from '../runtime/clock.js';
import { resolveStoreUrl } from '../config/codec.js';
import type { RunDaemonOptions } from './run.js';
import type { ReadConfigResult } from '../config/codec.js';
export interface DaemonSupervisorOptions { launcher?: ProcessLauncher; inspector?: ProcessInspector; cancelGraceMs?: number; cancelPollMs?: number; groupConfirmMs?: number; probeWorker?: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }; pollMs?: number; renewEveryMs?: number; disabled?: boolean }
export function startDaemonSupervisor(options: RunDaemonOptions, config: ReadConfigResult, log: { write(message: string): Promise<void> }): { stop(): Promise<void> } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const running = (async () => {
    if (options.supervisor?.disabled) return;
    const opened = await openBrainStore({ home: options.home, env: options.env, config, path: 'drain', createStore: options.createStore });
    try {
      const url = config.ok ? await resolveStoreUrl(options.home, config.config.storeUrlEnv, options.env).catch(() => undefined) : undefined;
      await runSupervisor({ store: opened.store, schemaVersions: opened.expected,
        inspector: options.supervisor?.inspector ?? systemProcessInspector,
        ...(options.supervisor?.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.supervisor.cancelGraceMs }),
        ...(options.supervisor?.cancelPollMs === undefined ? {} : { cancelPollMs: options.supervisor.cancelPollMs }),
        ...(options.supervisor?.groupConfirmMs === undefined ? {} : { groupConfirmMs: options.supervisor.groupConfirmMs }),
        launcher: options.supervisor?.launcher ?? systemProcessLauncher, clock: options.clock, timer: systemTimer,
        idGen: options.idGen, signal: controller.signal, log: (message) => log.write(message),
        ...(options.supervisor?.pollMs === undefined ? {} : { pollMs: options.supervisor.pollMs }),
        ...(options.supervisor?.renewEveryMs === undefined ? {} : { renewEveryMs: options.supervisor.renewEveryMs }),
        launches: { process_probe: (item, token) => url ? ({ command: options.supervisor?.probeWorker?.command ?? process.execPath,
          args: options.supervisor?.probeWorker?.args ?? [fileURLToPath(new URL('../../dist/workers/process-probe.js', import.meta.url))],
          env: { ...options.supervisor?.probeWorker?.env, [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: url, [PROCESS_ABI_ENV.workId]: item.id,
            [PROCESS_ABI_ENV.runGeneration]: String(item.attempts), [PROCESS_ABI_ENV.attemptToken]: token, [PROCESS_ABI_ENV.workKind]: item.kind,
            [PROCESS_ABI_ENV.targetKind]: item.targetKind, [PROCESS_ABI_ENV.targetId]: item.targetId },
        }) : null },
      });
    } finally { await opened.store.close(); }
  })().catch(async () => { await log.write('감독자를 실행할 수 없습니다'); });
  return { async stop() { controller.abort(); await running; options.signal.removeEventListener('abort', abort); } };
}
