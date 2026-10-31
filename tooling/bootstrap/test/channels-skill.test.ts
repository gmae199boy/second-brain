import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { commands } from '../../../apps/cli/src/commands/index.js';
import { JSON_FLAG } from '../../../apps/cli/src/envelope.js';
const skill = readFileSync(fileURLToPath(new URL('../../../plugin/skills/channels/SKILL.md', import.meta.url)), 'utf8');
it('스킬 명령과 인자는 등록된 CommandSpec에 존재한다', () => {
  const calls = [...skill.matchAll(/`(brain [^`]+)`/g)].map(m => m[1]!.split(/\s+/));
  expect(new Set(calls.map(c => c.slice(1, 3).join(' ')))).toEqual(new Set(['guide schema', 'channels list', 'channels status', 'channels resend']));
  for (const [, ns, verb, ...args] of calls) {
    const spec = commands.find(c => c.ns === ns && c.verb === verb); expect(spec).toBeDefined();
    const positional = args.filter(a => !a.startsWith('--')); const declared = spec!.arguments ?? [];
    expect(positional.length).toBeGreaterThanOrEqual(declared.filter(a => a.startsWith('<')).length); expect(positional.length).toBeLessThanOrEqual(declared.length);
    for (const flag of args.filter(a => a.startsWith('--'))) expect([JSON_FLAG, ...(spec!.options ?? []).flatMap(o => o.flags.match(/--[\w-]+/g) ?? [])]).toContain(flag);
  }
  expect(skill).toContain('재전송 접수만으로 발신 성공을 주장하지 않는다');
});
