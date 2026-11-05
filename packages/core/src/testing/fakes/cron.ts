import { nextDailyOccurrence, isLocalTime } from '../../local-time.js';
import type { CronCalculator } from '../../ports/cron.js';
/** Small deterministic daily calculator used by core tests. */
export const fakeCron: CronCalculator = {
 validate(expr, zone) { const match=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr); try { new Intl.DateTimeFormat('en',{timeZone:zone}); if(match && isLocalTime(`${match[2]!.padStart(2,'0')}:${match[1]!.padStart(2,'0')}`))return {ok:true}; } catch {} return {ok:false,code:'SCHEDULE_INVALID',message:'invalid fixture expression'}; },
 next(expr,zone,after) { const match=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr); return match?nextDailyOccurrence(after,`${match[2]!.padStart(2,'0')}:${match[1]!.padStart(2,'0')}`,zone):null; },
};
