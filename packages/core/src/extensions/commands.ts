import { resolveSelfUser } from '../users/self.js';
import { hasOnlyFiniteNumbers } from './json-values.js';
import { decodeExtensionManifest } from './manifest.js';
import { acquireExtensionSnapshot } from './snapshot.js';
import { cleanProcessGroup } from '../queue/process-cleanup.js';
import { maskOutputText, maskOutputValue } from '../output/mask.js';
import type { ExtensionDependencies } from './install.js';
import type { UserStore } from '../ports/store.js';

const failure = (code: string) => ({ ok: false as const, code, message: '확장 명령을 실행할 수 없습니다' });
export async function extensionCommands(deps: ExtensionDependencies) {
  const runtime = deps.extensions;
  if (!runtime?.installedManifest || !runtime.validateSchema) return { ok: false as const, code: 'CONFIG_INVALID', message: '확장 실행 환경이 없습니다' };
  const list = await deps.store.listExtensions();
  if (!list.ok) return list;
  const result: { extension: string; command: import('./manifest.js').ExtensionCommandDeclaration }[] = [];
  for (const ext of list.extensions.filter(item => item.enabled)) {
    try {
      const decoded = decodeExtensionManifest(await runtime.installedManifest(ext.name), runtime.validateSchema);
      if (decoded.ok && decoded.manifest.name === ext.name && decoded.manifest.version === ext.version)
        for (const command of decoded.manifest.commands ?? []) result.push({ extension: ext.name, command });
    } catch { /* Missing installed manifests do not register commands. */ }
  }
  return { ok: true as const, commands: result };
}

export async function executeExtensionCommand(deps: ExtensionDependencies & { store: ExtensionDependencies['store'] & Pick<UserStore, 'readSelfUser'> }, input: { name: string; command: string; input: unknown; signal?: AbortSignal }) {
  const runtime = deps.extensions;
  if (!runtime?.installedManifest || !runtime.validateSchema || !runtime.validateValue || !runtime.installedDirectory) return failure('EXTENSION_COMMAND_UNAVAILABLE');
  if (input.signal?.aborted) return failure('EXTENSION_COMMAND_TIMEOUT');
  const run = async () => {
    if (input.signal?.aborted) return failure('EXTENSION_COMMAND_TIMEOUT');
    const quiesce = await deps.store.readExtensionQuiesce(input.name);
    if (!quiesce.ok) return quiesce;
    if (quiesce.owner !== null) return failure('EXTENSION_COMMAND_UNAVAILABLE');
    const installed = await deps.store.getExtension(input.name);
    if (!installed.ok) return installed;
    if (!installed.extension?.enabled) return failure('EXTENSION_COMMAND_UNAVAILABLE');
    let manifest: ReturnType<typeof decodeExtensionManifest>;
    try { manifest = decodeExtensionManifest(await runtime.installedManifest!(input.name), runtime.validateSchema); } catch { return failure('EXTENSION_COMMAND_UNAVAILABLE'); }
    if (!manifest.ok || manifest.manifest.name !== input.name || manifest.manifest.version !== installed.extension.version) return failure('EXTENSION_COMMAND_UNAVAILABLE');
    const command = manifest.manifest.commands?.find(c => c.name === input.command);
    if (!command) return failure('EXTENSION_COMMAND_UNAVAILABLE');
    if (!hasOnlyFiniteNumbers(input.input) || runtime.validateValue!(command.input_schema, input.input) !== true) return failure('EXTENSION_COMMAND_INPUT_INVALID');
    const self = await resolveSelfUser(deps.store);
    if (!self.ok) return self;
    const declarations = manifest.manifest.settings ?? [];
    const snapshot = await acquireExtensionSnapshot({ extension: input.name, userId: self.userId, stage: 'work', requiredKeys: [], declarations, getSettings: deps.store.getSettings?.bind(deps.store), readSecrets: runtime.readSecrets?.bind(runtime), machineValues: () => runtime.machineValues?.(input.name) ?? {} });
    if (!snapshot.ok) return snapshot.kind === 'settings' || snapshot.kind === 'snapshot' ? snapshot.result : failure('EXTENSION_CONFIG_INVALID');
    const directory = runtime.installedDirectory!(input.name);
    let url: string; try { url = await runtime.databaseUrl(input.name); } catch { return failure('EXTENSION_CONFIG_INVALID'); }
    if (input.signal?.aborted) return failure('EXTENSION_COMMAND_TIMEOUT');
    const started = await runtime.launcher.start({ command: command.runtime === 'python' ? `${directory}/.venv/bin/python` : 'node', args: [`${directory}/${command.entry}`], cwd: directory, env: { BRAIN_DATABASE_URL: url }, stdin: JSON.stringify({ abi: 1, user_id: self.userId, settings: (JSON.parse(snapshot.serialized) as { values: unknown }).values, input: input.input }) });
    if (!started.ok) return failure('EXTENSION_COMMAND_FAILED');
    const handle = started.handle;
    const timerPort = runtime.timer;
    async function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
      const deadline = new AbortController();
      try { return await Promise.race([work.catch(() => fallback), timerPort.sleep(250, deadline.signal).then(() => fallback)]); }
      finally { deadline.abort(); }
    }
    const inspector = {
      bootTime: () => bounded(runtime.inspector.bootTime(), { state: 'unknown' as const }),
      startedAt: (pid: number) => bounded(runtime.inspector.startedAt(pid), { state: 'unknown' as const }),
      groupMembers: (pgid: number) => bounded(runtime.inspector.groupMembers(pgid), { state: 'unknown' as const }),
      signalGroup: (pgid: number, signal: 'SIGTERM' | 'SIGKILL') => bounded(runtime.inspector.signalGroup(pgid, signal), 'failed' as const),
    };
    const timer = new AbortController();
    const timeout = runtime.timer.sleep(command.timeout_ms, timer.signal).then(() => ({ kind: 'timeout' as const }));
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<{ kind: 'cancel' }>(resolve => {
      onAbort = () => resolve({ kind: 'cancel' });
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
    });
    const observation = Promise.all([inspector.bootTime(), inspector.startedAt(handle.pid)]);
    const observed = await Promise.race([observation.then(([boot, at]) => ({ kind: 'observed' as const, boot, at })), timeout, cancelled]);
    const identity = { pgid: handle.pid, osBootAt: observed.kind === 'observed' && observed.boot.state === 'found' ? observed.boot.value : null, osStartedAt: observed.kind === 'observed' && observed.at.state === 'found' ? observed.at.value : null };
    let stdout = '', outBytes = 0, errBytes = 0, overflow = false, unreadable = false;
    let exceeded!: () => void; const tooLarge = new Promise<'overflow'>(resolve => { exceeded = () => resolve('overflow'); });
    const consume = async (stream: AsyncIterable<string>, isOut: boolean) => { try { for await (const chunk of stream) { const size = new TextEncoder().encode(chunk).length; if (isOut) { outBytes += size; if (outBytes <= 1048576) stdout += chunk; } else errBytes += size; if (outBytes > 1048576 || errBytes > 1048576) { overflow = true; exceeded(); break; } } } catch { unreadable = true; } };
    const output = Promise.all([consume(handle.stdout, true), consume(handle.stderr, false)]);
    const result = observed.kind === 'observed' ? await Promise.race([handle.exited.then(exit => ({ kind: 'exit' as const, exit })), timeout, cancelled, tooLarge.then(() => ({ kind: 'overflow' as const }))]) : observed;
    timer.abort();
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    let cleaned: 'died' | 'unknown';
    try { cleaned = await cleanProcessGroup({ inspector, identity, clock: deps.clock, timer: runtime.timer, handle, graceMs: 1000, confirmMs: 1000 }); }
    catch { cleaned = 'unknown'; }
    if (cleaned === 'unknown' && !handle.leaderExited) {
      // The live leader still pins the group identity; make a final best-effort
      // kill and wait for reaping without treating uncertainty as success.
      try { handle.signalGroup('SIGKILL'); } catch { /* report cleanup failure */ }
      const reap = new AbortController();
      await Promise.race([handle.exited, runtime.timer.sleep(1000, reap.signal)]);
      reap.abort();
    }
    const drain = new AbortController();
    await Promise.race([output, runtime.timer.sleep(1000, drain.signal)]);
    drain.abort();
    handle.closeOutput(); await output;
    if (cleaned !== 'died') return failure('EXTENSION_COMMAND_CLEANUP_FAILED');
    if (result.kind === 'timeout' || result.kind === 'cancel') return failure('EXTENSION_COMMAND_TIMEOUT');
    if (result.kind !== 'exit' || overflow || unreadable || result.exit.code !== 0 || result.exit.signal) return failure('EXTENSION_COMMAND_FAILED');
    let value: unknown; try { value = JSON.parse(stdout); } catch { return failure('EXTENSION_COMMAND_OUTPUT_INVALID'); }
    if (!hasOnlyFiniteNumbers(value) || runtime.validateValue!(command.output_schema, value) !== true) return failure('EXTENSION_COMMAND_OUTPUT_INVALID');
    let masked: unknown;
    try { masked = JSON.parse(maskOutputText(JSON.stringify(maskOutputValue(value)))); } catch { return failure('EXTENSION_COMMAND_OUTPUT_REDACTED'); }
    if (runtime.validateValue!(command.output_schema, masked) !== true) return failure('EXTENSION_COMMAND_OUTPUT_REDACTED');
    return { ok: true as const, data: masked };
  };
  const withLock = runtime.withCommandLock ?? runtime.withInstallLock;
  if (!withLock) { try { return await run(); } catch { return failure('EXTENSION_COMMAND_FAILED'); } }
  const lockSignal = new AbortController(), lockTimer = new AbortController();
  let expired = false;
  const cancelLock = () => lockSignal.abort();
  input.signal?.addEventListener('abort', cancelLock, { once: true });
  if (input.signal?.aborted) cancelLock();
  const deadline = runtime.timer.sleep(30_000, lockTimer.signal).then(() => { if (!lockTimer.signal.aborted) { expired = true; lockSignal.abort(); } });
  try { return await withLock(input.name, async () => { lockTimer.abort(); if (lockSignal.signal.aborted) return failure('EXTENSION_COMMAND_TIMEOUT'); return run(); }, lockSignal.signal); }
  catch { return failure(expired || input.signal?.aborted ? 'EXTENSION_COMMAND_TIMEOUT' : 'EXTENSION_COMMAND_FAILED'); }
  finally { lockTimer.abort(); await deadline; input.signal?.removeEventListener('abort', cancelLock); }
}
