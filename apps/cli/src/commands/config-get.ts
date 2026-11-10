import { settingDefinitions } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

export const configGetCommand: CommandSpec = {
  ns: 'config', verb: 'get', nsDescription: 'DB에 저장된 사용자 설정을 관리합니다',
  usedFor: '사용자 설정을 읽습니다',
  arguments: ['<key>'], required: ['key'],
  examples: ['brain config get timezone --json'],
  output: 'key, value(토큰은 configured), source와 updated_at을 반환합니다',
  risk: 'read', writes: false, hook: false, dryRun: false, drain: false,
  preflight(context) {
    const definition = settingDefinitions().get(context.args[0] ?? '');
    if (definition === undefined && (context.args[0] ?? '').includes('.')) return undefined;
    if (definition === undefined) return { ok: false, code: 'CONFIG_INVALID', message: `모르는 사용자 설정 키입니다: ${context.args[0] ?? ''}`, exit: 2 };
    return undefined;
  },
  async runSettings(context) {
    const result = await context.brain.config.get({ key: context.args[0] ?? '' });
    if (!result.ok) return result;
    return { ok: true, data: { key: result.key, scope: result.scope, ...(result.key === 'telegram.bot_token' ? { configured: result.value !== '' } : { value: result.value }), source: result.source, updated_at: result.updatedAt?.toISOString() ?? null }, text: [`${result.key} = ${result.key === 'telegram.bot_token' ? (result.value ? '[설정됨]' : '[미설정]') : result.value} (${result.source})`] };
  },
  async run() { return { ok: false, code: 'CONFIG_INVALID', message: '사용자 설정은 PostgreSQL 저장소에 둡니다', exit: 2 }; },
};
