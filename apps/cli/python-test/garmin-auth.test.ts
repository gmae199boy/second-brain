import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('감독자 인증의 성공, 토큰 오류와 당일 차단을 네트워크 없이 투영한다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome({ realGarminAuth: true }), home = await realpath(fixture.home), ext = join(home, 'extensions/garmin');
  const ids = uuidV7IdGen(), store = postgresStore({ databaseUrl: fixture.db.appUrl }), controller = new AbortController();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed = await fixture.run(['ext', 'install', 'garmin', '--json']);
    expect(installed.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/auth_fixture.py', import.meta.url)), join(ext, 'auth_fixture.py'));
    const manifestPath = join(ext, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.auth = {kind:'garmin.auth',execution:'supervised',runtime:'python',entry:'auth_fixture.py'};
    manifest.error_codes = [...new Set([...(manifest.error_codes ?? []), 'LOGIN_REQUIRED', 'SESSION_BLOCKED', 'SESSION_LOCK_TIMEOUT'])];
    manifest.settings = [...(manifest.settings ?? []).filter((s: {key:string}) => s.key !== 'garmin.tokenstore'), {key:'garmin.tokenstore',type:'string',required:[],secret:false}];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const tokens = join(home, 'fake-tokens'); await mkdir(tokens);
    await store.setSetting({key:'garmin.tokenstore', value:tokens, updatedAt:new Date()});
    const marker = {home, invalid:false};
    const writeMarker = () => writeFile(join(home, '.garmin-auth-fixture.json'), JSON.stringify(marker));
    await writeMarker();
    const calls = async () => (await readFile(join(home, 'auth-calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    const queue = async (target = 'garmin') => {
      const id = ids.next();
      expect(await store.addWork({id,kind:'garmin.auth',targetKind:'extension',targetId:target,createdAt:new Date(),nextAttemptAt:new Date()})).toMatchObject({ok:true});
      return id;
    };
    daemon = runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const first = installed.body.data.install.auth_work_id;
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await calls()).toBe(1);
    marker.invalid = true; await writeMarker();
    const invalid = await queue();
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${invalid}'`))[0]?.error_code,{timeout:20000}).toBe('LOGIN_REQUIRED');
    expect(await calls()).toBe(2);
    const today = new Date(); const local = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    await writeFile(join(tokens,'block.json'), JSON.stringify({schema_version:1,local_date:local,reason:'rate_limited'}));
    const blocked = await queue();
    await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${blocked}'`))[0]?.error_code,{timeout:20000}).toBe('SESSION_BLOCKED');
    expect(await calls()).toBe(2);
    await rm(join(tokens, 'block.json'));
    marker.invalid = false; await writeMarker();
    const ready = join(home, 'lock-ready'), release = join(home, 'lock-release'), other = join(home, 'other-tokens');
    const holder = spawn(join(ext,'.venv/bin/python'), ['-c', "import fcntl,sys,time,pathlib; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); pathlib.Path(sys.argv[2]).touch();\nwhile not pathlib.Path(sys.argv[3]).exists(): time.sleep(.02)", join(tokens,'.session.lock'), ready, release], {stdio:'ignore'});
    try {
      await expect.poll(async () => readFile(ready).then(() => true).catch(() => false), {timeout:10000}).toBe(true);
      const locked = await queue();
      await expect.poll(async () => (await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${locked}'`))[0]?.error_code,{timeout:20000}).toBe('SESSION_LOCK_TIMEOUT');
      expect((await fixture.db.rows(`select error_retryable from brain.work_attempts where work_item_id='${locked}'`))[0]?.error_retryable).toBe(true);
      expect(await calls()).toBe(2);
      await mkdir(other);
      await store.setSetting({key:'garmin.tokenstore', value:other, updatedAt:new Date()});
      const separate = await queue('other');
      await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${separate}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
      expect(await calls()).toBe(3);
    } finally { await writeFile(release, ''); holder.kill(); }
    const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const pty = "import os,pty,sys\npid,fd=pty.fork()\nif pid == 0: os.execv(sys.argv[1],sys.argv[1:])\nwhile True:\n try: data=os.read(fd,4096)\n except OSError: break\n if not data: break\n os.write(1,data)\n_,status=os.waitpid(pid,0)\nsys.exit(os.waitstatus_to_exitcode(status))";
    const runTerminal = () => spawnSync(join(ext,'.venv/bin/python'), ['-c', pty, process.execPath, cli, 'ext', 'login', 'garmin'], {encoding:'utf8', env:fixture.env, timeout:15000});
    const logged = runTerminal();
    expect(logged.status, logged.stdout + logged.stderr).toBe(0);
    expect((await (await import('node:fs/promises')).stat(join(other,'garmin_tokens.json'))).mode & 0o777).toBe(0o600);
    expect((await (await import('node:fs/promises')).stat(other)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home,'terminal-calls'),'utf8')).toBe('login\nprofile\ndump\n');
    Object.assign(marker, {mfa:true}); await writeMarker();
    const mfa = runTerminal();
    expect(mfa.status).not.toBe(0);
    expect(mfa.stdout + mfa.stderr).toContain('LOGIN_REQUIRED');
    expect(await readFile(join(home,'terminal-calls'),'utf8')).toBe('login\nprofile\ndump\nlogin\n');
    expect(await readFile(join(other,'garmin_tokens.json'),'utf8')).toBe('synthetic-token-canary');
    const audit = await readFile(join(home,'process-audit'),'utf8');
    expect(audit).toContain('auth: clean'); expect(audit.match(/terminal: clean/g)).toHaveLength(2);
    const files: string[] = [];
    async function scan(directory: string): Promise<void> {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = join(directory, entry.name);
        if (path === other || path === tokens) continue;
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    await scan(home);
    for (const path of files) {
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from('synthetic-password-canary')), path).toBe(false);
      expect(bytes.includes(Buffer.from('synthetic-token-canary')), path).toBe(false);
    }
    for (const output of [logged.stdout, logged.stderr, mfa.stdout, mfa.stderr, JSON.stringify(await fixture.db.rows("select * from brain.work_attempts")), JSON.stringify(await fixture.db.rows("select * from brain.failures"))]) {
      expect(output).not.toContain('synthetic-password-canary');
      expect(output).not.toContain('synthetic-token-canary');
    }

  } finally { controller.abort(); await daemon; await store.close(); await fixture.cleanup(); }
});
