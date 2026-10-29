import type { CommandSpec } from '../dispatch.js';
import { extensionData } from './ext-status.js';
export const extListCommand: CommandSpec = {
  ns: 'ext', verb: 'list', nsDescription: '선택 확장을 관리합니다', usedFor: '설치한 확장 목록을 봅니다', required: [],
  examples: ['brain ext list --json'], output: '확장 목록과 건수를 반환합니다', risk: 'read', hook: false, dryRun: false,
  async run(context) {
    const r = await context.brain.ext.list(); if (!r.ok) return r;
    return { ok: true, data: r.extensions.map(row => extensionData(row.name, row)), meta: { count: r.extensions.length }, text: [...r.extensions.map(row => `확장 ${row.name}: ${row.connectionStatus ?? '미확인'}`), `확장 ${r.extensions.length}건.`] };
  },
};
