import { spawn } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createExtensionSnapshot, decodeExtensionManifest, isExtensionName } from 'second_brain';
import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { readConfig } from '../config/codec.js';
import { configHome, envFilePath } from '../config/paths.js';
import { openBrainStore } from '../runtime/brain-store.js';

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
    const home = configHome(context.env);
    const config = await readConfig(home);
    const { store } = await openBrainStore({ home, env: context.env, config, path: 'command' });
    try {
      const installed = await store.listExtensions();
      if (!installed.ok) return installed;
      const extension = installed.extensions.find(item => item.name === name);
      if (!extension) return { ok: false, code: 'EXTENSION_NOT_INSTALLED', message: '설치된 확장을 찾을 수 없습니다' };
      const directory = join(home, 'extensions', name);
      const dirInfo = await lstat(directory);
      const manifestInfo = await lstat(join(directory, 'manifest.json'));
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw Error();
      const decoded = decodeExtensionManifest(await readFile(join(directory, 'manifest.json'), 'utf8'));
      if (!decoded.ok || decoded.manifest.name !== name || decoded.manifest.version !== extension.version || !decoded.manifest.auth) return { ok: false, code: 'EXTENSION_INVALID', message: '확장 인증을 찾을 수 없습니다' };
      const manifest = decoded.manifest;
      const declarations = manifest.settings ?? [];
      const read = await store.getSettings({ keys: declarations.map(setting => setting.key) });
      if (!read.ok) return read;
      let secrets: Record<string, string> = {};
      if (declarations.some(setting => setting.secret)) {
        try { secrets = Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const snapshot = createExtensionSnapshot({ extension: name, stage: 'auth', declarations, settings: Object.fromEntries(read.settings.map(setting => [setting.key, setting.value])), secrets, machine: { tokenstore: join(directory, 'tokenstore') } });
      if (!snapshot.ok) return { ok: false, code: snapshot.code, message: '확장 설정을 확인하세요' };
      const entry = manifest.auth!;
      const { status, code } = await launchTerminal(entry.runtime === 'python' ? join(directory, '.venv', 'bin', 'python') : process.execPath, join(directory, entry.entry), { ...context.env, BRAIN_SETTINGS_SNAPSHOT: snapshot.serialized, BRAIN_EXTENSION_HOME: directory }, manifest.error_codes ?? []);
      if (status !== 0) return { ok: false, code, message: '확장 로그인을 완료하지 못했습니다' };
      return { ok: true, data: { status: 'succeeded' }, text: ['확장 로그인 완료'] };
    } catch {
      return { ok: false, code: 'EXTENSION_INVALID', message: '확장 인증을 실행할 수 없습니다' };
    } finally { await store.close(); }
  },
};

export async function launchTerminal(command: string, entry: string, env: NodeJS.ProcessEnv, codes: readonly string[]): Promise<{ status: number | null; code: string }> {
  const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(command, [entry, '--terminal'], { stdio: ['inherit', 'inherit', 'pipe'], env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.once('error', () => resolve({ status: null, stderr: '' }));
    child.once('close', status => resolve({ status, stderr }));
  });
  const lastLine = result.stderr.trimEnd().split('\n').at(-1) ?? '';
  return { status: result.status, code: /^[A-Z][A-Z0-9_]*$/.test(lastLine) && codes.includes(lastLine) ? lastLine : 'LOGIN_REQUIRED' };
}
