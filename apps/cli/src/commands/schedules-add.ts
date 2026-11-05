import { isoWithOffset } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
export const schedulesAddCommand: CommandSpec = {
  ns:'schedules',verb:'add',nsDescription:'예약한 일을 관리합니다',usedFor:'cron 또는 한 번 실행할 일을 예약합니다',
  required:['kind','target-kind','target-id'],examples:['brain schedules add --kind process_probe --target-kind probe --target-id daily --cron "0 9 * * 5" --tz Asia/Seoul','brain schedules add --kind process_probe --target-kind probe --target-id once --once 2030-01-01T09:00:00+09:00'],
  output:'예약 id와 다음 실행 시각을 반환합니다',risk:'write',writes:true,drain:false,hook:false,dryRun:false,
  options:[{flags:'--kind <kind>',description:'일감 종류',required:true},{flags:'--target-kind <kind>',description:'대상 종류',required:true},{flags:'--target-id <id>',description:'대상 id',required:true},{flags:'--cron <expr>',description:'5필드 cron 식'},{flags:'--tz <zone>',description:'고정 IANA 시간대'},{flags:'--once <ISO>',description:'오프셋이 있는 미래 시각'},{flags:'--at <HH:MM>',description:'매일 현지 예약 시각'}],
  async run(context){const o=context.options;const [cron,once,at,tz]=[o['cron'],o['once'],o['at'],o['tz']];
    if([cron,once,at].filter(x=>x!==undefined).length!==1 || (tz!==undefined && cron===undefined))return {ok:false,code:'USAGE',message:'--cron [--tz], --once, --at 중 하나를 지정하세요',exit:2};
    const r=await context.brain.schedules.add({kind:String(o['kind']),targetKind:String(o['targetKind']),targetId:String(o['targetId']),...(cron===undefined?{}:{cron:String(cron)}),...(once===undefined?{}:{once:String(once)}),...(at===undefined?{}:{localTime:String(at)}),...(tz===undefined?{}:{timeZone:String(tz)})});
    if(!r.ok)return r;return {ok:true,data:{id:r.schedule.id,next_run_at:r.schedule.nextRunAt===null?null:isoWithOffset(r.schedule.nextRunAt)},text:[`예약 ${r.schedule.id}을 추가했습니다.`]};
  },
};
