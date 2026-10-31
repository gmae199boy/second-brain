import type { CommandSpec } from '../dispatch.js';
export const extRunCommand: CommandSpec = {
  ns: 'ext', verb: 'run', nsDescription: '선택 확장을 관리합니다', usedFor: '허용된 확장 일감을 요청합니다',
  required: ['name', 'job'], arguments: ['<name>', '<job>'], options: [{ flags: '--target <target>', description: '대상 식별자' }],
  examples: ['brain ext run testext example --json'], output: '일감 id와 상태 및 허용된 공개 집계를 반환합니다',
  risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run(context) {
    const target = context.options['target'];
    const result = await context.brain.ext.run({ name: String(context.args[0]), job: String(context.args[1]), ...(target === undefined ? {} : { target: String(target) }) });
    if (!result.ok) {
      if ('report' in result && result.report && 'workId' in result) return { ...result, data: { work_id: result.workId, status: 'failed', report: result.report }, text: [...Object.entries(result.report.counts).map(([key, value]) => `${key}: ${value}`), ...Object.entries(result.report.checks).map(([key, value]) => `${key}: ${value}`)] };
      return result;
    }
    return { ok: true, data: { work_id: result.workId, created: result.created, status: result.status, ...('report' in result ? { report: result.report } : {}) }, text: [`확장 일감 ${result.workId}: ${result.status}`, ...('report' in result && result.report ? [...Object.entries(result.report.counts).map(([key, value]) => `${key}: ${value}`), ...Object.entries(result.report.checks).map(([key, value]) => `${key}: ${value}`)] : [])] };
  },
};
