import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { comparePackagePaths, decodeExtensionManifest, validateMigrationNames, type ExtensionManifest } from 'second_brain';
import { validPythonPin } from './extension-python.js';
import { readBuildIdentity, readInstalled, type BuildIdentity } from '../install/installed.js';
import { validateSchema } from './json-schema.js';

/** Compare release components as integers without Number precision loss. */
export function compareRelease(a: string, b: string): number {
  const pattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
  if (!pattern.test(a) || !pattern.test(b)) throw new Error('invalid release');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i]! < right[i]!) return -1; if (left[i]! > right[i]!) return 1; }
  return 0;
}

export async function checkInstalledCore(home: string, running: BuildIdentity | undefined): Promise<void> {
  const [disk, installed] = await Promise.all([readBuildIdentity(), readInstalled(home)]);
  if (!running?.commit || !disk?.commit || !installed?.commit || running.commit !== disk.commit || running.commit !== installed.commit || running.schema_version !== disk.schema_version || running.schema_version !== installed.schema_version || running.version !== disk.version) throw new Error('core identity mismatch');
}

export async function checkPackageCore(home: string, manifest: ExtensionManifest, running: BuildIdentity | undefined): Promise<void> {
  await checkInstalledCore(home, running);
  if ((running?.schema_version ?? 0) >= 47 && manifest.name === 'garmin' && compareRelease(manifest.version, '1.2.7') < 0) throw new Error('결과 이벤트를 지원하는 Garmin 1.2.7 이상 패키지가 필요합니다');
  const range = manifest.core_compat;
  if (!range || !running?.version || compareRelease(running.version, range.min) < 0 || compareRelease(running.version, range.max_exclusive) >= 0) throw new Error('core compatibility mismatch');
}

/** Hash the exact path/byte sequence used by the package digest contract. */
export function digestPackageFiles(files: readonly string[], bytes: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const path of files) {
    const data = bytes.get(path); if (!data) throw new Error('missing file');
    const pathBytes = Buffer.from(path, 'utf8');
    hash.update(`f${pathBytes.length}:`); hash.update(pathBytes); hash.update(`:${data.length}:`); hash.update(data);
  }
  return hash.digest('hex');
}

export function needsPython(manifest: ExtensionManifest): boolean {
  return [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : []), ...(manifest.commands ?? [])].some(command => command.runtime === 'python');
}

/** Materialize validated immutable bytes in a private directory for the caller. */
export async function prepareExtensionPackage(source: string, hooks?: { signal?: AbortSignal; onDirectoryOpened?(relative: string): Promise<void>; onFileStated?(relative: string): Promise<void>; onSnapshot?(): Promise<void>; onStage?(dir: string): Promise<void> }): Promise<{ name: string; dir: string; manifestText: string; digest: string; cleanup(): Promise<void> }> {
  const root = resolve(source);
  const checkCancelled = () => { if (hooks?.signal?.aborted) throw new Error('package snapshot cancelled'); };
  checkCancelled();
  const stage = await mkdtemp(join(tmpdir(), 'brain-package-'));
  try {
    await hooks?.onStage?.(stage);
    checkCancelled();
    const files = await new Promise<Map<string, Buffer>>((resolveSnapshot, rejectSnapshot) => {
      // A separate Node process has a private cwd, allowing directory-relative
      // traversal without relying on non-portable /dev/fd or filesystem volfs.
      const worker = fork(new URL('../../dist/runtime/extension-package-worker.js', import.meta.url), [root], { silent: true, serialization: 'advanced', execArgv: [] });
      const cancel = () => { worker.kill('SIGKILL'); };
      hooks?.signal?.addEventListener('abort', cancel, { once: true });
      if (hooks?.signal?.aborted) cancel();
      let result: Map<string, Buffer> | undefined, failure: unknown;
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.on('error', error => { failure = error; });
      worker.on('message', message => {
        const event = message as { type?: string; relative?: string; files?: Map<string, Buffer> };
        if (event.type === 'result') result = event.files;
        else if (event.type === 'error') failure = new Error('invalid package tree');
        else if ((event.type === 'directory' || event.type === 'file') && typeof event.relative === 'string') {
          void Promise.resolve().then(() => event.type === 'directory' ? hooks?.onDirectoryOpened?.(event.relative!) : hooks?.onFileStated?.(event.relative!)).then(() => { if (worker.connected) worker.send('continue'); }, error => { failure = error; worker.kill('SIGKILL'); });
        }
      });
      worker.on('close', code => { hooks?.signal?.removeEventListener('abort', cancel); if (code === 0 && result instanceof Map && !hooks?.signal?.aborted) resolveSnapshot(result); else rejectSnapshot(failure ?? new Error('package snapshot failed')); });
    });
    await hooks?.onSnapshot?.(); checkCancelled();
    const manifestText = files.get('manifest.json')?.toString('utf8');
    if (manifestText === undefined) throw new Error('manifest missing');
    const decoded = decodeExtensionManifest(manifestText, validateSchema);
    if (!decoded.ok || !decoded.manifest.files || !decoded.manifest.core_compat || !decoded.manifest.plugin_version) throw new Error('invalid package manifest');
    const manifest = decoded.manifest, declared = manifest.files!;
    const actual = [...files.keys()].filter(path => path !== 'digest').sort(comparePackagePaths);
    if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error('file list mismatch');
    const required = [manifest.connection_check.entry, ...(manifest.work ?? []).map(x => x.entry), ...(manifest.commands ?? []).map(x => x.entry), ...(manifest.auth ? [manifest.auth.entry] : [])];
    const reserved = (path: string) => ['reports', 'staging', 'tokenstore', ...(needsPython(manifest) ? ['.venv'] : [])].includes(path.split('/')[0]!);
    if ([...declared, ...required, manifest.migrations].some(reserved)) throw new Error('package conflicts with persistent extension data');
    if (required.some(path => !files.has(path))) throw new Error('entry missing');
    const migrationPaths = actual.filter(path => path.startsWith(`${manifest.migrations}/`)).map(path => path.slice(manifest.migrations.length + 1));
    if (migrationPaths.some(path => path.includes('/') && path.endsWith('.sql'))) throw new Error('nested migration');
    validateMigrationNames(migrationPaths.filter(path => !path.includes('/')));
    if (needsPython(manifest)) {
      const pin = files.get('.python-version');
      if (!pin || !files.has('pyproject.toml') || !files.has('uv.lock') || !validPythonPin(pin.toString('utf8'))) throw new Error('invalid Python dependency inputs');
    }
    const digest = digestPackageFiles(declared, files);
    if (files.get('digest')?.toString('utf8') !== `${digest}\n`) throw new Error('digest mismatch');
    for (const [path, data] of files) { checkCancelled(); const dest = join(stage, path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, data, { flag: 'wx', mode: 0o600 }); }
    checkCancelled();
    return { name: manifest.name, dir: stage, manifestText, digest, cleanup: () => rm(stage, { recursive: true, force: true }) };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export interface PackageObservation { name: string; version: string; pluginVersion: string; digest: string }
export async function observePackage(home: string, observation: PackageObservation): Promise<void> {
  const { name, version, pluginVersion, digest } = observation;
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid observation');
  compareRelease(version, version); compareRelease(pluginVersion, pluginVersion);
  const folder = join(home, 'run', 'extension-packages');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `.${name}-${randomUUID()}.tmp`);
  try { await writeFile(temp, `${JSON.stringify({ name, version, pluginVersion, digest })}\n`, { flag: 'wx', mode: 0o600 }); await rename(temp, join(folder, `${name}.json`)); }
  finally { await rm(temp, { force: true }); }
}
export async function readPackageObservation(home: string, name: string): Promise<PackageObservation | null> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) throw new Error('invalid name');
  let text: string;
  try { text = await readFile(join(home, 'run', 'extension-packages', `${name}.json`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid observation');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'digest,name,pluginVersion,version' || data.name !== name || typeof data.version !== 'string' || typeof data.pluginVersion !== 'string' || typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest)) throw new Error('invalid observation');
  compareRelease(data.version, data.version); compareRelease(data.pluginVersion, data.pluginVersion);
  return { name, version: data.version, pluginVersion: data.pluginVersion, digest: data.digest };
}
