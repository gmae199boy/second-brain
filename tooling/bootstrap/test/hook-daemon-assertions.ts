import { strict as assert } from 'node:assert';
import { maskOutputValue } from '../../../packages/core/src/output/mask.js';

export interface DaemonIdentity { pid: number | null; commit: string | null; }
export function assertDaemonIdentity(raw: DaemonIdentity, status: DaemonIdentity & {alive:boolean}, spawnedPid: number, installed: string | null, snapshot: string, processAlive: boolean): void {
  assert.equal(processAlive, true, 'spawned daemon must still be alive');
  assert.equal(status.alive, true);
  assert.equal(raw.pid, spawnedPid, 'daemon.pid must identify the spawned process');
  assert.equal(status.pid, spawnedPid, 'status must identify the spawned process');
  assert.equal(installed, snapshot, 'installed commit must equal the snapshot');
  assert.equal(raw.commit, snapshot, 'daemon.pid must contain the full snapshot commit');
  assert.equal(status.commit, maskOutputValue(snapshot), 'status must contain the public codec value');
}
