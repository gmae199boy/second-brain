import type { CommandSpec } from '../dispatch.js';
import { extensionData } from './ext-status.js';
export const extListCommand: CommandSpec = {
  ns: 'ext', verb: 'list', nsDescription: '선택 확장을 관리합니다', usedFor: '설치한 확장 목록을 봅니다', required: [],
  examples: ['brain ext list --json'], output: '확장 목록과 건수를 반환합니다', risk: 'read', hook: false, dryRun: false,
  async run(context) {
    const r = await context.brain.ext.list(); if (!r.ok) return r;
    const statuses = await Promise.all(r.extensions.map(row => context.brain.ext.status({ name: row.name })));
    const failure = statuses.find(status => !status.ok); if (failure && !failure.ok) return failure;
    return { ok: true, data: statuses.flatMap(status => status.ok ? [extensionData(status.name, status.extension, status.pythonEnvironment)] : []), meta: { count: r.extensions.length }, text: [...r.extensions.map(row => `확장 ${row.name}: ${row.connectionStatus ?? '미확인'}`), `확장 ${r.extensions.length}건.`] };
  },
};
