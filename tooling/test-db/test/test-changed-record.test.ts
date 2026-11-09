import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
type Options = { paths?: string[]; defaultFiles?: string[]; postgresFiles?: string[]; pythonFiles?: string[]; fail?: string; childSignal?: string; block?: string; secret?: string; sources?: Record<string, string[]> };
const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const opt = JSON.parse(process.env.FIXTURE_OPTIONS);
const gitKey = args[0] === 'rev-parse' ? 'verify-ref' : args[0] === 'ls-files' ? 'git-untracked' : args.includes('--cached') ? 'git-staged' : args.some(a => a.endsWith('...HEAD')) ? 'git-committed' : 'git-unstaged';
const key = name === 'git' ? gitKey : name === 'pnpm' && args[0] === 'build' ? 'build' : name === 'pnpm' && args[1] === 'vitest' ? (args.includes('--config') ? 'python-' : args.includes('--project') ? 'postgres-' : 'default-') + args[2] : name;
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([name, ...args]) + String.fromCharCode(10));
if (opt.block === key) {
  fs.writeFileSync(process.env.MARKER, String(process.pid));
  while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (opt.childSignal === key) process.kill(process.pid, 'SIGTERM');
if (opt.fail === key) { console.error('external secret ' + (opt.secret || '')); process.exit(7); }
if (name === 'git' && args[0] === 'rev-parse') console.log('a'.repeat(40));
if (name === 'git' && key !== 'verify-ref') process.stdout.write(((opt.sources || {})[key] || (key === 'git-committed' ? opt.paths : []) || []).map(p => p + String.fromCharCode(0)).join(''));
if (name === 'pnpm' && args[2] === 'list') {
 const files = key === 'python-list' ? opt.pythonFiles : key === 'postgres-list' ? opt.postgresFiles : opt.defaultFiles;
 process.stdout.write(JSON.stringify((files || []).map(file => ({file: path.resolve(process.cwd(), file)}))));
}
`;
function fixture(options: Options, writable = true, baseline = false) {
  const dir = mkdtempSync(join(tmpdir(), 'changed-record-'));
  const root = join(dir, 'repo'); const bin = join(dir, 'bin');
  mkdirSync(join(root, 'tooling/test-changed'), { recursive: true }); mkdirSync(bin);
  for (const name of ['run.mjs', 'record.mjs', 'rules.mjs']) copyFileSync(join(sourceRoot, 'tooling/test-changed', name), join(root, 'tooling/test-changed', name));
  if (baseline) copyFileSync(join(sourceRoot, 'tooling/test-db/test/fixtures/test-changed/run-baseline.mjs'), join(root, 'tooling/test-changed/run.mjs'));
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/HEAD'), 'b'.repeat(40) + '\n');
  for (const name of ['git', 'pnpm', 'node']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
  if (!writable) writeFileSync(join(root, '.brain-test-changed'), 'blocked');
  const log = join(dir, 'commands'); const marker = join(dir, 'marker'); const release = join(dir, 'release');
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, FIXTURE_OPTIONS: JSON.stringify(options), COMMAND_LOG: log, MARKER: marker, RELEASE: release, PRIVATE_FIXTURE_VALUE: options.secret ?? '' };
  const args = [join(root, 'tooling/test-changed/run.mjs'), 'origin/main'];
  const records = () => existsSync(join(root, '.brain-test-changed')) && writable ? readdirSync(join(root, '.brain-test-changed')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(root, '.brain-test-changed', f), 'utf8'))) : [];
  const commands = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
  return { dir, root, env, args, marker, release, records, commands, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function execute(options: Options, writable: boolean, ref = 'origin/main') {
  const f = fixture(options, writable);
  try {
    f.args[1] = ref;
    const result = spawnSync(process.execPath, f.args, { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
    return { status: result.status, signal: result.signal, records: f.records(), commands: f.commands() };
  } finally { f.clean(); }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
}
function stopPid(pid: number) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }

const cases: [string, Options][] = [
  ['docs', { paths: ['docs/readme.md'] }],
  ['all', { paths: ['packages/postgres/migrations/0001.sql', 'extensions/example/a.py'], defaultFiles: ['apps/cli/test/drive-source-tracer.test.ts', 'apps/cli/test/drive-source-tracer.test.ts'], postgresFiles: ['packages/postgres/test/a.test.ts', 'packages/postgres/test/a.test.ts'], pythonFiles: ['apps/cli/python-test/a.test.ts', 'apps/cli/python-test/a.test.ts'] }],
  ['missing', { paths: ['apps/cli/python-test/deleted.test.ts'] }],
  ['build failure', { fail: 'build', secret: 'supersecretvalue' }],
  ['list failure', { fail: 'default-list' }],
  ['run failure', { defaultFiles: ['apps/cli/test/a.test.ts'], fail: 'default-run' }],
];

describe('test:changed structured records', () => {
  it.each(cases)('preserves command order and exit with recording unavailable: %s', (_name, options) => {
    const enabled = execute(options, true); const blocked = execute(options, false);
    expect(enabled.status).toBe(options.fail ? 1 : 0);
    expect({ status: blocked.status, signal: blocked.signal, commands: blocked.commands }).toEqual({ status: enabled.status, signal: enabled.signal, commands: enabled.commands });
    expect(enabled.commands[0]).toEqual(['pnpm', 'build']);
    expect(enabled.records).toHaveLength(1);
    expect(enabled.records[0]).toMatchObject({ version: 1, status: options.fail ? 'failed' : 'completed', runnerExitCode: options.fail ? 1 : 0, comparison: { ref: 'origin/main', baseSha: options.fail === 'build' ? null : 'a'.repeat(40), headSha: 'b'.repeat(40) } });
  });
  it('records empty selections, deduplicated full selections and reasons', () => {
    const docs = execute(cases[0]![1], true).records[0];
    expect(docs.inputs).toEqual(['docs/readme.md']); expect(docs.selection).toMatchObject({ default: [], python: [], pythonMode: 'none', postgresAll: false });
    expect(docs.stages).toContainEqual(expect.objectContaining({ name: 'postgres-run', status: 'skipped', reason: 'no-migration-change' }));
    const all = execute(cases[1]![1], true); const r = all.records[0];
    expect(r.selection.default).toEqual(['apps/cli/test/drive-source-tracer.test.ts']);
    expect(r.selection.postgres).toEqual(['packages/postgres/test/a.test.ts']); expect(r.selection.python).toEqual(['apps/cli/python-test/a.test.ts']);
    expect(r.selection.reasons).toEqual(expect.arrayContaining([expect.objectContaining({prefix:'packages/postgres'}), expect.objectContaining({prefix:'extensions'})]));
    expect(r.tracer).toMatchObject({files:['apps/cli/test/drive-source-tracer.test.ts'], stage:'default-run', elapsedMs:null, timing:'shared-stage'});
    expect(all.commands).toEqual([
      ['pnpm','build'], ['git','rev-parse','--verify','--end-of-options','origin/main^{commit}'],
      ['git','diff','--name-only','--no-renames','-z','origin/main...HEAD'],
      ['git','diff','--cached','--name-only','--no-renames','-z'], ['git','diff','--name-only','--no-renames','-z'],
      ['git','ls-files','--others','--exclude-standard','-z'],
      ['pnpm','exec','vitest','list','--changed','origin/main','--filesOnly','--json'],
      ['pnpm','exec','vitest','run','--changed','origin/main','--passWithNoTests'],
      ['pnpm','exec','vitest','list','--project','postgres','--filesOnly','--json'],
      ['pnpm','exec','vitest','run','--project','postgres','--passWithNoTests'],
      ['pnpm','exec','vitest','list','--config','apps/cli/python-test/vitest.config.ts','--filesOnly','--json'],
      ['node','tooling/test-db/dist/python-slots.js'],
    ]);
    expect(all.commands).toContainEqual(['pnpm','exec','vitest','run','--project','postgres','--passWithNoTests']);
    for (const stage of r.stages.filter((s: {status:string}) => s.status === 'completed')) expect(stage).toMatchObject({startedAt:expect.any(String), endedAt:expect.any(String), elapsedMs:expect.any(Number), exitCode:0, signal:null});
  });
  it('uses only existing direct Python files and records missing files', () => {
    const options = { paths: ['apps/cli/python-test/exists.test.ts', 'apps/cli/python-test/deleted.test.ts'] };
    const run = (writable: boolean) => { const f = fixture(options, writable); try {
      mkdirSync(join(f.root, 'apps/cli/python-test'), {recursive:true}); writeFileSync(join(f.root, options.paths[0]!), '');
      const result = spawnSync(process.execPath, f.args, {cwd:f.root, env:f.env, encoding:'utf8', timeout:30000});
      return {status:result.status, commands:f.commands(), records:f.records()};
    } finally { f.clean(); } };
    const a = run(true); const b = run(false); expect(a.status).toBe(0); expect(b.status).toBe(0); expect(a.commands).toEqual(b.commands);
    expect(a.commands).toContainEqual(['node','tooling/test-db/dist/python-slots.js','--files',options.paths[0]]);
    expect(a.records[0].selection).toMatchObject({pythonMode:'files', python:[options.paths[0]], pythonMissing:[options.paths[1]]});
    const missing = execute(cases[2]![1], true); expect(missing.commands.some(c => c[0] === 'node')).toBe(false);
    expect(missing.records[0].stages).toContainEqual(expect.objectContaining({name:'python-run', reason:'no-existing-files'}));
  });
  it('records failure and redacts paths, ref and external error without storing environment', () => {
    const secret = 'sensitive-credential-value';
    const out = execute({paths:['docs/password.txt', '/outside/private.txt'], fail:'default-list', secret}, true, 'private-ref');
    const r = out.records[0]; const json = JSON.stringify(r);
    expect(r.comparison.ref).toBe('[redacted]'); expect(r.inputs).toEqual(['[redacted]','[redacted]']);
    expect(json).not.toContain(secret); expect(json).not.toContain('external secret'); expect(json).not.toContain('PRIVATE_FIXTURE_VALUE');
    expect(r.stages).toContainEqual(expect.objectContaining({name:'default-list', status:'failed', exitCode:7}));
    expect(r.stages).toContainEqual(expect.objectContaining({name:'python-run', status:'skipped', reason:'prior-failure'}));
  });
  it('classifies spawn errors without persisting system messages', () => {
    const f = fixture({}, true); try {
      rmSync(join(f.dir, 'bin/pnpm'));
      const result = spawnSync(process.execPath, f.args, {cwd:f.root, env:{...f.env, PATH:join(f.dir,'bin')}, encoding:'utf8', timeout:30000});
      expect(result.status).toBe(1); expect(f.records()[0].stages[0]).toMatchObject({name:'build', status:'failed', exitCode:null, error:'spawn-error'});
    } finally { f.clean(); }
  });
  it('records child signal and preserves exit with recording unavailable', () => {
    const options = { childSignal:'build' }; const a = execute(options, true); const b = execute(options, false);
    expect(a.status).toBe(1); expect(b.status).toBe(a.status); expect(b.commands).toEqual(a.commands);
    expect(a.records[0]).toMatchObject({status:'interrupted', runnerExitCode:1, interruption:{source:'child', signal:'SIGTERM', stage:'build'}});
    expect(a.records[0].stages[0]).toMatchObject({status:'failed', exitCode:null, signal:'SIGTERM'});
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('preserves runner %s and child completion with recording unavailable', async signal => {
    const run = async (writable: boolean) => { const f = fixture({block:'build'}, writable); let pid = 0; let child: ChildProcess | undefined;
      try {
        child = spawn(process.execPath, f.args, {cwd:f.root, env:f.env, stdio:'ignore'}); const done = exited(child);
        await until(() => existsSync(f.marker)); pid = Number(readFileSync(f.marker, 'utf8'));
        child.kill(signal); writeFileSync(f.release, ''); const result = await done;
        await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
        return {result, records:f.records(), commands:f.commands()};
      } finally { if (pid) stopPid(pid); child?.kill('SIGKILL'); f.clean(); }
    };
    const a = await run(true); const b = await run(false);
    expect(a.result).toEqual({code:null, signal}); expect(b.result).toEqual(a.result); expect(b.commands).toEqual(a.commands);
    expect(a.records[0]).toMatchObject({status:'incomplete', runnerExitCode:null, interruption:null});
  }, 40000);
  it('leaves an incomplete valid snapshot after SIGKILL and does not claim child cleanup', async () => {
    const f = fixture({block:'build'}); let pid = 0; let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, f.args, {cwd:f.root, env:f.env, stdio:'ignore'}); const done = exited(child);
      await until(() => existsSync(f.marker)); pid = Number(readFileSync(f.marker, 'utf8'));
      child.kill('SIGKILL'); expect(await done).toEqual({code:null, signal:'SIGKILL'});
      const records = f.records(); expect(records).toHaveLength(1); expect(records[0]).toMatchObject({status:'incomplete', endedAt:null, runnerExitCode:null});
      expect(records[0].stages[0]).toMatchObject({name:'build', status:'running', endedAt:null});
      // SIGKILL cannot run teardown; explicitly clean this fixture's surviving child.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally { if (pid) stopPid(pid); child?.kill('SIGKILL'); f.clean(); }
  }, 20000);
  it('distinguishes overlapping runs and keeps each published JSON parseable', async () => {
    const f = fixture({block:'build'}); let a: ChildProcess | undefined; let b: ChildProcess | undefined;
    try {
      a = spawn(process.execPath, f.args, {cwd:f.root, env:f.env, stdio:'ignore'}); const doneA = exited(a);
      await until(() => existsSync(f.marker));
      b = spawn(process.execPath, f.args, {cwd:f.root, env:{...f.env, MARKER: f.marker + '-2'}, stdio:'ignore'}); const doneB = exited(b);
      await until(() => existsSync(f.marker + '-2'));
      expect(f.records()).toHaveLength(2); expect(new Set(f.records().map(r => r.id)).size).toBe(2);
      expect(f.records().every(r => r.status === 'incomplete')).toBe(true);
      // An abandoned partial temp file is never interpreted as a published JSON record.
      writeFileSync(join(f.root, '.brain-test-changed', '.partial.tmp'), '{');
      expect(f.records()).toHaveLength(2);
      writeFileSync(f.release, ''); expect((await doneA).code).toBe(0); expect((await doneB).code).toBe(0);
      expect(f.records().every(r => r.status === 'completed')).toBe(true);
    } finally {
      for (const path of [f.marker, f.marker + '-2']) if (existsSync(path)) stopPid(Number(readFileSync(path, 'utf8')));
      a?.kill('SIGKILL'); b?.kill('SIGKILL'); f.clean();
    }
  }, 30000);
});

describe('r1 regression contracts', () => {
  it('pins the exact baseline blob and compares command order and exit for all fixture cases', () => {
    const bytes = readFileSync(join(sourceRoot, 'tooling/test-db/test/fixtures/test-changed/run-baseline.mjs'));
    expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe('ce6e751256758653db7f5bec6eb2cb0fe818375f');
    for (const [, options] of cases) {
      const run = (baseline: boolean, writable: boolean) => { const f = fixture(options, writable, baseline); try {
        const result = spawnSync(process.execPath, f.args, {cwd:f.root, env:f.env, encoding:'utf8', timeout:30000});
        return {status:result.status, signal:result.signal, commands:f.commands()};
      } finally { f.clean(); } };
      const original = run(true, true);
      expect(run(false, true)).toEqual(original); expect(run(false, false)).toEqual(original);
    }
  });
  it('compares baseline direct Python selection and child signal outcomes', () => {
    for (const options of [{paths:['apps/cli/python-test/existing.test.ts']}, {childSignal:'build'}]) {
      const run = (baseline: boolean, writable: boolean) => { const f = fixture(options,writable,baseline); try {
        mkdirSync(join(f.root,'apps/cli/python-test'),{recursive:true}); writeFileSync(join(f.root,'apps/cli/python-test/existing.test.ts'),'');
        const r = spawnSync(process.execPath,f.args,{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
        return {status:r.status,signal:r.signal,commands:f.commands()};
      } finally { f.clean(); } };
      const original = run(true,true); expect(run(false,true)).toEqual(original); expect(run(false,false)).toEqual(original);
    }
  });
  it.each(['SIGINT','SIGTERM'] as const)('compares baseline and recorded %s while the owned child remains blocked', async signal => {
    const run = async (baseline: boolean, writable: boolean) => {
      const f = fixture({block:'build'}, writable, baseline); let pid = 0; let child: ChildProcess | undefined;
      try {
        child = spawn(process.execPath, f.args, {cwd:f.root, env:f.env, stdio:'ignore'}); const done = exited(child);
        await until(() => existsSync(f.marker)); pid = Number(readFileSync(f.marker,'utf8'));
        child.kill(signal);
        const result = await Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner failed to terminate while child blocked')), 3000))]);
        expect(() => process.kill(pid, 0)).not.toThrow();
        const records = f.records();
        if (!baseline && writable) expect(records[0]).toMatchObject({status:'incomplete', runnerExitCode:null, interruption:null});
        return {result, commands:f.commands()};
      } finally { if (pid) stopPid(pid); child?.kill('SIGKILL'); f.clean(); }
    };
    const original = await run(true, true);
    expect(original.result).toEqual({code:null, signal});
    expect(await run(false, true)).toEqual(original); expect(await run(false, false)).toEqual(original);
  }, 30000);
  it('merges all four Git sources without duplicates and connects each mixed input to its rules', () => {
    const migration = 'packages/postgres/migrations/0001.sql'; const extension = 'extensions/example/a.py';
    const direct = 'apps/cli/python-test/direct.test.ts'; const docs = 'docs/example.md';
    const r = execute({sources:{'git-committed':[migration,docs], 'git-staged':[extension,docs], 'git-unstaged':[direct,migration], 'git-untracked':[docs,'docs/other.md']}}, true).records[0];
    expect(r.inputs).toEqual([migration,docs,extension,direct,'docs/other.md']);
    expect(r.selection.inputReasons).toEqual([
      {path:migration, reasons:[{prefix:'packages/postgres',reason:'Python integration uses the real PostgreSQL store'}], postgresMigration:true, pythonDirect:false},
      {path:docs,reasons:[],postgresMigration:false,pythonDirect:false},
      {path:extension,reasons:[{prefix:'extensions',reason:'extension runtime, Garmin native SQL, Python oracle and subprocess fixtures'}],postgresMigration:false,pythonDirect:false},
      {path:direct,reasons:[],postgresMigration:false,pythonDirect:true},
      {path:'docs/other.md',reasons:[],postgresMigration:false,pythonDirect:false},
    ]);
  });
  it.each(['verify-ref','git-committed','git-staged','git-unstaged','git-untracked'])('records %s failure without later commands and preserves baseline exit', fail => {
    const options = {fail}; const original = fixture(options, true, true); const current = fixture(options);
    try {
      const a = spawnSync(process.execPath, original.args, {cwd:original.root, env:original.env, encoding:'utf8', timeout:30000});
      const b = spawnSync(process.execPath, current.args, {cwd:current.root, env:current.env, encoding:'utf8', timeout:30000});
      expect(a.status).toBe(1); expect(b.status).toBe(a.status); expect(current.commands()).toEqual(original.commands());
      const r = current.records()[0]; expect(r).toMatchObject({status:'failed', inputs:null, selection:null});
      expect(r.stages).toContainEqual(expect.objectContaining({name:fail,status:'failed',exitCode:7}));
      expect(r.stages).toContainEqual(expect.objectContaining({name:'default-list',status:'skipped',reason:'prior-failure'}));
    } finally { original.clean(); current.clean(); }
  });
  it.each(['loose','packed'])('reads linked worktree %s symbolic HEAD using relative commondir', kind => {
    const f = fixture({}); try {
      rmSync(join(f.root,'.git'),{recursive:true});
      const gitdir = join(f.root,'meta','worktrees','one'); const common = join(f.root,'meta');
      mkdirSync(gitdir,{recursive:true}); writeFileSync(join(f.root,'.git'),'gitdir: meta/worktrees/one\n');
      writeFileSync(join(gitdir,'HEAD'),'ref: refs/heads/topic\n'); writeFileSync(join(gitdir,'commondir'),'../..\n');
      if (kind === 'loose') { mkdirSync(join(common,'refs/heads'),{recursive:true}); writeFileSync(join(common,'refs/heads/topic'),'c'.repeat(40)+'\n'); }
      else writeFileSync(join(common,'packed-refs'),'# packed-refs\n'+'c'.repeat(40)+' refs/heads/topic\n');
      const result = spawnSync(process.execPath,f.args,{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
      expect(result.status).toBe(0); expect(f.records()[0].comparison.headSha).toBe('c'.repeat(40));
    } finally { f.clean(); }
  });
  it.each([['write',undefined],['rename',undefined],['write','default-list'],['rename','default-list']] as const)('preserves last published JSON on injected %s failures with command failure %s', (kind, fail) => {
    const baseline = fixture({fail}); const faulty = fixture({fail});
    try {
      const preload = join(sourceRoot,'tooling/test-db/test/fixtures/test-changed/preload.cjs');
      const run = (f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv) => spawnSync(process.execPath,f.args,{cwd:f.root,env,encoding:'utf8',timeout:30000});
      const a = run(baseline,baseline.env);
      const b = run(faulty,{...faulty.env,NODE_OPTIONS:`--require ${preload}`,FAULT_KIND:kind});
      expect(b.status).toBe(a.status); expect(faulty.commands()).toEqual(baseline.commands());
      expect(faulty.records()).toHaveLength(1); expect(faulty.records()[0]).toMatchObject({status:'incomplete',endedAt:null,runnerExitCode:null,stages:[]});
    } finally { baseline.clean(); faulty.clean(); }
  });
  it.each([['ENOBUFS','output-limit'],['EIO','process-error']] as const)('classifies injected %s separately from a child signal', (code, classification) => {
    const f = fixture({}); try {
      const preload = join(sourceRoot,'tooling/test-db/test/fixtures/test-changed/preload.cjs');
      const result = spawnSync(process.execPath,f.args,{cwd:f.root,env:{...f.env,NODE_OPTIONS:`--require ${preload}`,FAULT_SPAWN:code},encoding:'utf8',timeout:30000});
      const r = f.records()[0]; expect(result.status).toBe(1); expect(r.status).toBe('failed');
      expect(r.stages[0]).toMatchObject({status:'failed',error:classification,signal:'SIGTERM',exitCode:null});
      expect(r.interruption).toMatchObject({source:'runner',stage:'build'}); expect(JSON.stringify(r)).not.toContain('injected secret');
    } finally { f.clean(); }
  });
  it('redacts synthetic credential prefixes in input reasons and all selected lists', () => {
    const gh = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const pat = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const gitlab = 'glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const slack = 'xoxb-ABCDEFGHIJKLMNOPQRST';
    const aws = 'AKIA' + 'A'.repeat(16);
    const paths = [`docs/${gh}.txt`, `docs/${pat}.txt`, `docs/${gitlab}.txt`, `docs/${slack}.txt`, `docs/${aws}.txt`, 'docs/ordinary.md', 'packages/postgres/migrations/0001.sql'];
    const out = execute({paths, defaultFiles:[`apps/cli/test/${gh}-tracer.test.ts`, 'apps/cli/test/ordinary.test.ts'], postgresFiles:[`packages/postgres/test/${pat}.test.ts`], pythonFiles:[`apps/cli/python-test/${gitlab}.test.ts`]}, true);
    const r = out.records[0];
    expect(r.inputs).toEqual(['[redacted]','[redacted]','[redacted]','[redacted]','[redacted]','docs/ordinary.md','packages/postgres/migrations/0001.sql']);
    expect(r.selection.inputReasons.map((entry:{path:string}) => entry.path)).toEqual(r.inputs);
    expect(r.selection.default).toEqual(['[redacted]','apps/cli/test/ordinary.test.ts']);
    expect(r.selection.postgres).toEqual(['[redacted]']); expect(r.selection.python).toEqual(['[redacted]']);
    expect(r.tracer.files).toEqual(['[redacted]']);
    const missing = execute({paths:[`apps/cli/python-test/${gh}.test.ts`]}, true).records[0];
    expect(missing.selection.pythonMissing).toEqual(['[redacted]']);
    for (const secret of [gh,pat,gitlab,slack,aws]) expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(missing)).not.toContain(gh);
    const directPath = `apps/cli/python-test/${gh}.test.ts`;
    const f = fixture({paths:[directPath]}); try {
      mkdirSync(join(f.root,'apps/cli/python-test'),{recursive:true}); writeFileSync(join(f.root,directPath),'');
      const result = spawnSync(process.execPath,f.args,{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
      expect(result.status).toBe(0); expect(f.records()[0].selection.python).toEqual(['[redacted]']);
      expect(f.commands()).toContainEqual(['node','tooling/test-db/dist/python-slots.js','--files',directPath]);
      expect(JSON.stringify(f.records()[0])).not.toContain(gh);
    } finally { f.clean(); }
  });
  it('redacts synthetic Stripe live and test paths while preserving ordinary names and command arguments', () => {
    const live = 'sk_live_' + 'A'.repeat(24); const test = 'sk_test_' + 'B'.repeat(24);
    const direct = `apps/cli/python-test/${live}.test.ts`;
    const paths = [direct, `docs/${test}.txt`, 'docs/ordinary.md'];
    const f = fixture({paths, defaultFiles:[`apps/cli/test/${live}.test.ts`, `apps/cli/test/${test}.test.ts`, 'apps/cli/test/ordinary.test.ts']});
    try {
      mkdirSync(join(f.root,'apps/cli/python-test'),{recursive:true}); writeFileSync(join(f.root,direct),'');
      const result = spawnSync(process.execPath,f.args,{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});
      const record = f.records()[0];
      expect(result.status).toBe(0);
      expect(record.inputs).toEqual(['[redacted]','[redacted]','docs/ordinary.md']);
      expect(record.selection.inputReasons.map((entry:{path:string}) => entry.path)).toEqual(record.inputs);
      expect(record.selection.default).toEqual(['[redacted]','[redacted]','apps/cli/test/ordinary.test.ts']);
      expect(record.selection.python).toEqual(['[redacted]']);
      expect(f.commands()).toContainEqual(['node','tooling/test-db/dist/python-slots.js','--files',direct]);
      expect(JSON.stringify(record)).not.toContain(live); expect(JSON.stringify(record)).not.toContain(test);
    } finally { f.clean(); }
  });
  it('redacts api-key and sk-proj paths and records consistent UTC and monotonic times', () => {
    const r = execute({paths:['docs/api-key-abc.txt','docs/sk-proj-abc123.txt','docs/public.md']},true).records[0];
    expect(r.inputs).toEqual(['[redacted]','[redacted]','docs/public.md']);
    expect(r.startedAt).toMatch(/Z$/); expect(r.endedAt).toMatch(/Z$/);
    expect(Date.parse(r.startedAt)).toBeLessThanOrEqual(Date.parse(r.endedAt)); expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    for (const stage of r.stages.filter((s:{status:string}) => s.status === 'completed')) {
      expect(Date.parse(stage.startedAt)).toBeGreaterThanOrEqual(Date.parse(r.startedAt));
      expect(Date.parse(stage.endedAt)).toBeGreaterThanOrEqual(Date.parse(stage.startedAt));
      expect(Date.parse(stage.endedAt)).toBeLessThanOrEqual(Date.parse(r.endedAt));
      expect(stage.elapsedMs).toBeGreaterThanOrEqual(0); expect(stage.elapsedMs).toBeLessThanOrEqual(r.elapsedMs);
    }
  });
  it('reads published JSON throughout simultaneous updates and keeps IDs independent', async () => {
    const f = fixture({block:'build'}); let a:ChildProcess|undefined; let b:ChildProcess|undefined;
    try {
      a = spawn(process.execPath,f.args,{cwd:f.root,env:f.env,stdio:'ignore'}); const da = exited(a);
      await until(() => existsSync(f.marker));
      b = spawn(process.execPath,f.args,{cwd:f.root,env:{...f.env,MARKER:f.marker+'-2'},stdio:'ignore'}); const db = exited(b);
      await until(() => existsSync(f.marker+'-2'));
      const ids = f.records().map(r => r.id); expect(new Set(ids).size).toBe(2);
      let done = false; const both = Promise.all([da,db]).then(result => {done = true; return result;});
      writeFileSync(f.release,'');
      while (!done) { expect(f.records().map(r => r.id).sort()).toEqual([...ids].sort()); await new Promise(resolve => setTimeout(resolve, 2)); }
      expect((await both).map(r => r.code)).toEqual([0,0]); expect(f.records().every(r => r.status === 'completed')).toBe(true);
    } finally {
      for (const path of [f.marker,f.marker+'-2']) if (existsSync(path)) stopPid(Number(readFileSync(path,'utf8')));
      a?.kill('SIGKILL'); b?.kill('SIGKILL'); f.clean();
    }
  },30000);
});
