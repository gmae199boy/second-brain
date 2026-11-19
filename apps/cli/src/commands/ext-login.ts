import { validateSchema } from '../runtime/json-schema.js';
import { spawn } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createExtensionSnapshot, readScopedSettings, resolveSelfUser, decodeExtensionManifest, isExtensionName, checkExtensionExecution, validInstallProgress } from 'second_brain';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { readConfig, resolveStoreUrl } from '../config/codec.js';
import { configHome, envFilePath } from '../config/paths.js';
import { openBrainStore } from '../runtime/brain-store.js';
import { appRootPath } from '../install/installed.js';

export const extLoginCommand: CommandSpec = {
  ns: 'ext', verb: 'login', usedFor: '터미널에서 확장에 로그인합니다',
  required: ['name'], arguments: ['<name>'], examples: ['brain ext login garmin'],
  output: '로그인 결과를 반환합니다', risk: 'write', hook: false, dryRun: false, standalone: true,
  async run(context: StandaloneCommandContext) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) return { ok: false, code: 'LOGIN_REQUIRED', message: '터미널에서 실행하세요' };
    try { const tty = await open('/dev/tty', 'r+'); await tty.close(); }
    catch { return { ok: false, code: 'LOGIN_REQUIRED', message: '터미널에서 실행하세요' }; }
    const name = String(context.args[0]);
    if (!isExtensionName(name)) return { ok: false, code: 'EXTENSION_INVALID', message: '확장 이름을 확인하세요' };
    return await withLoginSignalBoundary(async control => {
    const cancelled = () => ({ ok: false as const, code: 'AUTH_CANCELLED' as const, message: '확장 로그인이 취소되었습니다' });
    const home = configHome(context.env);
    const config = await readConfig(home);
    const { store } = await openBrainStore({ home, env: context.env, config, path: 'command' });
    try {
      if (control.signal.aborted) return cancelled();
      if (!config.ok) return { ok: false, code: 'CONFIG_INVALID', message: '설정을 읽을 수 없습니다' };
      const url = await resolveStoreUrl(home, config.config.storeUrlEnv, context.env);
      if (control.signal.aborted) return cancelled();
      if (!url) return { ok: false, code: 'DB_UNAVAILABLE', message: '데이터베이스를 확인할 수 없습니다' };
      const { withExtensionInstallLock } = await import('second_brain/postgres');
      return await withExtensionInstallLock(url, name, async () => {
      const allowed = await checkExtensionExecution(store, name); if (!allowed.ok) return allowed;
      const installed = await store.listExtensions();
      if (!installed.ok) return installed;
      const extension = installed.extensions.find(item => item.name === name);
      if (!extension) return { ok: false, code: 'EXTENSION_NOT_INSTALLED', message: '설치된 확장을 찾을 수 없습니다' };
      const directory = join(home, 'extensions', name);
      const dirInfo = await lstat(directory);
      const manifestInfo = await lstat(join(directory, 'manifest.json'));
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw Error();
      const decoded = decodeExtensionManifest(await readFile(join(directory, 'manifest.json'), 'utf8'), validateSchema);
      if (!decoded.ok || decoded.manifest.name !== name || decoded.manifest.version !== extension.version || !decoded.manifest.auth) return { ok: false, code: 'EXTENSION_INVALID', message: '확장 인증을 찾을 수 없습니다' };
      const manifest = decoded.manifest;
      const declarations = manifest.settings ?? [];
      const self = await resolveSelfUser(store);
      if (!self.ok) return self;
      const read = await readScopedSettings(store, self.userId, declarations);
      if (!read.ok) return read;
      let secrets: Record<string, string> = {};
      if (declarations.some(setting => setting.secret)) {
        try { secrets = Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const snapshot = createExtensionSnapshot({ extension: name, userId: self.userId, stage: 'auth', declarations, settings: Object.fromEntries(read.settings.map(setting => [setting.key, setting.value])), secrets, machine: { tokenstore: join(directory, 'tokenstore') } });
      if (!snapshot.ok) return { ok: false, code: snapshot.code, message: '확장 설정을 확인하세요' };
      const entry = manifest.auth!;
      let protectedPublication = false;
      if (name === 'garmin' && entry.runtime === 'python' && entry.entry === 'src/auth.py' && entry.probe_on_install === true) {
        // The cooperative shutdown contract belongs to the bundled Garmin
        // package, not an arbitrary external package using the same name.
        try {
          const bundled = join(appRootPath(), 'plugins/garmin/package');
          const digest = (await readFile(join(bundled, 'digest'), 'utf8')).trim();
          const [installedEntry, bundledEntry] = await Promise.all([readFile(join(directory, entry.entry)), readFile(join(bundled, entry.entry))]);
          protectedPublication = extension.packageDigest === digest && installedEntry.equals(bundledEntry);
        } catch { /* unknown package uses the bounded shutdown contract */ }
      }
      if (control.signal.aborted) return cancelled();
      control.started();
      const result = await launchTerminal(entry.runtime === 'python' ? join(directory, '.venv', 'bin', 'python') : process.execPath, join(directory, entry.entry), { ...context.env, BRAIN_SETTINGS_SNAPSHOT: snapshot.serialized, BRAIN_EXTENSION_HOME: directory }, manifest.error_codes ?? [], { protectedPublication });
      const { status, code } = result;
      if (entry.probe_on_install) {
        const found = await store.getExtensionInstallProgress(name); if (!found.ok) return found;
        if (found.journal) {
          const progress = found.journal.progress;
          if (!validInstallProgress(progress) || progress.name !== name) return { ok: false, code: 'DB_LOCKED', message: '확장 설치 기록을 확인할 수 없습니다' };
          if (status === 0 || (code !== 'GARMIN_BOUND_LOGIN_REFUSED' && progress.stages.login?.status !== 'succeeded' && extension.connectionStatus !== 'connected')) {
            const at = new Date().toISOString();
            const safeCode = code === 'AUTH_CANCELLED' || code === 'GARMIN_BOUND_LOGIN_REFUSED' || code === 'AUTH_UNAVAILABLE' ? code : 'EXTENSION_AUTH_FAILED';
            progress.stages.login = status === 0 ? { status: 'pending', code: 'TOKEN_VERIFY_PENDING', at } : { status: 'failed', code: safeCode, at };
            progress.result = status === 0 ? null : code === 'AUTH_CANCELLED' ? 'cancelled' : 'failed';
            progress.failedStage = status === 0 || code === 'AUTH_CANCELLED' ? null : 'login';
            if (status !== 0) progress.lastFailure = { stage: 'login', code: safeCode, at };
            const saved = await store.writeExtensionInstallProgress({ expectedRevision: found.journal.revision, progress });
            if (!saved.ok) return saved;
            if (!saved.written) return { ok: false, code: 'DB_LOCKED', message: '확장 설치 기록이 동시에 변경되었습니다' };
          }
        }
      }
      if (status !== 0) return { ok: false, code, message: '확장 로그인을 완료하지 못했습니다' };
      return { ok: true, data: { status: 'succeeded' }, text: ['확장 로그인 완료'] };
      }, control.signal);
    } catch (error) {
      if (control.signal.aborted || (error as { code?: string })?.code === 'EXTENSION_INSTALL_CANCELLED') return cancelled();
      return { ok: false, code: 'EXTENSION_INVALID', message: '확장 인증을 실행할 수 없습니다' };
    } finally { await store.close(); }
    });
  },
};

// Keep SIGINT handled until the install lock has been released and the journal
// update is complete, even after the terminal child has exited.
export async function withLoginSignalBoundary<T>(operation: (control: { signal: AbortSignal; started(): void }) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let childStarted = false;
  const hold = () => { if (!childStarted) controller.abort(); };
  process.on('SIGINT', hold);
  try { return await operation({ signal: controller.signal, started: () => { childStarted = true; } }); }
  finally { process.off('SIGINT', hold); }
}

export async function launchTerminal(command: string, entry: string, env: NodeJS.ProcessEnv, codes: readonly string[], options: { protectedPublication?: boolean } = {}): Promise<{ status: number | null; code: string }> {
  const result = await new Promise<{ status: number | null; stderr: string; cancelled: boolean; spawnFailed: boolean }>((resolve) => {
    let interrupted = false;
    let child: ReturnType<typeof spawn> | undefined;
    let terminate: ReturnType<typeof setTimeout> | undefined;
    let kill: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { process.off('SIGINT', onInterrupt); if (terminate) clearTimeout(terminate); if (kill) clearTimeout(kill); if (drain) clearTimeout(drain); };
    const onInterrupt = () => {
      if (interrupted) return;
      interrupted = true;
      child?.kill('SIGINT');
      if (!options.protectedPublication) {
        terminate = setTimeout(() => child?.kill('SIGTERM'), 2000); terminate.unref();
        kill = setTimeout(() => child?.kill('SIGKILL'), 5000); kill.unref();
      }
    };
    process.on('SIGINT', onInterrupt);
    try { child = spawn(command, [entry, '--terminal'], { stdio: ['inherit', 'inherit', 'pipe'], env }); }
    catch { cleanup(); resolve({ status: null, stderr: '', cancelled: false, spawnFailed: true }); return; }
    if (interrupted) child.kill('SIGINT');
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.once('error', () => { cleanup(); resolve({ status: null, stderr: '', cancelled: interrupted, spawnFailed: true }); });
    const finish = (status: number | null, signal: NodeJS.Signals | null) => { cleanup(); resolve({ status, stderr, cancelled: interrupted || signal === 'SIGINT', spawnFailed: false }); };
    child.once('exit', (status, signal) => {
      if (!options.protectedPublication) {
        // A helper can retain the pipe after the direct child exits. Give
        // buffered diagnostics a short drain, then release our descriptor.
        drain = setTimeout(() => { child?.stderr?.destroy(); finish(status, signal); }, 250);
      }
    });
    child.once('close', finish);
  });
  if (result.cancelled && !(result.status === 0 && result.stderr.trimEnd().split('\n').at(-1) === 'GARMIN_TOKEN_PUBLISHED')) return { status: null, code: 'AUTH_CANCELLED' };
  if (result.spawnFailed) return { status: null, code: 'AUTH_UNAVAILABLE' };
  const lastLine = result.stderr.trimEnd().split('\n').at(-1) ?? '';
  return { status: result.status, code: /^[A-Z][A-Z0-9_]*$/.test(lastLine) && codes.includes(lastLine) ? lastLine : 'LOGIN_REQUIRED' };
}
