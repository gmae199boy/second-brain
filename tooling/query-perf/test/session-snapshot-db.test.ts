import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createIsolatedTestDatabase } from '../../test-db/src/index.js';
// @ts-expect-error JavaScript runner has no declarations.
import { run } from '../src/session-snapshot.mjs';

it('small isolated snapshot run excludes warmup and removes owned databases after success and injected failure', async () => {
 const fixture=await createIsolatedTestDatabase();
 const checkout=resolve(import.meta.dirname,'../../..');
 try {
  const result=await run({checkout,databaseUrl:fixture.url},{rows:40});
  expect(result.fixture.rows).toBe(40); expect(result.results.oracleMatch).toBe(true);
  expect(result.results.staleFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/); expect(result.results.staleFingerprint).not.toBe(result.results.fingerprint);
  for(const key of ['readTransaction','commitTransaction','lockHeld','initialWrite','changedWrite']) expect(result.measurements[key].samplesMs).toHaveLength(3);
  expect(result.measurements.probe.confirmedWaits).toBe(3);
  expect(result.resources).toMatchObject({created:true,deleted:true});
  const names=[result.resources.database];
  try {
   await run({checkout,databaseUrl:fixture.url},{rows:40,afterFixture:({client}: {client:{emit:(event:string,error:Error)=>void}})=>{client.emit('error',new Error('synthetic socket failure')); throw new Error('synthetic injection');}});
   throw new Error('expected injection failure');
  } catch(error) {
   const failure=error as Error & {resources:{database:string;created:boolean;deleted:boolean};errors:Error[]};
   expect(failure.message).toContain('synthetic injection');
   expect(failure.errors.some(e=>e.message.includes('synthetic socket failure'))).toBe(true);
   expect(failure.resources).toMatchObject({created:true,deleted:true}); names.push(failure.resources.database);
  }
  const existing=await fixture.rows<{datname:string}>(`select datname from pg_database where datname in (${names.map(name=>`'${name}'`).join(',')})`);
  expect(existing).toEqual([]);
  let remaining='';
  try {
   await run({checkout,databaseUrl:fixture.url},{rows:40,afterFixture:()=>{throw new Error('stop after fixture');},beforeDrop:()=>{throw new Error('synthetic drop failure');}});
   throw new Error('expected cleanup failure');
  } catch(error) {
   const failure=error as Error & {resources:{database:string;created:boolean;deleted:boolean}};
   expect(failure.resources).toMatchObject({created:true,deleted:false}); remaining=failure.resources.database;
   expect(failure.message).toContain(remaining); expect(failure.message).toContain('synthetic drop failure');
   expect(await fixture.rows<{datname:string}>(`select datname from pg_database where datname='${remaining}'`)).toEqual([{datname:remaining}]);
  } finally { if(remaining) await fixture.query(`drop database "${remaining}" with (force)`); }
 } finally { await fixture.drop(); }
}, 120000);

it('cleans up and preserves the cause of a refused initial connection', async () => {
 const checkout=resolve(import.meta.dirname,'../../..');
 try {
  await run({checkout,databaseUrl:'postgres://user:secret@127.0.0.1:1/postgres'},{rows:40});
  throw new Error('expected refusal');
 } catch(error) {
  const failure=error as Error & {resources:{created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};
  expect(failure.resources).toMatchObject({created:false,deleted:false});
  expect(failure.errors.some(e=>e.code==='ECONNREFUSED')).toBe(true);
  expect(failure.message).not.toContain('secret'); expect(failure.message).not.toContain('/Users/');
 }
});

it('preserves a real store database failure instead of reporting an oracle mismatch', async () => {
 const fixture=await createIsolatedTestDatabase(); const checkout=resolve(import.meta.dirname,'../../..');
 try {
  try {
   await run({checkout,databaseUrl:fixture.url},{rows:40,beforeOracleRead:async ({client}:{client:{query:(sql:string)=>Promise<unknown>}})=>{await client.query('drop table brain.messages cascade');}});
   throw new Error('expected store failure');
  } catch(error) {
   const failure=error as Error & {resources:{created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};
   expect(failure.resources).toMatchObject({created:true,deleted:true});
   expect(failure.message).not.toContain('oracle mismatch'); expect(failure.message).not.toContain(fixture.url);
   expect(failure.errors.some(e=>e.code==='DB_UNAVAILABLE' && e.message.includes('messages'))).toBe(true);
   expect(failure.message).toContain('DB_UNAVAILABLE');
  }
 } finally { await fixture.drop(); }
}, 120000);
