import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { docker, removeCluster, type Docker } from './cluster.js';
import { assertUnprotected } from './protected.js';

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
/** Read-only proof that all recorded hook resources have already disappeared. */
export async function hookResourcesAbsent(path: string, fileDir: string, run: Docker = docker): Promise<boolean> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  for (const item of parseHookResources(text, fileDir)) {
    if ((await run(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`])).stdout.trim()) return false;
    try { await run(['volume', 'inspect', item.volume]); return false; } catch (error) { if (!noVolume(error, item.volume)) throw error; }
    if ((await run(['network', 'ls', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`, '-q'])).stdout.trim()) return false;
  }
  return true;
}
export async function cleanupHookResources(path: string, fileDir: string, run: Docker = docker): Promise<unknown[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = parseHookResources(text, fileDir), results: unknown[] = [], errors: unknown[] = [];
  for (const item of records) {
    const list = async () => {
      const ids = (await run(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`])).stdout.split(/\s+/).filter(Boolean);
      if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid hook container ID');
      return ids;
    };
    const removed: string[] = []; let containersAbsent = false;
    try {
      const ids = await list();
      for (const id of ids) try {
        const info = JSON.parse((await run(['inspect', '--format', '{{json .}}', id])).stdout) as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
        assertUnprotected(info.Name, info.Config?.Labels);
        if (info.Id !== id || typeof info.Name !== 'string' || !info.Name.replace(/^\//, '') || info.Config?.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook container ownership mismatch');
        await removeCluster(id, run); removed.push(id);
      } catch (error) { errors.push(error); }
      containersAbsent = (await list()).length === 0;
      if (!containersAbsent) errors.push(new Error('hook containers remain'));
    } catch (error) { errors.push(error); }
    try {
      let volumeExists = true;
      try {
        const info = JSON.parse((await run(['volume', 'inspect', '--format', '{{json .}}', item.volume])).stdout) as { Name?: string; Labels?: Record<string, string>; UsageData?: { RefCount?: number } | null };
        assertUnprotected(info.Name, info.Labels);
        if (info.Name !== item.volume || info.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook volume ownership mismatch');
        if (!containersAbsent && info.UsageData?.RefCount !== 0) throw new Error('hook volume use unconfirmed');
      } catch (error) { if (noVolume(error, item.volume)) volumeExists = false; else throw error; }
      if (volumeExists) try { await run(['volume', 'rm', item.volume]); } catch (error) { if (!noVolume(error, item.volume)) throw error; }
      try { await run(['volume', 'inspect', item.volume]); throw new Error(`hook volume remains: ${item.volume}`); } catch (error) { if (!noVolume(error, item.volume)) throw error; }
    } catch (error) { errors.push(error); }
    const networksRemoved: string[] = [];
    try {
      const listNetworks = async () => {
        const ids = (await run(['network', 'ls', '--no-trunc', '--filter', `label=com.docker.compose.project=${item.project}`, '-q'])).stdout.split(/\s+/).filter(Boolean);
        if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid hook network ID');
        return ids;
      };
      for (const id of await listNetworks()) try {
        let info: { Id?: string; Name?: string; Labels?: Record<string, string>; Containers?: Record<string, unknown> | null };
        try { info = JSON.parse((await run(['network', 'inspect', '--format', '{{json .}}', id])).stdout) as typeof info; }
        catch (error) { if (noNetwork(error, id)) continue; throw error; }
        assertUnprotected(info.Name, info.Labels);
        if (info.Id !== id || info.Name !== `${item.project}_default` || info.Labels?.['com.docker.compose.project'] !== item.project) throw new Error('hook network ownership mismatch');
        if (!containersAbsent && (!info.Containers || Object.keys(info.Containers).length !== 0)) throw new Error('hook network use unconfirmed');
        try { await run(['network', 'rm', id]); } catch (error) { if (!noNetwork(error, id)) throw error; }
        try { await run(['network', 'inspect', id]); } catch (error) { if (noNetwork(error, id)) { networksRemoved.push(id); continue; } throw error; }
        throw new Error(`hook network remains: ${id}`);
      } catch (error) { errors.push(error); }
      if ((await listNetworks()).length) errors.push(new Error('hook networks remain'));
    } catch (error) { errors.push(error); }
    results.push({ ...item, containersRemoved: removed, networksRemoved });
  }
  if (errors.length) throw new AggregateError(errors, `hook resource cleanup failed: ${errors.map(String).join('; ')}`);
  return results;
}
