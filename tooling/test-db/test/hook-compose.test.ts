import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { homeResources } from '../../../apps/cli/src/config/resources.js';
import { cleanupHookResources, parseHookResources } from '../src/slots/hook-compose.js';
import type { Docker } from '../src/slots/cluster.js';

it('validates recorded home identity and cleans exact Compose resources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-cleanup-')), home = join(dir, 'brain-hook-abcdef', 'home'), path = join(dir, 'hook-resources.jsonl');
  const { project, volume, port } = homeResources(home), item = { home, project, volume, port }, id = 'a'.repeat(64), calls: string[][] = [];
  const networkId = 'b'.repeat(64); let container = true, volumeExists = true, network = true;
  const absent = (name: string) => ({ code: 1, stderr: `Error: No such object: ${name}` });
  const missingVolume = { code: 1, stderr: `Error: No such volume: ${volume}` };
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: container ? id : '' };
    if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: id, Name: '/hook-container', Config: { Labels: { 'com.docker.compose.project': project } } }) };
    if (args[0] === 'rm') { container = false; return { stdout: '' }; }
    if (args[0] === 'inspect') throw absent(id);
    if (args[0] === 'volume' && args[1] === 'rm') { volumeExists = false; return { stdout: '' }; }
    if (args[0] === 'volume' && args[1] === 'inspect') { if (!volumeExists) throw missingVolume; return { stdout: JSON.stringify({ Name: volume, Labels: { 'com.docker.compose.project': project } }) }; }
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: network ? networkId : '' };
    if (args[0] === 'network' && args[1] === 'rm') { network = false; return { stdout: '' }; }
    if (args[0] === 'network' && args[1] === 'inspect') { if (!network) throw { code: 1, stderr: `Error: No such network: ${networkId}` }; return { stdout: JSON.stringify({ Id: networkId, Name: `${project}_default`, Labels: { 'com.docker.compose.project': project } }) }; }
    throw new Error('unexpected docker command');
  };
  try {
    await writeFile(path, JSON.stringify(item) + '\n');
    expect(parseHookResources(JSON.stringify(item), dir)).toEqual([item]);
    expect(() => parseHookResources(JSON.stringify({ ...item, volume: 'foreign' }), dir)).toThrow('identity');
    await cleanupHookResources(path, dir, run);
    expect(calls.map(args => args.slice(0, 2).join(' '))).toEqual(['ps -aq', 'inspect --format', 'rm -fv', 'inspect --format', 'ps -aq', 'volume inspect', 'volume rm', 'volume inspect', 'network ls', 'network inspect', 'network rm', 'network inspect', 'network ls']);
    expect(await cleanupHookResources(path, dir, run)).toHaveLength(1);
    const bad: Docker = async args => args[0] === 'ps' ? { stdout: '' } : Promise.reject(new Error('permission denied'));
    await expect(cleanupHookResources(path, dir, bad)).rejects.toThrow('permission denied');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('refuses to remove a network whose name or project label does not match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-network-')), home = join(dir, 'brain-hook-abcdef', 'home'), path = join(dir, 'hook-resources.jsonl');
  const { project, volume, port } = homeResources(home), networkId = 'c'.repeat(64), calls: string[][] = [];
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: '' };
    if (args[0] === 'volume') throw { code: 1, stderr: `Error: No such volume: ${volume}` };
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: networkId };
    if (args[0] === 'network' && args[1] === 'inspect') return { stdout: JSON.stringify({ Id: networkId, Name: 'foreign', Labels: { 'com.docker.compose.project': project } }) };
    throw new Error('unexpected');
  };
  try {
    await writeFile(path, JSON.stringify({ home, project, volume, port }) + '\n');
    await expect(cleanupHookResources(path, dir, run)).rejects.toThrow('network ownership mismatch');
    expect(calls.some(args => args[0] === 'network' && args[1] === 'rm')).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('attempts later hook records after an earlier cleanup error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-cleanup-errors-')), path = join(dir, 'hook-resources.jsonl');
  const homes = ['abcdef', 'ghijkl'].map(suffix => join(dir, `brain-hook-${suffix}`, 'home'));
  const records = homes.map(home => ({ home, ...homeResources(home) }));
  const calls: string[][] = [];
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps' && args.at(-1) === `label=com.docker.compose.project=${records[0]!.project}`) throw new Error('first unavailable');
    if (args[0] === 'ps' || (args[0] === 'network' && args[1] === 'ls')) return { stdout: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') throw { code: 1, stderr: `Error: No such volume: ${records[1]!.volume}` };
    throw new Error('unexpected');
  };
  try {
    await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await expect(cleanupHookResources(path, dir, run)).rejects.toThrow('first unavailable');
    expect(calls.some(args => args[0] === 'ps' && args.at(-1) === `label=com.docker.compose.project=${records[1]!.project}`)).toBe(true);
    expect(calls.some(args => args[0] === 'network' && args[1] === 'ls')).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it.each(['volume', 'container'] as const)('continues independent network cleanup after %s failure when usage is verified absent', async failure => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-independent-')), home = join(dir, 'brain-hook-abcdef', 'home'), path = join(dir, 'hook.jsonl');
  const { project, volume, port } = homeResources(home), container = 'a'.repeat(64), network = 'b'.repeat(64), calls: string[][] = [];
  let networkExists = true, volumeExists = true;
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: failure === 'container' ? container : '' };
    if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: container, Name: '/fixture', Config: { Labels: { 'com.docker.compose.project': project } } }) };
    if (args[0] === 'rm') throw new Error('container removal failed');
    if (args[0] === 'volume' && args[1] === 'inspect') { if (!volumeExists) throw { code: 1, stderr: `Error: No such volume: ${volume}` }; return { stdout: JSON.stringify({ Name: volume, Labels: { 'com.docker.compose.project': project }, UsageData: { RefCount: 0 } }) }; }
    if (args[0] === 'volume' && args[1] === 'rm') { if (failure === 'volume') throw new Error('volume removal failed'); volumeExists = false; return { stdout: '' }; }
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: networkExists ? network : '' };
    if (args[0] === 'network' && args[1] === 'inspect') { if (!networkExists) throw { code: 1, stderr: `Error: No such network: ${network}` }; return { stdout: JSON.stringify({ Id: network, Name: `${project}_default`, Labels: { 'com.docker.compose.project': project }, Containers: {} }) }; }
    if (args[0] === 'network' && args[1] === 'rm') { networkExists = false; return { stdout: '' }; }
    throw new Error('unexpected');
  };
  try {
    await writeFile(path, JSON.stringify({ home, project, volume, port }) + '\n');
    await expect(cleanupHookResources(path, dir, run)).rejects.toThrow(`${failure} removal failed`);
    expect(calls).toContainEqual(['network', 'rm', network]);
    if (failure === 'container') expect(calls).toContainEqual(['volume', 'rm', volume]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('preserves volume and network when remaining container usage is unknown or active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hook-busy-')), home = join(dir, 'brain-hook-abcdef', 'home'), path = join(dir, 'hook.jsonl');
  const { project, volume, port } = homeResources(home), container = 'a'.repeat(64), network = 'b'.repeat(64), calls: string[][] = [];
  const run: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: container };
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Id: container, Name: '/fixture', Config: { Labels: { 'com.docker.compose.project': project } } }) };
    if (args[0] === 'rm') throw new Error('busy');
    if (args[0] === 'volume') return { stdout: JSON.stringify({ Name: volume, Labels: { 'com.docker.compose.project': project }, UsageData: null }) };
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: network };
    if (args[0] === 'network' && args[1] === 'inspect') return { stdout: JSON.stringify({ Id: network, Name: `${project}_default`, Labels: { 'com.docker.compose.project': project }, Containers: { [container]: {} } }) };
    throw new Error('unexpected');
  };
  try {
    await writeFile(path, JSON.stringify({ home, project, volume, port }) + '\n');
    await expect(cleanupHookResources(path, dir, run)).rejects.toThrow('use unconfirmed');
    expect(calls.some(args => ['volume', 'network'].includes(args[0]!) && args[1] === 'rm')).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
