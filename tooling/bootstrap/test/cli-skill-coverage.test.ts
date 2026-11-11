import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { commands } from '../../../apps/cli/src/commands/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const skills = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => `${directory}/${entry.name}/SKILL.md`);
const core = skills('plugin/skills');
const garmin = skills('plugins/garmin/skills');
const body = (path: string) => read(path).replace(/^---\n[\s\S]*?\n---\n/, '');
const internal = JSON.parse(read('tooling/skill-coverage/internal.json')) as { command: string; reason: string }[];
// Require a whole command in executable notation, not a mention in frontmatter,
// another command's prefix (send-pending vs send), or a separate coverage map.
function mentions(text: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('`brain ' + escaped + '(?=\\s|`)').test(text);
}
const uncovered = (names: string[], paths: string[], exceptions: typeof internal) => names.filter(name =>
  !paths.some(path => mentions(body(path), name)) && !exceptions.some(entry => entry.command === name));
const names = commands.map(command => `${command.ns} ${command.verb}`);

it('모든 공개 CommandSpec은 배포 스킬 본문 또는 사유가 있는 내부 전용 목록으로 덮는다', () => {
  expect(uncovered(names, core, internal)).toEqual([]);
  expect(new Set(internal.map(entry => entry.command)).size).toBe(internal.length);
  for (const entry of internal) {
    expect(names).toContain(entry.command);
    expect(entry.reason.trim().length).toBeGreaterThan(25);
    expect(core.some(path => mentions(body(path), entry.command))).toBe(false);
  }
  // A new command, a removed skill and a prefix collision must fail the gate.
  expect(uncovered([...names, 'future newly-added'], core, internal)).toContain('future newly-added');
  expect(uncovered(['config set'], core.filter(path => !path.includes('/brain-config/')), [])).toEqual(['config set']);
  expect(mentions('`brain channels send-pending --json`', 'channels send')).toBe(false);
});

it('Garmin의 두 manifest에 있는 manual과 공개 조회 명령도 Garmin 배포 스킬이 덮는다', () => {
  for (const path of ['plugins/garmin/package/manifest.json', 'extensions/garmin/manifest.json']) {
    const manifest = JSON.parse(read(path)) as { work: { manual?: string }[]; commands: { name: string }[] };
    const manual = manifest.work.flatMap(work => work.manual ? [`ext run garmin ${work.manual}`] : []);
    const queries = manifest.commands.map(command => `ext garmin ${command.name}`);
    expect(manual.length).toBeGreaterThan(0);
    expect(uncovered([...manual, ...queries], garmin, [])).toEqual([]);
    expect(uncovered([...manual, 'ext run garmin new-manual'], garmin, [])).toContain('ext run garmin new-manual');
  }
});

it('신규·확장 스킬은 지원 확인을 먼저 하고 예시의 명령·옵션은 실제 schema에 있다', () => {
  const changed = ['channels', 'config', 'schedules', 'status', 'ext', 'sources', 'files', 'messages', 'sessions', 'setup', 'guide'];
  for (const name of changed) {
    const text = body(`plugin/skills/brain-${name}/SKILL.md`);
    expect(text).toMatch(/먼저[^\n]*`brain guide schema/);
    expect(text).toContain('미구현');
    for (const match of text.matchAll(/`brain ([^`]+)`/g)) {
      const [ns, verb, ...args] = match[1]!.split(/\s+/);
      const command = commands.find(command => command.ns === ns && command.verb === verb);
      expect(command, `${name}: ${ns} ${verb}`).toBeDefined();
      const flags = ['--json', ...(command!.options ?? []).flatMap(option => option.flags.match(/--[\w-]+/g) ?? [])];
      for (const flag of args.filter(arg => arg.startsWith('--'))) expect(flags, `${name}: ${flag}`).toContain(flag);
    }
  }
});

it('배포 스킬의 폴더명과 name은 하네스 namespace 없이도 구별된다', () => {
  for (const [paths, prefix] of [[core, 'brain-'], [garmin, 'brain-garmin-']] as const) {
    for (const path of paths) {
      const name = basename(dirname(path));
      expect(name.startsWith(prefix), path).toBe(true);
      expect(read(path).match(/^name: (.+)$/m)?.[1], path).toBe(name);
    }
  }
  const deployedNames = [...core, ...garmin].map(path => basename(dirname(path)));
  expect(new Set(deployedNames).size).toBe(deployedNames.length);
});

it('Codex 실행 경로 설정과 doctor 복구를 배포 설정 스킬이 덮는다', () => {
  const text = body('plugin/skills/brain-config/SKILL.md');
  expect(text).toContain('`brain config get agent.codex_path --json`');
  expect(text).toContain('`brain config set agent.codex_path <절대경로> --json`');
  expect(text).toContain('`brain doctor run --json`');
  expect(text).toContain('--version');
});
