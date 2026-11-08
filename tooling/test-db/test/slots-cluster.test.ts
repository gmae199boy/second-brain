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
  expect(calls.some(args => args[0] === 'rm' && args[2] === id)).toBe(true);
});
it('propagates a boundary query failure', async () => {
  await expect(checkClusterBoundary('', async () => { throw new Error('query failed'); })).rejects.toThrow('query failed');
});
