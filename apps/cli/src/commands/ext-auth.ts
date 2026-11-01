import type { CommandSpec } from '../dispatch.js';

// 상대와 실행물 신원이 검증된 capability가 없는 플랫폼은 입력 전에 실패한다.
export const extAuthCommand: CommandSpec = {
  ns:'ext',verb:'auth',nsDescription:'선택 확장을 관리합니다',usedFor:'승인된 확장 인증을 시작합니다',
  required:['name'],arguments:['<name>'],examples:['brain ext auth garmin'],
  output:'인증 채널의 상태를 반환합니다',risk:'write',writes:true,drain:false,hook:false,dryRun:false,
  async run(context) {
    const result = await context.brain.ext.auth({name:String(context.args[0])});
    return result.ok ? {ok:true, data:{status:'completed'}, text:['확장 인증이 완료되었습니다.']} : result;
  },
};
