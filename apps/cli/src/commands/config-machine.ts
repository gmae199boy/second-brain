import { isAbsolute } from 'node:path';
import { configHome } from '../config/paths.js';
import { readConfig, setInstallChoice } from '../config/codec.js';
import { expandHome } from '../install/flow.js';
import type { CommandOutcome, StandaloneCommandContext } from '../dispatch.js';

/** bootstrap과 mirror가 실제 사용하는 머신 설정을 같은 config 명령으로 편집한다. */
export async function machineConfig(context: StandaloneCommandContext, write: boolean): Promise<CommandOutcome<unknown> | undefined> {
  const key = context.args[0];
  if (key !== 'mirror.path' && key !== 'update.auto') return undefined;
  const home = configHome(context.env);
  if (write) {
    const raw = context.args[1] === '-' ? (await context.stdin()).replace(/\r?\n$/, '') : context.args[1] ?? '';
    const value = key === 'mirror.path' ? expandHome(raw) : raw;
    if (key === 'mirror.path' ? !isAbsolute(value) : !['true', 'false'].includes(value)) return { ok: false, code: 'CONFIG_INVALID', message: key === 'mirror.path' ? 'mirror.path는 절대 경로여야 합니다' : 'update.auto는 true 또는 false여야 합니다', exit: 2 };
    const result = await setInstallChoice(home, key, value);
    if (!result.ok) return result;
  }
  const result = await readConfig(home);
  if (!result.ok) return result;
  const value = key === 'mirror.path' ? result.config.mirrorPath : result.config.updateAuto;
  return { ok: true, data: { key, scope: 'machine', value, source: 'file', updated_at: null }, text: [`${key} = ${String(value)} (file)`] };
}
