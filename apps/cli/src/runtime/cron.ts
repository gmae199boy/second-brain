import { Cron } from 'croner';
import { occurrenceAt, type CronCalculator } from 'second_brain';

function parser(expression: string, timeZone: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field, index) => !(index === 3 ? /^(?:[\d*,/\-]|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)+$/i : index === 4 ? /^(?:[\d*,/\-]|SUN|MON|TUE|WED|THU|FRI|SAT)+$/i : /^[\d*,/\-]+$/).test(field))) throw new TypeError('5필드 cron 식이 아닙니다');
  if (/^[+-]/.test(timeZone)) throw new TypeError('IANA 시간대가 필요합니다');
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  return new Cron(fields.join(' '), { mode: '5-part', timezone: 'UTC', paused: true });
}
function wallDate(at: Date, zone: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(at).map(p => [p.type,p.value]));
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}
export const cronCalculator: CronCalculator = {
  validate(expression, timeZone) {
    try { parser(expression,timeZone); return {ok:true}; }
    catch { return {ok:false,code:'SCHEDULE_INVALID',message:'cron 식 또는 시간대가 올바르지 않습니다'}; }
  },
  next(expression, timeZone, after) {
    const cron=parser(expression,timeZone);
    // Revisit the preceding wall interval so the second half of a fold never
    // creates a second occurrence; occurrenceAt always resolves to the first.
    const wall=wallDate(after,timeZone);
    const offset = (at: Date) => wallDate(at,timeZone).getTime() - at.getTime();
    const nearTransition = offset(new Date(after.getTime()-4*3600000)) !== offset(new Date(after.getTime()+4*3600000));
    let cursor=new Date(wall.getTime()-(nearTransition ? 3*3600000 : 60_000));
    for (;;) {
      const wall=cron.nextRun(cursor); if (!wall) return null;
      const iso=wall.toISOString(), candidate=occurrenceAt(iso.slice(0,10),iso.slice(11,16),timeZone);
      if(candidate>after)return candidate;
      cursor=wall;
    }
  },
};
