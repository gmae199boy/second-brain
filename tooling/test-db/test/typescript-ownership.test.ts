import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recoverRuns } from '../src/python-slots.js';
import { writeLedger } from '../src/slots/ledger.js';
import { cleanupHookResources } from '../src/slots/hook-compose.js';
import { homeResources } from '../../../apps/cli/src/config/resources.js';

const id = 'a'.repeat(64), fileId = 'b'.repeat(20), nonce = 'c'.repeat(24), name = `brain-fixture-${nonce}`;
async function fixture(root: string) {
  const base = join(root, '.brain-test-runs', 'run'), file = join(base, fileId);
  await mkdir(join(base, 'files'), { recursive: true }); await mkdir(file);
  await writeLedger(root, { runId: 'run', kind: 'typescript', state: 'running', coordinator: { pid: 10, started: 'owner' }, slots: [], files: [], resources: [], cleanup: [] });
  await writeFile(join(base, 'files', `${fileId}.json`), JSON.stringify({ fileId, worker: { pid: 11, started: 'worker' } }));
  await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"sealed"}\n');
  await writeFile(join(file, 'resources.jsonl'), JSON.stringify({ fixturePostgres: 'created', name, id }) + '\n');
  return file;
}
function dockerMock(info: { Name?: string; Labels?: Record<string, string> } = {}) {
  const calls: string[][] = []; let present = true;
  const labels = info.Labels ?? { 'brain.test-run': 'run', 'brain.test-file': fileId, 'brain.fixture': nonce };
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return { stdout: present ? id : '' };
    if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: id, Name: info.Name ?? `/${name}`, Config: { Labels: labels } }) };
    if (args[0] === 'rm') { present = false; return { stdout: '' }; }
    if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${id}` };
    throw new Error('unexpected Docker command');
  };
  return { run, calls };
}
it('recovers a dead owner and dead worker only when file journal and fixture labels agree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-owner-'));
  try {
    await fixture(root); const { run, calls } = dockerMock();
    const events = await recoverRuns(root, run, async () => null);
    expect(calls.some(args => args[0] === 'rm' && args.at(-1) === id)).toBe(true);
    expect(JSON.stringify(events)).toContain(id);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('quarantines live or unknown owners and live workers without Docker operations', async () => {
  for (const lookup of [async () => 'owner', async () => { throw new Error('unavailable'); }, async (pid: number) => pid === 10 ? null : 'worker']) {
    const root = await mkdtemp(join(tmpdir(), 'ts-live-'));
    try { await fixture(root); const { run, calls } = dockerMock(); const events = await recoverRuns(root, run, lookup); expect(calls).toEqual([]); expect(JSON.stringify(events)).toMatch(/alive|unknown|unconfirmed/); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
it('quarantines mismatched file labels and protected operational containers', async () => {
  for (const info of [
    { Labels: { 'brain.test-run': 'run', 'brain.test-file': 'other', 'brain.fixture': nonce } },
    { Name: '/second-brain-postgres-1' },
    { Labels: { 'brain.test-run': 'run', 'brain.test-file': fileId, 'brain.fixture': nonce, 'com.docker.compose.project': 'sjtech' } },
    { Labels: { 'brain.test-run': 'run', 'brain.test-file': fileId, 'brain.fixture': nonce, 'com.docker.compose.project': 'second-brain' } },
  ] as { Name?: string; Labels?: Record<string, string> }[]) {
    const root = await mkdtemp(join(tmpdir(), 'ts-protected-'));
    try { await fixture(root); const { run, calls } = dockerMock(info); const events = await recoverRuns(root, run, async () => null); expect(calls.some(args => args[0] === 'rm')).toBe(false); expect(JSON.stringify(events)).toContain('error'); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
it('refuses forged hook records and protected container, volume and network identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-hook-')), home = join(root, 'brain-hook-abcdef', 'home'), path = join(root, 'hook.jsonl');
  const { project, volume, port } = homeResources(home); const network = 'd'.repeat(64);
  try {
    await writeFile(path, JSON.stringify({ home, project: 'sjtech', volume: 'sjtech-db', port }) + '\n');
    await expect(cleanupHookResources(path, root, async () => { throw new Error('Docker must not be called'); })).rejects.toThrow('identity');
    await writeFile(path, JSON.stringify({ home, project, volume, port }) + '\n');
    for (const target of ['container', 'volume', 'network']) {
      const calls: string[][] = [];
      const run = async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'ps') return { stdout: target === 'container' ? id : '' };
        if (args[0] === 'inspect') return { stdout: JSON.stringify({ Id: id, Name: '/second-brain-postgres-1', Config: { Labels: { 'com.docker.compose.project': project } } }) };
        if (args[0] === 'volume' && target === 'volume') return { stdout: JSON.stringify({ Name: 'second-brain-pg', Labels: { 'com.docker.compose.project': project } }) };
        if (args[0] === 'volume') throw { code: 1, stderr: `Error: No such volume: ${volume}` };
        if (args[0] === 'network' && args[1] === 'ls') return { stdout: network };
        if (args[0] === 'network' && args[1] === 'inspect') return { stdout: JSON.stringify({ Id: network, Name: 'sjtech-db', Labels: { 'com.docker.compose.project': project } }) };
        throw new Error('unexpected');
      };
      await expect(cleanupHookResources(path, root, run)).rejects.toThrow('protected');
      expect(calls.some(args => args[0] === 'rm' || args[1] === 'rm')).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('recovers a hook compose container, volume and network from the file journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-hook-recovery-'));
  try {
    const file = await fixture(root), home = join(file, 'brain-hook-abcdef', 'home');
    const { project, volume, port } = homeResources(home), network = 'd'.repeat(64), calls: string[][] = [];
    await writeFile(join(file, 'resources.jsonl'), '');
    await writeFile(join(file, 'hook-resources.jsonl'), JSON.stringify({ home, project, volume, port }) + '\n');
    let container = true, volumeExists = true, networkExists = true;
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: args.some(arg => arg.startsWith('label=com.docker.compose.project=')) && container ? id : '' };
      if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: id, Name: '/test-hook', Config: { Labels: { 'com.docker.compose.project': project } } }) };
      if (args[0] === 'rm') { container = false; return { stdout: '' }; }
      if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${id}` };
      if (args[0] === 'volume' && args[1] === 'rm') { volumeExists = false; return { stdout: '' }; }
      if (args[0] === 'volume') { if (!volumeExists) throw { code: 1, stderr: `Error: No such volume: ${volume}` }; return { stdout: JSON.stringify({ Name: volume, Labels: { 'com.docker.compose.project': project } }) }; }
      if (args[0] === 'network' && args[1] === 'ls') return { stdout: networkExists ? network : '' };
      if (args[0] === 'network' && args[1] === 'rm') { networkExists = false; return { stdout: '' }; }
      if (args[0] === 'network' && args[1] === 'inspect') { if (!networkExists) throw { code: 1, stderr: `Error: No such network: ${network}` }; return { stdout: JSON.stringify({ Id: network, Name: `${project}_default`, Labels: { 'com.docker.compose.project': project } }) }; }
      throw new Error('unexpected');
    };
    const events = await recoverRuns(root, run, async () => null);
    expect(JSON.stringify(events)).toContain('hookCleanup');
    expect(calls.some(args => args[0] === 'rm' && args.at(-1) === id)).toBe(true);
    expect(calls).toContainEqual(['volume', 'rm', volume]);
    expect(calls).toContainEqual(['network', 'rm', network]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('quarantines fixtures when a test process group lacks a confirmed termination record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-process-quarantine-'));
  try {
    const file = await fixture(root), token = 'f'.repeat(24);
    await writeFile(join(file, 'processes.jsonl'), JSON.stringify({ token, pid: 1234, state: 'active' }) + '\n');
    const { run, calls } = dockerMock();
    const events = await recoverRuns(root, run, async () => null, undefined, undefined, async () => [{ pid: 1234, ppid: 1, pgid: 1234, started: 'time', cpu: 0, time: '0' }]);
    expect(calls.some(args => args[0] === 'rm')).toBe(false); expect(JSON.stringify(events)).toContain('child process termination unconfirmed');
    await writeFile(join(file, 'processes.jsonl'), JSON.stringify({ token, pid: 1234, state: 'active' }) + '\n' + JSON.stringify({ token, pid: 1234, state: 'gone' }) + '\n');
    await recoverRuns(root, run, async () => null);
    expect(calls.some(args => args[0] === 'rm')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('continues other recorded container cleanup when one container removal fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-cleanup-errors-')), second = 'e'.repeat(64), calls: string[][] = [];
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'resources.jsonl'), [id, second].map(value => JSON.stringify({ fixturePostgres: 'created', name, id: value })).join('\n') + '\n');
    const present = new Set([id, second]);
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: [...present].join('\n') };
      if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: args.at(-1), Name: `/${name}`, Config: { Labels: { 'brain.test-run': 'run', 'brain.test-file': fileId, 'brain.fixture': nonce } } }) };
      if (args[0] === 'rm' && args.at(-1) === id) throw new Error('removal failed');
      if (args[0] === 'rm') { present.delete(second); return { stdout: '' }; }
      if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${args.at(-1)}` };
      throw new Error('unexpected');
    };
    const events = await recoverRuns(root, run, async () => null);
    expect(calls).toContainEqual(['rm', '-fv', id]); expect(calls).toContainEqual(['rm', '-fv', second]);
    expect(JSON.stringify(events)).toContain('cleanup incomplete');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(['missing-guard', 'malformed-journal'] as const)('quarantines %s while recovering an independently proven file', async reason => {
  const root = await mkdtemp(join(tmpdir(), 'ts-partial-')), otherFile = 'e'.repeat(20), otherId = 'f'.repeat(64), otherNonce = '1'.repeat(24);
  try {
    const first = await fixture(root), base = join(root, '.brain-test-runs', 'run'), second = join(base, otherFile);
    if (reason === 'missing-guard') await rm(join(first, 'children.jsonl'));
    else await writeFile(join(first, 'processes.jsonl'), '{invalid\n');
    await mkdir(second);
    await writeFile(join(base, 'files', `${otherFile}.json`), JSON.stringify({ fileId: otherFile, worker: { pid: 12, started: 'worker2' } }));
    await writeFile(join(second, 'children.jsonl'), '{"state":"begin"}\n{"state":"sealed"}\n');
    await writeFile(join(second, 'resources.jsonl'), JSON.stringify({ fixturePostgres: 'created', name: `brain-fixture-${otherNonce}`, id: otherId }) + '\n');
    const present = new Set([id, otherId]), removed: string[] = [];
    const run = async (args: string[]) => {
      if (args[0] === 'ps') {
        const filter = args.find(arg => arg.startsWith('label=brain.test-file='));
        const target = filter?.endsWith(fileId) ? [id] : filter?.endsWith(otherFile) ? [otherId] : [...present];
        return { stdout: target.filter(value => present.has(value)).join('\n') };
      }
      if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: otherId, Name: `/brain-fixture-${otherNonce}`, Config: { Labels: { 'brain.test-run': 'run', 'brain.test-file': otherFile, 'brain.fixture': otherNonce } } }) };
      if (args[0] === 'rm') { removed.push(args.at(-1)!); present.delete(args.at(-1)!); return { stdout: '' }; }
      if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${args.at(-1)}` };
      throw new Error('unexpected');
    };
    const events = await recoverRuns(root, run, async () => null);
    expect(removed).toEqual([otherId]); expect(JSON.stringify(events)).toContain('error'); expect(present.has(id)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('quarantines a file when its common guard observed any child even without a group journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-untracked-child-'));
  try {
    const file = await fixture(root); await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const { run, calls } = dockerMock(); const events = await recoverRuns(root, run, async () => null);
    expect(calls.some(args => args[0] === 'rm')).toBe(false); expect(JSON.stringify(events)).toContain('untracked child safety unconfirmed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('owner-initiated cleanup still refuses a live worker after Vitest close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-owner-live-worker-'));
  try {
    await fixture(root);
    await writeLedger(root, { runId: 'run', kind: 'typescript', state: 'running', coordinator: { pid: process.pid, started: 'owner' }, slots: [], files: [], resources: [], cleanup: [] });
    const { run, calls } = dockerMock();
    const events = await recoverRuns(root, run, async pid => pid === process.pid ? 'owner' : pid === 11 ? 'worker' : null, 'run', { pid: process.pid, started: 'owner' });
    expect(calls.some(args => args[0] === 'rm')).toBe(false);
    expect(JSON.stringify(events)).toContain('test worker termination unconfirmed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('fences a shared database user while an arbitrary child is unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-shared-fence-'));
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'resources.jsonl'), '');
    await writeFile(join(file, 'shared-db.jsonl'), '{"state":"used"}\n');
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const { run } = dockerMock();
    const events = await recoverRuns(root, run, async () => null);
    expect(JSON.stringify(events)).toContain('untracked child safety unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('completes a hook record already absent without demanding child termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-hook-absent-'));
  try {
    const file = await fixture(root), home = join(file, 'brain-hook-abcdef', 'home');
    const { project, volume, port } = homeResources(home);
    await writeFile(join(file, 'resources.jsonl'), '');
    await writeFile(join(file, 'hook-resources.jsonl'), JSON.stringify({ home, project, volume, port }) + '\n');
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps' || (args[0] === 'network' && args[1] === 'ls')) return { stdout: '' };
      if (args[0] === 'volume' && args[1] === 'inspect') throw { code: 1, stderr: `Error: No such volume: ${volume}` };
      throw new Error('unexpected Docker command');
    };
    await recoverRuns(root, run, async () => null);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('completed');
    expect(calls.some(args => args[0] === 'rm' || args[1] === 'rm')).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('completes an already removed isolated fixture despite an unrelated untracked child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-isolated-already-removed-'));
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); if (args[0] === 'ps') return { stdout: '' }; throw new Error('unexpected Docker command'); };
    const events = await recoverRuns(root, run, async () => null);
    expect(JSON.stringify(events)).not.toContain('untracked child safety unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('completed');
    expect(calls.some(args => args[0] === 'rm')).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  ['active', '{"state":"acquired","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n'],
  ['legacy', '{"state":"used"}\n'],
  ['partial', '{"state":"acquired","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}'],
  ['duplicate acquisition', '{"state":"acquired","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"state":"acquired","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n'],
  ['invalid transition', '{"state":"released","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n'],
  ['duplicate release', '{"state":"acquired","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"state":"released","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"state":"released","fixtureId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n'],
  ['corrupt', '{oops}\n'],
])('fences %s shared journal with an unresolved child', async (_label, journal) => {
  const root = await mkdtemp(join(tmpdir(), 'ts-shared-lease-fence-'));
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'resources.jsonl'), '');
    await writeFile(join(file, 'shared-db.jsonl'), journal);
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const { run } = dockerMock();
    const events = await recoverRuns(root, run, async () => null);
    expect(JSON.stringify(events)).toContain('untracked child safety unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('completes a file after all shared fixtures were released despite an unresolved child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-shared-released-'));
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'resources.jsonl'), '');
    const rows = ['a', 'b'].flatMap(c => ['acquired', 'released'].map(state => JSON.stringify({ state, fixtureId: c.repeat(24) })));
    await writeFile(join(file, 'shared-db.jsonl'), rows.join('\n') + '\n');
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    const { run } = dockerMock();
    const events = await recoverRuns(root, run, async () => null);
    expect(JSON.stringify(events)).not.toContain('untracked child safety unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('records an absent detached group and recovers its owned fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-absent-group-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
    await writeFile(join(file, 'processes.jsonl'), ['active', 'termination-proof'].map(state => JSON.stringify({ state, token, pid: 1234 })).join('\n') + '\n');
    const { run, calls } = dockerMock();
    await recoverRuns(root, run, async () => null, undefined, undefined, async () => []);
    expect(calls.some(args => args[0] === 'rm')).toBe(true);
    expect(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).toContain('process-groups-absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves an occupied group or failed OS observation', async () => {
  for (const sampler of [async () => [{ pid: 5678, ppid: 1, pgid: 1234, started: 'time', cpu: 0, time: '0' }], async () => { throw new Error('unavailable'); }]) {
    const root = await mkdtemp(join(tmpdir(), 'ts-occupied-group-'));
    try {
      const file = await fixture(root), token = 'f'.repeat(24);
      await writeFile(join(file, 'processes.jsonl'), ['active', 'termination-proof'].map(state => JSON.stringify({ state, token, pid: 1234 })).join('\n') + '\n');
      const { run, calls } = dockerMock();
      expect(JSON.stringify(await recoverRuns(root, run, async () => null, undefined, undefined, sampler))).toContain('termination unconfirmed');
      expect(calls.some(args => args[0] === 'rm')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

it('audits explicit release while preserving the shared database and refusing live owners', async () => {
  const { releaseQuarantine } = await import('../src/python-slots.js');
  const root = await mkdtemp(join(tmpdir(), 'ts-explicit-release-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root); await writeFile(join(file, 'resources.jsonl'), '');
    await writeFile(join(file, 'shared-db.jsonl'), JSON.stringify({ state: 'acquired', fixtureId: nonce }) + '\n');
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false })].join('\n') + '\n');
    const noDocker = async (args: string[]) => { if (args[0] === 'ps') return { stdout: '' }; throw new Error('unexpected operation'); };
    await expect(releaseQuarantine(root, 'run', noDocker, async () => 'owner', async () => [])).rejects.toThrow('eligible');
    await releaseQuarantine(root, 'run', noDocker, async () => null, async () => []);
    const ledger = JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8'));
    expect(ledger.preservedShared).toBe(true);
    expect(ledger.cleanup.filter((row: { action?: string }) => row.action === 'explicit-release').map((row: { phase: string }) => row.phase)).toEqual(['before', 'after']);
    expect(await readFile(join(file, 'shared-db.jsonl'), 'utf8')).toContain('acquired');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses release of an active registered child and never touches protected resources', async () => {
  const { releaseQuarantine } = await import('../src/python-slots.js');
  const root = await mkdtemp(join(tmpdir(), 'ts-release-active-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); throw new Error('must not access resources'); };
    await expect(releaseQuarantine(root, 'run', run, async () => null, async () => [{ pid: 1234, ppid: 1, pgid: 1234, started: 'time', cpu: 0, time: '0' }])).rejects.toThrow('active');
    expect(calls).toEqual([]);
    const ledger = JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8'));
    expect(ledger.state).toBe('running'); expect(ledger.cleanup.at(-1).outcome).toBe('refused');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves an unreleased shared DB after proven group absence and fences the current owner', async () => {
  for (const current of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'ts-shared-absence-')), token = 'f'.repeat(24);
    try {
      const file = await fixture(root);
      await writeFile(join(file, 'resources.jsonl'), '');
      await writeFile(join(file, 'shared-db.jsonl'), JSON.stringify({ state: 'acquired', fixtureId: nonce }) + '\n');
      await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
      await writeFile(join(file, 'processes.jsonl'), ['active', 'termination-proof'].map(state => JSON.stringify({ state, token, pid: 1234 })).join('\n') + '\n');
      if (current) await writeLedger(root, { runId: 'run', kind: 'typescript', state: 'running', coordinator: { pid: process.pid, started: 'owner' }, slots: [], files: [], resources: [], cleanup: [] });
      const noDocker = async (args: string[]) => { if (args[0] === 'ps') return { stdout: '' }; throw new Error('unexpected operation'); };
      const events = await recoverRuns(root, noDocker, async pid => current && pid === process.pid ? 'owner' : null, current ? 'run' : undefined, current ? { pid: process.pid, started: 'owner' } : undefined, async () => []);
      const ledger = JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8'));
      expect(ledger.state).toBe(current ? 'running' : 'completed');
      expect(JSON.stringify(events)).toContain(current ? 'shared database lease remains' : 'preservedShared');
      expect(await readFile(join(file, 'shared-db.jsonl'), 'utf8')).toContain('acquired');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

it('keeps legacy active-only resources when a detached descendant escaped the original group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-escaped-descendant-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
    await writeFile(join(file, 'processes.jsonl'), JSON.stringify({ state: 'active', token, pid: 1234 }) + '\n');
    const { run } = dockerMock();
    const escaped = [{ pid: 5678, ppid: 1, pgid: 5678, started: 'descendant', cpu: 0, time: '0' }];
    const events = await recoverRuns(root, run, async () => null, undefined, undefined, async () => escaped);
    expect(JSON.stringify(events)).toContain('termination unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
    expect(JSON.stringify(events)).toContain(id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps the fixture when a proof-bearing group still has a leaderless member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-leaderless-group-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
    await writeFile(join(file, 'processes.jsonl'), ['active', 'termination-proof'].map(state => JSON.stringify({ state, token, pid: 1234 })).join('\n') + '\n');
    const { run } = dockerMock();
    const events = await recoverRuns(root, run, async () => null, undefined, undefined, async () => [{ pid: 5678, ppid: 1, pgid: 1234, started: 'child', cpu: 0, time: '0' }]);
    expect(JSON.stringify(events)).toContain('termination unconfirmed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
    expect(JSON.stringify(events)).toContain(id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a termination proof belonging to a different token or PID', async () => {
  for (const proof of [{ token: 'e'.repeat(24), pid: 1234 }, { token: 'f'.repeat(24), pid: 4321 }]) {
    const root = await mkdtemp(join(tmpdir(), 'ts-proof-mismatch-')), token = 'f'.repeat(24);
    try {
      const file = await fixture(root);
      await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
      await writeFile(join(file, 'processes.jsonl'), [JSON.stringify({ state: 'active', token, pid: 1234 }), JSON.stringify({ state: 'termination-proof', ...proof })].join('\n') + '\n');
      const { run, calls } = dockerMock();
      const events = await recoverRuns(root, run, async () => null, undefined, undefined, async () => []);
      expect(JSON.stringify(events)).toContain('invalid child process journal transition');
      expect(calls.some(args => args[0] === 'rm')).toBe(false);
      expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

it('does not accept a truncated termination proof as durable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-proof-partial-')), token = 'f'.repeat(24);
  try {
    const file = await fixture(root);
    await writeFile(join(file, 'children.jsonl'), [JSON.stringify({ state: 'begin' }), JSON.stringify({ state: 'spawned', token, tool: false }), JSON.stringify({ state: 'pid', token, pid: 1234 })].join('\n') + '\n');
    await writeFile(join(file, 'processes.jsonl'), JSON.stringify({ state: 'active', token, pid: 1234 }) + '\n' + JSON.stringify({ state: 'termination-proof', token, pid: 1234 }));
    const { run, calls } = dockerMock();
    const events = await recoverRuns(root, run, async () => null, undefined, undefined, async () => []);
    expect(JSON.stringify(events)).toContain('incomplete child process journal');
    expect(calls.some(args => args[0] === 'rm')).toBe(false);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', 'run.json'), 'utf8')).state).toBe('running');
  } finally { await rm(root, { recursive: true, force: true }); }
});
