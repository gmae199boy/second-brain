import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { postgresStore } from '../src/index.js';
import { clock, database } from './fixture.js';

const catalog = JSON.parse(readFileSync(new URL('../../core/schemas/health/v1/catalog.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../../core/fixtures/health/v1/current.json', import.meta.url), 'utf8'));

it('공유 fixture와 catalog, 보관키 및 집계 계약을 PostgreSQL에서 재현한다', async () => {
  const db = await database();
  const admin = new pg.Client({ connectionString: db.url });
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    await admin.connect();
    expect((await admin.query('select definition from brain.health_catalog_v1 order by metric')).rows.map(r => r.definition).sort((a,b) => a.metric.localeCompare(b.metric))).toEqual([...catalog.metrics].sort((a,b) => a.metric.localeCompare(b.metric)));
    const source = 'synthetic', work = randomUUID(), token = randomUUID(), now = clock.now();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[source]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[source,`${source}.import`]);
    await store.addWork({id:work,kind:`${source}.import`,targetKind:'import',targetId:'test',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${source}.import`],attemptToken:token});
    const insert = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,activity_id,sub_identity) values($1,$2,$3,'batch','daily',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`;
    expect((await admin.query('select version from brain.health_supported_versions order by version')).rows.map(r => r.version)).toEqual([1,2,8]);
    const v1=randomUUID(), v2=randomUUID();
    for (const [id,version,value] of [[v1,1,1],[v2,2,2]] as [string,number,number][]) await admin.query(insert,[id,source,'D1','default-version','account',true,'daily_metric.steps',value,'count','2026-01-01',null,'Asia/Seoul',false,'hash','2026-01-01T00:00:00Z',version,work,token,'default-version',null]);
    expect((await admin.query("select id,value from brain.health_current_v1 where activity_id='default-version'")).rows).toEqual([{id:v2,value:2}]);
    expect((await admin.query("select count(*)::int as count from brain.health_observations where activity_id='default-version'")).rows[0].count).toBe(2);
    for (const [index,c] of fixture.cases.entries()) {
      await admin.query('delete from brain.health_supported_versions');
      for (const version of c.versions) await admin.query('insert into brain.health_supported_versions values ($1)',[version]);
      const ids = new Map<string,string>();
      for (const [j,r] of c.rows.entries()) {
        const id = `00000000-0000-4000-8000-${String(index*100+j+1).padStart(12,'0')}`; ids.set(r.id,id);
        if (r.type === 'json') {
          await admin.query(`insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,activity_id,value_type,value_json) values ($1,$2,$3,'batch','daily',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'json',$18::jsonb)`,[id,source,r.dataset,`${index}-${r.id}`,r.account,r.accountConfirmed,r.metric,r.unit,r.date,r.timezone,r.timezone===null,r.revision,r.fetchedAt,r.version,work,token,`case-${index}`,JSON.stringify(r.value)]);
        } else {
          await admin.query(insert,[id,source,r.dataset,`${index}-${r.id}`,r.account,r.accountConfirmed,r.metric,r.value,r.unit,r.date,r.instant,r.timezone,r.timezone===null,r.revision,r.fetchedAt,r.version,work,token,`case-${index}`,null]);
        }
      }
      if (c.authority) await admin.query('insert into brain.health_authority_rules(id,source,account,activity_id,revision,datasets) values ($1,$2,$3,$4,$5,$6)',[randomUUID(),source,'account',`case-${index}`,c.authority.version,c.authority.datasets]);
      const result = (await admin.query('select * from brain.health_resolution_v1 where source=$1 and activity_id=$2',[source,`case-${index}`])).rows[0];
      expect(result.reason,c.name).toBe(c.expected.reason);
      expect(result.current_id,c.name).toBe(c.expected.current === null ? null : ids.get(c.expected.current));
      expect(result.selected_ids,c.name).toEqual(c.expected.selected.map((id:string) => ids.get(id)));
      expect(result.all_ids.filter((id:string) => !result.selected_ids.includes(id)),c.name).toEqual(c.expected.unselected.map((id:string) => ids.get(id)));
    }
    const row = fixture.cases[0].rows[0];
    const duplicate = [randomUUID(),source,row.dataset,'0-a',row.account,true,row.metric,row.value,row.unit,row.date,null,row.timezone,false,row.revision,row.fetchedAt,row.version,work,token,'case-0',null];
    expect((await admin.query(insert,duplicate)).rowCount).toBe(0);
    duplicate[7]=99;
    await expect(admin.query(insert,duplicate)).rejects.toThrow('payload 충돌');
    // 운동·하위 identity·날짜·시간대는 각각 별개의 논리 키다.
    for (const [j,identity] of [
      ['run','set-1','2026-02-01','Asia/Seoul'], ['run','set-2','2026-02-01','Asia/Seoul'],
      ['walk','set-1','2026-02-01','Asia/Seoul'], ['run','set-1','2026-02-02','Asia/Seoul'],
      ['run','set-1','2026-02-01','America/New_York'],
    ].entries()) {
      for (const [k,dataset] of ['D1','D2'].entries()) await admin.query(insert,[randomUUID(),source,dataset,`identity-${j}-${k}`,'account',true,'daily_metric.steps',k+1,'count',identity[2],null,identity[3],false,'revision','2026-01-01T00:00:00Z',1,work,token,identity[0],identity[1]]);
    }
    await admin.query("insert into brain.health_authority_rules(id,source,account,metric,activity_id,date_from,date_to,revision,datasets) values ($1,$2,'account','daily_metric.steps','run','2026-02-01','2026-02-01',1,array['D2','D1'])",[randomUUID(),source]);
    const scopes = (await admin.query("select activity_id,sub_identity,local_date::text,time_zone,dataset,reason,cardinality(unselected_ids) as unselected from brain.health_resolution_v1 where source=$1 and activity_id in ('run','walk') order by activity_id,sub_identity,local_date,time_zone",[source])).rows;
    expect(scopes).toHaveLength(5);
    expect(scopes.filter(r => r.dataset === 'D2')).toHaveLength(3);
    expect(scopes.filter(r => r.reason === 'dataset_ambiguous')).toHaveLength(2);
    expect(scopes.filter(r => r.dataset === 'D2').every(r => r.unselected === 1)).toBe(true);
    await expect(admin.query("update brain.health_authority_rules set revision=2 where source=$1",[source])).rejects.toThrow('불변');
    await expect(admin.query(insert,[randomUUID(),source,'D1','bad-unit','account',true,'daily_metric.steps',1,'g','2026-01-01',null,'Asia/Seoul',false,'hash',now,1,work,token,'bad',null])).rejects.toThrow('타입 또는 단위');
    await expect(admin.query(insert,[randomUUID(),source,'D1','bad-time','account',true,'daily_metric.steps',1,'count','2026-01-01','2026-01-01T00:00:00Z','Asia/Seoul',false,'hash',now,1,work,token,'bad',null])).rejects.toMatchObject({code:'23514'});
    // 원문 동률과 최종 값 동률은 현재 view 및 sum·mean에서 모두 빠진다.
    for (const [key,revision,value,sub] of [['r1','hash-a',10,'revision'],['r2','hash-b',20,'revision'],['v1','same',30,'value'],['v2','same',40,'value'],['ok','good',4,'ok']] as [string,string,number,string][]) await admin.query(insert,[randomUUID(),source,'D1',key,'account',true,'daily_metric.steps',value,'count','2026-03-01',null,'Asia/Seoul',false,revision,'2026-01-01T00:00:00Z',1,work,token,'ambiguity',sub]);
    expect((await admin.query("select sub_identity,reason from brain.health_resolution_v1 where activity_id='ambiguity' order by sub_identity")).rows).toEqual([{sub_identity:'ok',reason:null},{sub_identity:'revision',reason:'revision_ambiguous'},{sub_identity:'value',reason:'value_ambiguous'}]);
    expect((await admin.query("select value from brain.health_current_v1 where activity_id='ambiguity'")).rows).toEqual([{value:4}]);
    for (const op of ['sum','mean']) expect((await admin.query("select brain.health_aggregate_v1('daily_metric.steps',$1,$2,'ambiguity') as value",[op,source])).rows[0].value).toBe(4);
    await expect(admin.query(`insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json) values ($1,$2,'D1','b','daily','scalar','account',true,'day_summary.drinks_json','json','2026-01-01','Asia/Seoul',false,'hash',now(),1,$3,$4,'json','42'::jsonb)`,[randomUUID(),source,work,token])).rejects.toMatchObject({code:'23514'});
    for (const [index,c] of fixture.aggregations.entries()) {
      for (const [j,r] of c.rows.entries()) {
        expect(r.source).toBe(source);
        await admin.query(`insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,activity_id,sub_identity,value_type,value_text,value_json) values ($1,$2,$3,'b','daily',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,[randomUUID(),r.source,r.dataset,`aggregate-${index}-${j}`,r.account,r.accountConfirmed,r.metric,r.type === 'number' ? r.value : null,r.unit,r.date,r.instant,r.timezone,r.timezone === null,r.revision,r.fetchedAt,r.version,work,token,r.activity,r.subIdentity,r.type,r.type === 'text' ? r.value : null,r.type === 'json' ? JSON.stringify(r.value) : null]);
      }
      const query = admin.query('select brain.health_aggregate_v1($1,$2,$3,$4) as value',[c.metric,c.operation,source,`aggregate-${index}`]);
      if (c.error) await expect(query).rejects.toThrow(c.error);
      else expect((await query).rows[0].value,c.name).toBe(c.expected);
    }
    const first = new pg.Client({connectionString:db.url}), second = new pg.Client({connectionString:db.url});
    await first.connect(); await second.connect();
    try {
      const pid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid;
      for (const different of [false,true]) {
        const key = different ? 'race-conflict' : 'race-identical';
        const args = [randomUUID(),source,'D1',key,'account',true,'daily_metric.steps',7,'count','2026-04-01',null,'Asia/Seoul',false,'hash','2026-01-01T00:00:00Z',1,work,token,key,null];
        const other = [...args]; other[0]=randomUUID(); if (different) other[7]=8;
        await first.query('begin'); await second.query('begin');
        await first.query(insert,args);
        const pending = second.query(insert,other).then(result => ({result}), error => ({error}));
        await expect.poll(async () => Number((await admin.query('select cardinality(pg_blocking_pids($1)) as n',[pid])).rows[0].n),{timeout:5000,interval:10}).toBeGreaterThan(0);
        await first.query('commit');
        const outcome = await pending;
        if (different) { expect('error' in outcome && outcome.error.message).toContain('payload 충돌'); await second.query('rollback'); }
        else { expect('result' in outcome && outcome.result.rowCount).toBe(0); await second.query('commit'); }
        expect((await admin.query('select count(*)::int as n from brain.health_observations where original_key=$1',[key])).rows[0].n).toBe(1);
      }
    } finally { await first.end(); await second.end(); }
    for (const metric of ['daily_metric.steps','daily_metric.hrv_status']) await expect(admin.query('select brain.health_aggregate_v1($1,$2)',[metric,null])).rejects.toThrow('HEALTH_AGGREGATION_NOT_ALLOWED');

  } finally { await admin.end(); await store.close(); await db.drop(); }
});
