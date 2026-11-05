import { settingDefinitions } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

export const configSetCommand: CommandSpec = {
  ns: 'config', verb: 'set', nsDescription: 'DB에 저장된 사용자 설정을 관리합니다',
  usedFor: '사용자 설정을 바꿉니다',
  arguments: ['<key>', '<value>'], required: ['key', 'value'],
  examples: ['brain config set timezone America/New_York --json'],
  output: 'key, value, source와 updated_at을 반환합니다',
  risk: 'write', writes: true, hook: false, dryRun: false, drain: false,
  preflight(context) {
    const definition = settingDefinitions().get(context.args[0] ?? '');
    if (definition === undefined && (context.args[0] ?? '').includes('.')) return undefined;
    if (definition === undefined) return { ok: false, code: 'CONFIG_INVALID', message: `모르는 사용자 설정 키입니다: ${context.args[0] ?? ''}`, exit: 2 };
    const parsed = definition.normalize(context.args[1] ?? '');
    if (!parsed.ok) return { ok: false, code: 'CONFIG_INVALID', message: parsed.message, exit: 2 };
    return undefined;
  },
  async runSettings(context) {
    const result = await context.brain.config.set({ key: context.args[0] ?? '', value: context.args[1] ?? '' });
    if (!result.ok) return result;
    return { ok: true, data: { key: result.key, scope: result.scope, value: result.value, source: result.source, updated_at: result.updatedAt?.toISOString() ?? null }, text: [`${result.key} = ${result.value} (${result.source})`] };
  },
  async run() { return { ok: false, code: 'CONFIG_INVALID', message: '사용자 설정은 PostgreSQL 저장소에 둡니다', exit: 2 }; },
};
