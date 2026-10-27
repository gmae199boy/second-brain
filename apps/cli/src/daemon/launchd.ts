import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

export const DAEMON_LABEL = 'io.github.gmae199boy.second-brain.daemon';

export function launchAgentsPath(env: NodeJS.ProcessEnv): string {
  return env['SECOND_BRAIN_LAUNCH_AGENTS'] || join(homedir(), 'Library', 'LaunchAgents');
}

export function daemonPlistPath(env: NodeJS.ProcessEnv): string {
  return join(launchAgentsPath(env), `${DAEMON_LABEL}.plist`);
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
}

export function renderDaemonPlist(shim: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(shim)}</string><string>daemon</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export type LaunchctlResult = { ok: true } | { ok: false; message: string };

export interface Launchctl {
  readonly uid: number | undefined;
  isLoaded(label: string): Promise<boolean>;
  bootstrap(plistPath: string): Promise<LaunchctlResult>;
  bootout(label: string): Promise<LaunchctlResult>;
}

const execute = promisify(execFile);

export function systemLaunchctl({ env, uid }: {
  env: NodeJS.ProcessEnv;
  uid: number | undefined;
}): Launchctl {
  const executable = env['SECOND_BRAIN_LAUNCHCTL'] || '/bin/launchctl';
  const domain = `gui/${String(uid)}`;
  const run = async (args: string[]): Promise<LaunchctlResult> => {
    try {
      await execute(executable, args, { env, timeout: 10_000 });
      return { ok: true };
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const first = failure.stderr?.trim().split(/\r?\n/)[0];
      return { ok: false, message: `launchctl 실행에 실패했습니다: ${first || failure.message.split(/\r?\n/)[0]}` };
    }
  };
  return {
    uid,
    async isLoaded(label) { return (await run(['print', `${domain}/${label}`])).ok; },
    bootstrap: (path) => run(['bootstrap', domain, path]),
    bootout: (label) => run(['bootout', `${domain}/${label}`]),
  };
}

export interface DaemonRegistration {
  label: string;
  plist_path: string | null;
  status: 'registered' | 'loaded' | 'unsupported' | 'failed';
  plist_changed: boolean;
  message?: string;
}

interface DaemonOptions {
  env: NodeJS.ProcessEnv;
  launchctl: Launchctl;
  platform: NodeJS.Platform;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function writePlist(path: string, content: string): Promise<boolean> {
  try {
    if (await readFile(path, 'utf8') === content) {
      await chmod(path, 0o644);
      return false;
    }
  } catch (error) { if (!missing(error)) throw error; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
  }
  return true;
}

export async function registerDaemon({ shim, env, launchctl, platform }: DaemonOptions & {
  shim: string;
}): Promise<DaemonRegistration> {
  const result: DaemonRegistration = {
    label: DAEMON_LABEL, plist_path: null, status: 'unsupported', plist_changed: false,
  };
  if (platform !== 'darwin' || launchctl.uid === undefined) return result;
  result.plist_path = daemonPlistPath(env);
  try {
    result.plist_changed = await writePlist(result.plist_path, renderDaemonPlist(shim));
    if (await launchctl.isLoaded(DAEMON_LABEL)) return { ...result, status: 'loaded' };
    const bootstrapped = await launchctl.bootstrap(result.plist_path);
    return bootstrapped.ok
      ? { ...result, status: 'registered' }
      : { ...result, status: 'failed', message: bootstrapped.message };
  } catch (error) {
    return { ...result, status: 'failed', message: `데몬 등록에 실패했습니다: ${message(error)}` };
  }
}

export async function unregisterDaemon({ env, launchctl, platform }: DaemonOptions): Promise<
  { ok: true; booted_out: boolean; plist_removed: boolean } | { ok: false; message: string }
> {
  let booted_out = false;
  if (platform !== 'darwin' || launchctl.uid === undefined) {
    return { ok: true, booted_out, plist_removed: false };
  }
  try {
    if (await launchctl.isLoaded(DAEMON_LABEL)) {
      const result = await launchctl.bootout(DAEMON_LABEL);
      if (!result.ok) return result;
      booted_out = true;
    }
    try { await unlink(daemonPlistPath(env)); }
    catch (error) {
      if (missing(error)) return { ok: true, booted_out, plist_removed: false };
      throw error;
    }
    return { ok: true, booted_out, plist_removed: true };
  } catch (error) {
    return { ok: false, message: `데몬 등록 해제에 실패했습니다: ${message(error)}` };
  }
}
