import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile, rename, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import { pgHome } from './pg-home.js';
import { PgTestClient } from './pg-client.js';
import { tempHomes } from './temp-home.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const homes = tempHomes();
afterEach(() => homes.cleanup());
const line = (v: unknown) => JSON.stringify(v) + '\n';
const meta = (id: string) => line({ type: 'session_meta', payload: { id } });
const message = (body: string, second: number) => line({ timestamp: `2026-01-01T00:00:0${second}Z`, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] } });
function invoke(home: string, args: string[]) {
  const env = withoutHarnessFolders({ ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, [HOME_ENV]: home, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') });
  env.CODEX_HOME = join(home, 'codex'); delete env.SECOND_BRAIN_DATABASE_URL; delete env.BRAIN_TEST_DATABASE_URL;
  return new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += String(b); }); child.stderr.on('data', b => { stderr += String(b); });
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr}));
  });
}
async function drain(home: string) { const result = await invoke(home, ['queue', 'drain', '--json']); expect(result.code).toBe(0); return JSON.parse(result.stdout); }
async function bodies(home: string, id: string) { const result = await invoke(home, ['sessions', 'read', `codex:${id}`, '--json']); expect(result.code).toBe(0); return JSON.parse(result.stdout).data.filter((row: {kind: string}) => row.kind === 'message').map((row: {body: string}) => row.body); }
describe('Codex folder scan', () => {
  it('recovers historical, partial, appended, moved and duplicate records without a trigger', async () => {
    const home = await homes.create('brain-codex-scan-'); await pgHome(home, true, createIsolatedTestDatabase);
    const active = join(home, 'codex', 'sessions', '2026', '01', '01'), archive = join(home, 'codex', 'archived_sessions');
    await mkdir(active, {recursive: true}); await mkdir(archive, {recursive: true});
    const a = join(active, 'a.jsonl'), b = join(archive, 'b.jsonl');
    await writeFile(a, meta('one') + message('first', 1) + message('partial', 2).slice(0, -1));
    await writeFile(b, meta('two') + message('archived', 3));
    await drain(home); expect(await bodies(home, 'one')).toEqual(['first']); expect(await bodies(home, 'two')).toEqual(['archived']);
    await appendFile(a, '\n' + message('later', 4) + '{broken\n'); const damaged = await drain(home);
    expect(damaged.warnings).toContain('TRANSCRIPT_LINES_SKIPPED');
    expect(await bodies(home, 'one')).toEqual(['first', 'partial', 'later']);
    const copy = join(archive, 'copy.jsonl'); await copyFile(a, copy); await drain(home);
    expect(await bodies(home, 'one')).toEqual(['first', 'partial', 'later']);
    await rm(copy); await rename(a, copy); await drain(home);
    expect(await bodies(home, 'one')).toEqual(['first', 'partial', 'later']);
    await writeFile(a, meta('one') + message('conflict', 1));
    const conflict = await drain(home); expect(conflict.data.scan_stopped).toContain('중복');
    const text = await invoke(home, ['queue', 'drain']); expect(text.code).toBe(0); expect(text.stdout).toContain('중복');
  });
  it('reconciles prefix insertion and same-size rewrites, then accepts an append', async () => {
    const home = await homes.create('brain-codex-rewrite-'); await pgHome(home, true, createIsolatedTestDatabase);
    const active = join(home, 'codex', 'sessions', '2026', '01', '01'); await mkdir(active, {recursive: true});
    const path = join(active, 'session.jsonl');
    const first = meta('rewrite') + message('same', 1) + message('later', 2);
    await writeFile(path, first); await drain(home);
    const prefix = line({type: 'event_msg', payload: {}});
    await writeFile(path, meta('rewrite') + prefix + message('same', 1) + message('later', 2)); await drain(home);
    expect(await bodies(home, 'rewrite')).toEqual(['same', 'later']);
    await appendFile(path, message('new', 3)); await drain(home);
    expect(await bodies(home, 'rewrite')).toEqual(['same', 'later', 'new']);
    await writeFile(path, first); await drain(home);
    expect(await bodies(home, 'rewrite')).toEqual(['same', 'later', 'new']);
    const sameSize = first.replace('same', 'SAME');
    await writeFile(path, sameSize); await drain(home);
    expect(await bodies(home, 'rewrite')).toContain('SAME');
  });
  it('keeps a redacted message masked after a moved prefix and concurrent drains', async () => {
    const home = await homes.create('brain-codex-redaction-'); await pgHome(home, true, createIsolatedTestDatabase);
    const active = join(home, 'codex', 'sessions', '2026', '01', '01'); await mkdir(active, {recursive: true});
    const path = join(active, 'session.jsonl'); const turn = message('sensitive-synthetic', 1);
    await writeFile(path, meta('redact') + turn); await drain(home);
    const db = new PgTestClient(home);
    try {
      const row = await db.prepare("select id from messages where body=$1").get('sensitive-synthetic');
      const redacted = await invoke(home, ['messages', 'redact', String(row!.id), '--text', 'sensitive-synthetic', '--yes', '--json']);
      expect(redacted.code).toBe(0);
      await writeFile(path, meta('redact') + line({type:'event_msg'}) + turn + message('next', 2));
      await Promise.all([drain(home), drain(home)]); await drain(home);
      const rows = await db.prepare("select body from messages where session_id=(select id from sessions where harness_session_id='redact') order by occurred_at").all();
      expect(rows).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain('sensitive-synthetic');
      expect((await bodies(home, 'redact')).at(-1)).toBe('next');
    } finally { await db.close(); }
  });

});
