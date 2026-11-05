import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { extHome } from './ext-fixture.js';
import { testExtensionsFolder } from '../src/runtime/extensions.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
it('installs testext through the real CLI, records its owner migration and reads registry facts on repeat', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const before = await fixture.run(['ext', 'status', 'testext', '--json']);
  expect(before.code, before.stderr).toBe(0); expect(before.body.data).toMatchObject({ installed: false, enabled: false, connection: { status: null } });
  const empty = await fixture.run(['ext', 'list', '--json']);
  expect(empty.code, empty.stderr).toBe(0); expect(empty.body.data).toEqual([]);
  await expect(access(join(fixture.home, 'extensions'))).rejects.toThrow();
  const first = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const { readFile, stat } = await import('node:fs/promises');
  const { parseEnv } = await import('node:util');
  const secret = parseEnv(await readFile(join(fixture.home, '.env'), 'utf8')).BRAIN_EXT_TESTEXT_PASSWORD;
  expect(secret).toMatch(/^[a-f0-9]{48}$/);
  expect((await stat(join(fixture.home, '.env'))).mode & 0o777).toBe(0o600);
  expect(first.stdout + first.stderr).not.toContain(secret);
  const { extensionDatabaseUrl, extensionAdminUrl } = await import('../src/config/codec.js');
  const pg = await import('pg');
  const override = new URL(fixture.db.appUrl);
  override.searchParams.set('user', 'brain_app'); override.searchParams.set('password', 'brain-test-app');
  const extensionUrl = await extensionDatabaseUrl(fixture.home, 'testext', override.toString());
  const client = new pg.default.Client({ connectionString: extensionUrl });
  await client.connect();
  try {
    expect((await client.query('select current_user as name')).rows).toEqual([{ name: 'brain_ext_testext' }]);
    const { randomUUID } = await import('node:crypto');
    const { postgresStore } = await import('second_brain/postgres');
    const store = postgresStore({ databaseUrl: fixture.db.appUrl });
    const channel = randomUUID(), conversation = randomUUID(), work = randomUUID(), token = randomUUID(), now = new Date();
    try {
      expect(await store.ensureChannel({ id: channel, kind: 'telegram', botRef: 'bot' })).toMatchObject({ ok: true });
      expect(await store.ensureChannelConversation({ userId: '01940000-0000-7000-8000-00000000000a', id: conversation, channelId: channel, externalRef: 'chat', threadRef: null })).toMatchObject({ ok: true });
      await fixture.db.query("insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.import')");
      expect(await store.addWork({ id: work, kind: 'testext.import', targetKind: 'probe', targetId: 'test', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
      expect(await store.claimSupervisedWork({ now, kinds: ['testext.import'], claimedBy: 'test', attemptToken: token })).toMatchObject({ ok: true, item: { id: work } });
      const requestSql = `insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,$4,'notice','body',now(),$5,$6)`;
      const notificationSql = `insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'data','notifications',$4,'batch','2026-10-31','event','',now(),$5,$6)`;
      const deliverySql = `insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'data','deliveries',$4,'batch',$4,'2026-10-31','notice',null,true,now(),$5,$6)`;
      const statements = [requestSql, notificationSql, deliverySql];
      for (const statement of statements) {
        await client.query(statement, [randomUUID(), conversation, 'testext', randomUUID(), work, token]);
        await expect(client.query(statement, [randomUUID(), conversation, 'otherext', randomUUID(), work, token])).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(statement, [randomUUID(), conversation, 'testext', randomUUID(), work, null])).rejects.toMatchObject({ code: 'BRS01' });
      }
      for (const table of ['channel_requests', 'channel_legacy_notifications', 'channel_legacy_deliveries']) {
        await expect(client.query(`update brain.${table} set id=id`)).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(`delete from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(client.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,work_item_id,source_work_item_id,source_attempt_token) values ($1,$2,'testext','forged','notice','body',now(),$3,$3,$4)`, [randomUUID(), conversation, work, token])).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,source_work_item_id,source_attempt_token) values ($1,$2,'testext','forged','notice','body',now(),'sent',$3,$4)`, [randomUUID(), conversation, work, token])).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,external_message_id,source_work_item_id,source_attempt_token) values ($1,$2,'testext','forged','notice','body',now(),'forged',$3,$4)`, [randomUUID(), conversation, work, token])).rejects.toMatchObject({ code: '42501' });
      expect(await store.settleSupervisedAttempt({ id: work, attemptToken: token, now, outcome: 'died' })).toEqual({ ok: true, outcome: 'done' });
      for (const statement of statements) await expect(client.query(statement, [randomUUID(), conversation, 'testext', randomUUID(), work, token])).rejects.toMatchObject({ code: 'BRS01' });
      expect(await fixture.db.rows('select count(*)::integer as count from brain.channel_requests')).toEqual([{ count: 1 }]);
      expect(await fixture.db.rows('select count(*)::integer as count from brain.channel_legacy_notifications')).toEqual([{ count: 1 }]);
      expect(await fixture.db.rows('select count(*)::integer as count from brain.channel_legacy_deliveries')).toEqual([{ count: 1 }]);
    } finally { await store.close(); }
  }
  finally { await client.end(); }
  const adminUrl = new URL(await extensionAdminUrl(fixture.home, override.toString(), fixture.env));
  expect(adminUrl.searchParams.has('user')).toBe(false);
  expect(adminUrl.searchParams.has('password')).toBe(false);
  expect(first.body.data).toMatchObject({ name: 'testext', installed: true, enabled: true, version: '0.1.0', connection: { status: 'connected', checked_at: expect.any(String) } });
  await expect(access(join(fixture.home, 'extensions/testext/manifest.json'))).resolves.toBeUndefined();
  expect(await fixture.ledger('testext')).toEqual([{ owner: 'testext', version: 1 }]);
  const { chmod } = await import('node:fs/promises');
  await chmod(join(fixture.home, '.env'), 0o644);
  const second = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect((await stat(join(fixture.home, '.env'))).mode & 0o777).toBe(0o600);
  expect(second.code, second.stdout + second.stderr).toBe(0);
  expect(await fixture.ledger('testext')).toEqual([{ owner: 'testext', version: 1 }]);
  expect(second.body.data.installed_at).toBe(first.body.data.installed_at);
  const status = await fixture.run(['ext', 'status', 'testext', '--json']);
  expect(status.body.data).toEqual(second.body.data);
  const list = await fixture.run(['ext', 'list', '--json']);
  expect(list.body.data).toEqual([status.body.data]); expect(list.body.meta.count).toBe(1);
  expect(await fixture.db.rows('select count(*)::integer as count from brain.extensions')).toEqual([{ count: 1 }]);
  const guide = await fixture.run(['guide', 'schema', 'ext', '--json']);
  expect(guide.code, guide.stderr).toBe(0);
  expect(JSON.stringify(guide.body.data)).toContain('install'); expect(JSON.stringify(guide.body.data)).toContain('status'); expect(JSON.stringify(guide.body.data)).toContain('list');
});
it('turns off the test package resolver in the default home, comparing resolved paths', async () => {
  expect(await testExtensionsFolder('/tmp/home/../home', { SECOND_BRAIN_TEST_EXTENSIONS: '/tmp/fixtures' }, '/tmp/home')).toBeUndefined();
  expect(await testExtensionsFolder('/tmp/other', { SECOND_BRAIN_TEST_EXTENSIONS: '/tmp/fixtures' }, '/tmp/home')).toBe('/tmp/fixtures');
  expect(await testExtensionsFolder('/tmp/other', {}, '/tmp/home')).toBeUndefined();
});
it('rejects linked packages before creating an extension installation directory', async () => {
  const { tempHomes } = await import('./temp-home.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { extensionRuntime } = await import('../src/runtime/extensions.js');
  const { symlink } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const homes = tempHomes(); cleanup.push(() => homes.cleanup());
  const home = await homes.create('brain-ext-links-');
  const source = join(home, 'testext');
  await symlink(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source);
  const runtime = extensionRuntime({ home, env: {}, config: await readConfig(home), clock: { now: () => new Date() } });
  await expect(runtime.packages.place('testext', source)).rejects.toThrow('실제 폴더');
  await expect(access(join(home, 'extensions'))).rejects.toThrow();
});
it('restores the previous package and registry facts when a reinstall migration fails', async () => {
  const { cp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages');
  await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const installed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
  const target = join(fixture.home, 'extensions/testext');
  const originalManifest = await readFile(join(target, 'manifest.json'), 'utf8');
  const originalCheck = await readFile(join(target, 'bin/check.mjs'), 'utf8');
  await mkdir(join(target, 'tokenstore'));
  await writeFile(join(target, 'tokenstore', 'credentials'), 'existing-token');
  await mkdir(join(target, 'staging'));
  await writeFile(join(target, 'staging', 'pending'), 'pending-bytes');
  await mkdir(join(source, 'tokenstore'));
  await writeFile(join(source, 'tokenstore', 'credentials'), 'package-token');
  const reinstalled = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(reinstalled.code).toBe(0);
  expect(await readFile(join(target, 'tokenstore', 'credentials'), 'utf8')).toBe('existing-token');
  expect(await readFile(join(target, 'staging', 'pending'), 'utf8')).toBe('pending-bytes');
  await writeFile(join(source, 'manifest.json'), originalManifest.replace('0.1.0', '0.2.0'));
  await writeFile(join(source, 'bin/check.mjs'), 'throw new Error("replacement must not remain");\n');
  await writeFile(join(source, 'migrations/0002_refused.sql'), 'select extension_missing_column;\n');
  const failed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(failed.code, failed.stdout + failed.stderr).toBe(1);
  expect(failed.body.error.code).toBe('MIGRATION_FAILED');
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(originalManifest);
  expect(await readFile(join(target, 'bin/check.mjs'), 'utf8')).toBe(originalCheck);
  expect(await readFile(join(target, 'tokenstore', 'credentials'), 'utf8')).toBe('existing-token');
  expect(await readFile(join(target, 'staging', 'pending'), 'utf8')).toBe('pending-bytes');
  await expect(access(join(target, 'migrations/0002_refused.sql'))).rejects.toThrow();
  const failedStatus = (await fixture.run(['ext', 'status', 'testext', '--json'])).body.data;
  expect(failedStatus).toMatchObject({ installed: true, version: reinstalled.body.data.version, connection: reinstalled.body.data.connection, install: { result: 'failed', failed_stage: 'migration' } });
  expect(failed.body.data).toEqual(failedStatus);
  expect(await fixture.ledger('testext')).toEqual([{ owner: 'testext', version: 1 }]);
  expect(await readdir(join(fixture.home, 'extensions'))).toEqual(['testext']);
  const failedProgress = (await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress as import('second_brain').ExtensionInstallProgress;
  await writeFile(join(source, 'bin/check.mjs'), originalCheck);
  await writeFile(join(source, 'migrations/0002_refused.sql'), 'select 1;\n');
  const resumed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toContain('0.2.0');
  expect(await readFile(join(target, 'tokenstore', 'credentials'), 'utf8')).toBe('existing-token');
  expect(await readFile(join(target, 'staging', 'pending'), 'utf8')).toBe('pending-bytes');
  const resumedProgress = (await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress as import('second_brain').ExtensionInstallProgress;
  expect(resumedProgress.stages.package?.at).not.toBe(failedProgress.stages.package?.at);
  expect(await fixture.ledger('testext')).toEqual([{ owner: 'testext', version: 1 }, { owner: 'testext', version: 2 }]);
});
it.each([
  ['invalid', 'EXTENSION_PYTHON_PIN_INVALID'], ['uv', 'EXTENSION_UV_NOT_FOUND'],
  ['python', 'EXTENSION_PYTHON_NOT_FOUND'], ['sync', 'EXTENSION_PYTHON_SYNC_FAILED'],
  ['version', 'EXTENSION_PYTHON_VERSION_MISMATCH'],
])('Python %s 실패 시 이전 패키지와 tokenstore를 복원한다', async (mode, code) => {
  const { cp, mkdir, readFile, writeFile, readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages'); await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const installed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(installed.code, installed.stderr).toBe(0);
  const target = join(fixture.home, 'extensions/testext');
  const original = await readFile(join(target, 'manifest.json'), 'utf8');
  await mkdir(join(target, 'tokenstore')); await writeFile(join(target, 'tokenstore/credentials'), 'existing-token');
  const replacement = JSON.parse(original);
  replacement.connection_check = { runtime: 'python', entry: 'check.py' };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(replacement));
  await writeFile(join(source, '.python-version'), mode === 'invalid' ? '3.12' : '3.12.13');
  await writeFile(join(source, 'pyproject.toml'), ''); await writeFile(join(source, 'uv.lock'), '');
  const bin = join(fixture.home, 'fake-bin'); await mkdir(bin);
  if (mode !== 'uv') await writeFile(join(bin, 'uv'), `#!/bin/sh\ncase "$1" in\n--version) exit 0;;\npython) ${mode === 'python' ? 'echo secret-output >&2; exit 1' : 'echo /local/python; exit 0'};;\nsync) ${mode === 'sync' ? 'echo secret-output >&2; exit 1' : '/bin/mkdir -p .venv/bin; /bin/echo "#!/bin/sh\\necho 3.12.14" > .venv/bin/python; /bin/chmod +x .venv/bin/python; exit 0'};;\nesac\n`, { mode: 0o755 });
  const environment: NodeJS.ProcessEnv = fixture.env;
  environment.PATH = bin; environment.SECRET_TEST_VALUE = 'secret-output';
  const failed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(failed.body.error.code).toBe(code);
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(original);
  expect(await readFile(join(target, 'tokenstore/credentials'), 'utf8')).toBe('existing-token');
  expect(await readdir(join(fixture.home, 'extensions'))).toEqual(['testext']);
  const status = await fixture.run(['ext', 'status', 'testext', '--json']);
  expect(status.body.data).toMatchObject({ installed: true, connection: { status: 'connected' }, python_environment: { status: 'failed', code } });
  expect(JSON.stringify({ failed, status })).not.toContain('secret-output');
  const textStatus = await fixture.run(['ext', 'status', 'testext']); expect(textStatus.stdout).toContain(code);
});
it('persists ABI errors containing NUL and credentials as a failed connection', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages');
  await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const message = '연결 거절\u0000 postgres://brain_app:private-password@localhost/brain';
  await writeFile(join(source, 'bin/check.mjs'), `console.log(${JSON.stringify(JSON.stringify({ abi: 1, type: 'error', code: 'REFUSED', retryable: false, message }))});\n`);
  const failed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(failed.code, failed.stdout + failed.stderr).toBe(1);
  expect(failed.body.error.code).toBe('EXTENSION_CHECK_FAILED');
  const status = await fixture.run(['ext', 'status', 'testext', '--json']);
  expect(status.code, status.stdout + status.stderr).toBe(0);
  expect(status.body.data).toMatchObject({ installed: true, enabled: true, connection: { status: 'failed', code: 'EXTENSION_WORKER_ERROR' } });
  expect(status.body.data.connection.message).toBe('확장 실행에 실패했습니다');
  expect(status.body.data.connection.message).not.toContain('private-password');
  expect(status.body.data.connection.message).not.toContain('\u0000');
});

it('turns off the test resolver for a symbolic link to the default home', async () => {
  const { tempHomes } = await import('./temp-home.js');
  const { mkdir, symlink } = await import('node:fs/promises');
  const homes = tempHomes(); cleanup.push(() => homes.cleanup());
  const parent = await homes.create('brain-ext-default-link-');
  const defaultHome = join(parent, '.second_brain'), alias = join(parent, 'alias');
  await mkdir(defaultHome);
  await symlink(defaultHome, alias);
  expect(await testExtensionsFolder(alias, { SECOND_BRAIN_TEST_EXTENSIONS: '/tmp/fixtures' }, defaultHome)).toBeUndefined();
});
it('rejects a linked check entry in a real package before creating extensions', async () => {
  const { tempHomes } = await import('./temp-home.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { extensionRuntime } = await import('../src/runtime/extensions.js');
  const { cp, symlink, unlink } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const homes = tempHomes(); cleanup.push(() => homes.cleanup());
  const home = await homes.create('brain-ext-entry-link-');
  const source = join(home, 'testext');
  const fixture = fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url));
  await cp(fixture, source, { recursive: true });
  await unlink(join(source, 'bin/check.mjs'));
  await symlink(join(fixture, 'bin/check.mjs'), join(source, 'bin/check.mjs'));
  const runtime = extensionRuntime({ home, env: {}, config: await readConfig(home), clock: { now: () => new Date() } });
  await expect(runtime.packages.place('testext', source)).rejects.toThrow('심볼릭 링크');
  await expect(access(join(home, 'extensions'))).rejects.toThrow();
});
it('returns an absolute installed target for a relative home', async () => {
  const { tempHomes } = await import('./temp-home.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { extensionRuntime } = await import('../src/runtime/extensions.js');
  const { fileURLToPath } = await import('node:url');
  const homes = tempHomes(); cleanup.push(() => homes.cleanup());
  const home = relative(process.cwd(), await homes.create('brain-ext-relative-'));
  const runtime = extensionRuntime({ home, env: {}, config: await readConfig(home), clock: { now: () => new Date() } });
  const target = await runtime.packages.place('testext', fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)));
  expect(isAbsolute(target)).toBe(true);
  expect(target).toBe(resolve(home, 'extensions', 'testext'));
  await expect(access(join(target, 'bin/check.mjs'))).resolves.toBeUndefined();
});
it('refuses testext through the real CLI in the default home with a test resolver configured', async () => {
  const { tempHomes } = await import('./temp-home.js');
  const { rename } = await import('node:fs/promises');
  const homes = tempHomes(); cleanup.push(() => homes.cleanup());
  const parent = await homes.create('brain-ext-default-');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const defaultHome = join(parent, '.second_brain');
  await rename(fixture.home, defaultHome);
  const env: NodeJS.ProcessEnv = fixture.env;
  env.HOME = parent;
  delete env.SECOND_BRAIN_HOME;
  const result = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(2);
  expect(result.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_NOT_FOUND' } });
  await expect(access(join(defaultHome, 'extensions'))).rejects.toThrow();
  expect(await fixture.db.rows('select count(*)::integer as count from brain.extensions')).toEqual([{ count: 0 }]);
});

it('reruns the connection check on reinstall and preserves the original installation time', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages');
  await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const installed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
  expect(installed.body.data.connection.status).toBe('connected');
  expect(installed.body.data.installed_at).toEqual(expect.any(String));
  const error = { abi: 1, type: 'error', code: 'REINSTALL_REFUSED', retryable: false, message: '재설치 연결 거절' };
  await writeFile(join(source, 'bin/check.mjs'), `console.log(${JSON.stringify(JSON.stringify(error))});\n`);
  const reinstalled = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(reinstalled.code, reinstalled.stdout + reinstalled.stderr).toBe(1);
  expect(reinstalled.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_CHECK_FAILED' } });
  const status = await fixture.run(['ext', 'status', 'testext', '--json']);
  expect(status.code, status.stdout + status.stderr).toBe(0);
  expect(reinstalled.body.data).toEqual(status.body.data);
  expect(status.body.data.install).toMatchObject({ result: 'connection_failed', failed_stage: 'connection' });
  expect(status.body.data).toMatchObject({ installed: true, enabled: true, installed_at: installed.body.data.installed_at,
    connection: { status: 'failed', code: 'EXTENSION_WORKER_ERROR' } });
});
it('preserves the initial package and cleans staging when the first migration fails', async () => {
  const { cp, mkdir, readdir, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages');
  await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  await writeFile(join(source, 'migrations/0001_testext.sql'), 'select extension_missing_column;\n');
  await expect(access(join(fixture.home, 'extensions'))).rejects.toThrow();
  const failed = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(failed.code, failed.stdout + failed.stderr).toBe(1);
  expect(failed.body).toMatchObject({ ok: false, error: { code: 'MIGRATION_FAILED' } });
  expect(await fixture.db.rows('select count(*)::integer as count from brain.extensions')).toEqual([{ count: 0 }]);
  expect(await fixture.ledger('testext')).toEqual([]);
  await expect(access(join(fixture.home, 'extensions/testext/migrations/0001_testext.sql'))).resolves.toBeUndefined();
  expect(await readdir(join(fixture.home, 'extensions'))).toEqual(['testext']);
});

it('registers manifest work and auth kinds in PostgreSQL for subsequent enqueue', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { postgresStore } = await import('second_brain/postgres');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages'); await mkdir(sources);
  const source = join(sources, 'testext');
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.work = [{ kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs' }];
  manifest.auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs' };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest)); fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const installed = await fixture.run(['ext', 'install', 'testext', '--json']); expect(installed.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  try {
    const now = new Date();
    for (const [i, kind, expected] of [[1, 'testext.sync', 'supervised'], [2, 'testext.login', 'supervised'], [3, 'other.job', 'core']] as const) {
      const result = await store.addWork({ id: `00000000-0000-7000-8000-00000000000${i}`, kind, targetKind: 'account', targetId: 'x', createdAt: now, nextAttemptAt: now });
      expect(result.ok && result.item.executionClass).toBe(expected);
    }
  } finally { await store.close(); }
});

it('resolves a real connection snapshot and keeps arbitrary diagnostics out of registry and status', async () => {
  const { cp, mkdir, readFile, writeFile, appendFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages'); await mkdir(sources);
  const source = join(sources, 'testext'); await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.settings = [{ key: 'testext.token', type: 'string', secret: true, required: ['connect'] }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await appendFile(join(fixture.home, '.env'), '\nTESTEXT_SECRET=SYNTHETIC_VALUE_49\n');
  await fixture.db.query("insert into brain.settings(user_id,key,value,updated_at) values ((select id from brain.users where is_self=1),'testext.token','TESTEXT_SECRET',now())");
  await writeFile(join(source, 'bin/check.mjs'), `const v=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values['testext.token']; if(v!=='SYNTHETIC_VALUE_49'||process.argv.join(' ').includes(v)) process.exit(2); process.stderr.write(v.slice(0,4)); process.stderr.write(v.slice(4)); const s=JSON.stringify({abi:1,type:'error',code:v,retryable:false,message:v+'\\n'}); process.stdout.write(s.slice(0,7)); process.stdout.write(s.slice(7)+'\\n');\n`);
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const result = await fixture.run(['ext', 'install', 'testext', '--json']);
  const status = await fixture.run(['ext', 'status', 'testext', '--json']);
  const registry = await fixture.db.rows('select * from brain.extensions');
  expect(result.code).toBe(1);
  expect(status.body.data.connection).toMatchObject({ status: 'failed', code: 'EXTENSION_WORKER_ERROR', message: '확장 실행에 실패했습니다' });
  expect(JSON.stringify({ result, status, registry })).not.toContain('SYNTHETIC_VALUE_49');
});

it('discovers a newly installed manifest and runs its registered work with a fresh snapshot', async () => {
  const { cp, mkdir, readFile, writeFile, appendFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { postgresStore } = await import('second_brain/postgres');
  const { sequenceIdGen } = await import('second_brain/testing');
  const { readConfig } = await import('../src/config/codec.js');
  const { startDaemonSupervisor } = await import('../src/daemon/supervisor.js');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'packages'); await mkdir(sources);
  const source = join(sources, 'testext'); await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.work = [{ kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/sync.mjs' }];
  manifest.error_codes = ['TEMPORARY'];
  manifest.auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'bin/login.mjs' };
  manifest.settings = [{ key: 'testext.token', type: 'string', secret: true, required: ['work'] }, { key: 'testext.tokenstore', type: 'string', machine: 'tokenstore', required: ['auth', 'work'] }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'bin/login.mjs'), `if(new URL(process.env.BRAIN_DATABASE_URL).username!=='brain_ext_testext' || process.argv.join(' ').includes(new URL(process.env.BRAIN_DATABASE_URL).password)) process.exit(2); const v=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values; if('testext.token' in v || !v['testext.tokenstore'].endsWith('/testext/tokenstore')) process.exit(2); console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  await writeFile(join(source, 'bin/sync.mjs'), `import {writeFileSync} from 'node:fs'; const snapshot=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT); writeFileSync(process.env.BRAIN_EXTENSION_HOME+'/snapshot-user-id-'+process.env.BRAIN_RUN_GENERATION,JSON.stringify({snapshot:snapshot.user_id,env:process.env.BRAIN_USER_ID})); if(new URL(process.env.BRAIN_DATABASE_URL).username!=='brain_ext_testext' || process.argv.join(' ').includes(new URL(process.env.BRAIN_DATABASE_URL).password)) process.exit(2); const x=snapshot.values['testext.token']; if(process.argv.join(' ').includes(x) || process.env.BRAIN_RANGE_FROM!=='2026-10-20' || process.env.BRAIN_RANGE_TO!=='2026-10-22' || JSON.stringify(JSON.parse(process.env.BRAIN_OCCURRENCES))!==JSON.stringify(['2026-10-20T00:00:00.000+00:00','2026-10-22T00:00:00.000+00:00'])) process.exit(2); if(process.env.BRAIN_RUN_GENERATION==='1' && x==='SYNTHETIC_VALUE_49') console.log(JSON.stringify({abi:1,type:'error',code:'TEMPORARY',retryable:true,message:x})); else if(process.env.BRAIN_RUN_GENERATION==='2' && x==='SYNTHETIC_VALUE_50') console.log(JSON.stringify({abi:1,type:'result'})); else process.exit(2);\n`);
  await appendFile(join(fixture.home, '.env'), '\nTESTEXT_SECRET=SYNTHETIC_VALUE_49\nTESTEXT_NEW=SYNTHETIC_VALUE_50\n');
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const controller = new AbortController(); const logs: string[] = []; const idGen = sequenceIdGen({ timestampMs: Date.now() });
  const supervisor = startDaemonSupervisor({ home: fixture.home, env: fixture.env, clock: { now: () => new Date() }, idGen, signal: controller.signal, supervisor: { pollMs: 20, cancelPollMs: 20, cancelGraceMs: 30, groupConfirmMs: 100 } }, await readConfig(fixture.home), { async write(message) { logs.push(message); } });
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await expect.poll(async () => (await fixture.db.rows("select outcome from brain.work_items where kind='testext.login' and target_kind='extension'"))[0]?.outcome, { timeout: 5000 }).toBe('succeeded');
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).code).toBe(0);
    const now = new Date(); const loginId = idGen.next();
    const login = await store.addWork({ id: loginId, kind: 'testext.login', targetKind: 'account', targetId: 'a', createdAt: now, nextAttemptAt: now });
    expect(login.ok && login.item.executionClass).toBe('supervised');
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${loginId}'`))[0]?.outcome, { timeout: 5000 }).toBe('succeeded');
    expect((await fixture.run(['config', 'set', 'testext.token', 'TESTEXT_SECRET', '--json'])).code).toBe(0);
    const id = idGen.next();
    const selfUser = await store.readSelfUser(); if (!selfUser.ok || !selfUser.user) throw new Error('missing self');
    const scheduleId = idGen.next(); const dueAt = new Date(now.getTime()+3600000);
    expect(await store.addSchedule({id:scheduleId,kind:'testext.sync',targetKind:'account',targetId:'a',triggerKind:'cron',cronExpr:'0 9 * * *',runAt:null,timeZone:'Asia/Seoul',timeZoneSource:'fixed',intervalSeconds:null,extension:null,scheduleKey:null,userId:selfUser.user.id,enabled:true,removedAt:null,nextRunAt:dueAt,lastRunAt:null,createdAt:now})).toMatchObject({ok:true});
    const added = await store.fireSchedule({scheduleId,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'0 9 * * *',expectedNextRunAt:dueAt,nextRunAt:new Date(now.getTime()+86400000),now,work:{id,kind:'testext.sync',targetKind:'account',targetId:'a',createdAt:now,nextAttemptAt:now},occurrences:['2026-10-20T00:00:00Z','2026-10-22T00:00:00Z'].map(value=>({occurrenceAt:new Date(value),status:'pending' as const}))});
    expect(added).toMatchObject({ok:true,fired:true,created:true});
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_attempts where work_item_id='${id}'`))[0]?.outcome, { timeout: 5000 }).toBe('failed');
    expect((await fixture.run(['config', 'set', 'testext.token', 'TESTEXT_NEW', '--json'])).code).toBe(0);
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${id}'`);
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome, { timeout: 5000 }).toBe('succeeded');
    const selfId = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    for (const generation of [1, 2]) expect(JSON.parse(await readFile(join(fixture.home, `extensions/testext/snapshot-user-id-${generation}`), 'utf8'))).toEqual({ snapshot: selfId, env: selfId });
    const facts = await fixture.db.rows(`select * from brain.work_attempts where work_item_id='${id}'`);
    const status = await fixture.run(['ext', 'status', 'testext', '--json']);
    expect(JSON.stringify({ facts, status, logs })).not.toContain('SYNTHETIC_VALUE_49');
    expect(JSON.stringify({ facts, status, logs })).not.toContain('SYNTHETIC_VALUE_50');
    expect(facts).toHaveLength(2);
  } finally { controller.abort(); await supervisor.stop(); await store.close(); }
});

it('preserves both private passwords during simultaneous installs in separate processes', async () => {
  const { cp, mkdir, readFile, writeFile, stat } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { parseEnv } = await import('node:util');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'concurrent-packages'); await mkdir(sources);
  const original = fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url));
  await cp(original, join(sources, 'testext'), { recursive: true });
  await cp(original, join(sources, 'otherext'), { recursive: true });
  for (const file of ['manifest.json', 'bin/check.mjs', 'migrations/0001_testext.sql']) {
    const path = join(sources, 'otherext', file);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('testext', 'otherext'));
  }
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const results = await Promise.all([fixture.run(['ext', 'install', 'testext', '--json']), fixture.run(['ext', 'install', 'otherext', '--json'])]);
  expect(results.map(result => result.code), JSON.stringify(results)).toEqual([0, 0]);
  const env = parseEnv(await readFile(join(fixture.home, '.env'), 'utf8'));
  expect(env.BRAIN_EXT_TESTEXT_PASSWORD).toMatch(/^[a-f0-9]{48}$/);
  expect(env.BRAIN_EXT_OTHEREXT_PASSWORD).toMatch(/^[a-f0-9]{48}$/);
  expect(env.BRAIN_EXT_TESTEXT_PASSWORD).not.toBe(env.BRAIN_EXT_OTHEREXT_PASSWORD);
  expect((await stat(join(fixture.home, '.env'))).mode & 0o777).toBe(0o600);
  for (const result of results) for (const secret of [env.BRAIN_EXT_TESTEXT_PASSWORD!, env.BRAIN_EXT_OTHEREXT_PASSWORD!]) expect(result.stdout + result.stderr).not.toContain(secret);
});

it('reinstall keeps a user setting and inserts only newly declared defaults', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'setting-packages'), source = join(sources, 'testext');
  await mkdir(sources);
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const first = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const changed = await fixture.run(['config', 'set', 'testext.label', 'custom-value', '--json']);
  expect(changed.code, changed.stdout + changed.stderr).toBe(0);
  const path = join(source, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.settings.push({ key: 'testext.added', type: 'string', required: [], default: 'new-default' });
  await writeFile(path, JSON.stringify(manifest));
  const second = await fixture.run(['ext', 'install', 'testext', '--json']);
  expect(second.code, second.stdout + second.stderr).toBe(0);
  const old = await fixture.run(['config', 'get', 'testext.label', '--json']);
  const added = await fixture.run(['config', 'get', 'testext.added', '--json']);
  expect(old.body.data).toMatchObject({ value: 'custom-value', source: 'db', scope: 'user' });
  expect(added.body.data).toMatchObject({ value: 'new-default', source: 'db', scope: 'user' });
  expect(await fixture.db.rows("select s.key,s.value from brain.settings s join brain.users u on u.id=s.user_id where u.is_self=1 and s.key in ('testext.label','testext.added') order by s.key")).toEqual([{ key: 'testext.added', value: 'new-default' }, { key: 'testext.label', value: 'custom-value' }]);
});

it('daemon prepare fails with USER_MISSING without starting an extension child', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { postgresStore } = await import('second_brain/postgres');
  const { fakeProcessLauncher } = await import('second_brain/testing');
  const { startDaemonSupervisor } = await import('../src/daemon/supervisor.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome({ self: false }); cleanup.push(fixture.cleanup);
  const directory = join(fixture.home, 'extensions', 'testext'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: 'testext', version: '1', core: 1, abi: 1, migrations: 'migrations', connection_check: { runtime: 'node', entry: 'check.mjs' }, work: [{ kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'sync.mjs' }] }));
  await fixture.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now()); insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.sync')");
  const store = postgresStore({ databaseUrl: fixture.db.appUrl }), id = randomUUID(), now = new Date(), controller = new AbortController(), launcher = fakeProcessLauncher();
  const added = await store.addWork({ id, kind: 'testext.sync', targetKind: 'extension', targetId: 'testext', createdAt: now, nextAttemptAt: now });
  expect(added.ok).toBe(true);
  const supervisor = startDaemonSupervisor({ home: fixture.home, env: fixture.env, clock: { now: () => new Date() }, idGen: uuidV7IdGen(), signal: controller.signal, supervisor: { pollMs: 20, launcher } }, await readConfig(fixture.home), { async write() {} });
  try {
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome, { timeout: 10000 }).toBe('failed');
    expect(await fixture.db.rows(`select error_code,error_retryable from brain.work_attempts where work_item_id='${id}'`)).toEqual([{ error_code: 'USER_MISSING', error_retryable: false }]);
    expect(launcher.specs).toEqual([]);
  } finally { controller.abort(); await supervisor.stop(); await store.close(); }
});

it('daemon refuses a core supervised process when self is missing', async () => {
  const { randomUUID } = await import('node:crypto');
  const { postgresStore } = await import('second_brain/postgres');
  const { fakeProcessLauncher } = await import('second_brain/testing');
  const { startDaemonSupervisor } = await import('../src/daemon/supervisor.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome({ self: false }); cleanup.push(fixture.cleanup);
  const store = postgresStore({ databaseUrl: fixture.db.appUrl }), id = randomUUID(), now = new Date(), controller = new AbortController(), launcher = fakeProcessLauncher();
  expect(await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '100', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
  const supervisor = startDaemonSupervisor({ home: fixture.home, env: fixture.env, clock: { now: () => new Date() }, idGen: uuidV7IdGen(), signal: controller.signal, supervisor: { pollMs: 20, launcher } }, await readConfig(fixture.home), { async write() {} });
  try {
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome, { timeout: 10000 }).toBe('failed');
    expect(await fixture.db.rows(`select error_code,error_retryable from brain.work_attempts where work_item_id='${id}'`)).toEqual([{ error_code: 'USER_MISSING', error_retryable: false }]);
    expect(launcher.specs).toEqual([]);
  } finally { controller.abort(); await supervisor.stop(); await store.close(); }
});

it('installs and preserves a global default at the NULL scope on reinstall', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'global-packages'), source = join(sources, 'testext');
  await mkdir(sources); await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  const path = join(source, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.settings.push({ key: 'testext.global', type: 'string', required: [], scope: 'global', default: 'initial' });
  await writeFile(path, JSON.stringify(manifest)); fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const first = await fixture.run(['ext', 'install', 'testext', '--json']); expect(first.code, first.stdout + first.stderr).toBe(0);
  expect(await fixture.db.rows("select user_id,value from brain.settings where key='testext.global'")).toEqual([{ user_id: null, value: 'initial' }]);
  expect((await fixture.run(['config', 'set', 'testext.global', 'changed', '--json'])).body.ok).toBe(true);
  const before = await fixture.db.rows("select user_id,value,updated_at from brain.settings where key='testext.global'");
  const again = await fixture.run(['ext', 'install', 'testext', '--json']); expect(again.code, again.stdout + again.stderr).toBe(0);
  expect(await fixture.db.rows("select user_id,value,updated_at from brain.settings where key='testext.global'")).toEqual(before);
  expect((await fixture.run(['config', 'get', 'testext.global', '--json'])).body.data).toMatchObject({ scope: 'global', source: 'db', value: 'changed' });
});

it('global setting agrees across config, command, connection check and daemon work', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { randomUUID } = await import('node:crypto');
  const { postgresStore } = await import('second_brain/postgres');
  const { startDaemonSupervisor } = await import('../src/daemon/supervisor.js');
  const { readConfig } = await import('../src/config/codec.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const sources = join(fixture.home, 'scope-packages'), source = join(sources, 'testext'); await mkdir(sources);
  await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  const path = join(source, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.settings.push({ key: 'testext.global', type: 'string', scope: 'global', required: ['connect', 'work'] });
  manifest.work = [{ kind: 'testext.scope', execution: 'supervised', runtime: 'node', entry: 'bin/scope.mjs' }];
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(source, 'bin/check.mjs'), "const s=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT); if(s.values['testext.global']!=='shared') process.exit(2); console.log(JSON.stringify({abi:1,type:'result'}));\n");
  await writeFile(join(source, 'bin/scope.mjs'), "import {writeFileSync} from 'node:fs'; const s=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT); writeFileSync(process.env.BRAIN_EXTENSION_HOME+'/scope-result',JSON.stringify(s)); console.log(JSON.stringify({abi:1,type:'result'}));\n");
  await fixture.db.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'testext.global','shared',now()),((select id from brain.users where is_self=1),'testext.global','personal',now())");
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = sources;
  const installed = await fixture.run(['ext', 'install', 'testext', '--json']); expect(installed.code, installed.stdout + installed.stderr).toBe(0);
  const config = await fixture.run(['config', 'get', 'testext.global', '--json']); expect(config.body.data).toMatchObject({ value: 'shared', scope: 'global' });
  const command = await fixture.run(['ext', 'testext', 'echo-stats', '--json']); expect(command.body.data.settings['testext.global']).toBe(config.body.data.value);
  const self = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
  expect(command.body.data.user_id).toBe(self);
  const store = postgresStore({ databaseUrl: fixture.db.appUrl }), controller = new AbortController(), id = randomUUID(), now = new Date();
  expect(await store.addWork({ id, kind: 'testext.scope', targetKind: 'extension', targetId: 'testext', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
  const supervisor = startDaemonSupervisor({ home: fixture.home, env: fixture.env, clock: { now: () => new Date() }, idGen: uuidV7IdGen(), signal: controller.signal, supervisor: { pollMs: 20 } }, await readConfig(fixture.home), { async write() {} });
  try {
    await expect.poll(async () => (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome, { timeout: 10000 }).toBe('succeeded');
    const snapshot = JSON.parse(await readFile(join(fixture.home, 'extensions/testext/scope-result'), 'utf8'));
    expect(snapshot).toMatchObject({ user_id: self, values: { 'testext.global': config.body.data.value } });
  } finally { controller.abort(); await supervisor.stop(); await store.close(); }
}, 60000);
