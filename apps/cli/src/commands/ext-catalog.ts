import type { CommandSpec } from '../dispatch.js';

export const extCatalogCommand: CommandSpec = {
  ns: 'ext', verb: 'catalog', usedFor: '설치 가능한 확장과 설치 여부를 봅니다', required: [],
  examples: ['brain ext catalog --json'], output: '검증한 확장의 이름, 버전, 설명, 로그인 필요 여부와 설치 여부를 반환합니다. 패키지 오류는 EXTENSION_INVALID입니다',
  risk: 'read', hook: false, dryRun: false,
  outputSchema: {
    type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['name', 'version', 'description', 'login_required', 'installed'],
      properties: { name: { type: 'string' }, version: { type: 'string' }, description: { type: 'string' }, login_required: { type: 'boolean' }, installed: { type: 'boolean' } },
    },
  },
  async run(context) {
    const result = await context.brain.ext.catalog();
    if (!result.ok) return result;
    return { ok: true, data: result.extensions, meta: { count: result.extensions.length }, text: [...result.extensions.map(item => `${item.name} ${item.version}: ${item.description} · 로그인 ${item.login_required ? '필요' : '불필요'} · ${item.installed ? '설치됨' : '미설치'}`), `확장 ${result.extensions.length}건.`] };
  },
};
