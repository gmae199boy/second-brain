import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Inputs are untrusted, including Git paths and Vitest output. Do not persist
// arbitrary strings that could contain credentials, home paths or control text.
// Recognize common credential prefixes conservatively; arbitrary opaque values
// cannot be reliably classified from a filename alone.
const credentialShape = /(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|sk_(?:live|test)_)[a-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}/i;

export function safePath(root, value) {
  if (typeof value !== 'string') return '[redacted]';
  const path = isAbsolute(value) ? relative(root, value) : value;
  if (!path || path.startsWith('..') || isAbsolute(path) || path.includes('\\') ||
      !/^[a-zA-Z0-9._/@+ -]+$/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /^\.(?!github$)/.test(part) || (/secret|credential|password|token|private|\.env|api[-_]?key|sk[-_]proj[-_]/i.test(part) || credentialShape.test(part)))) return '[redacted]';
  return path.split(sep).join('/');
}

function headSha(root) {
  try {
    let gitDir = resolve(root, '.git');
    try { const gitFile = readFileSync(gitDir, 'utf8'); gitDir = resolve(root, gitFile.trim().replace(/^gitdir: /, '')); } catch {}
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head;
    if (!/^ref: refs\/[a-zA-Z0-9._/-]+$/.test(head)) return null;
    const ref = head.slice(5);
    let common = gitDir;
    try { common = resolve(gitDir, readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim()); } catch {}
    let sha;
    try { sha = readFileSync(resolve(common, ref), 'utf8').trim(); }
    catch { sha = readFileSync(resolve(common, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0]; }
    return /^[a-f0-9]{40,64}$/i.test(sha ?? '') ? sha : null;
  } catch { return null; }
}

export function createRecord(root, ref) {
  const started = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const directory = resolve(root, '.brain-test-changed');
  const target = resolve(directory, `${id}.json`);
  const data = {
    version: 1, id, status: 'incomplete', startedAt, endedAt: null,
    elapsedMs: null, runnerExitCode: null, interruption: null,
    comparison: { ref: ref === 'origin/main' || /^[a-f0-9]{40,64}$/i.test(ref) ? ref : '[redacted]', baseSha: null, headSha: headSha(root) },
    inputs: null, selection: null, stages: [],
    tracer: { files: null, stage: 'default-run', elapsedMs: null, timing: 'shared-stage' },
  };
  function snapshot() {
    try {
      mkdirSync(directory, { recursive: true });
      const temp = resolve(directory, `.${id}.tmp`);
      writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, target);
    } catch { /* Observation must never affect the command. */ }
  }
  function begin(name) {
    const start = process.hrtime.bigint();
    const stage = { name, status: 'running', startedAt: new Date().toISOString(), endedAt: null, elapsedMs: null, exitCode: null, signal: null, error: null };
    data.stages.push(stage); snapshot();
    return (status, result = {}) => {
      stage.status = status; stage.endedAt = new Date().toISOString();
      stage.elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      stage.exitCode = result.status ?? null; stage.signal = result.signal ?? null;
      stage.error = !result.error ? null : result.error.code === 'ENOBUFS' ? 'output-limit' : ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOEXEC', 'EAGAIN', 'ENOMEM'].includes(result.error.code) ? 'spawn-error' : 'process-error';
      snapshot();
    };
  }
  function skip(name, reason) { data.stages.push({ name, status: 'skipped', reason, startedAt: null, endedAt: null, elapsedMs: null, exitCode: null, signal: null, error: null }); snapshot(); }
  function finish(status, exitCode, interruption = null) {
    data.status = status; data.runnerExitCode = exitCode; data.interruption = interruption;
    data.endedAt = new Date().toISOString(); data.elapsedMs = Number(process.hrtime.bigint() - started) / 1e6; snapshot();
  }
  snapshot();
  return { data, snapshot, begin, skip, finish };
}
