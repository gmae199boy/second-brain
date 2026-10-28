import { describe, expect, it, vi } from 'vitest';
import { runInstallFlow, installExit, parseFlags, type InstallDeps } from '../src/install/flow.js';
import { assertKoreanLine } from './language.js';
const home = '/tmp/brain-flow';
const env = { SECOND_BRAIN_HOME: home };
function harness() {
  const order: string[] = [], lines: string[] = [];
  const step = (name: string) => { order.push(name); };
  const deps: InstallDeps = {
    isTTY: false, log: line => lines.push(line),
    prompts: { confirm: vi.fn(async () => true), text: vi.fn(async () => ''), multiselect: vi.fn(async (_q, _c, values) => values) },
    config: { read: vi.fn(async () => ({ ok: true as const, recorded: undefined, warnings: [] })), write: vi.fn(async () => { step('config'); return { ok: true as const }; }) },
    orbstack: vi.fn(async () => { step('orbstack'); return { ok: true as const, detail: '실행 중입니다' }; }),
    legacyFileExists: vi.fn(async () => false),
    postgres: vi.fn(async () => { step('postgres'); return { ok: true as const, report: { project: 'second-brain-test', volume: 'test', port: 54329, schema_version: 1, applied: ['0001_initial.sql'], owner_created: true, owner_name: 'brain-owner', compose_started: true } }; }),
    settings: { get: vi.fn(async () => { step('timezone'); return { ok: true as const, key: 'timezone', value: 'Asia/Seoul', source: 'default' as const, updatedAt: null }; }), set: vi.fn(async (_h, _s, _e, value) => ({ ok: true as const, key: 'timezone', value, source: 'db' as const, updatedAt: new Date() })) },
    files: { prepare: vi.fn(async path => { step('files'); return { ok: true as const, path, created: true }; }) },
    importTranscripts: vi.fn(async () => { step('import'); return { scanned: 0, enqueued: 0, spooled: 0, spoolFailed: 0, imported: 0, succeeded: 0, failed: 0, claimed: 0, processed: 0, stopped: 'empty' } as never; }),
    postgresDoctor: vi.fn(async () => { step('doctor'); return { checks: [{ id: 'db', status: 'ok' as const, detail: '접속했습니다' }], summary: { passed: 1, failed: 0, skipped: 0, warned: 0 } }; }),
    shim: { write: vi.fn(async () => { step('shim'); return { path: home + '/bin/brain', changed: true, node: '/usr/bin/node' }; }) },
    installed: { verify: vi.fn(async () => { step('verify'); return { ok: true as const }; }), build: vi.fn(async () => ({ commit: null, schema_version: 1, schema_versions: { core: 1 } })), read: vi.fn(async () => undefined), write: vi.fn(async () => { step('installed'); return { path: home + '/installed.json' }; }) },
    daemon: { register: vi.fn(async () => ({ label: 'test', plist_path: null, status: 'unsupported' as const, plist_changed: false })), restart: vi.fn(async () => ({ ok: true as const, method: 'signal' as const, pid: 1, commit: 'a'.repeat(40) })) },
    connectors: [],
  };
  return { deps, order, lines, run: (args: string[] = ['--yes']) => runInstallFlow(args, env, deps) };
}
describe('PG installer flow', () => {
  it.each(['get', 'set'] as const)('propagates setup settings %s failures before writing config', async operation => {
    const kit = harness();
    kit.deps.settings!.get = vi.fn(async () => operation === 'get'
      ? { ok: false as const, code: 'DB_LOCKED' as const, message: '잠금 초과' }
      : { ok: true as const, key: 'timezone', value: 'Asia/Seoul', source: 'default' as const, updatedAt: null });
    kit.deps.settings!.set = vi.fn(async () => ({ ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '연결 실패' }));

    const result = await kit.run();

    expect(result).toMatchObject({ ok: false, failure: { code: operation === 'get' ? 'DB_LOCKED' : 'DB_UNAVAILABLE' } });
    expect(kit.deps.config.write).not.toHaveBeenCalled();
    expect(kit.deps.installed.write).not.toHaveBeenCalled();
    if (operation === 'get') expect(kit.deps.settings!.set).not.toHaveBeenCalled();
  });

  it.each([false, true])('validates TTY timezone answers and stops after repeated invalid input: %s', async exhausted => {
    const kit = harness();
    kit.deps.isTTY = true;
    kit.deps.config.read = async () => ({ ok: true, warnings: [], recorded: { timezone: 'Europe/Paris', extra: {} } });
    const answers = ['Mars/Base', '+09:00', exhausted ? 'invalid' : 'america/new_york'];
    const placeholders: (string | undefined)[] = [];
    kit.deps.prompts.text = vi.fn(async (question, fallback) => {
      if (!question.includes('시간대')) return '';
      placeholders.push(fallback);
      const answer = answers.shift();
      if (answer === undefined) throw new Error('준비한 시간대 답변을 모두 썼습니다');
      return answer;
    });

    const result = await kit.run();

    expect(placeholders).toEqual(['Europe/Paris', 'Europe/Paris', 'Europe/Paris']);
    if (exhausted) {
      expect(result).toMatchObject({ ok: false, failure: { code: 'CONFIG_INVALID', exit: 2 } });
      expect(kit.deps.settings!.set).not.toHaveBeenCalled();
      expect(kit.deps.config.write).not.toHaveBeenCalled();
      expect(kit.deps.installed.write).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: true, report: { timezone: 'America/New_York' } });
      expect(kit.deps.settings!.set).toHaveBeenCalledExactlyOnceWith(home, 'BRAIN_DATABASE_URL', env, 'America/New_York');
      expect(kit.deps.config.write).toHaveBeenCalledOnce();
      expect(kit.deps.installed.write).toHaveBeenCalledOnce();
    }
  });

  it('warns when transcript replay fails even though the queue stops normally without failures', async () => {
    const kit = harness();
    const imported = { claimed: 0, completed: 0, retried: 0, failed: 0, released: 0, lost: 0,
      spooled: 0, stopped: 'empty' as const, replayed: 0, spoolFailed: 1, enqueued: 0,
      rereadMissing: 0, reextractRedacted: 0, reextractUnreachable: 0 };
    kit.deps.importTranscripts = async () => imported;

    const result = await kit.run();

    expect(result).toMatchObject({ ok: true, report: { postgres: { import: imported } } });
    expect(kit.lines).toContain('경고: transcript 가져오기에 실패한 일감이 있습니다. 남은 일감은 이후 drain이 이어서 처리합니다');
    expect(kit.lines.join('\n')).not.toContain('디스크의 transcript를 가져왔습니다');
  });

  it('takes a new home through PG, timezone, import and doctor before recording completion', async () => {
    const kit = harness();
    const result = await kit.run();
    expect(result).toMatchObject({ ok: true as const, report: { postgres: { schema_version: 1, legacy_sqlite_path: null }, timezone: 'Asia/Seoul' } });
    if (result.ok && !('helped' in result)) expect(result.report).not.toHaveProperty('store');
    expect(kit.order).toEqual(['orbstack', 'postgres', 'timezone', 'files', 'config', 'import', 'shim', 'doctor', 'verify', 'installed']);
    expect(kit.deps.config.write).toHaveBeenCalledWith(home, expect.objectContaining({ storeUrlEnv: 'BRAIN_DATABASE_URL', filesPath: home + '/files', mirrorPath: home + '/mirror' }));
    for (const line of kit.lines) assertKoreanLine(line, { label: '설치 진행' });
  });
  it('requires consent before reading or probing anything and provides exact retry arguments', async () => {
    const kit = harness();
    const result = await kit.run(['--mirror-path', '/tmp/mirror']);
    expect(result).toMatchObject({ ok: false, failure: { code: 'CONFIRMATION_REQUIRED', retry: { args: { mirrorPath: '/tmp/mirror' } } } });
    expect(kit.order).toEqual([]);
    expect(kit.deps.config.read).not.toHaveBeenCalled();
    expect(installExit(result)).toBe(3);
  });
  it.each(['--store-path', '--unknown', '--database-url'])('refuses removed or unknown flag %s with USAGE', async flag => {
    const kit = harness();
    expect(await kit.run([flag, '/tmp/db', '--yes'])).toMatchObject({ ok: false, failure: { code: 'USAGE' } });
    expect(kit.order).toEqual([]);
  });
  it('prints help without touching configuration or PG', async () => {
    const kit = harness(); expect(await kit.run(['--help'])).toEqual({ ok: true as const, helped: true });
    expect(kit.order).toEqual([]); expect(kit.lines.join('\n')).not.toContain('--store-path');
  });
  it('keeps custom selectors, machine values and extra configuration', async () => {
    const kit = harness();
    kit.deps.config.read = async () => ({ ok: true as const, warnings: [], recorded: { storeUrlEnv: 'CUSTOM_DB', filesPath: '/tmp/files', mirrorPath: '/tmp/mirror', timezone: 'Europe/Berlin', updateAuto: false, extra: { custom: { keep: true } } } });
    expect((await kit.run()).ok).toBe(true);
    expect(kit.deps.postgres).toHaveBeenCalledWith(home, 'CUSTOM_DB', env);
    expect(kit.deps.config.write).toHaveBeenCalledWith(home, expect.objectContaining({ storeUrlEnv: 'CUSTOM_DB', filesPath: '/tmp/files', mirrorPath: '/tmp/mirror', updateAuto: false, extra: { custom: { keep: true } } }));
    expect(kit.deps.settings!.set).toHaveBeenCalledWith(home, 'CUSTOM_DB', env, 'Europe/Berlin');
  });
  it('reports an old file without deleting or moving it', async () => {
    const kit = harness(); kit.deps.legacyFileExists = vi.fn(async () => true);
    kit.deps.config.read = async () => ({ ok: true as const, warnings: [], recorded: { legacySqlitePath: '/tmp/legacy.db', extra: {} } });
    expect(await kit.run()).toMatchObject({ ok: true as const, report: { postgres: { legacy_sqlite_path: '/tmp/legacy.db' } } });
    expect(kit.lines).toContain('옛 SQLite 파일 /tmp/legacy.db는 지우지 않았고 더 쓰지 않습니다');
    expect(kit.deps.legacyFileExists).toHaveBeenCalledWith('/tmp/legacy.db');
  });
  it('refuses invalid whole configuration before probing or writing', async () => {
    const kit = harness(); kit.deps.config.read = async () => ({ ok: false, code: 'CONFIG_INVALID', message: '설정이 잘못되었습니다' });
    expect(await kit.run()).toMatchObject({ ok: false, failure: { code: 'CONFIG_INVALID' } }); expect(kit.order).toEqual([]);
  });
  it('stops on OrbStack refusal with actionable guidance', async () => {
    const kit = harness(); kit.deps.orbstack = async () => ({ ok: false, reason: 'stopped', message: 'OrbStack이 꺼져 있습니다', hint: 'OrbStack을 켜세요' });
    expect(await kit.run()).toMatchObject({ ok: false, failure: { code: 'ORBSTACK_UNAVAILABLE', hint: 'OrbStack을 켜세요' } }); expect(kit.order).toEqual([]);
  });
  it('never writes configuration or completion after a PG failure', async () => {
    const kit = harness(); kit.deps.postgres = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: '접속할 수 없습니다' });
    expect(await kit.run()).toMatchObject({ ok: false, failure: { code: 'DB_UNAVAILABLE' } });
    expect(kit.deps.config.write).not.toHaveBeenCalled(); expect(kit.deps.installed.write).not.toHaveBeenCalled();
  });
  it('keeps importing failures recoverable and finishes doctor', async () => {
    const kit = harness(); kit.deps.importTranscripts = async () => { throw new Error('가져오기 실패'); };
    expect((await kit.run()).ok).toBe(true); expect(kit.lines.join('\n')).toContain('남은 일감은 이후 drain');
  });
  it.each(['doctor', 'verify'] as const)('never records completion after %s fails', async stage => {
    const kit = harness();
    if (stage === 'doctor') kit.deps.postgresDoctor = async () => ({ checks: [{ id: 'db', status: 'fail', detail: '접속 실패' }], summary: { passed: 0, failed: 1, skipped: 0, warned: 0 } });
    else kit.deps.installed.verify = async () => ({ ok: false, message: 'shim 실행 실패' });
    expect(await kit.run()).toMatchObject({ ok: false, failure: { code: 'SETUP_INCOMPLETE' } }); expect(kit.deps.installed.write).not.toHaveBeenCalled();
  });
  it('refuses relative mirror paths in noninteractive mode', async () => {
    expect(await harness().run(['--mirror-path', 'relative', '--yes'])).toMatchObject({ ok: false, failure: { code: 'CONFIG_INVALID' } });
  });
  it('asks terminal questions and honors refusal before writing', async () => {
    const kit = harness(); kit.deps.isTTY = true;
    kit.deps.prompts.confirm = vi.fn(async question => !question.includes('진행'));
    expect(await kit.run([])).toMatchObject({ ok: false, failure: { code: 'SETUP_CANCELLED' } });
    expect(kit.deps.postgres).not.toHaveBeenCalled(); expect(kit.deps.config.write).not.toHaveBeenCalled();
  });
  it('parses repeated connections and absolute plugin roots', () => {
    expect(parseFlags(['--connect', 'demo', '--connect', 'demo', '--plugin-root', '/tmp/plugin', '--yes'])).toMatchObject({ ok: true as const, flags: { connect: ['demo'], pluginRoot: '/tmp/plugin' } });
    expect(parseFlags(['--plugin-root', 'relative']).ok).toBe(false);
  });
});
