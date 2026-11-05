import { isoWithOffset } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
import { scheduleIdPreflight } from './list-options.js';
export const schedulesUpdateCommand: CommandSpec = {
 ns:'schedules',verb:'update',nsDescription:'예약한 일을 관리합니다',usedFor:'예약 시각과 활성 상태를 변경합니다',required:['id'],arguments:['<id>'],
 examples:['brain schedules update <id> --cron "0 9 * * 5" --tz Asia/Seoul','brain schedules update <id> --disable'],output:'변경한 예약 id와 다음 실행 시각을 반환합니다',risk:'write',writes:true,drain:false,hook:false,dryRun:false,preflight:scheduleIdPreflight,
 options:[{flags:'--cron <expr>',description:'새 5필드 cron 식'},{flags:'--once <ISO>',description:'새 오프셋 포함 미래 시각'},{flags:'--tz <zone>',description:'고정 IANA 시간대'},{flags:'--enable',description:'예약 활성화'},{flags:'--disable',description:'예약 비활성화'}],
 async run(context){const o=context.options, cron=o['cron'],once=o['once'],tz=o['tz'],enable=o['enable']===true,disable=o['disable']===true;
  if((cron!==undefined&&once!==undefined)||(once!==undefined&&tz!==undefined)||(enable&&disable)||(cron===undefined&&once===undefined&&tz===undefined&&!enable&&!disable))return {ok:false,code:'USAGE',message:'변경할 옵션을 지정하고 충돌하는 옵션은 함께 쓰지 마세요',exit:2};
  const r=await context.brain.schedules.update({id:context.args[0]!,...(cron===undefined?{}:{cron:String(cron)}),...(once===undefined?{}:{once:String(once)}),...(tz===undefined?{}:{timeZone:String(tz)}),...(enable||disable?{enabled:enable}:{})});
  if(!r.ok)return r;return {ok:true,data:{id:r.schedule.id,next_run_at:r.schedule.nextRunAt?isoWithOffset(r.schedule.nextRunAt):null,enabled:r.schedule.enabled},text:[`예약 ${r.schedule.id}을 변경했습니다.`]};
 },
};
