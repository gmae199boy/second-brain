import type { CommandSpec } from '../dispatch.js';

export const configPatchCommand: CommandSpec = {
  ns: 'config', verb: 'patch', nsDescription: '사용자 설정과 설치 선택을 관리합니다',
  usedFor: '구조화 설정의 항목을 원자적으로 수정합니다',
  arguments: ['<key>', '<patch>'], required: ['key', 'patch'],
  examples: ['brain config patch garmin.analysis_profile \'{"set":{"goals.target_weight_kg":75}}\' --json', 'brain config patch garmin.analysis_profile \'{"unset":["goals.target_weight_kg"]}\' --json'],
  output: '설정 키·범위·값·출처·변경 시각을 반환합니다. 동시 변경은 DB_LOCKED입니다',
  risk: 'write', writes: true, hook: false, dryRun: false, drain: false,
  async runSettings(context) {
    const raw = context.args[1] === '-' ? await context.stdin() : context.args[1] ?? '';
    let patch: unknown;
    try { patch = JSON.parse(raw); } catch { return { ok: false, code: 'CONFIG_INVALID', message: '항목 수정은 JSON이어야 합니다', exit: 2 }; }
    const result = await context.brain.config.patch({ key: context.args[0] ?? '', patch: patch as import('second_brain').ProfilePatch });
    if (!result.ok) return result;
    return { ok: true, data: { key: result.key, scope: result.scope, value: result.value, source: result.source, updated_at: result.updatedAt?.toISOString() ?? null }, text: [`${result.key} = ${result.value}`] };
  },
  async run() { return { ok: false, code: 'CONFIG_INVALID', message: '사용자 설정은 PostgreSQL 저장소에 둡니다', exit: 2 }; },
};
