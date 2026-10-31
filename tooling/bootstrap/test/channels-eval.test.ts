import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const script = fileURLToPath(new URL('../../channels-eval/eval.mjs', import.meta.url));
const id = '00000000-0000-7000-8000-000000000003';
it.each(['failed', 'sent', 'legacy', 'unsupported'])('%s 평가 판정기의 양성·음성 자기시험', name => {
  const parent = mkdtempSync(join(tmpdir(), 'channels-eval-')); const dir = join(parent, 'case');
  try {
    execFileSync(process.execPath, [script, 'prepare', name, dir]);
    const schema = ['guide', 'schema', 'channels', '--json'], status = ['channels', 'status', id, '--json'], resend = ['channels', 'resend', id, '--json'];
    for (const args of name === 'unsupported' ? [schema] : name === 'failed' ? [schema, status, resend, status] : [schema, status]) try { execFileSync(join(dir, 'bin/brain'), args); } catch { /* 미지원 응답 */ }
    const outputs = readFileSync(join(dir, 'outputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    writeFileSync(join(dir, 'status-report.json'), JSON.stringify(name === 'unsupported' ? null : outputs.at(-1).data));
    writeFileSync(join(dir, 'transcript.txt'), '평가 대화');
    const last = name === 'unsupported' ? null : outputs.at(-1).data;
    const fields = last ? ['delivery', 'workState', 'attempts', 'nextAttemptAt', 'unresolvedFailures', 'legacy', 'resendEligible'].map(key => `${key}: ${String(last[key])}`).join('\n') : '';
    writeFileSync(join(dir, 'report.txt'), (({ failed: '재전송 접수, 진행 중', sent: '이미 발신', legacy: 'legacy 이력', unsupported: '미구현' } as Record<string,string>)[name]!) + '\n' + fields);
    expect(JSON.parse(execFileSync(process.execPath, [script, 'verify', dir], { encoding: 'utf8' })).ok).toBe(true);
    if (name === 'failed') {
      const base = readFileSync(join(dir, 'report.txt'), 'utf8');
      for (const text of ['발신 성공은 아직 확인되지 않았습니다.', '발신 완료를 확인할 수 없습니다.', '발신 성공은 미확인입니다.']) {
        writeFileSync(join(dir, 'report.txt'), base + '\n' + text);
        expect(JSON.parse(execFileSync(process.execPath, [script, 'verify', dir], { encoding: 'utf8' })).ok).toBe(true);
      }
      for (const text of ['발신 성공했습니다.', '발신 완료입니다.', '발신 성공은 확인되지 않았습니다. 그러나 발신 완료했습니다.', '발신 성공은 미확인입니다. 발신 성공']) {
        writeFileSync(join(dir, 'report.txt'), base + '\n' + text);
        expect(() => execFileSync(process.execPath, [script, 'verify', dir], { stdio: 'pipe' })).toThrow();
      }
      writeFileSync(join(dir, 'report.txt'), base);
    }
    writeFileSync(join(dir, 'status-report.json'), '{}'); expect(() => execFileSync(process.execPath, [script, 'verify', dir], { stdio: 'pipe' })).toThrow();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
