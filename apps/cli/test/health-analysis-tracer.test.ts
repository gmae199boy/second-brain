import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { localFileStore } from '../src/runtime/file-store.js';
import { join } from 'node:path';
import { healthAnalysisFixture } from './health-analysis-fixture.js';

let fixture: Awaited<ReturnType<typeof healthAnalysisFixture>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
describe('health analysis tracer', () => {
  it('runs in the supervised group, masks input and commits one report', async () => {
    const f = fixture = await healthAnalysisFixture();
    expect(await f.waitWork(f.workId)).toMatchObject({ outcome: 'succeeded' });
    const [record] = await f.records(); expect(record).toBeDefined();
    const attempts = await f.db.rows(`select * from brain.work_attempts where work_item_id='${f.workId}'`);
    const attempt = attempts[0]!; expect(record.pgid).toBe(attempt.pgid);
    expect(record.args).toContain('--json'); expect(record.args).toContain('--output-schema'); expect(record.args).toContain('-o'); expect(record.args).not.toContain('-m');
    expect(record.exported).not.toContain('synthetic-secret-123456'); expect(record.exported).toContain('[REDACTED:');
    expect(Object.keys(record.env).filter(k => k.startsWith('BRAIN_'))).toEqual([]); expect(record.env.OPENAI_API_KEY).toBeUndefined(); expect(record.env.CODEX_API_KEY).toBeUndefined(); expect(record.env.CUSTOM_DB).toBeUndefined();
    const schema = record.args[record.args.indexOf('--output-schema') + 1];
    expect(schema).toContain('resources/health-analysis/v1/'); expect(createHash('sha256').update(await readFile(schema)).digest('hex')).toBe('85e22c6c5d2909309c926bd0326a07ff084c341fa89aecb3f2bbbbc4a32b7532');
    const skill = join(schema, '../../skills/garmin-daily-analysis/SKILL.md');
    expect(createHash('sha256').update(await readFile(skill)).digest('hex')).toBe('98a0b852fef27b21c5ab8422eb5423c2488e12e6896441b29bdfb38fbf0880c8');
    expect([attempt.input_tokens, attempt.cached_input_tokens, attempt.output_tokens].map(Number)).toEqual([12, 3, 4]);
    const found = await f.store.findCoreAnalysis(f.snapshot.id, 'day', 1); expect(found.ok && found.analysis).toMatchObject({ bundleId: f.snapshot.bundleId, reportDate: f.snapshot.localDate, agent: 'codex', output: { report_md: '# Synthetic report\n' } });
    if (!found.ok || !found.analysis) throw Error('분석 누락');
    const reread = await f.store.readCoreAnalysis(found.analysis.id); expect(reread).toEqual(found);
    const locations = await f.store.listFileLocations(found.analysis.fileId); if (!locations.ok || !locations.locations[0]) throw Error('파일 위치 누락');
    const bytes = await localFileStore({ root: join(f.home, 'files') }).get(locations.locations[0]);
    expect(bytes.ok && Buffer.from(bytes.bytes).toString('utf8')).toBe('# Synthetic report\n');
    // A daemon round may claim the extraction concurrently, and the shared drain
    // deadline can expire before it is enqueued or claimed. Wait for completion.
    const deadline = Date.now() + 30_000;
    let extractions: { id: string; finished_at: unknown }[] = [];
    do {
      const drained = await runPgCommand(['queue', 'drain', '--budget', '5', '--json'], { ...f.env, [HOME_ENV]: f.home });
      expect(drained.code, drained.stderr).toBe(0);
      extractions = await f.db.rows(`select id,finished_at from brain.document_extractions where file_id='${found.analysis.fileId}'`);
      if (extractions.length === 1 && extractions[0]!.finished_at !== null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    expect(extractions).toHaveLength(1);
    expect(extractions[0]!.finished_at).not.toBeNull();
    const configEnv = { ...f.env, [HOME_ENV]: f.home };
    const getDefault = await runPgCommand(['config', 'get', 'analysis.agent', '--json'], configEnv);
    expect(JSON.parse(getDefault.stdout)).toMatchObject({ ok: true, data: { value: 'codex', source: 'default' } });
    const setAgent = await runPgCommand(['config', 'set', 'analysis.agent', 'codex', '--json'], configEnv);
    expect(JSON.parse(setAgent.stdout)).toMatchObject({ ok: true, data: { value: 'codex' } });
    const getSaved = await runPgCommand(['config', 'get', 'analysis.agent', '--json'], configEnv);
    expect(JSON.parse(getSaved.stdout)).toMatchObject({ ok: true, data: { value: 'codex', source: 'db' } });
    const invalidConfig = await runPgCommand(['config', 'set', 'analysis.agent', 'foo', '--json'], { ...f.env, [HOME_ENV]: f.home });
    expect(invalidConfig.stdout).toContain('CONFIG_INVALID');
    const now = new Date(); const again = await f.store.addWork({ id: f.ids.next(), kind: 'health_analysis', targetKind: 'analysis_snapshot', targetId: f.snapshot.id, createdAt: now, nextAttemptAt: now });
    if (!again.ok) throw Error(again.message); expect(await f.waitWork(again.item.id)).toMatchObject({ outcome: 'succeeded' }); expect(await f.records()).toHaveLength(1);
    const after = await f.store.findCoreAnalysis(f.snapshot.id, 'day', 1); expect(after).toEqual(found);
    expect(await f.db.rows("select id from brain.analyses where source='core'")).toHaveLength(1);
    expect(await f.db.rows('select * from brain.analysis_files')).toHaveLength(1);
    expect(await f.db.rows('select id from brain.files')).toHaveLength(1);
  }, 90000);
  it('rejects schema mismatch without creating an analysis', async () => {
    const f = fixture = await healthAnalysisFixture('invalid'); await f.waitWork(f.workId);
    const attempts = await f.db.rows(`select * from brain.work_attempts where work_item_id='${f.workId}'`);
    expect(attempts[0]).toMatchObject({ outcome: 'failed', error_code: 'ANALYSIS_OUTPUT_INVALID', error_retryable: false });
    expect(await f.db.rows('select id from brain.analyses')).toHaveLength(0);
    expect(await f.db.rows('select * from brain.analysis_files')).toHaveLength(0);
    expect(await f.db.rows('select id from brain.files')).toHaveLength(0);
  }, 60000);
});
