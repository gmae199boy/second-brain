import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = join(repo, 'tooling/test-db/test/fixtures/test-changed-selection');
const baselineSha256 = '1f39214540c63450f9d46efe699eedfc7bfba2e62f0e2ddb9528d5538dedabd5';
const baselineRevision = '7b09aead25094304f8aee9359899a69fc477a932';
const independent = [
  'tooling/test-db/test/test-changed.test.ts', 'tooling/test-db/test/test-changed-record.test.ts',
  'packages/postgres/test/schedule-occurrences.test.ts', 'packages/postgres/test/user-keys.test.ts',
];
type Sources = Record<string, string[]>;
type Options = { sources: Sources; existing?: string[]; fail?: string; ref?: string; baseSha?: string; headSha?: string };
const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), opt = JSON.parse(process.env.OPTIONS);
const gitKey = args[0] === 'rev-parse' ? 'verify-ref' : args[0] === 'ls-files' ? 'git-untracked' : args.includes('--cached') ? 'git-staged' : args.some(a => a.endsWith('...HEAD')) ? 'git-committed' : 'git-unstaged';
const key = name === 'git' ? gitKey : name === 'pnpm' && args[0] === 'build' ? 'build' : name === 'pnpm' && args[1] === 'vitest' ? (args.includes('--config') ? 'python-' : args.includes('--project') ? 'postgres-' : 'default-') + args[2] : name;
fs.appendFileSync(process.env.LOG, JSON.stringify([name,...args]) + String.fromCharCode(10));
if (opt.fail === key) process.exit(7);
if (name === 'git' && key === 'verify-ref') console.log(opt.baseSha || 'a'.repeat(40));
if (name === 'git' && key !== 'verify-ref') process.stdout.write((opt.sources[key] || []).map(p => p + String.fromCharCode(0)).join(''));
if (name === 'pnpm' && args[2] === 'list') {
 const files = key === 'python-list' ? ['apps/cli/python-test/example.test.ts'] : key === 'postgres-list' ? ['packages/postgres/test/example.test.ts'] : ['apps/cli/test/example-tracer.test.ts'];
 process.stdout.write(JSON.stringify(files.map(file => ({file:path.resolve(process.cwd(),file)}))));
}
`;
function execute(options: Options, baseline: boolean, writable = true) {
  const dir = mkdtempSync(join(tmpdir(), 'selection-compare-'));
  const root = join(dir, 'repo'), bin = join(dir, 'bin'), log = join(dir, 'commands');
  try {
    mkdirSync(join(root, 'tooling/test-changed'), {recursive:true}); mkdirSync(bin);
    for (const name of ['run.mjs', 'record.mjs', 'rules.mjs']) copyFileSync(join(repo, 'tooling/test-changed', name), join(root, 'tooling/test-changed', name));
    if (baseline) copyFileSync(join(fixtures, 'baseline-rules.mjs'), join(root, 'tooling/test-changed/rules.mjs'));
    mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/HEAD'), (options.headSha ?? 'b'.repeat(40)) + '\n');
    for (const path of options.existing ?? []) { mkdirSync(dirname(join(root,path)), {recursive:true}); writeFileSync(join(root,path), ''); }
    for (const name of ['git','pnpm','node']) writeFileSync(join(bin,name), fake, {mode:0o755});
    if (!writable) writeFileSync(join(root,'.brain-test-changed'), 'blocked');
    const result = spawnSync(process.execPath, [join(root,'tooling/test-changed/run.mjs'), options.ref ?? baselineRevision], {
      cwd:root, env:{...process.env,PATH:bin+delimiter+process.env.PATH, OPTIONS:JSON.stringify(options), LOG:log}, encoding:'utf8', timeout:30000,
    });
    const records = writable && existsSync(join(root,'.brain-test-changed')) ? readdirSync(join(root,'.brain-test-changed')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(root,'.brain-test-changed',n),'utf8'))) : [];
    const commands = existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as string[]) : [];
    const diagnostic = `baseline=${baseline} sources=${Object.keys(options.sources).join(',')} status=${result.status} signal=${result.signal} error=${result.error?.name ?? 'none'} stdout=[redacted:${result.stdout?.length ?? 0}] stderr=[redacted:${result.stderr?.length ?? 0}]`;
    return {status:result.status, signal:result.signal, records, commands, diagnostic};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
function compare(options: Options) {
  const before = execute(options,true), after = execute(options,false);
  expect(before.status,before.diagnostic).toBe(0); expect(after.status,after.diagnostic).toBe(0);
  expect(before.records).toHaveLength(1); expect(after.records).toHaveLength(1);
  const a = before.records[0], b = after.records[0];
  for (const r of [a,b]) expect(r).toMatchObject({version:1,status:'completed',runnerExitCode:0,comparison:{ref:options.ref ?? baselineRevision,baseSha:options.baseSha ?? 'a'.repeat(40),headSha:options.headSha ?? 'b'.repeat(40)},tracer:{files:['apps/cli/test/example-tracer.test.ts'],stage:'default-run',elapsedMs:null,timing:'shared-stage'}});
  expect(b.inputs).toEqual(a.inputs);
  expect(b.selection.default).toEqual(a.selection.default);
  expect(b.selection.postgres).toEqual(a.selection.postgres);
  expect(b.selection.postgresAll).toEqual(a.selection.postgresAll);
  const paths = Object.values(options.sources).flat();
  const expectedReasons = a.selection.reasons.filter((reason: {prefix:string}) => {
    if (reason.prefix !== 'tooling/test-db' && reason.prefix !== 'packages/postgres') return true;
    return paths.some(path => path.startsWith(reason.prefix + '/') && !independent.includes(path));
  });
  expect(b.selection.reasons).toEqual(expectedReasons);
  const stages = (r: typeof a) => r.stages.filter((s: {name:string})=>!s.name.startsWith('python-')).map((s: {name:string;status:string;reason?:string;exitCode:number|null;signal:string|null})=>({name:s.name,status:s.status,reason:s.reason,exitCode:s.exitCode,signal:s.signal}));
  expect(stages(b)).toEqual(stages(a));
  const isPython = (c: string[]) => c[0] === 'node' || (c[0] === 'pnpm' && c.includes('apps/cli/python-test/vitest.config.ts'));
  expect(after.commands.filter(c=>!isPython(c))).toEqual(before.commands.filter(c=>!isPython(c)));
  const ref = options.ref ?? baselineRevision;
  for (const run of [before,after]) {
    expect(run.commands.slice(0,8)).toEqual([
      ['pnpm','build'], ['git','rev-parse','--verify','--end-of-options',`${ref}^{commit}`],
      ['git','diff','--name-only','--no-renames','-z',`${ref}...HEAD`],
      ['git','diff','--cached','--name-only','--no-renames','-z'], ['git','diff','--name-only','--no-renames','-z'],
      ['git','ls-files','--others','--exclude-standard','-z'],
      ['pnpm','exec','vitest','list','--changed',ref,'--filesOnly','--json'],
      ['pnpm','exec','vitest','run','--changed',ref,'--passWithNoTests'],
    ]);
    const r = run.records[0];
    const pg = run.commands.filter(c=>c.includes('--project'));
    expect(pg).toEqual(r.selection.postgresAll ? [
      ['pnpm','exec','vitest','list','--project','postgres','--filesOnly','--json'],
      ['pnpm','exec','vitest','run','--project','postgres','--passWithNoTests'],
    ] : []);
    const py = run.commands.filter(isPython);
    const list = ['pnpm','exec','vitest','list','--config','apps/cli/python-test/vitest.config.ts','--filesOnly','--json'];
    const node = ['node','tooling/test-db/dist/python-slots.js'];
    const mode = r.selection.pythonMode;
    expect(py).toEqual(mode === 'all' ? [list,node] : mode === 'files' && r.selection.python.length ? [[...node,'--files',...r.selection.python]] : []);
    const pyStages = r.stages.filter((s:{name:string})=>s.name.startsWith('python-')).map((s:{name:string;status:string;reason?:string;exitCode:number|null;signal:string|null})=>({name:s.name,status:s.status,reason:s.reason,exitCode:s.exitCode,signal:s.signal}));
    expect(pyStages).toEqual(mode === 'all' ? [
      {name:'python-list',status:'completed',reason:undefined,exitCode:0,signal:null}, {name:'python-run',status:'completed',reason:undefined,exitCode:0,signal:null},
    ] : [
      {name:'python-list',status:'skipped',reason:mode === 'files' ? 'direct-files' : 'no-matching-rule',exitCode:null,signal:null},
      {name:'python-run',status:mode === 'files' && r.selection.python.length ? 'completed' : 'skipped',reason:mode === 'none' ? 'no-matching-rule' : r.selection.python.length ? undefined : 'no-existing-files',exitCode:mode === 'files' && r.selection.python.length ? 0 : null,signal:null},
    ]);
  }
  return {before,after,a,b};
}
const committed = (paths: string[]): Sources => ({'git-committed':paths});

describe('test:changed v1 selection comparison with mocked children', () => {
  it('pins the baseline rules bytes and revision', () => {
    expect(baselineRevision).toBe('7b09aead25094304f8aee9359899a69fc477a932');
    expect(createHash('sha256').update(readFileSync(join(fixtures,'baseline-rules.mjs'))).digest('hex')).toBe(baselineSha256);
  });
  it.each([...independent.map(p=>({paths:[p]})), {paths:[...independent, independent[0]!]}])('omits Python for $paths', ({paths}) => {
      const {a,b,after} = compare({sources:committed(paths)});
      expect(a.selection.pythonMode).toBe('all'); expect(b.selection.pythonMode).toBe('none');
      expect(a.selection.python).toEqual(['apps/cli/python-test/example.test.ts']); expect(b.selection.python).toEqual([]);
      expect(a.selection.reasons.length).toBeGreaterThan(0); expect(b.selection.reasons).toEqual([]);
      expect(b.selection.inputReasons.every((row: {reasons:unknown[]})=>row.reasons.length===0)).toBe(true);
      expect(b.stages).toEqual(expect.arrayContaining([expect.objectContaining({name:'python-list',status:'skipped',reason:'no-matching-rule'}),expect.objectContaining({name:'python-run',status:'skipped',reason:'no-matching-rule'})]));
      expect(after.commands).toContainEqual(['pnpm','exec','vitest','run','--changed',baselineRevision,'--passWithNoTests']);
      expect(after.commands.some(c=>c[0]==='node')).toBe(false);
  });
  it.each(['tooling/test-db/src/index.ts','tooling/test-db/test/global-setup.test.ts','tooling/test-db/test/fixtures/test-changed/preload.cjs','packages/postgres/test/fixture.ts','packages/postgres/test/global-setup.ts','packages/postgres/test/fixtures/drive-delete-barrier-child.mjs','packages/postgres/tsconfig.json','packages/postgres/src/store.ts','packages/postgres/test/unknown.test.ts'].flatMap(path => [ {path,paths:[path]}, {path,paths:[independent[0]!,path]} ]))('preserves full selection for $paths', ({path,paths}) => {
        const {a,b} = compare({sources:committed(paths)});
        expect(b.selection.pythonMode,path).toBe('all'); expect(b.selection.python).toEqual(a.selection.python);
        expect(b.selection.inputReasons.at(-1)).toEqual(a.selection.inputReasons.at(-1));
  });
  it('preserves migration and direct/missing Python selection', () => {
    const migration = compare({sources:committed([independent[2]!, 'packages/postgres/migrations/0044_drive_resume.sql'])});
    expect(migration.b.selection).toMatchObject({pythonMode:'all',postgresAll:true,postgres:['packages/postgres/test/example.test.ts']});
    const direct = 'apps/cli/python-test/existing.test.ts', missing = 'apps/cli/python-test/deleted.test.ts';
    const {a,b} = compare({sources:committed([independent[0]!,direct,missing]),existing:[direct]});
    expect(a.selection.pythonMode).toBe('all');
    expect(b.selection).toMatchObject({pythonMode:'files',python:[direct],pythonMissing:[missing]});
    expect(b.stages).toEqual(expect.arrayContaining([expect.objectContaining({name:'python-list',reason:'direct-files'}),expect.objectContaining({name:'python-run',status:'completed'})]));
    const onlyMissing = compare({sources:committed([missing])});
    expect(onlyMissing.b.selection).toMatchObject({pythonMode:'files',python:[],pythonMissing:[missing]});
    expect(onlyMissing.b.stages).toContainEqual(expect.objectContaining({name:'python-run',reason:'no-existing-files'}));
  });
  it('combines four Git sources and treats rename, deletion and literal path forms as inputs', () => {
    const options = {sources:{'git-committed':[independent[2]!,independent[2]!], 'git-staged':['packages/postgres/test/renamed.test.ts'], 'git-unstaged':[independent[0]!], 'git-untracked':['docs/new.md']}};
    const {a,b,after} = compare(options);
    expect(b.inputs).toEqual([independent[2], 'packages/postgres/test/renamed.test.ts', independent[0], 'docs/new.md']);
    expect(b.selection.pythonMode).toBe('all');
    expect(after.commands).toContainEqual(['git','diff','--name-only','--no-renames','-z',`${baselineRevision}...HEAD`]);
    const empty = compare({sources:{}}); expect(empty.b.inputs).toEqual([]); expect(empty.b.selection.pythonMode).toBe('none');
    const literal = compare({sources:committed([independent[2]!.replace('schedule','Schedule'),independent[0]!.replaceAll('/','\\')])});
    expect(literal.b.selection.pythonMode).toBe('all'); expect(literal.b.inputs[1]).toBe('[redacted]');
  });
  it.each(['git-committed','git-staged','git-unstaged','git-untracked'].flatMap(source => independent.map(path => ({source,path}))))('classifies absent candidate $path from $source', ({source,path}) => {
    const {a,b} = compare({sources:{[source]:[path]}});
    expect(a.selection.pythonMode).toBe('all'); expect(b.selection.pythonMode).toBe('none');
    expect(b.inputs).toEqual([path]);
  });
  it.each(independent.flatMap((oldPath,i)=>independent.filter((_,j)=>i!==j).map(newPath=>({oldPath,newPath}))))('keeps candidate rename $oldPath to $newPath narrow', ({oldPath,newPath}) => {
    const {a,b} = compare({sources:committed([oldPath,newPath])});
    expect(a.selection.pythonMode).toBe('all'); expect(b.selection.pythonMode).toBe('none');
    expect(b.inputs).toEqual([oldPath,newPath]);
  });
  it.each([
    {label:'mixed full list', paths:[independent[0]!, 'tooling/test-db/src/index.ts'], fail:'python-list', existing:[], baseline:false, mode:'all'},
    {label:'mixed full runner', paths:[independent[0]!, 'tooling/test-db/src/index.ts'], fail:'node', existing:[], baseline:false, mode:'all'},
    {label:'baseline full list', paths:[independent[0]!], fail:'python-list', existing:[], baseline:true, mode:'all'},
    {label:'baseline full runner', paths:[independent[0]!], fail:'node', existing:[], baseline:true, mode:'all'},
    {label:'candidate direct runner', paths:[independent[0]!, 'apps/cli/python-test/existing.test.ts'], fail:'node', existing:['apps/cli/python-test/existing.test.ts'], baseline:false, mode:'files'},
  ])('preserves $label failure and unavailable recording', ({paths,fail,existing,baseline,mode}) => {
    const options = {sources:committed(paths),fail,existing};
    const enabled = execute(options,baseline), blocked = execute(options,baseline,false);
    expect(enabled.status,enabled.diagnostic).toBe(1); expect(blocked.status,blocked.diagnostic).toBe(1);
    expect(blocked.signal).toEqual(enabled.signal); expect(blocked.commands).toEqual(enabled.commands); expect(blocked.records).toEqual([]);
    const record = enabled.records[0]; expect(record).toMatchObject({status:'failed',runnerExitCode:1,selection:{pythonMode:mode}});
    const list = ['pnpm','exec','vitest','list','--config','apps/cli/python-test/vitest.config.ts','--filesOnly','--json'];
    const node = ['node','tooling/test-db/dist/python-slots.js'];
    expect(enabled.commands.filter(c=>c[0]==='node' || c.includes('apps/cli/python-test/vitest.config.ts'))).toEqual(
      mode === 'files' ? [[...node,'--files',...existing]] : fail === 'python-list' ? [list] : [list,node]);
    expect(record.stages).toContainEqual(expect.objectContaining({name:fail === 'node' ? 'python-run' : 'python-list',status:'failed',exitCode:7,signal:null}));
    if (fail === 'python-list') expect(record.stages).toContainEqual(expect.objectContaining({name:'python-run',status:'skipped',reason:'prior-failure'}));
    if (mode === 'files') expect(record.stages).toContainEqual(expect.objectContaining({name:'python-list',status:'skipped',reason:'direct-files'}));
  });
  it('compares fixed accepted ticket diffs with full parent and head identifiers', () => {
    const diffs = JSON.parse(readFileSync(join(fixtures,'diffs.json'),'utf8')) as {head:string;parent:string;paths:string[]}[];
    expect(diffs.map(d=>[d.head,d.parent])).toEqual([
      ['0dc360911a02b4f17b4514919c1ce724e8e7c19a','cb8391173aead346abb5177d87212d999ce30bd8'],
      ['f361d8d40a8170c0e1fd470d665428440d7d782a','4e63538383590b575847754362c61630acd82a3b'],
      ['ed915a226b26f7e14dda67003c0a94b8706399c8','0441998e3b0994573a49afbbc68b6f93cb56fe90'],
    ]);
    // Digests independently recorded from git diff --name-only --no-renames -z parent head.
    const hashes = ['7e697bf6379b901b010cd5190ff2c30284184a30b7d228da13356d3df106cd0e','e2472111149cae5963c2a2bea071c7a36ad2c1e715c35afe9f1ac6392fa53254','a9aed462fad36b3b4338bea037d38f2f1e107d7a496fddd71bb2c2dd16b63558'];
    for (const [i,diff] of diffs.entries()) {
      expect(createHash('sha256').update(diff.paths.map(path=>path+'\0').join('')).digest('hex')).toBe(hashes[i]);
      const {a,b} = compare({sources:committed(diff.paths),ref:diff.parent,baseSha:diff.parent,headSha:diff.head});
      expect(b.selection.pythonMode).toBe('all'); expect(b.selection.python).toEqual(a.selection.python);
      expect(b.inputs).toEqual(diff.paths.map(path => path === '.gitignore' ? '[redacted]' : path));
    }
  });
  it('preserves exit and commands when recording fails and redacts sensitive values', () => {
    for (const baseline of [true,false]) {
      const options = {sources:committed([independent[0]!, 'docs/password.txt'])};
      const enabled = execute(options,baseline), blocked = execute(options,baseline,false);
      expect(blocked.status).toBe(enabled.status); expect(blocked.signal).toBe(enabled.signal); expect(blocked.commands).toEqual(enabled.commands);
      expect(blocked.records).toEqual([]); expect(enabled.records[0].inputs).toEqual([independent[0],'[redacted]']);
      expect(JSON.stringify(enabled.records[0])).not.toContain('docs/password.txt');
      const fail = execute({...options,fail:'default-list'},baseline), failBlocked = execute({...options,fail:'default-list'},baseline,false);
      expect(fail.status).toBe(1); expect(failBlocked.status).toBe(1); expect(failBlocked.commands).toEqual(fail.commands);
      expect(fail.records[0]).toMatchObject({status:'failed',runnerExitCode:1});
    }
  });
});
