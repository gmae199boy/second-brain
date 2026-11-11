import { machineConfig } from './config-machine.js';
import { settingDefinitions } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

export const configSetCommand: CommandSpec = {
  ns: 'config', verb: 'set', nsDescription: '사용자 설정과 설치 선택을 관리합니다',
  usedFor: '사용자 설정을 바꿉니다',
  arguments: ['<key>', '<value>'], required: ['key', 'value'],
  examples: ['brain config set timezone America/New_York --json', 'brain config set telegram.bot_token -', 'brain config set update.auto false --json'],
  output: 'key, value(토큰은 configured), source와 updated_at을 반환합니다',
  risk: 'write', writes: true, hook: false, dryRun: false, drain: false,
  preflight(context) {
    const definition = settingDefinitions().get(context.args[0] ?? '');
    if (definition === undefined && (context.args[0] ?? '').includes('.')) return undefined;
    if (definition === undefined) return { ok: false, code: 'CONFIG_INVALID', message: `모르는 사용자 설정 키입니다: ${context.args[0] ?? ''}`, exit: 2 };
    if (context.args[1] === '-') return undefined;
    const parsed = definition.normalize(context.args[1] ?? '');
    if (!parsed.ok) return { ok: false, code: 'CONFIG_INVALID', message: parsed.message, exit: 2 };
    return undefined;
  },
  runMachine: context => machineConfig(context, true),
  async runSettings(context) {
    const input = context.args[1] === '-' ? await context.stdin() : context.args[1] ?? '';
    if (context.args[1] === '-' && input === '') return { ok: false, code: 'CONFIG_INVALID', message: 'stdin으로 설정 값을 연결하세요', exit: 2 };
    const value = context.args[1] === '-' ? input.replace(/\r?\n$/, '') : input;
    const result = await context.brain.config.set({ key: context.args[0] ?? '', value });
    if (!result.ok) return result;
    return { ok: true, data: { key: result.key, scope: result.scope, ...(result.key === 'telegram.bot_token' ? { configured: result.value !== '' } : { value: result.value }), source: result.source, updated_at: result.updatedAt?.toISOString() ?? null }, text: [`${result.key} = ${result.key === 'telegram.bot_token' ? (result.value ? '[설정됨]' : '[미설정]') : result.value} (${result.source})`] };
  },
  async run() { return { ok: false, code: 'CONFIG_INVALID', message: '사용자 설정은 PostgreSQL 저장소에 둡니다', exit: 2 }; },
};
