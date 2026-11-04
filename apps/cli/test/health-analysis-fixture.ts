import { createHash } from 'node:crypto';
import { mkdtemp, rm, copyFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueDayAnalysis } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { pgHome } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
import { runDaemon } from '../src/daemon/run.js';
import { writeConfig } from '../src/config/codec.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

export function syntheticDaySnapshot(options: { localDate?: string; timeZone?: string; content?: Uint8Array } = {}) {
  const ids = uuidV7IdGen();
  const content = options.content ?? Buffer.from(JSON.stringify({ note: 'password: synthetic-secret-123456' }));
  return { id: ids.next(), bundleId: ids.next(), localDate: options.localDate ?? '2026-01-02', timeZone: options.timeZone ?? 'Asia/Seoul', content, contentSha256: createHash('sha256').update(content).digest('hex'), createdAt: new Date() };
}
export async function healthAnalysisFixture(mode: 'ok' | 'invalid' = 'ok', snapshot = syntheticDaySnapshot()) {
  const home = await mkdtemp(join(tmpdir(), 'brain-analysis-test-'));
  let db: Awaited<ReturnType<typeof pgHome>> | undefined;
  let store: ReturnType<typeof postgresStore> | undefined;
  let running: ReturnType<typeof runDaemon> | undefined;
  const controller = new AbortController();
  async function close() {
    controller.abort();
    try { await running; } finally { try { await store?.close(); } finally { try { await db?.drop(); } finally { await rm(home, { recursive: true, force: true }); } } }
  }
  try {
    db = await pgHome(home); store = postgresStore({ databaseUrl: db.appUrl });
    const configured = await writeConfig(home, { storeUrlEnv: 'CUSTOM_DB' }); if (!configured.ok) throw Error(configured.message);
    const bin = join(home, 'codex'); await copyFile(fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), bin); await chmod(bin, 0o755);
    const log = join(home, 'fake.log'); const ids = uuidV7IdGen();
    const added = await enqueueDayAnalysis({ store, idGen: ids, now: () => new Date() }, snapshot);
    if (!added.ok) throw Error(added.message);
    const env = { ...withoutHarnessFolders(process.env), HOME: home, ...db.env, CUSTOM_DB: db.appUrl, PATH: `${home}:${process.env.PATH}`, FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode, OPENAI_API_KEY: 'synthetic-key', CODEX_API_KEY: 'synthetic-codex-key', BRAIN_FAKE_SECRET: 'synthetic-secret' };
    running = runDaemon({ home, env, clock: { now: () => new Date() }, idGen: ids, signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    const ownedDb = db, ownedStore = store;
    return { db: ownedDb, store: ownedStore, ids, snapshot, workId: added.item.id, env, log, home,
      async records() { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
      async waitWork(id: string) { for (let i = 0; i < 300; i++) { const rows = await ownedDb.rows(`select * from brain.work_items where id='${id}' and completed_at is not null`); if (rows.length) return rows[0]; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('일감 시간 초과'); },
      close,
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
