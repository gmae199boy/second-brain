import { readFile } from 'node:fs/promises';
import { docker, inspectPort, type Docker } from './cluster.js';
import type { TestDatabase } from '../index.js';

export interface SlotLease { runId: string; slotId: string; fileId: string; url: string; containerId: string; port: number }
export interface LeaseDependencies {
  docker?: Docker;
  read?: (path: string) => Promise<string>;
  boundary: (url: string) => Promise<{ clean: boolean }>;
  create: (url: string) => Promise<TestDatabase>;
  isolated: () => Promise<TestDatabase>;
}
const occupied = new Set<string>();
export async function validateSlotLease(path: string, options: { docker?: Docker; read?: (path: string) => Promise<string> } = {}): Promise<SlotLease> {
  const value: unknown = JSON.parse(await (options.read ?? (p => readFile(p, 'utf8')))(path));
  if (!value || typeof value !== 'object') throw new Error('invalid slot lease');
  const lease = value as SlotLease;
  if (![lease.runId, lease.slotId, lease.fileId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v)) || typeof lease.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(lease.containerId) || !Number.isInteger(lease.port) || lease.port < 1 || lease.port > 65535 || [54329, 54320].includes(lease.port) || typeof lease.url !== 'string') throw new Error('invalid slot lease fields');
  let url: URL;
  try { url = new URL(lease.url); } catch { throw new Error('invalid slot lease URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || Number(url.port) !== lease.port || url.pathname !== '/postgres' || !url.username || !url.password || url.search || url.hash) throw new Error('invalid slot lease URL');
  const result = await (options.docker ?? docker)(['inspect', '--format', '{{json .}}', lease.containerId]);
  const container = JSON.parse(result.stdout) as { Id: string; Config?: { Labels?: Record<string, string> }; NetworkSettings?: { Ports?: unknown } };
  if (container.Id !== lease.containerId || container.Config?.Labels?.['brain.test-run'] !== lease.runId || container.Config?.Labels?.['brain.test-slot'] !== lease.slotId || inspectPort(JSON.stringify(container.NetworkSettings?.Ports)) !== lease.port) throw new Error('slot lease ownership mismatch');
  return lease;
}
export async function acquireSlotDatabase(path: string | undefined, deps: LeaseDependencies): Promise<TestDatabase> {
  if (!path) return deps.isolated();
  const lease = await validateSlotLease(path, deps);
  if (occupied.has(lease.containerId)) return deps.isolated();
  occupied.add(lease.containerId);
  let db: TestDatabase;
  try {
    if (!(await deps.boundary(lease.url)).clean) { occupied.delete(lease.containerId); return deps.isolated(); }
    db = await deps.create(lease.url);
  } catch (error) { occupied.delete(lease.containerId); throw error; }
  let dropped = false;
  return { ...db, get fixtureDatabaseDropped() { return dropped; }, get fixtureContainerRemoved() { return undefined; }, async drop() {
    if (dropped) return;
    await db.drop();
    dropped = true;
    occupied.delete(lease.containerId);
  } };
}
