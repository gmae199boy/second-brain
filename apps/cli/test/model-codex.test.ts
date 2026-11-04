import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexModelRunner } from '../src/runtime/model-codex.js';
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(script: string) {
  const dir = await mkdtemp(join(tmpdir(), 'brain-codex-test-')); dirs.push(dir);
  const command = join(dir, 'codex'); await writeFile(command, '#!/usr/bin/env node\n' + script); await chmod(command, 0o755);
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  return { cwd: dir, schemaPath: join(dir, 'schema'), outputPath: join(dir, 'output'), prompt: 'synthetic', effort: 'high' as const, model: null, timeoutMs: 3000 };
}
it('parses valid usage after an oversized line without retaining it', async () => {
  const input = await fixture("const fs = require('fs'); const args=process.argv; fs.writeFileSync(args[args.indexOf('-o')+1], '{}'); process.stdout.write('x'.repeat(100000)+'\\n'); console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:3,cached_input_tokens:1,output_tokens:2}}));");
  expect(await codexModelRunner.run(input)).toEqual({ ok: true, output: '{}', usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 } });
});
it('returns promptly on timeout when a descendant holds stdout open', async () => {
  const input = await fixture("require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore','inherit','ignore']}); setTimeout(()=>{},5000);");
  const started = Date.now();
  expect(await codexModelRunner.run({ ...input, timeoutMs: 100 })).toEqual({ ok: false, code: 'ANALYSIS_MODEL_FAILED' });
  expect(Date.now() - started).toBeLessThan(800);
});
it('returns model failure when codex cannot be spawned', async () => {
  const input = await fixture('');
  const empty = await mkdtemp(join(tmpdir(), 'brain-no-codex-')); dirs.push(empty); vi.stubEnv('PATH', empty);
  expect(await codexModelRunner.run(input)).toEqual({ ok: false, code: 'ANALYSIS_MODEL_FAILED' });
});
it('returns model failure on a nonzero exit', async () => {
  const input = await fixture('process.exitCode = 7;');
  expect(await codexModelRunner.run(input)).toEqual({ ok: false, code: 'ANALYSIS_MODEL_FAILED' });
});
it('returns model failure when successful execution produces no output file', async () => {
  const input = await fixture('process.exitCode = 0;');
  expect(await codexModelRunner.run(input)).toEqual({ ok: false, code: 'ANALYSIS_MODEL_FAILED' });
});
