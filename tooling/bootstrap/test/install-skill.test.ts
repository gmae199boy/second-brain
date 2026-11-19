import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commands } from '../../../apps/cli/src/commands/index.js';
import { JSON_FLAG } from '../../../apps/cli/src/envelope.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const skill = readFileSync(join(root, 'plugin/skills/brain-install/SKILL.md'), 'utf8');
const loginSkill = readFileSync(join(root, 'plugin/skills/brain-login/SKILL.md'), 'utf8');

function forbiddenInstructions(text: string): string[] {
  const patterns = [/(?:pip|npm|pnpm|brew)\s+(?:install|add)\b/i, /launchctl\s+(?:load|bootstrap)\b/i, /brain\s+schedules\s+add\b/i, /(?:비밀번호|토큰|MFA 코드).{0,20}(?:요청한다|수집한다|저장한다)/];
  return patterns.filter(pattern => pattern.test(text)).map(pattern => pattern.source);
}

describe('확장 설치 스킬', () => {
  it('명시한 모든 명령과 옵션을 등록된 CommandSpec과 비교한다', () => {
    const calls = [...skill.matchAll(/`(brain [^`]+)`/g)].map(match => match[1]!.split(/\s+/));
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map(call => call.slice(1, 3).join(' ')))).toEqual(new Set(['guide schema', 'ext catalog', 'ext status', 'ext install', 'ext login']));
    for (const [, ns, verb, ...args] of calls) {
      const spec = commands.find(command => command.ns === ns && command.verb === verb);
      expect(spec, `${ns} ${verb}`).toBeDefined();
      const positional = args.filter(arg => !arg.startsWith('--'));
      const declared = spec!.arguments ?? [];
      expect(positional.length).toBeGreaterThanOrEqual(declared.filter(arg => arg.startsWith('<')).length);
      expect(positional.length).toBeLessThanOrEqual(declared.length);
      for (const flag of args.filter(arg => arg.startsWith('--'))) {
        const flags = [JSON_FLAG, ...(spec!.options ?? []).flatMap(option => option.flags.match(/--[\w-]+/g) ?? [])];
        expect(flags).toContain(flag);
      }
    }
  });

  it('이름 없는 요청은 검증된 카탈로그를 제시하고 사용자의 선택을 기다린다', () => {
    expect(skill).toContain('`brain ext catalog --json`');
    expect(skill).toContain('사용자가 이름을 선택할 때까지 기다리며 임의로 정하거나 설치하지 않는다');
    expect(skill).toContain('조회가 실패하거나 목록이 비어 있으면 그대로 보고하고 중단한다');
    expect(skill).toContain('카탈로그의 `login_required`는 인증 필요 여부이지 현재 로그인 상태가 아니다');
    expect(skill).toContain('현재 배포 Garmin 패키지는 터미널 인증을 선언한다');
    expect(loginSkill).toContain('Garmin의 현재 배포 패키지는 터미널 인증을 선언한다');
    expect(loginSkill).toContain('이미 connected이고 login이 succeeded 또는 skipped인 상태를 그대로 보고');
    expect(loginSkill).toContain('카탈로그의 `login_required`는 패키지 메타데이터이지 현재 로그인 상태가 아니다');
    expect(loginSkill).toContain('기존 설치 입력을 그대로 사용해 한 번 재개한다');
    expect(loginSkill).toContain('`brain ext install --package <path> --json`');
    expect(loginSkill).toContain('브라우저나 다른 외부 원본');
    expect(loginSkill).toContain('원본을 모르면 확인 전까지 재개하지 않는다');
    expect(loginSkill).toContain('실패·취소이거나 사용자의 응답이 없으면 설치를 재개하지 않는다');
    for (const code of ['LOGIN_REQUIRED', 'AUTH_CANCELLED', 'AUTH_UNAVAILABLE', 'EXTENSION_AUTH_FAILED', 'EXTENSION_INVALID', 'EXTENSION_NOT_INSTALLED']) expect(loginSkill).toContain(code);
    expect(loginSkill).toContain('수집 계정 준비 또는 예약 발화의 증거가 아니다');
    expect(skill).toContain('기존 connected와 login skipped는 그대로 보고한다');
    expect(skill).toContain('수집 계정 준비나 예약 발화가 완료됐다는 근거로 삼지 않는다');
    expect(skill).not.toContain('인증 실행 항목이 없어');
  });

  it('인증 비밀과 우회 설치 및 별도 예약을 금지한다', () => {
    expect(skill).toContain('비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다');
    expect(skill).toContain('별도의 예약을 만들지 않는다');
    expect(commands.some(command => command.ns === 'ext' && command.verb === 'login')).toBe(true);
    expect(loginSkill).toContain('brain guide schema ext --json');
    expect(loginSkill).toContain('비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다');
    expect(forbiddenInstructions(loginSkill)).toEqual([]);
    expect(skill).toContain('다른 설치 방법으로 우회하지 않는다');
    expect(skill).toContain('임의 패키지를 설치하거나 별도 LaunchAgent를 생성하지 않는다');
    expect(forbiddenInstructions(skill)).toEqual([]);
    for (const example of ['pip install package', 'launchctl bootstrap gui/1 file', 'brain schedules add', '비밀번호를 요청한다']) {
      expect(forbiddenInstructions(example)).not.toEqual([]);
    }
    expect(skill).not.toMatch(/`(?:pip|npm|pnpm|brew|launchctl)\s/);
    expect(skill).not.toMatch(/`brain schedules\s/);
    expect(skill).toContain('마지막으로 `brain ext status <name> --json`');
  });

  it('마켓플레이스가 배포하는 플러그인 폴더에 스킬을 포함한다', () => {
    const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')) as { plugins: { name: string; source: string }[] };
    const source = marketplace.plugins.find(plugin => plugin.name === 'second-brain')?.source;
    expect(source).toBe('./plugin');
    expect(existsSync(resolve(root, source!, 'skills/brain-install/SKILL.md'))).toBe(true);
  });
});
