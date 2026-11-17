import { expect, it } from 'vitest';
import { FixtureTelemetry, inspectOwnedFixture, inspectOwnedSlot, safeErrorCode, type FixtureEvent } from '../src/fixture-observability.js';

const id = 'a'.repeat(64), nonce = 'b'.repeat(24), name = `brain-fixture-${nonce}`, runId = 'c'.repeat(24), fileId = 'd'.repeat(20), port = 32111;
const info = (labels: Record<string, string>, containerName = name) => JSON.stringify({ Id: id, Name: `/${containerName}`, Config: { Labels: labels }, State: { Status: 'running', Running: true, ExitCode: 0, Error: 'SECRET_TOKEN' }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } } });
const labels = { 'brain.fixture': nonce, 'brain.test-run': runId, 'brain.test-file': fileId };

it('records safe fixture identity, timestamps, durations and codes for shared and isolated phases', async () => {
  const events: FixtureEvent[] = [], old = { run: process.env.BRAIN_TEST_RUN_ID, file: process.env.BRAIN_TEST_FILE_ID, test: process.env.BRAIN_TEST_CASE_ID };
  try {
    process.env.BRAIN_TEST_RUN_ID = runId; process.env.BRAIN_TEST_FILE_ID = fileId; process.env.BRAIN_TEST_CASE_ID = 'e'.repeat(20);
    const shared = new FixtureTelemetry('shared', event => events.push(event));
    const isolated = new FixtureTelemetry('isolated', event => events.push(event));
    await shared.measure('sql-ready', async () => {});
    await shared.measure('database-create', async () => {});
    await shared.measure('database-drop', async () => {});
    await isolated.measure('container-create', async () => {});
    await isolated.measure('container-start', async () => {});
    await expect(isolated.measure('sql-ready', async () => { throw Object.assign(new Error('postgres://user:secret@host/db token=SECRET_TOKEN select private'), { code: 'ECONNREFUSED' }); })).rejects.toThrow();
    await isolated.measure('container-drop', async () => {});
    expect(events.map(event => event.phase)).toEqual(['sql-ready', 'database-create', 'database-drop', 'container-create', 'container-start', 'sql-ready', 'container-drop']);
    for (const event of events) {
      expect(event).toMatchObject({ runId, fileId, testId: 'e'.repeat(20), pid: process.pid });
      expect(Date.parse(event.utc)).not.toBeNaN(); expect(event.monotonicMs).toBeGreaterThanOrEqual(0); expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(events[5]).toMatchObject({ outcome: 'error', errorCode: 'ECONNREFUSED' });
    expect(JSON.stringify(events)).not.toMatch(/secret|TOKEN|postgres:|select private/i);
    expect(safeErrorCode({ code: '28000' })).toBe('28000'); expect(safeErrorCode({ code: 'TOKEN' })).toBeNull();
  } finally {
    for (const [key, value] of Object.entries({ BRAIN_TEST_RUN_ID: old.run, BRAIN_TEST_FILE_ID: old.file, BRAIN_TEST_CASE_ID: old.test })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
it('never lets a broken telemetry sink prevent setup or cleanup', async () => {
  const telemetry = new FixtureTelemetry('isolated', () => { throw new Error('disk full'); }), steps: string[] = [];
  await telemetry.measure('container-create', async () => { steps.push('create'); });
  await telemetry.measure('container-drop', async () => { steps.push('drop'); });
  await expect(telemetry.measure('database-drop', async () => { throw new Error('original failure'); })).rejects.toThrow('original failure');
  expect(steps).toEqual(['create', 'drop']);
});
it('collects only allowlisted state, severity counts and aggregate waits from the owned fixture', async () => {
  const calls: string[][] = [];
  const result = await inspectOwnedFixture({ id, name, nonce, runId, fileId, port,
    docker: async args => { calls.push(args); return { stdout: args[0] === 'inspect' ? info(labels) : 'FATAL: password=SECRET_TOKEN postgres://user:secret@host\nLOG: select private from user_data\n' }; },
    activity: async () => [{ type: 'Lock', count: 3, query: 'select private' }, { type: null, count: 2 }, { type: 'SECRET_TOKEN', count: 1 }],
  });
  expect(result).toEqual({ errors: [], state: { status: 'running', running: true, exitCode: 0 }, logSeverityCounts: { FATAL: 1, LOG: 1 }, connections: 6, waits: [{ type: 'Lock', count: 3 }] });
  expect(calls).toContainEqual(['logs', '--tail', '50', id]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|password|postgres:|user_data|select private/i);
});
it('refuses logs and activity when ownership, label or port is mismatched', async () => {
  for (const inspect of [info({ ...labels, 'brain.test-file': 'other' }), info(labels, 'second-brain-postgres-1'), info(labels).replace(String(port), '54320')]) {
    const calls: string[][] = []; let queried = false;
    const result = await inspectOwnedFixture({ id, name, nonce, runId, fileId, port, docker: async args => { calls.push(args); return { stdout: inspect }; }, activity: async () => { queried = true; return []; } });
    expect(result.errors).toEqual(['ownership-mismatch']); expect(calls).toHaveLength(1); expect(queried).toBe(false);
  }
});
it('verifies the owned shared slot before reading bounded diagnostics', async () => {
  const slot = 'slot1', calls: string[][] = [];
  const result = await inspectOwnedSlot({ id, runId, slotId: slot, port,
    docker: async args => { calls.push(args); return { stdout: args[0] === 'inspect' ? info({ 'brain.test-run': runId, 'brain.test-slot': slot }, `brain-slot-${runId}-${slot}-0`) : 'LOG: synthetic secret' }; },
    activity: async () => [{ type: 'IO', count: 2 }],
  });
  expect(result).toMatchObject({ connections: 2, waits: [{ type: 'IO', count: 2 }] });
  expect(calls.map(args => args[0])).toEqual(['inspect', 'logs']);
  const bad = await inspectOwnedSlot({ id, runId, slotId: slot, port, docker: async () => ({ stdout: info({ 'brain.test-run': runId, 'brain.test-slot': slot }, 'second-brain-postgres-1') }), activity: async () => { throw new Error('must not query'); } });
  expect(bad.errors).toEqual(['ownership-mismatch']);
});
it('reports diagnostic collection failures without exposing errors or stopping later collections', async () => {
  const result = await inspectOwnedFixture({ id, name, nonce, runId, fileId, port,
    docker: async args => { if (args[0] === 'inspect') return { stdout: info(labels) }; throw new Error('SECRET_TOKEN'); },
    activity: async () => { throw new Error('postgres://secret'); },
  });
  expect(result.errors).toEqual(['logs-unavailable', 'activity-unavailable']); expect(JSON.stringify(result)).not.toMatch(/SECRET|postgres:/);
});

it('never inspects or connects to a protected shared port', async () => {
  for (const forbidden of [54320, 54329]) {
    let contacted = false;
    const result = await inspectOwnedFixture({ id, name, nonce, runId, fileId, port: forbidden, docker: async () => { contacted = true; throw new Error('must not inspect'); }, activity: async () => { contacted = true; return []; } });
    expect(result.errors).toEqual(['invalid-identity']); expect(contacted).toBe(false);
  }
});
it('diagnoses still-owned fixtures only for a failing test and unregisters after cleanup', async () => {
  const { diagnoseTestFailure, registerFixtureDiagnostic, setFailureProbe } = await import('../src/fixture-observability.js');
  const phases: string[] = [], unregister = registerFixtureDiagnostic(async phase => { phases.push(phase); });
  try {
    setFailureProbe(() => false); await diagnoseTestFailure(); expect(phases).toEqual([]);
    setFailureProbe(() => true); await diagnoseTestFailure(); expect(phases).toEqual(['test-failure-diagnostic']);
    unregister(); await diagnoseTestFailure(); expect(phases).toEqual(['test-failure-diagnostic']);
  } finally { unregister(); setFailureProbe(); }
});

it('produces only validated, non-secret shared database ownership metadata', async () => {
  const { sharedDatabaseOwner } = await import('../src/index.js');
  const database = 'brain_test_123456abcdef', fixtureId = 'e'.repeat(24);
  expect(sharedDatabaseOwner(database, fixtureId, { BRAIN_TEST_RUN_ID: runId, BRAIN_TEST_FILE_ID: fileId, SECRET: 'hidden' })).toEqual({ runId, fileId, fixtureId, database });
  expect(sharedDatabaseOwner(database, fixtureId, { BRAIN_TEST_RUN_ID: "bad'", BRAIN_TEST_FILE_ID: fileId })).toBeUndefined();
  expect(sharedDatabaseOwner('postgres', fixtureId, { BRAIN_TEST_RUN_ID: runId, BRAIN_TEST_FILE_ID: fileId })).toBeUndefined();
});
