import type { EnvelopeMeta } from 'second_brain';
import { retryArgv } from '../envelope.js';

/** 읽기 결과의 다음 호출을 텍스트에서도 그대로 실행할 수 있게 보여 준다. */
export function recallText(lines: readonly string[], meta: EnvelopeMeta): string[] {
  const result = [...lines];
  if (meta.has_more !== undefined) result.push(`더 있는 결과: ${meta.has_more ? '있음' : '없음'}`);
  if (meta.omitted) result.push(`생략: ${String(meta.omitted.count)}건 (${meta.omitted.reason})`);
  if (meta.hint) result.push(`안내: ${meta.hint}`);
  if (meta.next) {
    const args = { ...meta.next.args };
    if ('from_at' in args) { args.fromAt = args.from_at; delete args.from_at; }
    const argv = retryArgv({ ...meta.next, args }, ['<session>']);
    const quoted = argv.map(arg => /^[a-zA-Z0-9_./:=@-]+$/u.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
    result.push(`다음: ${quoted}`);
  }
  return result;
}
