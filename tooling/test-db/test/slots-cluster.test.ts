import { describe, expect, it } from 'vitest';
import { checkClusterBoundary, createCluster, inspectPort, isNoSuchObject, recoverCluster, removeCluster, type Docker } from '../src/slots/cluster.js';
const id = 'a'.repeat(64);
const absent = (name: string) => ({ code: 1, stderr: `Error: No such object: ${name}` });
describe('slot cluster ownership', () => {
  it('rejects non-loopback, shared and invalid ports', () => {
    const port = (ip: string, p: string) => JSON.stringify({ '5432/tcp': [{ HostIp: ip, HostPort: p }] });
    expect(inspectPort(port('127.0.0.1', '32768'))).toBe  (32768);
    for (const [ip, p] of [['0.0.0.0', '32768'], ['127.0.0.1', '54329'], ['127.0.0.1', '54320']]) expect(() => inspectPort(port(ip!, p!))).toThrow();
  });
  it('recovers a lost create response only with matching name, labels and full ID', async () => {
    const calls: string[][] = [];
    const run: Docker = async args => { calls.push(args); if (args[0] === 'create') throw new Error('lost'); if (args[0] === 'inspect' && args.at(-1) === 'brain-slot-r-s-g') return { stdout: JSON.stringify({ Id: id, Name: '/brain-slot-r-s-g', Config: { Labels: { 'brain.test-run': 'r', 'brain.test-slot': 's' } } }) }; if (args[0] === 'rm') return { stdout: '' }; throw absent(id); };
    await expect(createCluster('r', 's', 'g', { docker: run })).rejects.toThrow('lost');
    expect(calls.some(c => c[0] === 'rm' && c[2] === id)).toBe(true);
    await expect(recoverCluster('n', 'r', 's', async () => ({ stdout: JSON.stringify({ Id: id, Name: '/n', Config: { Labels: {} } }) }))).rejects.toThrow('ownership');
  });
  it('distinguishes absence from transport and permission errors', async () => {
    expect(isNoSuchObject(absent(id), id)).toBe(true);
    expect(isNoSuchObject({ code: 1, stderr: 'permission denied' }, id)).toBe(false);
    await expect(removeCluster(id, async () => { throw new Error('transport'); })).rejects.toThrow('transport');
    await expect(removeCluster(id, async () => { throw absent(id); })).resolves.toBeUndefined();
  });
  it('detects databases, marker roles and other connections', async () => {
    const result = await checkClusterBoundary('', async sql => ({ rows: sql.includes('pg_database') ? [{ datname: 'leak' }] : sql.includes('pg_roles') ? [{ rolname: 'brain_ext_x' }] : [{ count: 1 }] }));
    expect(result).toEqual({ databases: ['leak'], roles: ['brain_ext_x'], connections: 1, clean: false });
  });
});

it('counts only other client backends at the boundary', async () => {
  const queries: string[] = [];
  const result = await checkClusterBoundary('', async sql => { queries.push(sql); return { rows: sql.includes('count(*)') ? [{ count: 0 }] : [] }; });
  expect(result.clean).toBe(true);
  expect(queries.find(sql => sql.includes('pg_stat_activity'))).toContain("backend_type = 'client backend'");
  expect(queries.find(sql => sql.includes('pg_stat_activity'))).toContain('pid <> pg_backend_pid()');
});

it('removes the exact created ID when starting a container fails', async () => {
  const calls: string[][] = [];
  const run: Docker = async args => { calls.push(args); if (args[0] === 'create') return { stdout: id }; if (args[0] === 'start') throw new Error('start failed'); if (args[0] === 'rm') return { stdout: '' }; throw absent(id); };
  await expect(createCluster('r', 's', 'g', { docker: run })).rejects.toThrow('start failed');
  expect(calls).toContainEqual(['rm', '-fv', id]);
  expect(calls.find(args => args[0] === 'create')).toContain('--tmpfs');
});
it('propagates a boundary query failure', async () => {
  await expect(checkClusterBoundary('', async () => { throw new Error('query failed'); })).rejects.toThrow('query failed');
});
it('preserves the last authentication error code without its message', async () => {
  const { waitForAuthentication } = await import('../src/slots/cluster.js');
  let now = 0, tries = 0;
  const error = await waitForAuthentication('postgres://private', 3, {
    now: () => now, sleep: async () => { now++; },
    probe: async () => { tries++; throw Object.assign(new Error('SECRET token and SQL'), { code: tries === 3 ? 'ECONNRESET' : 'ECONNREFUSED' }); },
  }).then(() => undefined, reason => reason);
  expect(error.code).toBe('ECONNRESET'); expect(error.message).not.toContain('SECRET'); expect(tries).toBe(3);
});
it('diagnoses an owned slot start failure before cleanup and retains the original error', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'slot-start-diagnostic-')), log = join(dir, 'events'), old = process.env.BRAIN_TEST_METRICS_LOG, calls: string[][] = [];
  process.env.BRAIN_TEST_METRICS_LOG = log;
  const failure = Object.assign(new Error('synthetic start failure'), { code: 'ECONNRESET' });
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'create') return { stdout: id };
    if (args[0] === 'start') throw failure;
    if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: id, Name: '/brain-slot-r-s-g', Config: { Labels: { 'brain.test-run': 'r', 'brain.test-slot': 's' } }, State: { Status: 'created', Running: false, ExitCode: 0 } }) };
    if (args[0] === 'logs') return { stdout: 'FATAL: synthetic secret token\n' };
    if (args[0] === 'rm') return { stdout: '' };
    throw absent(id);
  };
  try {
    const caught = await createCluster('r', 's', 'g', { docker: run }).then(() => undefined, reason => reason);
    expect(caught).toBe(failure);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { fixtureId: string; phase: string; errorCode: string; diagnostic?: unknown });
    const diagnostic = events.find(event => event.phase === 'readiness-diagnostic');
    expect(diagnostic?.errorCode).toBe('ECONNRESET'); expect(JSON.stringify(diagnostic)).not.toMatch(/secret|token/i);
    expect(new Set(events.map(event => event.fixtureId)).size).toBe(1);
    expect(calls.findIndex(args => args[0] === 'logs')).toBeLessThan(calls.findIndex(args => args[0] === 'rm'));
  } finally { if (old === undefined) delete process.env.BRAIN_TEST_METRICS_LOG; else process.env.BRAIN_TEST_METRICS_LOG = old; await rm(dir, { recursive: true, force: true }); }
});
it('diagnoses a slot removal failure before returning the original error', async () => {
  const { removeOwnedCluster } = await import('../src/slots/cluster.js');
  const { FixtureTelemetry } = await import('../src/fixture-observability.js');
  const events: { phase: string; diagnostic?: unknown }[] = [], calls: string[][] = [];
  const telemetry = new FixtureTelemetry('shared', event => events.push(event)), failure = new Error('synthetic removal failure');
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Id: id, Name: '/brain-slot-r-s-g', Config: { Labels: { 'brain.test-run': 'r', 'brain.test-slot': 's' } }, State: { Status: 'running', Running: true, ExitCode: 0 }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '32111' }] } } }) };
    if (args[0] === 'logs') return { stdout: 'ERROR: token=SECRET\n' };
    if (args[0] === 'rm') throw failure;
    throw new Error('unexpected');
  };
  const caught = await removeOwnedCluster({ id, name: 'brain-slot-r-s-g', runId: 'r', slotId: 's', port: 32111, url: 'postgres://unused', telemetry }, run, async () => []).then(() => undefined, error => error);
  expect(caught).toBe(failure);
  expect(events.map(event => event.phase)).toEqual(['pre-drop-diagnostic', 'container-drop', 'readiness-diagnostic']);
  expect(calls.filter(args => args[0] === 'logs')).toHaveLength(2);
  expect(JSON.stringify(events)).not.toMatch(/token|SECRET|postgres:/i);
});
