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

it('설치 가능한 확장 목록은 공개 설치 스킬이 직접 덮는다', () => {
  expect(names).toContain('ext catalog');
  expect(mentions(body('plugin/skills/brain-install/SKILL.md'), 'ext catalog')).toBe(true);
  expect(internal.some(entry => entry.command === 'ext catalog')).toBe(false);
});

it('Garmin 설치 및 공통 로그인 스킬이 공식 로그인과 이름 재개를 직접 덮는다', () => {
  const login = body('plugin/skills/brain-login/SKILL.md');
  const install = body('plugins/garmin/skills/brain-garmin-install/SKILL.md');
  for (const [text, suffix] of [[login, '<name>'], [install, 'garmin']] as const) {
    expect(text).toContain(`brain ext login ${suffix}`);
    expect(text).toContain(`brain ext install ${suffix} --json`);
    expect(mentions(text, 'guide schema')).toBe(true);
    expect(mentions(text, 'ext status')).toBe(true);
  }
  expect(internal.some(entry => entry.command === 'ext login')).toBe(false);
});

it('Garmin의 두 manifest에 있는 manual과 공개 조회 명령도 Garmin 배포 스킬이 덮는다', () => {
  for (const path of ['plugins/garmin/package/manifest.json', 'extensions/garmin/manifest.json']) {
    const manifest = JSON.parse(read(path)) as { work: { kind: string; manual?: string }[]; commands: { name: string }[]; settings: { key: string }[]; files?: string[] };
    const manual = manifest.work.flatMap(work => work.manual ? [`ext run garmin ${work.manual}`] : []);
    const queries = manifest.commands.map(command => `ext garmin ${command.name}`);
    for (const removed of ['import', 'import-preflight', 'import-verify']) expect(manual).not.toContain(`ext run garmin ${removed}`);
    for (const kind of ['garmin.import', 'garmin.import_preflight', 'garmin.import_verify']) expect(manifest.work.map(work => work.kind)).not.toContain(kind);
    for (const key of ['garmin.capture_manifest', 'garmin.legacy_conversation_id']) expect(manifest.settings.map(setting => setting.key)).not.toContain(key);
    for (const entry of ['src/import.py', 'src/import_preflight.py', 'src/import_verify.py']) expect(manifest.files ?? []).not.toContain(entry);
    expect(manual).toContain('ext run garmin collect');
    expect(manual).toContain('ext run garmin report-send');
    expect(manual).toContain('ext run garmin backfill');
    expect(manual).toContain('ext run garmin report-resend');
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

it('Garmin 분석 요청은 일일·기간·주간/월간 리뷰와 완료 후 결과 이벤트 계약을 찾을 수 있다', () => {
  const text=read('plugins/garmin/skills/brain-garmin-operations/SKILL.md');
  const description=text.match(/^description: (.+)$/m)?.[1] ?? '';
  expect(description).not.toContain('이관');
  for (const removed of ['import', 'import-preflight', 'import-verify']) expect(mentions(text, `ext run garmin ${removed}`)).toBe(false);
  for (const trigger of ['분석','기간 분석','주간/월간 리뷰']) expect(description).toContain(trigger);
  expect(text).toContain('ext run garmin period-analysis');
  expect(text).toContain('recent-period-evaluations');
  expect(text).toContain('시간대 DB');
  expect(text).toContain('`send` 선택 플래그는 없다');
  expect(text).toContain('garmin.report.completed');
  expect(text).toContain('garmin.period_report.completed');
  expect(text).toContain('발송은 core 구독 설정');
  expect(text).toContain('다시 보내기 요청');
  expect(text).toContain('새 revision·첨부·서식 버전은 새 이벤트');
  expect(text).not.toContain('항상 발신한다');
});

it('Garmin 백필 스킬은 계획·실행·재개와 backlog 완료를 구별한다', () => {
  const text=body('plugins/garmin/skills/brain-garmin-operations/SKILL.md');
  for (const token of ['"dry_run":true', '"dry_run":false', 'expected_calls_min', 'remaining_endpoints', 'not_provided', 'projection_complete', 'execution_status', 'backlog_status']) expect(text).toContain(token);
});

it('프로필 항목 수정은 공개 config patch와 설정 스킬에 함께 노출된다', () => {
  expect(names).toContain('config patch');
  const text = body('plugin/skills/brain-config/SKILL.md');
  expect(mentions(text, 'config patch')).toBe(true);
  for (const term of ['garmin.analysis_profile', 'goals.target_weight_kg', 'alcohol_units', 'unset', '재생성', 'DB_LOCKED']) expect(text).toContain(term);
  expect(uncovered(['config patch'], core.filter(path => !path.includes('/brain-config/')), [])).toEqual(['config patch']);
});

it('Codex 명시 파일 수집은 배포 세션 스킬에 입력과 범위를 설명한다', () => {
  const text = body('plugin/skills/brain-sessions/SKILL.md');
  expect(mentions(text, 'sessions ingest')).toBe(true);
  expect(internal.some(entry => entry.command === 'sessions ingest')).toBe(false);
  for (const term of ['`brain sessions ingest codex --json`', '`id`', '`transcript_path`', '`session_meta.payload.id`', '`session_id`', '명시적으로 요청', '폴더 스캔']) expect(text).toContain(term);
});

it('Codex 연결과 진단 안내는 실제 공개 명령과 상태를 덮는다', () => {
  const setup = body('plugin/skills/brain-setup/SKILL.md');
  const status = body('plugin/skills/brain-status/SKILL.md');
  expect(setup).toContain('`brain setup connect codex --json`');
  expect(setup).toContain('scan-only');
  expect(setup).toContain('`brain sessions ingest codex --json`');
  expect(status).toContain('codex-folders');
  expect(status).toContain('codex-transcripts');
  expect(status).toContain('Claude를 포함한 모든 세션 실패');
  expect(status).toContain('`brain failures retry --target-kind session --json`');
  expect(status).toContain('`brain queue drain --json`');
});

it('첨부 Drive 이전 공개 명령은 배포 스킬에 포함된다', () => {
  expect(names).toContain('files migrate-drive');
  expect(mentions(body('plugin/skills/brain-files/SKILL.md'), 'files migrate-drive')).toBe(true);
});
