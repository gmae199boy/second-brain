import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { commands } from '../../../apps/cli/src/commands/index.js';
import { JSON_FLAG } from '../../../apps/cli/src/envelope.js';
const skill = readFileSync(fileURLToPath(new URL('../../../plugin/skills/brain-channels/SKILL.md', import.meta.url)), 'utf8');
it('스킬 명령과 인자는 등록된 CommandSpec에 존재한다', () => {
  const calls = [...skill.matchAll(/`(brain [^`]+)`/g)].map(m => m[1]!.split(/\s+/));
  expect(new Set(calls.map(c => c.slice(1, 3).join(' ')))).toEqual(new Set(['guide schema', 'messengers list', 'messengers add', 'channels list', 'channels add', 'channels route', 'channels subscribe', 'channels send', 'channels send-pending', 'channels status', 'channels resend']));
  for (const [, ns, verb, ...args] of calls) {
    const spec = commands.find(c => c.ns === ns && c.verb === verb); expect(spec).toBeDefined();
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith('--')) positional.push(arg);
      else if ((spec!.options ?? []).some(o => o.flags.split(/[, ]/).includes(arg) && /<[^>]+>/.test(o.flags))) i++;
    }
    const declared = spec!.arguments ?? [];
    expect(positional.length).toBeGreaterThanOrEqual(declared.filter(a => a.startsWith('<')).length); expect(positional.length).toBeLessThanOrEqual(declared.length);
    for (const flag of args.filter(a => a.startsWith('--'))) expect([JSON_FLAG, ...(spec!.options ?? []).flatMap(o => o.flags.match(/--[\w-]+/g) ?? [])]).toContain(flag);
  }
  expect(skill).toContain('재전송 접수만으로 발신 성공을 주장하지 않는다');
});

it('구독 스킬은 발송 시각과 분석 예약의 경계 및 보관 이벤트를 안내한다', () => {
  expect(skill).toContain('--at 08:20');
  expect(skill).toContain('--tz Asia/Seoul');
  expect(skill).toContain('--at immediate');
  expect(skill).toContain('send-pending --event');
  expect(skill).toContain('분석 시각');
});
