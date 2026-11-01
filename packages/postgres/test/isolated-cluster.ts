import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { prepareDatabase, runMigrations } from '../src/index.js';
import { clock } from './fixture.js';

const execute=promisify(execFile);
/** role이 클러스터 전역인 시험만 전용 일회용 PostgreSQL을 사용한다. */
export async function isolatedClusterDatabase() {
  const name=`brain-role-fixture-${randomBytes(8).toString('hex')}`;
  let created=false;
  const remove=async()=>{if(created){await execute('docker',['rm','-fv',name],{timeout:15000});created=false;}};
  try {
    await execute('docker',['run','-d','--name',name,'--tmpfs','/var/lib/postgresql','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=postgres','postgres:18'],{timeout:30000});created=true;
    const portOutput=await execute('docker',['port',name,'5432/tcp'],{timeout:5000});
    const match=/^127\.0\.0\.1:(\d+)\s*$/.exec(portOutput.stdout);if(!match)throw new Error('격리 PostgreSQL 포트를 확인할 수 없습니다');
    const adminUrl=`postgres://postgres:postgres@127.0.0.1:${match[1]}/postgres`;
    let ready=false;
    for(let i=0;i<100;i++) {
      const client=new pg.Client({connectionString:adminUrl,connectionTimeoutMillis:500});
      try {await client.connect();await client.query('select 1');ready=true;break;} catch {} finally {await client.end().catch(()=>{});}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!ready)throw new Error('격리 PostgreSQL이 준비되지 않았습니다');
    const prepared=await prepareDatabase({databaseUrl:adminUrl,appPassword:'brain-test-app',maintenancePassword:'brain-test-maintenance',databaseName:'brain_fixture'});
    if(!prepared.ok)throw new Error(prepared.message);
    const url=prepared.databaseUrl;
    const migrated=await runMigrations({databaseUrl:url,clock});if(!migrated.ok)throw new Error('격리 migration 실패');
    const app=new URL(url);app.username='brain_app';app.password='brain-test-app';
    return {url,appUrl:app.toString(),drop:remove};
  } catch(error) {await remove();throw error;}
}
