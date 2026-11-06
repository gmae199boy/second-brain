import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript runner intentionally has no TypeScript declarations.
import { median, hash, parseArgs, compare, candidateConflict } from '../src/core.mjs';
describe('query performance helpers', () => {
 it('allows none and rejects only duplicate selected candidate indexes', () => {
  const locator={table_name:'file_requests',columns:['source','locator'],predicate:null};
  const open={table_name:'file_import_cleanup',columns:['request_id'],predicate:'(cleaned_at IS NULL)'};
  expect(candidateConflict('none',[locator,open])).toBeUndefined();
  expect(candidateConflict('locator',[locator])).toBe(locator);
  expect(candidateConflict('open',[open])).toBe(open);
  expect(candidateConflict('both',[locator])).toBe(locator);
  expect(candidateConflict('both',[open])).toBe(open);
  expect(candidateConflict('open',[locator])).toBeUndefined();
  expect(candidateConflict('locator',[open])).toBeUndefined();
  expect(candidateConflict('locator',[{...locator,predicate:'(source IS NOT NULL)'}])).toBeUndefined();
 });
 it('computes a median without mutating samples', () => { const samples=[3,1,2]; expect(median(samples)).toBe(2); expect(samples).toEqual([3,1,2]); expect(median([4,2])).toBe(3); expect(()=>median([])).toThrow(); });
 it('hashes ordered results deterministically', () => { expect(hash(['a','b'])).toBe(hash(['a','b'])); expect(hash(['b','a'])).not.toBe(hash(['a','b'])); });
 it('parses and validates arguments', () => { expect(parseArgs(['import-cleanup','--checkout','.','--database-url','postgres://localhost/postgres','--out','x','--sizes','1000,10000']).sizes).toEqual([1000,10000]); expect(()=>parseArgs(['import-cleanup','--sizes','bad'])).toThrow(); expect(()=>parseArgs(['compare','a'])).toThrow(); });
 const measurement=(n:number)=>({medianMs:n,samplesMs:[n,n,n]});
 const matrix=()=>[1000,10000,100000].flatMap(size=>['idle','pending100','shared100'].map(condition=>({size,condition,...measurement(condition==='pending100'?100:10),hash:'a'.repeat(64),rowCount:condition==='pending100'?100:0,cleanup:condition==='shared100'?{...measurement(2),cleaned:false,removeCalled:false}:undefined,unhanded:{...measurement(3),hash:'c'.repeat(64),rowCount:500}})));
 const wrap=(runs:ReturnType<typeof matrix>)=>({scenario:'import-cleanup',candidate:'none',queryVariant:'original',runs});
 const passing=()=>matrix().map(r=>r.size===100000&&r.condition==='pending100'?{...r,...measurement(50)}:r);
 it('requires all hashes and performance thresholds', () => {
  const base=wrap(matrix()), runs=passing(); expect(compare(base,wrap(runs)).pass).toBe(true);
  expect(compare(base,wrap(runs.map(r=>r.size===100000&&r.condition==='pending100'?{...r,hash:'b'.repeat(64)}:r))).pass).toBe(false);
 });
 it.each([[100000,'pending100',51],[1000,'idle',11.1],[10000,'idle',11.1],[100000,'idle',11.1]] as const)('rejects exceeded threshold %i/%s', (size,condition,value)=>{
  const runs=passing().map(r=>r.size===size&&r.condition===condition?{...r,...measurement(value)}:r); const result=compare(wrap(matrix()),wrap(runs));
  expect(result.pass).toBe(false); expect(result.rows.find((r:{condition:string})=>r.condition===`${size}/${condition}`).pass).toBe(false);
 });
 it.each(['idle','shared100'])('rejects missing %s from both inputs', condition=>{
  const runs=matrix().filter(r=>r.condition!==condition); const result=compare(wrap(runs),wrap(runs));
  expect(result.pass).toBe(false); expect(result.required.base).toHaveLength(3); expect(result.required.change).toHaveLength(3);
 });
 it.each(['duplicate','missing hash','median','cleanup','provenance'])('rejects invalid runs: %s', variant=>{
  const runs=matrix(); if(variant==='duplicate') runs.push(runs[0]!); if(variant==='missing hash') delete (runs[0] as {hash?:string}).hash; if(variant==='median') runs[0]!.medianMs=5; if(variant==='cleanup') runs.find(r=>r.condition==='shared100')!.cleanup=undefined;
  const result=wrap(runs); if(variant==='provenance') result.queryVariant='rewritten'; expect(()=>compare(result,wrap(matrix()))).toThrow();
 });
 it('reports shared cleanup ratio without applying a threshold', () => {
  const change=passing().map(r=>({...r,cleanup:r.condition==='shared100'?{...measurement(6),cleaned:false,removeCalled:false}:undefined}));
  const result=compare(wrap(matrix()),wrap(change)); expect(result.rows.find((r:{condition:string})=>r.condition==='100000/shared100').cleanupRatio).toBe(3); expect(result.pass).toBe(true);
 });
});

// @ts-expect-error JavaScript module has no TypeScript declarations.
import { parseRevisionFile, checkoutRevision, artifactFingerprint } from '../src/revision.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('revision identity', () => {
 it('validates an archive revision and fails without it', () => {
  const dir=mkdtempSync(join(tmpdir(),'query-perf-revision-'));
  try { expect(()=>checkoutRevision(dir)).toThrow(); writeFileSync(join(dir,'.query-perf-revision'),'a'.repeat(40)+'\n'); expect(checkoutRevision(dir)).toEqual({sha:'a'.repeat(40),dirty:null,diffSha256:null}); expect(()=>parseRevisionFile('a'.repeat(39))).toThrow(); } finally { rmSync(dir,{recursive:true,force:true}); }
 });

 it('includes untracked postgres files in git revision fingerprint', () => {
  const dir=mkdtempSync(join(tmpdir(),'query-perf-git-')); const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{stdio:'ignore'});
  try { git('init'); git('-c','user.name=test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','fixture'); const initial=checkoutRevision(dir);
   for(const part of ['src','migrations']) { const folder=join(dir,'packages/postgres',part); mkdirSync(folder,{recursive:true}); const path=join(folder,'new.txt'); writeFileSync(path,'one'); const first=checkoutRevision(dir); writeFileSync(path,'two'); const second=checkoutRevision(dir); expect(first.sha).toBe(initial.sha); expect(first.dirty).toBe(true); expect(first.diffSha256).not.toBe(second.diffSha256); }
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it('fingerprints artifact names and bytes deterministically', () => {
  const dir=mkdtempSync(join(tmpdir(),'query-perf-artifacts-')), other=mkdtempSync(join(tmpdir(),'query-perf-artifacts-'));
  try { for(const p of ['packages/core/dist','packages/postgres/dist','packages/postgres/migrations']) mkdirSync(join(dir,p),{recursive:true});
   writeFileSync(join(dir,'pnpm-lock.yaml'),'lock'); writeFileSync(join(dir,'packages/postgres/dist/z.js'),'z'); writeFileSync(join(dir,'packages/core/dist/a.js'),'a'); writeFileSync(join(dir,'packages/postgres/migrations/1.sql'),'sql');
   for(const p of ['packages/postgres/migrations','packages/postgres/dist','packages/core/dist']) mkdirSync(join(other,p),{recursive:true});
   writeFileSync(join(other,'packages/postgres/migrations/1.sql'),'sql'); writeFileSync(join(other,'packages/core/dist/a.js'),'a'); writeFileSync(join(other,'packages/postgres/dist/z.js'),'z'); writeFileSync(join(other,'pnpm-lock.yaml'),'lock');
   const first=artifactFingerprint(dir); expect(artifactFingerprint(other)).toEqual(first); expect(first.files).toEqual(['packages/core/dist/a.js','packages/postgres/dist/z.js','packages/postgres/migrations/1.sql']); expect(artifactFingerprint(dir)).toEqual(first);
   writeFileSync(join(dir,'packages/postgres/dist/z.js'),'changed'); const js=artifactFingerprint(dir); expect(js.sha256).not.toBe(first.sha256);
   writeFileSync(join(dir,'packages/postgres/migrations/1.sql'),'changed'); expect(artifactFingerprint(dir).sha256).not.toBe(js.sha256);
  } finally {rmSync(dir,{recursive:true,force:true}); rmSync(other,{recursive:true,force:true});}
 });

});
