import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import { PgTestClient } from './pg-client.js';
import { dropPgHome, pgHome } from './pg-home.js';
import { tempHomes } from './temp-home.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const claudeFixture = fileURLToPath(new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url));
const homes = tempHomes(async path => dropPgHome(await realpath(path)));
afterEach(() => homes.cleanup());
const exec = promisify(execFile);
const line = (v: unknown) => JSON.stringify(v) + '\n';
const msg = { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic identity message' }] } };

function gitEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('GIT_'))),
    HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  };
}
async function git(home: string, cwd: string, ...args: string[]) {
  await exec('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { env: gitEnvironment(home) });
}
async function repo(home: string, name: string, remote: string | null) {
  const dir = join(home, name);
  await mkdir(dir);
  await git(home, dir, 'init', '-q');
  await git(home, dir, 'commit', '--allow-empty', '-q', '-m', 'fixture');
  if (remote) await git(home, dir, 'remote', 'add', 'origin', remote);
  return dir;
}
async function ingest(home: string, harness: string, payload: object) {
  const env = withoutHarnessFolders({ ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, [HOME_ENV]: home, HOME: home, CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'xdg'), GIT_CONFIG_NOSYSTEM: '1' });
  delete env.SECOND_BRAIN_DATABASE_URL;
  delete env.BRAIN_TEST_DATABASE_URL;
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'sessions', 'ingest', harness, '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (v: Buffer) => { out += v.toString(); });
    child.stderr.on('data', (v: Buffer) => { err += v.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
  expect(result.code, result.err).toBe(0);
  const parsed = JSON.parse(result.out);
  expect(parsed.ok).toBe(true);
  return parsed;
}
async function codex(home: string, id: string, cwd: string, turn: string, branch?: string) {
  const path = join(home, `${id}.jsonl`);
  await writeFile(path, line({ type: 'session_meta', payload: { id, cwd, ...(branch ? { git: { branch } } : {}) } }) + line({ type: 'turn_context', payload: { cwd: turn } }) + line(msg));
  return { id, transcript_path: path };
}

describe('Codex identity through explicit CLI and PostgreSQL', () => {
  it('removes inherited Git overrides only from the fixture Git environment', () => {
    const inherited = { GIT_DIR: '/synthetic/other/.git', GIT_WORK_TREE: '/synthetic/other', GIT_CONFIG_COUNT: '1', GIT_SOMETHING_NEW: 'value', DOCKER_HOST: 'synthetic-docker', HOME: '/synthetic/original' };
    const env = gitEnvironment('/synthetic/fixture', inherited);
    expect(Object.keys(env).filter(key => key.startsWith('GIT_')).sort()).toEqual(['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
    expect(env).toMatchObject({ HOME: '/synthetic/fixture', XDG_CONFIG_HOME: '/synthetic/fixture/xdg', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', DOCKER_HOST: 'synthetic-docker' });
    expect(inherited.GIT_DIR).toBe('/synthetic/other/.git');
  });

  it('groups harnesses and checkouts, keeps first cwd and tags, and handles remote and non-repository cases', async () => {
    const home = await realpath(await homes.create('brain-codex-identity-'));
    await pgHome(home, true, createIsolatedTestDatabase);
    const primary = await repo(home, 'primary', 'git@GitHub.com:Example/Repo.git');
    const linked = join(home, 'linked');
    await git(home, primary, 'worktree', 'add', '-q', '-b', 'fixture-linked', linked);
    const clone = await repo(home, 'clone', 'https://github.com/example/repo');
    const caseOne = await repo(home, 'case-one', 'https://forge.example/Team/Repo.git');
    const caseTwo = await repo(home, 'case-two', 'https://forge.example/team/repo.git');
    const local = await repo(home, 'local', null);
    const outside = join(home, 'outside'); await mkdir(outside);
    const claudePath = join(home, 'claude.jsonl');
    await writeFile(claudePath, (await readFile(claudeFixture, 'utf8')).replaceAll('/demo/repo', primary));
    const claude = { session_id: 'synthetic-claude', transcript_path: claudePath };
    await ingest(home, 'claude-code', claude);
    const db = new PgTestClient(home);
    try {
      const snapshot = async () => ({
        sessions: await db.prepare('select harness, harness_session_id, project_id, worktree_id, first_cwd, tag_source from sessions order by harness, harness_session_id').all(),
        projects: await db.prepare('select id, identity_key, remote_identity from projects order by identity_key').all(),
        worktrees: await db.prepare('select id, project_id, path from worktrees order by path').all(),
        messages: await db.prepare('select s.harness, s.harness_session_id, m.body from messages m join sessions s on s.id=m.session_id order by s.harness, s.harness_session_id, m.occurred_at, m.id').all(),
        notes: await db.prepare('select s.harness, s.harness_session_id, n.tool, n.target, n.ok from tool_notes n join sessions s on s.id=n.session_id order by s.harness, s.harness_session_id, n.ordinal').all(),
      });
      const counts = async () => {
        const tables = await db.prepare("select tablename from pg_tables where schemaname='brain' order by tablename").all();
        const result: Record<string, number> = {};
        for (const table of tables) {
          const name = String(table.tablename);
          const row = await db.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`).get();
          result[name] = row!.n as number;
        }
        return result;
      };
      const claudeBefore = await snapshot();
      const inputs = [await codex(home, 'linked', linked, outside), await codex(home, 'clone', clone, outside, 'unrelated'), await codex(home, 'case-one', caseOne, primary), await codex(home, 'case-two', caseTwo, primary), await codex(home, 'local', local, primary), await codex(home, 'outside', outside, primary)];
      for (const input of inputs) await ingest(home, 'codex', input);
      const first = await snapshot();
      const beforeCounts = await counts();
      const sessions = Object.fromEntries(first.sessions.map(s => [s.harness_session_id as string, s]));
      const claudeRow = sessions['synthetic-claude']!;
      expect(first.sessions.filter(s => s.harness === 'claude-code')).toEqual(claudeBefore.sessions);
      expect(first.messages.filter(m => m.harness === 'claude-code')).toEqual(claudeBefore.messages);
      expect(first.notes.filter(n => n.harness === 'claude-code')).toEqual(claudeBefore.notes);
      expect(sessions['linked']).toMatchObject({ project_id: claudeRow.project_id, first_cwd: linked, tag_source: 'cwd' });
      expect(sessions['clone']).toMatchObject({ project_id: claudeRow.project_id, first_cwd: clone, tag_source: 'cwd' });
      expect(sessions['linked']!.worktree_id).not.toEqual(claudeRow.worktree_id);
      expect(first.worktrees.find(w => w.id === sessions['linked']!.worktree_id)).toMatchObject({ path: linked, project_id: claudeRow.project_id });
      expect(first.worktrees.find(w => w.id === sessions['clone']!.worktree_id)).toMatchObject({ path: clone, project_id: claudeRow.project_id });
      expect(sessions['case-one']!.project_id).not.toEqual(sessions['case-two']!.project_id);
      expect(sessions['outside']).toMatchObject({ first_cwd: outside, project_id: null, worktree_id: null });
      expect(first.projects.find(p => p.id === sessions['local']!.project_id)).toMatchObject({ identity_key: join(local, '.git') });
      expect(await db.prepare("select count(*) as n from work_items where kind='session_identity' and target_id=$1").get('codex:outside')).toMatchObject({ n: 0 });
      // Rewriting the turn context forces a cursor reset while the stored start
      // and checkout must remain unchanged on the subsequent ingest.
      await codex(home, 'linked', linked, primary);
      for (const input of inputs) {
        const replay = await ingest(home, 'codex', input);
        expect(replay.data).toMatchObject({ created: false, inserted: { messages: 0, toolNotes: 0 } });
      }
      await ingest(home, 'claude-code', claude);
      expect(await snapshot()).toEqual(first);
      expect(await counts()).toEqual(beforeCounts);
    } finally { await db.close(); }
  }, 120_000);
});
