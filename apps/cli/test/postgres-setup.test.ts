import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { homeResources, DEFAULT_DAEMON_LABEL } from '../src/config/resources.js';
import { postgresSecrets, readConfig, readConfigForSetup, resolveStoreUrl, writeConfig } from '../src/config/codec.js';
import { composeArgs, fakeCommandRunner, systemCommandRunner } from '../src/runtime/command-runner.js';
import { installPostgres, renderPostgresCompose } from '../src/install/postgres.js';
const pg = vi.hoisted(() => ({
  prepareDatabase: vi.fn(), runMigrations: vi.fn(), ensureSelfUser: vi.fn(), close: vi.fn(),
}));
vi.mock('second_brain/postgres', () => ({
  prepareDatabase: pg.prepareDatabase, runMigrations: pg.runMigrations,
  postgresStore: () => ({ listExtensions: async () => ({ ok: true, extensions: [] }), ensureSelfUser: pg.ensureSelfUser, close: pg.close }),
}));
const homes: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true}))); });
async function fresh() { const home=await mkdtemp(join(tmpdir(),'brain-pg-setup-')); homes.push(home); return home; }
const clock={now:()=>new Date('2026-10-28T00:00:00.000Z')};
it('derives isolated, stable resources and preserves the default home names',async()=>{
  expect(homeResources(join(homedir(),'.second_brain'))).toEqual({project:'second-brain',volume:'second-brain-pg',port:54320,label:DEFAULT_DAEMON_LABEL});
  const home=await fresh();const a=homeResources(home);const b=homeResources(`${home}-other`);
  expect(a).toEqual(homeResources(join(home,'.')));expect(a.project).not.toBe(b.project);expect(a.volume).not.toBe(b.volume);expect(a.label).not.toBe(b.label);
  expect(a.project).toMatch(/^second-brain-[a-f0-9]{12}$/);expect(a.label).toMatch(/\.[a-f0-9]{12}$/);expect([54320,54329]).not.toContain(a.port);
  const text=renderPostgresCompose(home);expect(text).toContain('name: '+a.project);expect(text).toContain('name: '+a.volume);expect(text).toContain('image: postgres:18');expect(text).toContain('data:/var/lib/postgresql');expect(text).toContain(`127.0.0.1:${a.port}:5432`);expect(text).toContain('${BRAIN_POSTGRES_PASSWORD:?');expect(text).toContain('restart: unless-stopped');
});
it('preserves url_env across setup and resolves process env before the private file',async()=>{
  const home=await fresh();await writeFile(join(home,'config.toml'),'[store]\nurl_env = "CUSTOM_DATABASE_URL"\n');
  const recorded=await readConfigForSetup(home);expect(recorded.ok).toBe(true);if(!recorded.ok)return;
  expect(recorded.recorded?.storeUrlEnv).toBe('CUSTOM_DATABASE_URL');
  expect((await writeConfig(home,{...recorded.recorded})).ok).toBe(true);
  const config=await readConfig(home);expect(config.ok&&config.config.storeUrlEnv).toBe('CUSTOM_DATABASE_URL');
  const first=await postgresSecrets(home,homeResources(home).port,'CUSTOM_DATABASE_URL');const before=await readFile(join(home,'.env'),'utf8');
  expect((await stat(join(home,'.env'))).mode&0o777).toBe(0o600);
  expect(await postgresSecrets(home,homeResources(home).port,'CUSTOM_DATABASE_URL')).toEqual(first);expect(await readFile(join(home,'.env'),'utf8')).toBe(before);
  expect(await resolveStoreUrl(home,'CUSTOM_DATABASE_URL',{})).toContain('postgresql://brain_app:');
  expect(await resolveStoreUrl(home,'CUSTOM_DATABASE_URL',{CUSTOM_DATABASE_URL:'postgresql://override'})).toBe('postgresql://override');
  expect(await resolveStoreUrl(home,'CUSTOM_DATABASE_URL',{CUSTOM_DATABASE_URL:''})).toBeUndefined();
  await writeFile(join(home,'.env'),'BRAIN_POSTGRES_PASSWORD=\nBRAIN_APP_PASSWORD=\n');
  const regenerated=await postgresSecrets(home,homeResources(home).port,'CUSTOM_DATABASE_URL');
  expect(new URL(regenerated.adminUrl).password).toMatch(/^[a-f0-9]{48}$/);
  expect(regenerated.appPassword).toMatch(/^[a-f0-9]{48}$/);
  expect(new URL((await resolveStoreUrl(home,'CUSTOM_DATABASE_URL',{}))!).password).toBe(regenerated.appPassword);
  expect(await postgresSecrets(home,homeResources(home).port,'CUSTOM_DATABASE_URL')).toEqual(regenerated);
});
it('runs Compose through shared argv, prepares and migrates before seeding the owner',async()=>{
  const home=await fresh();const fake=fakeCommandRunner([{ok:false,stdout:'',stderr:'no such volume',message:'missing'}, {ok:true,stdout:'',stderr:''}, {ok:true,stdout:'healthy',stderr:''}]);
  pg.prepareDatabase.mockResolvedValue({ok:true,databaseUrl:'postgresql://postgres:private@localhost/brain'});
  pg.runMigrations.mockResolvedValue({ok:true,to:1,applied:['0001_initial.sql']});pg.ensureSelfUser.mockResolvedValue({ok:true,created:true,user:{name:'주인'}});
  const result=await installPostgres({home,urlEnv:'BRAIN_DATABASE_URL',env:{COMPOSE_PROJECT_NAME:'another-home'},clock,runner:fake.runner});
  expect(result).toMatchObject({ok:true,report:{...homeResources(home),schema_version:1,owner_created:true}});
  const expected=['compose','-p',homeResources(home).project,'--env-file',join(home,'.env'),'-f',join(home,'postgres','compose.yaml'),'up','-d','--wait'];
  expect(composeArgs(home,['up','-d','--wait'])).toEqual(expected);
  expect(fake.calls[2]?.args).toEqual(expected);expect(fake.calls[2]?.command).toBe('docker');
  expect(pg.prepareDatabase.mock.invocationCallOrder[0]).toBeLessThan(pg.runMigrations.mock.invocationCallOrder[0]!);
  expect(pg.runMigrations.mock.invocationCallOrder[0]).toBeLessThan(pg.ensureSelfUser.mock.invocationCallOrder[0]!);expect(pg.close).toHaveBeenCalledOnce();
});
it('reports Compose tail and OrbStack guidance without preparing the database',async()=>{
  const home=await fresh();const fake=fakeCommandRunner([{ok:false,stdout:'',stderr:'no such volume',message:'missing'}, {ok:true,stdout:'',stderr:''}, {ok:false,stdout:'',stderr:'x'.repeat(3000)+'daemon offline',message:'failed'}]);
  const result=await installPostgres({home,urlEnv:'BRAIN_DATABASE_URL',env:{},clock,runner:fake.runner});
  expect(result).toMatchObject({ok:false,code:'DB_UNAVAILABLE'});if(result.ok)return;
  expect(result.message).toContain('OrbStack');expect(result.message).toContain('daemon offline');expect(result.message.length).toBeLessThan(2300);expect(pg.prepareDatabase).not.toHaveBeenCalled();expect(fake.calls).toHaveLength(3);
});
it('guides lost-secret recovery without removing the existing volume',async()=>{
  const home=await fresh();const fake=fakeCommandRunner([{ok:false,stdout:'',stderr:'no such volume',message:'missing'}, {ok:true,stdout:'',stderr:''}, {ok:true,stdout:'healthy',stderr:''}]);pg.prepareDatabase.mockResolvedValue({ok:false,code:'DB_UNAVAILABLE',message:'password authentication failed'});
  const result=await installPostgres({home,urlEnv:'BRAIN_DATABASE_URL',env:{},clock,runner:fake.runner});
  expect(result).toMatchObject({ok:false});if(result.ok)return;expect(result.message).toContain('.env');expect(result.message).toContain('볼륨을 명시적으로');expect(fake.calls).toHaveLength(3);expect(pg.runMigrations).not.toHaveBeenCalled();
});
it('bounds an asynchronous command and returns an execution failure as a value',async()=>{
  const result=await systemCommandRunner({command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],env:process.env,timeoutMs:50});expect(result.ok).toBe(false);
});
