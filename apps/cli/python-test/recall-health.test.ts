import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

const cases = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tooling/recall-eval/health-cases.json', import.meta.url)), 'utf8')) as {
  connections: {id:string; timezone:string}[];
  rows: {connection_id:string; date:string; steps:number|null}[];
  workouts: {connection_id:string; activity_id:number; date:string; type:string; duration_s:number|null}[];
  exercise_logs: {connection_id:string; activity_id:number; exercise:string; reps:number}[];
  cases: {id:string; command:string; input:Record<string, string>; expected:{value:number|null; unit:string; observed_count:number; null_count:number; start_date:string; end_date:string}}[];
};

type Fixture = Awaited<ReturnType<typeof extHome>>;
async function withMcp(fixture:Fixture, fn:(request:(method:string, params?:unknown)=>Promise<any>)=>Promise<void>) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], {env:fixture.env, stdio:['pipe','pipe','pipe']});
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function request(method:string, params:unknown = {}) {
    child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:++id, method, params})+'\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const line = await Promise.race([lines.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP request timed out')), 10000); })]).finally(() => clearTimeout(timer));
    if (line.done) throw new Error('MCP exited before response');
    return JSON.parse(line.value);
  }
  try { await request('initialize'); await fn(request); }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill();
      await closed;
    }
  }
}

it('matches hand-calculated health cases through CLI and MCP', async () => {
  const fixture = await extHome();
  try {
    const install = await fixture.run(['ext','install','garmin','--json']);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const self = String((await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id);
    for (const connection of cases.connections) {
      await fixture.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${connection.id}','synthetic-${connection.id}','${connection.timezone}')`);
    }
    for (const row of cases.rows) {
      await fixture.db.query(`insert into garmin.day_summary(user_id,connection_id,date,steps) values ('${self}','${row.connection_id}','${row.date}',${row.steps === null ? 'null' : row.steps})`);
    }
    for (const row of cases.workouts) {
      await fixture.db.query(`insert into garmin.workout(user_id,connection_id,activity_id,date,type,duration_s) values ('${self}','${row.connection_id}',${row.activity_id},'${row.date}','${row.type}',${row.duration_s === null ? 'null' : row.duration_s})`);
    }
    for (const row of cases.exercise_logs) {
      await fixture.db.query(`insert into garmin.exercise_log(user_id,connection_id,activity_id,exercise,reps) values ('${self}','${row.connection_id}',${row.activity_id},'${row.exercise}',${row.reps})`);
    }
    const multi = cases.cases.find(item => item.id === 'multi-month')!;
    // Independent rational arithmetic for 10, 30, 50 and 70; NULL is excluded.
    expect(BigInt(multi.expected.value!) * 4n).toBe(10n + 30n + 50n + 70n);
    expect(multi.expected.observed_count).toBe(4);
    expect(multi.expected.null_count).toBe(1);
    await withMcp(fixture, async request => {
      for (const item of cases.cases) {
        const cli = await fixture.run(['ext','garmin',item.command,'--input',JSON.stringify(item.input),'--json']);
        expect(cli.body?.ok, `${item.id}: ${cli.stdout} ${cli.stderr}`).toBe(true);
        expect(cli.body.data, item.id).toEqual(item.expected);
        expect(cli.body.meta?.extensions, item.id).toEqual(expect.arrayContaining([expect.objectContaining({source:'garmin',installed:true,enabled:true,searchable:true})]));
        const response = await request('tools/call',{name:`ext_garmin_${item.command.replaceAll('-','_')}`, arguments:item.input});
        const body = JSON.parse(response.result.content[0].text);
        expect(body.ok, item.id).toBe(true);
        expect(body.data, item.id).toEqual(item.expected);
        expect(body.meta?.extensions, item.id).toEqual(cli.body.meta.extensions);
      }
    });
    const mismatch = {...cases.cases.find(item => item.id === 'dst-yesterday')!.input, timezone:'Asia/Seoul'};
    const denied = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify(mismatch),'--json']);
    expect(denied.body?.ok, denied.stdout + denied.stderr).toBe(false);
    expect(denied.body.meta?.extensions).toEqual(expect.arrayContaining([expect.objectContaining({source:'garmin',installed:true,enabled:true,searchable:true})]));
    await withMcp(fixture, async request => {
      const response = await request('tools/call',{name:'ext_garmin_period_summary',arguments:mismatch});
      expect(response.result.isError).toBe(true);
      const body = JSON.parse(response.result.content[0].text);
      expect(body.ok).toBe(false); expect(body.error.code).toBe(denied.body.error.code);
      expect(body.meta.extensions).toEqual(denied.body.meta.extensions);
    });
    for (const [key,value] of [['garmin.connection_id',cases.connections[0]!.id],['garmin.timezone','Asia/Seoul']]) {
      const set = await fixture.run(['config','set',key!,value!,'--json']);
      expect(set.body?.ok, set.stdout + set.stderr).toBe(true);
      const get = await fixture.run(['config','get',key!,'--json']);
      expect(get.body?.ok, get.stdout + get.stderr).toBe(true);
      expect(get.body.data.value).toBe(value);
    }
  } finally { await fixture.cleanup(); }
},120000);

it.each(['not-installed','disabled'])('reports unavailable Garmin commands when %s', async state => {
  const fixture = await extHome();
  try {
    if (state === 'disabled') {
      const install = await fixture.run(['ext','install','garmin','--json']);
      expect(install.code, install.stdout + install.stderr).toBe(0);
      const disable = await fixture.run(['ext','disable','garmin','--json']);
      expect(disable.body?.ok, disable.stdout + disable.stderr).toBe(true);
    }
    const status = await fixture.run(['ext','status','garmin','--json']);
    expect(status.body?.ok, status.stdout + status.stderr).toBe(true);
    if (state === 'not-installed') expect(status.body.data.installed).toBe(false);
    else expect(status.body.data.enabled).toBe(false);
    const command = await fixture.run(['ext','garmin','period-summary','--input',JSON.stringify(cases.cases[0]!.input),'--json']);
    expect(command.body?.ok, command.stdout + command.stderr).toBe(false);
    expect(command.body.error.code).toBe('USAGE');
    await withMcp(fixture, async request => {
      const list = await request('tools/list');
      expect(list.result.tools.some((tool:{name:string}) => tool.name.startsWith('ext_garmin_'))).toBe(false);
    });
  } finally { await fixture.cleanup(); }
},120000);
