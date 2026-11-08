import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { docker, removeCluster, type Docker } from './cluster.js';

export interface HookResource { home: string; project: string; volume: string; port: number }
export function parseHookResources(contents: string, fileDir: string): HookResource[] {
  return contents.split('\n').filter(Boolean).map(line => {
    const item = JSON.parse(line) as HookResource;
    if (!item || typeof item.home !== 'string' || !isAbsolute(item.home) || resolve(item.home) !== item.home || basename(item.home) !== 'home' || dirname(dirname(item.home)) !== resolve(fileDir) || !/^brain-hook-[a-zA-Z0-9]+$/.test(basename(dirname(item.home)))) throw new Error('invalid hook home');
    const hash = createHash('sha256').update(item.home).digest('hex'), suffix = hash.slice(0, 12);
    if (item.project !== `second-brain-${suffix}` || item.volume !== `second-brain-pg-${suffix}` || item.port !== 20000 + parseInt(hash.slice(0, 8), 16) % 30000) throw new Error('hook resource identity mismatch');
    return item;
  });
}
const noVolume = (error: unknown, name: string) => {
  const e = error as { code?: number; stderr?: string }, message = (e.stderr ?? '').trim().toLowerCase();
  return e.code === 1 && (message === `error response from daemon: get ${name}: no such volume` || message === `error response from daemon: remove ${name}: no such volume` || message === `error: no such volume: ${name}` || message === `error response from daemon: no such volume: ${name}`);
};
const noNetwork = (error: unknown, id: string) => {
  const e = error as { code?: number; stderr?: string }, message = (e.stderr ?? '').trim().toLowerCase();
  return e.code === 1 && (message === `error: no such network: ${id}` || message === `error response from daemon: no such network: ${id}` || message === `error response from daemon: network ${id} not found`);
};
export async function cleanupHookResources(path: string, fileDir: string, run: Docker = docker): Promise<unknown[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = parseHookResources(text, fileDir), results: unknown[] = [];
  for (const item of records) {
    const list = async () => {
      const ids = (await run(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`])).stdout.split(/\s+/).filter(Boolean);
      if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid hook container ID');
      return ids;
    };
    const ids = await list();
    for (const id of ids) {
      const info = JSON.parse((await run(['inspect', '--format', '{{json .}}', id])).stdout) as { Id?: string; Config?: { Labels?: Record<string, string> } };
      if (info.Id !== id || info.Config?.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook container ownership mismatch');
      await removeCluster(id, run);
    }
    if ((await list()).length) throw new Error('hook containers remain');
    let volumeExists = true;
    try {
      const info = JSON.parse((await run(['volume', 'inspect', '--format', '{{json .}}', item.volume])).stdout) as { Name?: string; Labels?: Record<string, string> };
      if (info.Name !== item.volume || info.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook volume ownership mismatch');
    } catch (error) { if (noVolume(error, item.volume)) volumeExists = false; else throw error; }
    if (volumeExists) try { await run(['volume', 'rm', item.volume]); } catch (error) { if (!noVolume(error, item.volume)) throw error; }
    try { await run(['volume', 'inspect', item.volume]); throw new Error(`hook volume remains: ${item.volume}`); } catch (error) { if (!noVolume(error, item.volume)) throw error; }
    const listNetworks = async () => {
      const networks = (await run(['network', 'ls', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`, '-q'])).stdout.split(/\s+/).filter(Boolean);
      if (networks.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid hook network ID');
      return networks;
    };
    const networks = await listNetworks();
    for (const id of networks) {
      let info: { Id?: string; Name?: string; Labels?: Record<string, string> };
      try { info = JSON.parse((await run(['network', 'inspect', '--format', '{{json .}}', id])).stdout) as typeof info; }
      catch (error) { if (noNetwork(error, id)) continue; throw error; }
      if (info.Id !== id || info.Name !== `${item.project}_default` || info.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook network ownership mismatch');
      try { await run(['network', 'rm', id]); } catch (error) { if (!noNetwork(error, id)) throw error; }
      try { await run(['network', 'inspect', id]); } catch (error) { if (noNetwork(error, id)) continue; throw error; }
      throw new Error(`hook network remains: ${id}`);
    }
    if ((await listNetworks()).length) throw new Error('hook networks remain');
    results.push({ ...item, containersRemoved: ids, volume: 'absent', networksRemoved: networks });
  }
  return results;
}
