import { validateSchema } from '../runtime/json-schema.js';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, rename, rm, readdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { envFilePath } from '../config/paths.js';
import { runSupervisor, readScopedSettings, resolveSelfUser, PROCESS_ABI_ENV, decodeExtensionManifest, createExtensionSnapshot, type SupervisorOptions, type ProcessInspector, type ProcessLauncher } from 'second_brain';
import { openBrainStore } from '../runtime/brain-store.js';
import { systemProcessInspector } from '../runtime/process-inspector.js';
import { systemProcessLauncher } from '../runtime/process-group.js';
import { systemTimer } from '../runtime/clock.js';
import { resolveStoreUrl, resolveTelegramConfig, extensionDatabaseUrl } from '../config/codec.js';
import type { RunDaemonOptions } from './run.js';
import { readDaemonLock } from './lock.js';
import type { ReadConfigResult } from '../config/codec.js';
export function scheduleEnvironment(groups: import('second_brain').ScheduledOccurrences[] | null): Record<string,string> {
  const instants = [...new Set((groups ?? []).flatMap(group => group.occurrences.map(at => at.toISOString())))].sort();
  if (!instants.length) return {};
  const dates = (groups ?? []).flatMap(group => group.occurrences.map(at => new Intl.DateTimeFormat('en-CA', { timeZone: group.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at))).sort();
  return { BRAIN_RANGE_FROM:dates[0]!, BRAIN_RANGE_TO:dates.at(-1)!, BRAIN_OCCURRENCES:JSON.stringify(instants.map(at=>at.replace('Z','+00:00'))) };
}
export interface DaemonSupervisorOptions { launcher?: ProcessLauncher; inspector?: ProcessInspector; cancelGraceMs?: number; cancelPollMs?: number; groupConfirmMs?: number; probeWorker?: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }; channelTestEndpoint?: string; channelTestBarrier?: 'before-finish' | 'after-finish'; pollMs?: number; renewEveryMs?: number; disabled?: boolean }
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
      const telegram = await resolveTelegramConfig(options.home, options.env).catch(() => null);
      const loadProtectedLaunches = async (): Promise<NonNullable<SupervisorOptions['protectedLaunches']>> => {
      const protectedLaunches: Record<string, NonNullable<SupervisorOptions['protectedLaunches']>[string]> = {};
      const installed = await opened.store.listExtensions();
      if (!installed.ok) throw new Error('확장 목록을 조회할 수 없습니다');
      if (installed.ok) for (const extension of installed.extensions.filter(entry => entry.enabled)) {
        try {
          const directory = join(options.home, 'extensions', extension.name);
          const directoryInfo = await lstat(directory);
          const manifestInfo = await lstat(join(directory, 'manifest.json'));
          if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) continue;
          const decoded = decodeExtensionManifest(await readFile(join(directory, 'manifest.json'), 'utf8'), validateSchema);
          if (!decoded.ok || decoded.manifest.name !== extension.name || decoded.manifest.version !== extension.version) continue;
          const manifest = decoded.manifest;
          const declarations = manifest.settings ?? [];
          for (const work of [...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])]) protectedLaunches[work.kind] = {
            extension: manifest.name, declarations: Object.fromEntries(declarations.map(setting => [setting.key, setting.type])), errorCodes: manifest.error_codes ?? [],
            required: 'required_settings' in work && Array.isArray(work.required_settings) ? work.required_settings : declarations.filter(setting => setting.required.includes(manifest.auth?.kind === work.kind ? 'auth' : 'work')).map(setting => setting.key),
            secrets: declarations.filter(setting => setting.secret).map(setting => setting.key),
            async prepare(item, token, userId) {
              const self = userId === undefined ? await resolveSelfUser(opened.store) : { ok: true as const, userId };
              if (!self.ok) return { ok: false, code: self.code };
              const read = await readScopedSettings(opened.store, self.userId, declarations);
              if (!read.ok) return { ok: false, code: read.code };
              let secrets: Record<string, string> = {};
              try {
                if (declarations.some(setting => setting.secret)) secrets = Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(options.home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined));
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, code: 'EXTENSION_CONFIG_INVALID' }; }
              const snapshot = createExtensionSnapshot({ extension: manifest.name, userId: self.userId, stage: manifest.auth?.kind === work.kind ? 'auth' : 'work', declarations, ...('required_settings' in work && Array.isArray(work.required_settings) ? { requiredKeys: work.required_settings } : {}), settings: Object.fromEntries(read.settings.map(setting => [setting.key, setting.value])), secrets, machine: { tokenstore: join(directory, 'tokenstore') } });
              if (!snapshot.ok || !url) return { ok: false, code: 'EXTENSION_CONFIG_INVALID' };
              let extensionUrl: string;
              try { extensionUrl = await extensionDatabaseUrl(options.home, manifest.name, url); } catch { return { ok: false, code: 'EXTENSION_CONFIG_INVALID' }; }
              const versions = await opened.store.readSchemaVersions();
              const applied = await opened.store.readSchemaMigrationVersions?.(manifest.name);
              let migrationVersions: number[];
              try { migrationVersions = (await readdir(join(directory, manifest.migrations))).filter(file => /^\d{4}_.+\.sql$/.test(file)).map(file => Number(file.slice(0, 4))).sort((a, b) => a - b); }
              catch { return { ok: false, code: 'EXTENSION_CONFIG_INVALID' }; }
              const readiness = { version: 1, core: versions.ok ? versions.versions['core']?.version ?? null : null, expected_core: opened.expected.core ?? null, extension: versions.ok ? versions.versions[manifest.name]?.version ?? null : null, migrations: migrationVersions, applied_migrations: applied?.ok ? applied.versions : null, manifest_version: manifest.version, abi: manifest.abi };
              return { ok: true, spec: { command: work.runtime === 'python' ? join(directory, '.venv', 'bin', 'python') : process.execPath, args: [join(directory, work.entry)], env: {
                [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: extensionUrl, [PROCESS_ABI_ENV.workId]: item.id,
                [PROCESS_ABI_ENV.runGeneration]: String(item.attempts), [PROCESS_ABI_ENV.attemptToken]: token, [PROCESS_ABI_ENV.workKind]: item.kind,
                [PROCESS_ABI_ENV.targetKind]: item.targetKind, [PROCESS_ABI_ENV.targetId]: item.targetId,
                ...scheduleEnvironment(item.scheduledOccurrences), BRAIN_SETTINGS_SNAPSHOT: snapshot.serialized, BRAIN_EXTENSION_HOME: await realpath(directory), BRAIN_SECRET_SCANNER_NODE: process.execPath, BRAIN_SECRET_SCANNER_SCRIPT: fileURLToPath(new URL('../../dist/workers/secret-scan.js', import.meta.url)), BRAIN_EXTENSION_READINESS: JSON.stringify(readiness),
              } } };
            },
          };
        } catch { await log.write('설치된 확장의 manifest를 읽을 수 없습니다'); }
      }
      return protectedLaunches;
      };
      const readinessPath = join(options.home, 'run', 'supervisor-ready.json');
      const onReadiness = async (ready: boolean) => {
        if (!ready) { await rm(readinessPath, { force: true }); return; }
        const owner = await readDaemonLock(options.home);
        if (!owner || owner.pid !== process.pid) { await rm(readinessPath, { force: true }); return; }
        const temporary = `${readinessPath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ pid: owner.pid, startedAt: owner.startedAt.toISOString(), at: options.clock.now().toISOString() }), { mode: 0o600 });
        await rename(temporary, readinessPath);
      };
      await runSupervisor({ loadProtectedLaunches, onReadiness, store: opened.store, schemaVersions: opened.expected,
        prepareLaunch: async () => { const self = await resolveSelfUser(opened.store); return self.ok ? { ok: true, userId: self.userId } : { ok: false, code: self.code }; },
        inspector: options.supervisor?.inspector ?? systemProcessInspector,
        ...(options.supervisor?.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.supervisor.cancelGraceMs }),
        ...(options.supervisor?.cancelPollMs === undefined ? {} : { cancelPollMs: options.supervisor.cancelPollMs }),
        ...(options.supervisor?.groupConfirmMs === undefined ? {} : { groupConfirmMs: options.supervisor.groupConfirmMs }),
        launcher: options.supervisor?.launcher ?? systemProcessLauncher, clock: options.clock, timer: systemTimer,
        idGen: options.idGen, signal: controller.signal, log: (message) => log.write(message),
        ...(options.supervisor?.pollMs === undefined ? {} : { pollMs: options.supervisor.pollMs }),
        ...(options.supervisor?.renewEveryMs === undefined ? {} : { renewEveryMs: options.supervisor.renewEveryMs }),
        launches: { channel_send: (item, token) => url ? ({
          command: process.execPath,
          args: [fileURLToPath(new URL('../../dist/workers/channel-send.js', import.meta.url))],
          env: { [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: url,
            [PROCESS_ABI_ENV.workId]: item.id, [PROCESS_ABI_ENV.runGeneration]: String(item.attempts),
            [PROCESS_ABI_ENV.attemptToken]: token, [PROCESS_ABI_ENV.workKind]: item.kind,
            [PROCESS_ABI_ENV.targetKind]: item.targetKind, [PROCESS_ABI_ENV.targetId]: item.targetId,
            BRAIN_CHANNEL_FILES_PATH: config.ok ? config.config.filesPath : join(options.home, 'files'),
            ...(telegram ? { BRAIN_TELEGRAM_BOT_TOKEN: telegram.token, BRAIN_TELEGRAM_CHAT_ID: telegram.chatId } : {}),
            ...(options.supervisor?.channelTestEndpoint ? { BRAIN_CHANNEL_TEST_ENDPOINT: options.supervisor.channelTestEndpoint } : {}),
            ...(options.supervisor?.channelTestEndpoint && options.supervisor.channelTestBarrier ? { BRAIN_CHANNEL_TEST_BARRIER: options.supervisor.channelTestBarrier } : {}),
          },
        }) : null, process_probe: (item, token) => url ? ({ command: options.supervisor?.probeWorker?.command ?? process.execPath,
          args: options.supervisor?.probeWorker?.args ?? [fileURLToPath(new URL('../../dist/workers/process-probe.js', import.meta.url))],
          env: { ...options.supervisor?.probeWorker?.env, [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: url, [PROCESS_ABI_ENV.workId]: item.id,
            [PROCESS_ABI_ENV.runGeneration]: String(item.attempts), [PROCESS_ABI_ENV.attemptToken]: token, [PROCESS_ABI_ENV.workKind]: item.kind,
            [PROCESS_ABI_ENV.targetKind]: item.targetKind, [PROCESS_ABI_ENV.targetId]: item.targetId },
        }) : null },
      });
    } finally { await opened.store.close(); }
  })().catch(async () => { await rm(join(options.home, 'run', 'supervisor-ready.json'), { force: true }); await log.write('감독자를 실행할 수 없습니다'); });
  return { async stop() { controller.abort(); await running; options.signal.removeEventListener('abort', abort); } };
}
