import type { CommandSpec } from '../dispatch.js';

function activationCommand(enabled: boolean): CommandSpec {
  const verb = enabled ? 'enable' : 'disable';
  return {
    ns: 'ext', verb, nsDescription: '선택 확장을 관리합니다', usedFor: enabled ? '확장을 켜고 일감을 재개합니다' : '확장을 끄고 일감을 보류합니다',
    required: ['name'], arguments: ['<name>'], examples: [`brain ext ${verb} testext --json`],
    output: '확장 활성 의도와 변경 여부를 반환합니다', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
    async run(context) {
      const input = { name: String(context.args[0]) };
      const result = enabled ? await context.brain.ext.enable(input) : await context.brain.ext.disable(input);
      if (!result.ok) return result;
      return { ok: true, data: result, text: [`확장 ${result.name}: ${enabled ? '활성' : '비활성'}${result.changed ? '으로 변경' : ' 상태 유지'}했습니다.`] };
    },
  };
}
export const extEnableCommand = activationCommand(true);
export const extDisableCommand = activationCommand(false);
