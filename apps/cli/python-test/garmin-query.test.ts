import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('registers Garmin query schemas for CLI and MCP and returns scoped masked results', async () => {
  const fixture = await extHome();
  try {
    const install = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const self = String((await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id);
    const account = '01940000-0000-7000-8000-000000000701';
    await fixture.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${account}','synthetic-query','Asia/Seoul');
      insert into garmin.day_summary(user_id,connection_id,date,steps) values ('${self}','${account}','2026-01-01',10),('${self}','${account}','2026-01-02',null),('${self}','${account}','2026-01-03',30);
      insert into garmin.workout(user_id,connection_id,activity_id,date,type,duration_s) values ('${self}','${account}',1,'2026-01-01','strength',60),('${self}','${account}',2,'2026-01-03','run',90);
      insert into garmin.exercise_log(user_id,connection_id,activity_id,exercise,reps) values ('${self}','${account}',1,'squat',10);
      insert into garmin.exercise_set(user_id,connection_id,activity_id,set_index,exercise_name,reps,is_rest) values
        ('${self}','${account}',1,0,'squat',10,0),('${self}','${account}',1,1,'squat',999,1),('${self}','${account}',1,2,'squat',null,0),('${self}','${account}',1,3,'press',20,0),('${self}','${account}',2,0,'squat',30,0);
      insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values ('${self}','${account}','2026-01-03','day','password=hunter2x','[]','[]','[]','synthetic','fake',1,1),('${self}','${account}','2026-01-03','day','password=hunter2x','[]','[]','[]','synthetic','fake',2,2)`);
    const input = {connection_id:account, timezone:'Asia/Seoul', start_date:'2026-01-01', end_date:'2026-01-03', metric:'steps', aggregation:'sum'};
    const cli = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify(input),'--json']);
    expect(cli.body?.ok, cli.stdout + cli.stderr).toBe(true);
    expect(cli.body.data).toMatchObject({value:40, observed_count:2, null_count:1, unit:'count'});
    const guide = await fixture.run(['guide','schema','ext.garmin','period-summary','--json']);
    const child = spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'mcp','serve'],{env:fixture.env,stdio:['pipe','pipe','pipe']});
    const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
    async function request(id:number,method:string,params:unknown={}) { child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); return JSON.parse((await lines.next()).value!); }
    try {
      await request(1,'initialize');
      const list = (await request(2,'tools/list')).result.tools;
      for (const name of ['daily_values','period_summary','recent_evaluations']) expect(list.some((tool:{name:string})=>tool.name===`ext_garmin_${name}`)).toBe(true);
      expect(list.find((tool:{name:string})=>tool.name==='ext_garmin_period_summary').inputSchema).toEqual(guide.body.data.commands[0].input_schema);
      const result = await request(3,'tools/call',{name:'ext_garmin_period_summary',arguments:input});
      expect(JSON.parse(result.result.content[0].text).data).toEqual(cli.body.data);
      const mean = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...input,aggregation:'mean'}),'--json']);
      expect(mean.body.data.value).toBe(20);
      const daily = await fixture.run(['ext','garmin','daily-values','--input',JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k])=>k!=='aggregation'))),'--json']);
      expect(daily.body.data.rows.map((row:{value:number|null})=>row.value)).toEqual([10,null,30]);
      const recent = await fixture.run(['ext','garmin','recent-evaluations','--input',JSON.stringify({connection_id:account,timezone:'Asia/Seoul',scope:'day',limit:5}),'--json']);
      expect(recent.body.data.evaluations).toHaveLength(1);
      expect(recent.body.data.evaluations[0]).toMatchObject({date:'2026-01-03',scope:'day',file_id:null});
      expect(JSON.stringify(recent.body.data)).not.toContain('hunter2x');
      const recentMcp = await request(4,'tools/call',{name:'ext_garmin_recent_evaluations',arguments:{connection_id:account,timezone:'Asia/Seoul',scope:'day',limit:5}});
      expect(JSON.parse(recentMcp.result.content[0].text).data).toEqual(recent.body.data);
      const denied = await fixture.run(['ext','garmin','daily-values','--input',JSON.stringify({connection_id:'01940000-0000-7000-8000-000000000799',timezone:'Asia/Seoul',start_date:'2026-01-01',end_date:'2026-01-03',metric:'steps'}),'--json']);
      expect(denied.body.ok).toBe(false);
      const filtered = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...input,activity_type:'strength',exercise:'squat'}),'--json']);
      expect(filtered.body.data).toMatchObject({value:10,observed_count:1,null_count:0});
      const setInput={connection_id:account,timezone:'Asia/Seoul',start_date:'2026-01-01',end_date:'2026-01-03',metric:'set.reps',activity_type:'strength',exercise:'squat'};
      const setDaily=await fixture.run(['ext','garmin','daily-values','--input',JSON.stringify(setInput),'--json']);
      expect(setDaily.body.ok).toBe(true);
      expect(setDaily.body.data.rows).toEqual([{date:'2026-01-01',value:10,unit:'count'},{date:'2026-01-01',value:null,unit:'count'}]);
      const setSum=await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...setInput,aggregation:'sum'}),'--json']);
      expect(setSum.body.data).toMatchObject({value:10,observed_count:1,null_count:1,unit:'count'});
      const setMean=await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...setInput,aggregation:'mean'}),'--json']);
      expect(setMean.body.data).toMatchObject({value:10,observed_count:1,null_count:1});
      const runSets=await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...setInput,activity_type:'run',aggregation:'sum'}),'--json']);
      expect(runSets.body.data).toMatchObject({value:30,observed_count:1,null_count:0});
      const allSets=await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({connection_id:account,timezone:'Asia/Seoul',start_date:'2026-01-01',end_date:'2026-01-03',metric:'set.reps',aggregation:'sum'}),'--json']);
      expect(allSets.body.data).toMatchObject({value:60,observed_count:3,null_count:1});
      const empty = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...input,activity_type:'none'}),'--json']);
      expect(empty.body.data).toMatchObject({value:null,observed_count:0,null_count:0});
      const invalid = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify({...input,metric:'weight_kg',aggregation:'sum'}),'--json']);
      expect(invalid.body.ok).toBe(false);
    } finally { child.stdin.end(); await new Promise(resolve=>child.once('close',resolve)); }
  } finally { await fixture.cleanup(); }
},120000);
