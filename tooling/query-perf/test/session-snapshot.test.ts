import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error JavaScript performance helpers have no declarations.
import { compare, parseArgs } from '../src/core.mjs';
// @ts-expect-error JavaScript runner has no declarations; importing does not execute it.
import { run, traced, samples } from '../src/session-snapshot.mjs';
// @ts-expect-error JavaScript provenance helper has no declarations.
import { checkoutRevision } from '../src/revision.mjs';
// @ts-expect-error JavaScript CLI has no declarations; importing does not run it.
import { main } from '../run.mjs';

const measurement = (n: number) => ({ samplesMs: [n + 1, n - 1, n], medianMs: n });
const sample = (n = 100) => ({
 scenario:'session-snapshot', fixture:{rows:100000,bodyBytes:1024,groupSize:20,chunkCount:5000},
 checkoutRevision:{sha:'a'.repeat(40),dirty:false,diffSha256:'b'.repeat(64)},
 artifacts:{sha256:'c'.repeat(64),lockSha256:'9'.repeat(64),runner:{sha256:'d'.repeat(64)}},
 environment:{node:'v24',postgres:'PostgreSQL 18',platform:'darwin',arch:'arm64',cpus:12},
 results:{rowCount:100000,fingerprint:'sha256:'+'e'.repeat(64),staleFingerprint:'sha256:'+'4'.repeat(64),chunksHash:'f'.repeat(64),changedChunksHash:'8'.repeat(64),configHash:'1'.repeat(64),messagesHash:'2'.repeat(64),staleCommitted:false,oracleMatch:true},
 measurements:{readTransaction:measurement(n),commitTransaction:measurement(n),lockHeld:measurement(n),initialWrite:measurement(n),changedWrite:measurement(n),advisoryWait:measurement(n),probe:{pid:42,confirmedWaits:3,sampleCount:3}},
});

describe('snapshot comparison', () => {
 it('accepts exactly one half for all three independent measurements', () => {
  const result=compare(sample(),sample(50));
  expect(result.pass).toBe(true); expect(result.equal).toBe(true);
  expect(result.ratios).toEqual({readTransaction:0.5,commitTransaction:0.5,lockHeld:0.5});
 });
 it.each(['readTransaction','commitTransaction','lockHeld'] as const)('rejects %s above half', key => {
  const change=sample(50); change.measurements[key]=measurement(51); expect(compare(sample(),change).pass).toBe(false);
 });
 it.each(['fingerprint','staleFingerprint','chunksHash','changedChunksHash','configHash','messagesHash'] as const)('rejects differing %s', key => {
  const change=sample(50); change.results[key]=key.endsWith('ingerprint')?'sha256:'+'3'.repeat(64):'3'.repeat(64);
  expect(compare(sample(),change).pass).toBe(false);
 });
 it.each(['fingerprint','staleFingerprint','chunksHash','changedChunksHash','configHash','messagesHash','rowCount','staleCommitted','oracleMatch'] as const)('rejects missing %s in either result', key => {
  const bad=sample(); delete (bad.results as Partial<typeof bad.results>)[key];
  expect(()=>compare(bad,sample(50))).toThrow(); expect(()=>compare(sample(),bad)).toThrow();
 });
 it('rejects accepted stale data, missing or forged samples and medians', () => {
  const bad=sample(50); bad.results.staleCommitted=true; expect(()=>compare(sample(),bad)).toThrow();
  const forged=sample(50); forged.measurements.lockHeld.medianMs=1; expect(()=>compare(sample(),forged)).toThrow();
  const noWait=sample(50); noWait.measurements.probe.confirmedWaits=0; expect(()=>compare(sample(),noWait)).toThrow();
  const missing=sample(50); missing.measurements.readTransaction.samplesMs.pop(); expect(()=>compare(sample(),missing)).toThrow();
  const invalid=sample(50); invalid.measurements.commitTransaction.samplesMs[0]=NaN; expect(()=>compare(sample(),invalid)).toThrow();
 });
 it('rejects incompatible fixture, runner, environment and missing provenance', () => {
  const fixture=sample(50); fixture.fixture.groupSize=10; expect(()=>compare(sample(),fixture)).toThrow();
  const both=sample(); both.fixture.chunkCount=2; expect(()=>compare(both,both)).toThrow();
  const runner=sample(50); runner.artifacts.runner.sha256='f'.repeat(64); expect(()=>compare(sample(),runner)).toThrow();
  const env=sample(50); env.environment.postgres='other'; expect(()=>compare(sample(),env)).toThrow();
  const noEnv=sample(); noEnv.environment.node=''; expect(()=>compare(noEnv,noEnv)).toThrow();
  const lock=sample(50); lock.artifacts.lockSha256='7'.repeat(64); expect(()=>compare(sample(),lock)).toThrow();
  const noLock=sample(); noLock.artifacts.lockSha256=''; expect(()=>compare(noLock,noLock)).toThrow();
  const revision=sample(50); revision.checkoutRevision.sha='not-a-sha'; expect(()=>compare(sample(),revision)).toThrow();
  const missingArtifact=sample(50); missingArtifact.artifacts.sha256=''; expect(()=>compare(sample(),missingArtifact)).toThrow();
  expect(()=>compare(sample(),{...sample(50),scenario:'import-cleanup'})).toThrow();
 });
});

describe('snapshot CLI and provenance', () => {
 it('parses the snapshot command and rejects incomplete, duplicate and irrelevant options', () => {
  const args=['session-snapshot','--checkout','.','--database-url','postgres://localhost/owned','--out','result.json'];
  expect(parseArgs(args)).toEqual({command:'session-snapshot',checkout:'.',databaseUrl:'postgres://localhost/owned',out:'result.json'});
  expect(()=>parseArgs(args.slice(0,-2))).toThrow();
  expect(()=>parseArgs([...args,'--out','other'])).toThrow();
  expect(()=>parseArgs([...args,'--sizes','1000'])).toThrow();
  expect(()=>parseArgs([...args,'--out'])).toThrow();
  expect(typeof run).toBe('function');
  expect(typeof main).toBe('function');
 });
 it('fingerprints untracked core source contents', () => {
  const dir=mkdtempSync(join(tmpdir(),'query-perf-core-'));
  const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{stdio:'ignore'});
  try {
   git('init'); git('-c','user.name=test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','fixture');
   const folder=join(dir,'packages/core/src'); mkdirSync(folder,{recursive:true}); const file=join(folder,'new.ts');
   writeFileSync(file,'first'); const first=checkoutRevision(dir);
   writeFileSync(file,'second'); const second=checkoutRevision(dir);
   expect(first.dirty).toBe(true); expect(first.sha).toBe(second.sha); expect(first.diffSha256).not.toBe(second.diffSha256);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
});

describe('snapshot tracing and resource lifecycle', () => {
 it('uses query completion times for transaction and held lock duration', async () => {
  class FakeClient { query(_query: string) { return Promise.resolve({ rows: [] }); } }
  const times=[0,10,20,30,80,100];
  const client=new FakeClient();
  const result=await traced(FakeClient,async()=>{
   await client.query('begin'); await client.query('select pg_advisory_xact_lock(1)'); await client.query('commit');
   return 'ok';
  },undefined,undefined,undefined,()=>times.shift());
  expect(result.transaction).toBe(90); expect(result.lockHeld).toBe(70); expect(result.result).toBe('ok');
 });
 it('excludes the identifiable warmup and preserves measured order', async () => {
  expect(await samples(async (i:number)=>[99,11,22,33][i])).toEqual([11,22,33]);
 });
 it('restores the query prototype and callback contract after rejection', async () => {
  const cause=new Error('query rejected');
  class FakeClient { query(_q:string, callback?: (error:Error|null, value?:string)=>void): Promise<string>|void {
   if(callback) { callback(null,'callback result'); return; } return Promise.reject(cause);
  } }
  const original=FakeClient.prototype.query, client=new FakeClient();
  try {
   await expect(traced(FakeClient,()=>client.query('bad'))).rejects.toBe(cause);
   expect(FakeClient.prototype.query).toBe(original);
   const callback=vi.fn(); client.query('callback',callback); expect(callback).toHaveBeenCalledWith(null,'callback result');
  } finally { FakeClient.prototype.query=original; }
 });
 it('rejects missing or corrupt advisory diagnostic samples', () => {
  for(const value of [[],[1,2],[1,2,0],[1,2,NaN]]) {
   const bad=sample(); bad.measurements.advisoryWait.samplesMs=value;
   expect(()=>compare(bad,sample())).toThrow();
  }
  const median=sample(); median.measurements.advisoryWait.medianMs=999; expect(()=>compare(median,sample())).toThrow();
  const count=sample(); count.measurements.probe.sampleCount=2; expect(()=>compare(count,sample())).toThrow();
 });
 it('validates git versus archive revision pairs and lockfile provenance', () => {
  const archive=sample(); (archive.checkoutRevision as {dirty:boolean|null;diffSha256:string|null}).dirty=null;
  (archive.checkoutRevision as {dirty:boolean|null;diffSha256:string|null}).diffSha256=null;
  expect(compare(archive,sample(50)).pass).toBe(true);
  const wrong=sample(); (wrong.checkoutRevision as {dirty:boolean|null}).dirty=null;
  expect(()=>compare(wrong,sample(50))).toThrow();
  const missing=sample(); delete (missing.checkoutRevision as Partial<typeof missing.checkoutRevision>).diffSha256;
  expect(()=>compare(missing,sample(50))).toThrow();
  expect(compare(sample(),sample(50)).provenance.base.artifacts.lockSha256).toBe('9'.repeat(64));
 });
});

it('sanitizes a nonexistent checkout error at the CLI boundary', async () => {
 const log=vi.spyOn(console,'error').mockImplementation(()=>{}); const previous=process.exitCode;
 try {
  await main(['session-snapshot','--checkout','/Users/private/missing-checkout','--database-url','postgres://user:secret@localhost/db','--out','unused']);
  expect(log).toHaveBeenCalled(); const message=String(log.mock.calls[0]?.[0]);
  expect(message).not.toContain('/Users/private'); expect(message).not.toContain('secret'); expect(process.exitCode).toBe(1);
 } finally { log.mockRestore(); process.exitCode=previous; }
});
