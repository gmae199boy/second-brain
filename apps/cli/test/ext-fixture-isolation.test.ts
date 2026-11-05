import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { extHome } from './ext-fixture.js';

async function withDockerWrapper(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'brain-docker-wrapper-'));
  const originalPath = process.env.PATH;
  const realDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
  await writeFile(join(dir, 'docker'), `#!/bin/sh
echo "$*" >> "$BRAIN_WRAPPER_DIR/calls"
if [ "$1" = inspect ] && [ "$2" = --format ] && [ "$3" = '{{json .NetworkSettings.Ports}}' ]; then
  echo "$4" >> "$BRAIN_WRAPPER_DIR/ids"
  if [ -f "$BRAIN_WRAPPER_DIR/fail-inspect" ]; then exit 71; fi
  if [ -n "$BRAIN_WRAPPER_PROXY_PORT" ]; then
    '${realDocker}' "$@" > "$BRAIN_WRAPPER_DIR/ports"
    printf '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"%s"}]}' "$BRAIN_WRAPPER_PROXY_PORT"
    exit 0
  fi
fi
if [ "$1" = inspect ] && [ "$2" = --format ] && [ "$3" = '{{.Id}}' ] && [ -f "$BRAIN_WRAPPER_DIR/fake-absence" ]; then
  case "$(cat "$BRAIN_WRAPPER_DIR/fake-absence")" in
    wrong-id) echo 'Error: No such object: unrelated' >&2; exit 1;;
    permission) echo 'permission denied' >&2; exit 1;;
    daemon) echo "error: no such object: $4" >&2; exit 125;;
  esac
fi
if [ "$1" = rm ] && [ -f "$BRAIN_WRAPPER_DIR/fail-rm-after" ]; then
  /bin/rm "$BRAIN_WRAPPER_DIR/fail-rm-after"
  '${realDocker}' "$@" || exit $?
  echo 'synthetic lost response' >&2
  exit 72
fi
if [ "$1" = rm ] && [ -f "$BRAIN_WRAPPER_DIR/fail-rm" ]; then
  rm "$BRAIN_WRAPPER_DIR/fail-rm"
  exit 72
fi
exec '${realDocker}' "$@"
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.BRAIN_WRAPPER_DIR = dir;
  try { await run(dir); }
  finally {
    process.env.PATH = originalPath;
    delete process.env.BRAIN_WRAPPER_DIR;
    delete process.env.BRAIN_WRAPPER_PROXY_PORT;
    await rm(dir, { recursive: true, force: true });
  }
}

it('removes a started cluster when port inspection fails while another fixture survives', async () => {
  await withDockerWrapper(async dir => {
    const survivor = await extHome();
    try {
      await writeFile(join(dir, 'fail-inspect'), '');
      await expect(createIsolatedTestDatabase()).rejects.toThrow();
      const ids = (await readFile(join(dir, 'ids'), 'utf8')).trim().split('\n');
      const failedId = ids.at(-1)!;
      expect(failedId).not.toBe(survivor.db.fixtureContainer!.id);
      expect(() => execFileSync('docker', ['inspect', failedId], { stdio: 'ignore' })).toThrow();
      expect(await survivor.db.rows('select 1 as value')).toEqual([{ value: 1 }]);
      console.log(`inspection failure removed ${failedId}; survivor ${survivor.db.fixtureContainer!.id} answered SQL`);
    } finally { await survivor.cleanup(); }
  });
});

it('retries a failed removal and shares concurrent cleanup', async () => {
  await withDockerWrapper(async dir => {
    const fixture = await extHome();
    const id = fixture.db.fixtureContainer!.id;
    try {
      await writeFile(join(dir, 'fail-rm'), '');
      await expect(fixture.cleanup()).rejects.toThrow();
      expect(execFileSync('docker', ['inspect', id], { encoding: 'utf8' })).toContain(id);
      const first = fixture.cleanup(), second = fixture.cleanup();
      expect(first).toBe(second);
      await Promise.all([first, second]);
      expect(() => execFileSync('docker', ['inspect', id], { stdio: 'ignore' })).toThrow();
      const calls = (await readFile(join(dir, 'calls'), 'utf8')).split('\n').filter(line => line === `rm -f ${id}`);
      expect(calls).toHaveLength(2);
      console.log(`removal retried and shared for ${id}: ${calls.length} attempts, container absent`);
    } finally { await fixture.cleanup(); }
  });
});

it('confirms exact owned ID is absent after a successful removal reports an error', async () => {
  await withDockerWrapper(async dir => {
    const fixture = await extHome(), survivor = await extHome(), id = fixture.db.fixtureContainer!.id;
    try {
      await writeFile(join(dir, 'fail-rm-after'), ''); await fixture.cleanup();
      const absent = spawnSync('docker', ['inspect', '--format', '{{.Id}}', id], { encoding: 'utf8' });
      expect(absent.status).toBe(1);
      expect(absent.stderr.trim().toLowerCase()).toBe(`error: no such object: ${id}`);
      console.log(`inspect confirmed ${absent.stderr.trim()}`);
      const calls = (await readFile(join(dir, 'calls'), 'utf8')).split('\n');
      expect(calls.filter(line => line === `rm -f ${id}`)).toHaveLength(1);
      expect(calls).toContain(`inspect --format {{.Id}} ${id}`);
      await expect(stat(fixture.home)).rejects.toThrow(); await fixture.cleanup();
      expect(await survivor.db.rows('select 1 as value')).toEqual([{ value: 1 }]);
      console.log(`confirmed removal of ${id}; survivor ${survivor.db.fixtureContainer!.id} answered SQL`);
    } finally { await fixture.cleanup(); await survivor.cleanup(); }
  });
});

it.each(['wrong-id', 'permission', 'daemon'])('preserves the removal error for %s inspection', async inspection => {
  await withDockerWrapper(async dir => {
    const fixture = await extHome(), id = fixture.db.fixtureContainer!.id;
    try {
      await writeFile(join(dir, 'fail-rm'), ''); await writeFile(join(dir, 'fake-absence'), inspection);
      await expect(fixture.cleanup()).rejects.toMatchObject({ code: 72 });
      expect(execFileSync('docker', ['inspect', id], { encoding: 'utf8' })).toContain(id);
      expect((await readFile(join(dir, 'calls'), 'utf8')).split('\n')).toContain(`inspect --format {{.Id}} ${id}`);
      await rm(join(dir, 'fake-absence')); await fixture.cleanup();
      expect(() => execFileSync('docker', ['inspect', id], { stdio: 'ignore' })).toThrow();
    } finally { await rm(join(dir, 'fake-absence'), { force: true }); await fixture.cleanup(); }
  });
});

it.each([false, true])('role SQL failure removes owned resources and retains removal failure=%s', async failRemoval => {
  await withDockerWrapper(async dir => {
    const fixture = await extHome(), survivor = await extHome(), id = fixture.db.fixtureContainer!.id;
    let queries = 0;
    fixture.db.rows = async () => { queries++; throw new Error('injected role SQL failure'); };
    try {
      if (failRemoval) await writeFile(join(dir, 'fail-rm'), '');
      const error = await fixture.cleanup().then(() => null, reason => reason);
      if (failRemoval) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toHaveLength(2);
        expect(String((error as AggregateError).errors[0])).toContain('injected role SQL failure');
        expect(String((error as AggregateError).errors[1])).toContain('docker');
        expect(execFileSync('docker', ['inspect', id], { encoding: 'utf8' })).toContain(id);
      } else {
        expect(String(error)).toContain('injected role SQL failure');
        expect(() => execFileSync('docker', ['inspect', id], { stdio: 'ignore' })).toThrow();
      }
      await expect(stat(fixture.home)).rejects.toThrow();
      expect(await survivor.db.rows('select 1 as value')).toEqual([{ value: 1 }]);
      await fixture.cleanup(); expect(queries).toBe(1);
      expect(() => execFileSync('docker', ['inspect', id], { stdio: 'ignore' })).toThrow();
      console.log(`role failure cleanup ${id}; survivor ${survivor.db.fixtureContainer!.id} answered SQL`);
    } finally { await fixture.cleanup(); await survivor.cleanup(); }
  });
});

it('waits for authenticated TCP query even when a socket accepts connections', async () => {
  await withDockerWrapper(async dir => {
    let forwarding = false, port = 0, accepted = 0;
    const server = createServer(socket => {
      accepted++;
      if (!forwarding) { socket.destroy(); return; }
      const upstream = connect(port, '127.0.0.1');
      socket.on('error', () => {}); upstream.on('error', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing proxy port');
    process.env.BRAIN_WRAPPER_PROXY_PORT = String(address.port);
    let settled = false;
    const creating = createIsolatedTestDatabase().finally(() => { settled = true; });
    let db: Awaited<typeof creating> | undefined;
    try {
      while (!accepted && !settled) await new Promise(resolve => setTimeout(resolve, 50));
      expect(accepted).toBeGreaterThan(0);
      expect(settled).toBe(false);
      const ports = JSON.parse(await readFile(join(dir, 'ports'), 'utf8'));
      port = Number(ports['5432/tcp'][0].HostPort);
      forwarding = true;
      db = await creating;
      expect(await db.rows('select 1 as value')).toEqual([{ value: 1 }]);
      console.log(`TCP readiness waited through ${accepted} proxy connections for ${db.fixtureContainer!.id}`);
    } finally {
      forwarding = true;
      if (!db) db = await creating.catch(() => undefined);
      if (db) await db.drop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

it('isolates simultaneous fixed extension roles and removes only each owned cluster', async () => {
  const created = await Promise.allSettled([extHome(), extHome()]);
  const fixtures = created.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  try {
    for (const result of created) if (result.status === 'rejected') throw result.reason;
    const [first, second] = fixtures;
    if (!first || !second) throw new Error('two fixtures required');
    const a = first.db.fixtureContainer!, b = second.db.fixtureContainer!;
    expect(a.id).not.toBe(b.id);
    expect(a.port).not.toBe(b.port);
    const installs = await Promise.all([first.run(['ext', 'install', 'testext', '--json']), second.run(['ext', 'install', 'testext', '--json'])]);
    for (const install of installs) expect(install.code, install.stdout + install.stderr).toBe(0);
    const password = async (home: string) => parseEnv(await readFile(join(home, '.env'), 'utf8')).BRAIN_EXT_TESTEXT_PASSWORD;
    expect(await password(first.home)).not.toBe(await password(second.home));
    for (const fixture of fixtures) {
      expect(await fixture.db.rows("select shobj_description(oid,'pg_authid') as marker from pg_roles where rolname='brain_ext_testext'"))
        .toEqual([{ marker: `second-brain extension:${new URL(fixture.db.url).pathname.slice(1)}` }]);
    }
    await first.cleanup();
    expect(() => execFileSync('docker', ['inspect', a.id], { stdio: 'ignore' })).toThrow();
    expect(await second.db.rows('select current_database() as name')).toEqual([{ name: new URL(second.db.url).pathname.slice(1) }]);
    expect((await second.run(['ext', 'status', 'testext', '--json'])).code).toBe(0);
    await second.cleanup();
    expect(() => execFileSync('docker', ['inspect', b.id], { stdio: 'ignore' })).toThrow();
  } finally {
    await Promise.all(fixtures.map(fixture => fixture.cleanup()));
  }
});
