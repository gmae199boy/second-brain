import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { commands } from '../../../apps/cli/src/commands/index.js';
import { JSON_FLAG } from '../../../apps/cli/src/envelope.js';

const read = (path:string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const skill = read('../../../plugin/skills/brain-recall/SKILL.md');
const manifest = JSON.parse(read('../../../extensions/garmin/manifest.json')) as {commands:{name:string; input_schema:{properties:Record<string, unknown>}}[]};

it('recall 명령과 입력은 등록된 명세에 있고 필수 안내를 포함한다', () => {
  const calls = [...skill.matchAll(/`(brain [^`]+)`/g)].map(match => match[1]!.split(/\s+/));
  expect(calls.length).toBeGreaterThan(0);
  expect(new Set(calls.map(c => c.slice(1, 3).join(' ')))).toEqual(new Set(['recall chunks', 'recall tools', 'recall docs', 'recall expand', 'sessions read', 'files show', 'ext status', 'config get', 'guide schema', 'ext garmin']));
  for (const [, ns, verb, ...args] of calls) {
    if (ns === 'ext' && verb === 'garmin') {
      const [name, ...rest] = args;
      const command = manifest.commands.find(c => c.name === name);
      expect(command, name).toBeDefined();
      expect(rest.filter(a => a.startsWith('--'))).toEqual(['--input', '--json']);
      expect(rest).toHaveLength(3);
      const input = rest[1]!;
      if (input !== "'<json>'") {
        const value = JSON.parse(input.replace(/^'|'$/g, '')) as Record<string, unknown>;
        for (const key of Object.keys(value)) expect(Object.keys(command!.input_schema.properties)).toContain(key);
      }
      continue;
    }
    const spec = commands.find(c => c.ns === ns && c.verb === verb);
    expect(spec, `${ns} ${verb}`).toBeDefined();
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) { const arg = args[i]!; if (!arg.startsWith('--')) positional.push(arg); else if (arg !== JSON_FLAG && /<[^>]+>/.test((spec!.options ?? []).find(o => o.flags.includes(arg))?.flags ?? '')) i++; }
    const declared = spec!.arguments ?? [];
    expect(positional.length).toBeGreaterThanOrEqual(declared.filter(a => a.startsWith('<')).length);
    expect(positional.length).toBeLessThanOrEqual(declared.length);
    for (const flag of args.filter(a => a.startsWith('--'))) expect([JSON_FLAG, ...(spec!.options ?? []).flatMap(o => o.flags.match(/--[\w-]+/g) ?? [])]).toContain(flag);
  }
  for (const phrase of ['표현을 바꿔', '출처만으로 원문', 'meta.extensions', '비활성이라도 보존된 리포트', '고아 도구 메모', '검색 실패', '설치를 안내']) expect(skill).toContain(phrase);
  expect(skill).toContain('brain guide schema ext.garmin daily-values --json');
  expect(skill).toContain('schema는 지표별 허용 집계를 알려주지 않으며 명령이 조합을 판정한다');
  expect(skill).toContain('집계를 거부하면 다른 집계가 가능한지 사용자에게 확인한다');
  expect(skill).toContain('미설치·비활성 각각의 경우 상태 안내와 별도 문장으로 반드시 “Garmin 건강 수치 조회 명령이 없어 쓸 수 없습니다.”라고 보고한다');
  expect(skill).toContain('`value` 0은 기록된 0');
  expect(skill).toContain('시간대 데이터베이스');
  expect(skill).toContain('고정 UTC 오프셋을 가정하거나 머릿속으로 계산하지 않는다');
  expect(skill).toContain('TZ=<garmin.timezone> date -r <epoch초> +%F');
  expect(skill).toContain('재조회해 맞는 답을 찾지 않는다');
  expect(skill).not.toMatch(/`(?:psql|curl|sqlite3)\b/i);
  expect(skill).not.toMatch(/비활성[^\n]*(?:삭제|제외)하/);
  for (const phrase of ['기록 0건', '모두 비어 있음', '0 아님', '미설치', '비활성', '오류']) expect(skill).toContain(phrase);
});
