import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PROCESS_ABI_ENV, decodeAbiEnv, runDayAnalysis } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { localFileStore } from '../runtime/file-store.js';
import { codexModelRunner } from '../runtime/model-codex.js';
import { uuidV7IdGen } from '../runtime/id-gen.js';

async function run(): Promise<void> {
  const env = process.env;
  if (!decodeAbiEnv(env).ok || env[PROCESS_ABI_ENV.workKind] !== 'health_analysis' || env[PROCESS_ABI_ENV.targetKind] !== 'analysis_snapshot' || !env.BRAIN_ANALYSIS_FILES_PATH) {
    console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false })); process.exitCode = 2; return;
  }
  const store = postgresStore({ databaseUrl: env[PROCESS_ABI_ENV.databaseUrl]! });
  const scratch = await mkdtemp(join(tmpdir(), 'brain-analysis-'));
  try {
    const setting = await store.getSetting({ key: 'analysis.agent' });
    if (!setting.ok) { console.log(JSON.stringify({ abi: 1, type: 'error', code: setting.code, retryable: true })); process.exitCode = 2; return; }
    if (setting.setting && setting.setting.value !== 'codex') { console.log(JSON.stringify({ abi: 1, type: 'error', code: 'CONFIG_INVALID', retryable: false })); process.exitCode = 2; return; }
    const require = createRequire(import.meta.url);
    const coreEntry = require.resolve('@second-brain/core', { paths: [dirname(require.resolve('second_brain'))] });
    const schemaPath = join(dirname(coreEntry), '../resources/health-analysis/v1/schemas/daily_analysis_output.schema.json');
    const result = await runDayAnalysis({ store, files: localFileStore({ root: env.BRAIN_ANALYSIS_FILES_PATH }), runner: codexModelRunner, idGen: uuidV7IdGen(), now: () => new Date(), cwd: scratch, schemaPath, outputPath: join(scratch, 'output.json'), snapshotId: env[PROCESS_ABI_ENV.targetId]!, workId: env[PROCESS_ABI_ENV.workId]!, attemptToken: env[PROCESS_ABI_ENV.attemptToken]!, writeExport: text => writeFile(join(scratch, 'export.json'), text, { mode: 0o600 }), decodeSnapshot: bytes => JSON.parse(Buffer.from(bytes).toString('utf8')), encodeReport: text => Buffer.from(text, 'utf8') });
    if (!result.ok) { console.log(JSON.stringify({ abi: 1, type: 'error', code: result.code, retryable: result.retryable })); process.exitCode = 2; return; }
    console.log(JSON.stringify({ abi: 1, type: 'result', summary: '분석 완료', ...(result.usage ? { usage: { input_tokens: result.usage.inputTokens, cached_input_tokens: result.usage.cachedInputTokens, output_tokens: result.usage.outputTokens } } : {}) }));
  } finally { await rm(scratch, { recursive: true, force: true }); await store.close(); }
}
await run().catch(() => { console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ANALYSIS_MODEL_FAILED', retryable: true })); process.exitCode = 2; });
