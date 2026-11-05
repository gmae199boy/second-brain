import { memoryFileStore } from '../src/testing/fakes/file-store.js';
import { describe, expect, it } from 'vitest';
import { createBrain, type BrainDependencies } from '../src/brain.js';
import { runDoctor, type DoctorCheck, type DoctorCheckSource } from '../src/doctor/doctor.js';
import type {
  HealthStore,
  ReadSchemaVersionsResult,
  SchemaStore,
  StoreHealth,
  StoreProbe,
} from '../src/ports/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import { memorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { memoryParser } from '../src/testing/fakes/parser.js';
import { memoryRepositories } from '../src/testing/fakes/repository.js';
import { memoryTranscriptReader } from '../src/testing/fakes/transcript.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';

/** The version these tests call current, so a mismatch is an explicit choice. */
const CURRENT = 2;
const workCheckIds = ['work-stalled', 'work-died', 'work-unknown', 'work-last-error', 'work-model-usage'];
const workChecks = (status: 'ok' | 'skip', detail: string) => workCheckIds.map(id => ({ id, status, detail: id === 'work-model-usage' && status === 'ok' ? '입력 0 토큰, 캐시 0 토큰, 출력 0 토큰, 걸린 시간 0초' : detail }));

/** A reachable store whose source answered with exactly these probes. */
function healthy(...probes: StoreProbe[]): StoreHealth {
  return {
    ok: true,
    serverVersion: '18.1',
    source: { location: 'db.example:5432/brain', probes },
  };
}

interface FakeStore extends HealthStore, SchemaStore {
  closed: () => number;
}

/**
 * A store with both capabilities doctor asks for. The schema half is the fake
 * every schema test uses, so what "a database at version n" means is one thing
 * in this repository and not two.
 */
function fakeStore(
  health: StoreHealth,
  schema: { version?: number | null; result?: ReadSchemaVersionsResult } = {},
): FakeStore {
  const schemaStore = memorySchemaStore(
    schema.result !== undefined
      ? { result: schema.result }
      : { version: schema.version === undefined ? CURRENT : schema.version },
  );
  let closes = 0;
  return {
    checkHealth: async () => health,
    readSchemaVersions: () => schemaStore.readSchemaVersions(),
    close: async () => {
      closes += 1;
    },
    closed: () => closes,
  };
}

/** One registered check that answers with whatever it was handed. */
function source(check: DoctorCheck): DoctorCheckSource {
  return { id: check.id, run: async () => check };
}

/**
 * The options every case here shares.
 *
 * `store` and `clock` are what the two capture checks read: the failures that
 * are still open and the transcript history (`DoctorReadStore`). An empty
 * memory store is what a healthy brain looks like, so `failures` is `ok` and —
 * with no folder — `transcripts` is a `skip`, which is exactly what a build
 * whose capture switch is off reports (Boundaries).
 */
const OPTIONS = {
  schemaVersions: { core: CURRENT },
  store: memoryStore(),
  clock: fixedClock(new Date('2026-03-04T05:06:07.000Z')),
};

describe('runDoctor', () => {
  it('reports db, pg_trgm and the schema version as ok when everything is healthy', async () => {
    const report = await runDoctor(
      fakeStore(healthy({ id: 'pg_trgm', ok: true, detail: 'pg_trgm' })),
      OPTIONS,
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'pg_trgm', status: 'ok', detail: 'pg_trgm' },
      { id: 'schema-version', status: 'ok', detail: '`core`: 2' },
      // Nothing is failing, and there is no folder to compare against, which
      // is what a build with its capture switch off reports (Boundaries).
      { id: 'failures', status: 'ok', detail: '0건' },
      { id: 'untagged', status: 'ok', detail: '0건' },
      { id: 'transcripts', status: 'skip', detail: '트랜스크립트 폴더 수집이 꺼져 있습니다' },
      ...workChecks('ok', '0건'),
    ]);
  });

  it('fails the pg_trgm check and explains when it is not installed', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy({ id: 'pg_trgm', ok: false, detail: 'pg_trgm 확장이 설치되어 있지 않습니다' }),
      ),
      OPTIONS,
    );

    expect(report.checks[0]).toEqual({ id: 'db', status: 'ok', detail: '18.1' });
    expect(report.checks[1]).toMatchObject({ id: 'pg_trgm', status: 'fail' });
    expect(report.checks[1]?.detail).toContain('pg_trgm');
    expect(report.checks[1]?.code).toBeUndefined();
  });

  it('reports db and a skipped schema version when the store is unavailable', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED 127.0.0.1:54329' }),
      OPTIONS,
    );

    // Nothing was probed, so there is no probe to report on. The schema version
    // gets a line all the same, as a `skip` naming the check that made it
    // pointless: a report that left it out would make a reader work out from
    // what is missing whether it was skipped or never existed.
    expect(report.checks).toEqual([
      {
        id: 'db',
        status: 'fail',
        code: 'DB_UNAVAILABLE',
        detail: 'connect ECONNREFUSED 127.0.0.1:54329',
      },
      { id: 'schema-version', status: 'skip', detail: '앞선 점검 실패: db' },
      // Everything a store would have answered is skipped under the same
      // reason: a reader must never have to work out from what is missing
      // whether a check was skipped or never existed.
      { id: 'failures', status: 'skip', detail: '앞선 점검 실패: db' },
      { id: 'untagged', status: 'skip', detail: '앞선 점검 실패: db' },
      { id: 'transcripts', status: 'skip', detail: '앞선 점검 실패: db' },
      ...workChecks('skip', '앞선 점검 실패: db'),
    ]);
  });

  it('reports a probe that passed without settling its question as warn', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy({
          id: 'writable',
          ok: true,
          warn: true,
          detail: 'another process holds the write lock',
        }),
      ),
      OPTIONS,
    );

    // The adapter's own verdict, passed through: only it knows it gave up on a
    // lock rather than finding the file unwritable.
    expect(report.checks[1]).toEqual({
      id: 'writable',
      status: 'warn',
      detail: 'another process holds the write lock',
    });
  });

  it('reports a failing probe as fail even if it also set warn', async () => {
    const report = await runDoctor(
      fakeStore(healthy({ id: 'writable', ok: false, warn: true, detail: 'EACCES' })),
      OPTIONS,
    );

    expect(report.checks[1]).toMatchObject({ id: 'writable', status: 'fail' });
  });

  it('reports one check per probe, under the names the adapter chose', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy(
          { id: 'wal', ok: true, detail: 'wal' },
          { id: 'fts5-trigram', ok: false, detail: 'no such tokenizer' },
          { id: 'foreign-keys', ok: true },
        ),
      ),
      OPTIONS,
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'wal', status: 'ok', detail: 'wal' },
      { id: 'fts5-trigram', status: 'fail', detail: 'no such tokenizer' },
      { id: 'foreign-keys', status: 'ok' },
      { id: 'schema-version', status: 'ok', detail: '`core`: 2' },
      { id: 'failures', status: 'ok', detail: '0건' },
      { id: 'untagged', status: 'ok', detail: '0건' },
      { id: 'transcripts', status: 'skip', detail: '트랜스크립트 폴더 수집이 꺼져 있습니다' },
      ...workChecks('ok', '0건'),
    ]);
  });

  it('reports db and the schema version alone when a healthy source ran no probes', async () => {
    const report = await runDoctor(fakeStore(healthy()), OPTIONS);

    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      ...workCheckIds,
    ]);
  });

  it('does not throw when the store is unavailable', async () => {
    await expect(
      runDoctor(fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' }), OPTIONS),
    ).resolves.toBeDefined();
  });
});

describe('runDoctor and the schema version', () => {
  it('fails with SCHEMA_MISMATCH and names both versions when they differ', async () => {
    const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, schemaVersions: { core: 7 } });

    const schema = report.checks.find((check) => check.id === 'schema-version');
    expect(schema).toMatchObject({ status: 'fail', code: 'SCHEMA_MISMATCH' });
    expect(schema?.detail).toContain('2');
    expect(schema?.detail).toContain('7');
  });

  it('fails with SCHEMA_MISMATCH when the database holds no version at all', async () => {
    const report = await runDoctor(fakeStore(healthy(), { version: null }), OPTIONS);

    expect(report.checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'fail',
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('carries DB_UNAVAILABLE when the health probe passed but the version could not be read', async () => {
    const report = await runDoctor(
      fakeStore(healthy(), {
        result: { ok: false, code: 'DB_UNAVAILABLE', message: 'applied_at is unreadable' },
      }),
      OPTIONS,
    );

    expect(report.checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'fail',
      code: 'DB_UNAVAILABLE',
    });
  });
});

describe('runDoctor and the checks the runtime registers', () => {
  it('runs them after the store, in the order they were registered', async () => {
    const report = await runDoctor(fakeStore(healthy({ id: 'wal', ok: true })), {
      ...OPTIONS,
      checks: [
        source({ id: 'config', status: 'ok', detail: '/home/me/.second_brain/config.toml' }),
        source({ id: 'shim', status: 'fail', detail: 'no shim' }),
        source({ id: 'node-path', status: 'skip' }),
      ],
    });

    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'wal',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      ...workCheckIds,
      'config',
      'shim',
      'node-path',
    ]);
    expect(report.checks.at(-1)).toEqual({ id: 'node-path', status: 'skip' });
  });

  it('runs them even when the store could not be reached', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' }),
      { ...OPTIONS, checks: [source({ id: 'shim', status: 'ok' })] },
    );

    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      ...workCheckIds,
      'shim',
    ]);
  });

  it('turns a check that throws into that id failing, and keeps going', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS,
      checks: [
        {
          id: 'shim',
          run: async () => {
            throw new Error('EACCES: permission denied\n    at readFile');
          },
        },
        source({ id: 'node-version', status: 'ok', detail: '24.16.0' }),
      ],
    });

    expect(report.checks.find((check) => check.id === 'shim')).toEqual({
      id: 'shim',
      status: 'fail',
      // One line: the stack is not a detail anybody can act on.
      detail: '점검이 실패했습니다: EACCES: permission denied',
    });
    expect(report.checks.at(-1)).toMatchObject({ id: 'node-version', status: 'ok' });
  });

  it('does not throw when a check rejects with something that is not an error', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS,
      checks: [{ id: 'shim', run: async (): Promise<DoctorCheck> => Promise.reject('nope') }],
    });

    expect(report.checks.at(-1)).toEqual({
      id: 'shim',
      status: 'fail',
      detail: '점검이 실패했습니다: nope',
    });
  });
});

describe('the summary of a report', () => {
  it('counts every check once, under the status it came to', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy(
          { id: 'wal', ok: true, detail: 'wal' },
          { id: 'writable', ok: true, warn: true, detail: 'the lock is held' },
          { id: 'fts5-trigram', ok: false, detail: 'no such tokenizer' },
        ),
      ),
      {
        ...OPTIONS,
        checks: [
          source({ id: 'shim', status: 'fail', detail: 'no shim' }),
          source({ id: 'node-path', status: 'skip', detail: '앞선 점검 실패: shim' }),
        ],
      },
    );

    // db ok, wal ok, writable warn, fts fail, schema ok, failures ok,
    // transcripts skip, shim fail, node skip.
    expect(report.summary).toEqual({ passed: 10, warned: 1, failed: 2, skipped: 2 });
    const counted =
      report.summary.passed +
      report.summary.warned +
      report.summary.failed +
      report.summary.skipped;
    expect(counted).toBe(report.checks.length);
  });

  it('counts the skipped schema version of an unreachable store', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' }),
      OPTIONS,
    );

    expect(report.summary).toEqual({ passed: 0, warned: 0, failed: 1, skipped: 9 });
  });

  it('is all passes for a healthy brain, bar the folders nobody asked for', async () => {
    const report = await runDoctor(fakeStore(healthy({ id: 'wal', ok: true })), OPTIONS);

    // db, wal, schema-version and failures pass; `transcripts` is a `skip`,
    // because this brain's capture switch is off (Boundaries).
    expect(report.summary).toEqual({ passed: 10, warned: 0, failed: 0, skipped: 1 });
  });
});

/**
 * The ports `createBrain` needs beside the store. Doctor uses none of them, so
 * they are the in-memory fakes and nothing here says anything about them: what
 * these two tests are about is that the report is wired to the store.
 */
function otherDependencies(): Omit<BrainDependencies, 'store' | 'schemaVersions' | 'checks'> {
  const instant = new Date('2026-01-02T03:04:05.000Z');
  return {
    clock: fixedClock(instant),
    idGen: sequenceIdGen({ timestampMs: instant.getTime() }),
    parsers: [memoryParser()],
    transcripts: memoryTranscriptReader(),
    repositories: memoryRepositories(),
    spool: memorySpool(),
    files: memoryFileStore(),
    machine: 'demo-machine',
  };
}

/** Doctor's fake with the session and identity halves filled in by the fake. */
function brainStore(store: FakeStore): BrainDependencies['store'] {
  return { ...memoryStore(), ...store };
}

describe('createBrain', () => {
  it('wires doctor to the store, with the schema version and the checks', async () => {
    const store = fakeStore(healthy({ id: 'pg_trgm', ok: true, detail: 'pg_trgm' }));
    const brain = createBrain({
      store: brainStore(store),
      schemaVersions: { core: CURRENT },
      checks: [source({ id: 'shim', status: 'ok' })],
      ...otherDependencies(),
    });

    const report = await brain.doctor.run();
    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'pg_trgm',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      ...workCheckIds,
      'extensions',
      'shim',
    ]);

    await brain.close();
    expect(store.closed()).toBe(1);
  });

  it('registers nothing when no check was handed in', async () => {
    const brain = createBrain({
      store: brainStore(fakeStore(healthy())),
      schemaVersions: { core: CURRENT },
      ...otherDependencies(),
    });

    const report = await brain.doctor.run();
    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      ...workCheckIds,
      'extensions',
    ]);
  });
});

describe('꼬리표 없는 세션 진단', () => {
  it('꼬리표 없는 수는 정상으로 보인다', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS, store: { ...memoryStore(), async countUntaggedSessions() { return { ok: true, count: 2 }; } },
    });
    expect(report.checks).toContainEqual({ id: 'untagged', status: 'ok', detail: '2건' });
  });
  it('읽기 실패는 실패한 점검으로 보인다', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS, store: { ...memoryStore(), async countUntaggedSessions() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '세션 수를 읽을 수 없습니다' };
      } },
    });
    expect(report.checks).toContainEqual({ id: 'untagged', status: 'fail',
      code: 'DB_UNAVAILABLE', detail: '세션 수를 읽을 수 없습니다' });
  });
});

const adapterProbeIds = ['adapter-write', 'adapter-search', 'adapter-cleanup'];
it.each(['orbstack', 'container'])('skips dependent checks after the first failed prerequisite %s without touching the database', async failedId => {
  const called: string[] = [];
  const store = fakeStore(healthy());
  store.checkHealth = async () => { throw new Error('DB must not be called'); };
  const prerequisite = (id: string): DoctorCheckSource => ({ id, run: async () => { called.push(id); return { id, status: id === failedId ? 'fail' : 'ok' }; } });
  const report = await runDoctor(store, { ...OPTIONS, adapterProbeIds, prerequisites: [prerequisite('orbstack'), prerequisite('container')], checks: [{ id: 'runtime', run: async () => { called.push('runtime'); return { id: 'runtime', status: 'ok' }; } }] });
  expect(called).toEqual(failedId === 'orbstack' ? ['orbstack', 'runtime'] : ['orbstack', 'container', 'runtime']);
  for (const id of ['db', ...adapterProbeIds, 'schema-version', 'failures', 'untagged', 'transcripts', ...workCheckIds]) expect(report.checks).toContainEqual({ id, status: 'skip', detail: `앞선 점검 실패: ${failedId}` });
  expect(report.checks.map(check => check.id)).toEqual(['orbstack', 'container', 'db', ...adapterProbeIds, 'schema-version', 'failures', 'untagged', 'transcripts', ...workCheckIds, 'runtime']);
});
it('does not invent probe rows when a prerequisite fails without declared adapter probes', async () => {
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, prerequisites: [source({ id: 'environment', status: 'fail' })] });
  expect(report.checks.map(check => check.id)).toEqual(['environment', 'db', 'schema-version', 'failures', 'untagged', 'transcripts', ...workCheckIds]);
});
it('omits declared adapter probes when prerequisites pass but the database is unavailable', async () => {
  const report = await runDoctor(fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: '연결 실패' }), {
    ...OPTIONS, adapterProbeIds, prerequisites: [source({ id: 'environment', status: 'ok' })],
  });
  expect(report.checks.map(check => check.id)).toEqual(['environment', 'db', 'schema-version', 'failures', 'untagged', 'transcripts', ...workCheckIds]);
  expect(report.checks[1]).toMatchObject({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' });
  for (const check of report.checks.slice(2)) expect(check).toMatchObject({ status: 'skip', detail: '앞선 점검 실패: db' });
});
it('passes prerequisite adapter probe IDs through createBrain to doctor', async () => {
  const store = fakeStore(healthy());
  store.checkHealth = async () => { throw new Error('DB must not be called'); };
  const brain = createBrain({
    ...otherDependencies(), store: brainStore(store), schemaVersions: { core: CURRENT }, adapterProbeIds,
    prerequisites: [source({ id: 'environment', status: 'fail' })],
  });
  try {
    const report = await brain.doctor.run();
    for (const id of adapterProbeIds) expect(report.checks).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: environment' });
  } finally { await brain.close(); }
});
it('runs healthy prerequisites before health and adapter probes', async () => {
  const called: string[] = [];
  const store = fakeStore(healthy({ id: 'writable', ok: true }));
  store.checkHealth = async () => { called.push('db'); return healthy({ id: 'writable', ok: true }); };
  const report = await runDoctor(store, { ...OPTIONS, prerequisites: [{ id: 'orbstack', run: async () => { called.push('orbstack'); return { id: 'orbstack', status: 'ok' }; } }] });
  expect(called).toEqual(['orbstack', 'db']); expect(report.checks.slice(0, 3).map(c => c.id)).toEqual(['orbstack', 'db', 'writable']);
});

it('reports each open work attempt problem as a warning with its latest item', async () => {
  const store = memoryStore(), idGen = sequenceIdGen({ timestampMs: OPTIONS.clock.now().getTime() }), now = OPTIONS.clock.now();
  for (const outcome of ['stalled', 'died', 'unknown', 'failed'] as const) {
    const id = idGen.next(), attemptToken = idGen.next();
    await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: outcome, createdAt: now, nextAttemptAt: now });
    await store.claimSupervisedWork({ now, claimedBy: idGen.next(), kinds: ['process_probe'], attemptToken });
    if (outcome === 'unknown') await store.settleSupervisedAttempt({ id, attemptToken, now, outcome });
    else await store.finishSupervisedWork({ id, attemptToken, now, outcome, nextAttemptAt: new Date(now.getTime() + 900_000), lastError: '마지막 오류', ...(outcome === 'failed' ? { errorCode: 'TEMPORARY', errorRetryable: true } : {}) });
    const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store });
    const check = report.checks.find(check => check.id === (outcome === 'failed' ? 'work-last-error' : `work-${outcome}`));
    expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining(id) });
    expect(check!.detail).toContain('1건'); expect(check!.detail).toContain('process_probe'); expect(check!.detail).toContain(now.toISOString());
    expect(check!.code).toBeUndefined();
    if (outcome === 'failed') { expect(check!.detail).toContain('TEMPORARY'); expect(check!.detail).toContain('retryable=true'); expect(check!.detail).toContain('마지막 오류'); }
  }
});
it('fails all work attempt checks with the read failure code', async () => {
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store: { ...memoryStore(), async readWorkAttemptHealth() { return { ok: false, code: 'DB_UNAVAILABLE', message: '읽기 실패' }; } } });
  for (const id of workCheckIds.filter(id => id !== 'work-model-usage')) expect(report.checks).toContainEqual({ id, status: 'fail', code: 'DB_UNAVAILABLE', detail: '읽기 실패' });
});

it('reports model work tokens and elapsed time without counts', async () => {
  const store = memoryStore(); const now = OPTIONS.clock.now();
  for (const [id, inputTokens, cachedInputTokens, outputTokens, elapsedMs] of [['first',10,2,5,1000], ['second',1,0,1,500]] as const) {
    await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: id, createdAt: now, nextAttemptAt: now });
    await store.claimSupervisedWork({ kinds: ['process_probe'], claimedBy: 'worker', now, attemptToken: id });
    await store.finishSupervisedWork({ id, attemptToken: id, now, outcome: 'succeeded', elapsedMs, usage: { inputTokens, cachedInputTokens, outputTokens } });
  }
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, modelWorkKinds: ['process_probe'] });
  const check = report.checks.find(c => c.id === 'work-model-usage');
  expect(check).toMatchObject({ status: 'ok', detail: expect.stringContaining('입력 11 토큰, 캐시 2 토큰, 출력 6 토큰, 걸린 시간 1.5초') });
  expect(check?.detail).toContain('최근 종류 process_probe 일감 second'); expect(check?.detail).not.toMatch(/횟수|시도|건/);
});
it('fails the model usage check when the store cannot be read', async () => {
  const store = { ...memoryStore(), async readModelWorkUsage() { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '읽기 실패' }; } };
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store });
  expect(report.checks).toContainEqual({ id: 'work-model-usage', status: 'fail', code: 'DB_UNAVAILABLE', detail: '읽기 실패' });
});

it('확장 진단은 공개 상태의 비활성과 보류 수를 표시한다', async () => {
  const store = memoryStore();
  const now = new Date('2026-10-31T00:00:00Z');
  await store.recordExtensionInstall({ name: 'testext', version: '1', now });
  await store.addWork({ id: '00000000-0000-4000-8000-000000000001', kind: 'testext.job', targetKind: 'test', targetId: '1', createdAt: now, nextAttemptAt: now });
  await store.setExtensionEnabled({ name: 'testext', enabled: false, now });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'warn', detail: expect.stringContaining('testext: 비활성, 중단 일감 1건, 보류 예약 0건') }));
});
it('확장 상태 조회 실패는 정상 진단으로 보고하지 않는다', async () => {
  const store = memoryStore();
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: { ...store, async listExtensionInventory() { return { ok: false, code: 'DB_UNAVAILABLE', message: '조회 실패' }; } } });
  expect(report.checks).toContainEqual({ id: 'extensions', status: 'fail', code: 'DB_UNAVAILABLE', detail: '조회 실패' });
});

it.each(['login_required', 'connection_failed', 'scheduler_unavailable', 'failed', 'cancelled'] as const)('설치 결과 %s는 활성 확장도 경고한다', async result => {
  const store = memoryStore(); const now = new Date('2026-10-31T00:00:00.000Z');
  await store.recordExtensionInstall({ name: 'testext', version: '1', now });
  await store.writeExtensionInstallProgress({ expectedRevision: null, progress: { name: 'testext', packageDigest: 'a'.repeat(64), result,
    failedStage: 'login', lastFailure: { stage: 'login', code: 'LOGIN_REQUIRED', at: now.toISOString() },
    stages: result === 'login_required' ? { login: { status: 'pending', code: 'LOGIN_REQUIRED', at: now.toISOString() } } : {}, authWorkId: null, scheduleIds: [] } });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store });
  const check = report.checks.find(entry => entry.id === 'extensions');
  expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining(`설치 결과 ${result}`) });
  if (result === 'login_required') expect(check?.detail).toContain('로그인 pending (LOGIN_REQUIRED)');
  expect(check?.detail).toContain('마지막 실패 login (LOGIN_REQUIRED)');
});
it('registry 없이 설치 실패 journal만 있으면 doctor가 경고와 고정 코드를 표시한다', async () => {
  const store = memoryStore(); const now = new Date('2026-10-31T00:00:00.000Z');
  await store.writeExtensionInstallProgress({ expectedRevision: null, progress: { name: 'missingext', packageDigest: 'a'.repeat(64), result: 'failed', failedStage: 'package',
    lastFailure: { stage: 'package', code: 'EXTENSION_NOT_FOUND', at: now.toISOString() }, stages: {}, authWorkId: null, scheduleIds: [] } });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store });
  const check = report.checks.find(entry => entry.id === 'extensions');
  expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining('missingext: 미설치') });
  expect(check?.detail).toContain('설치 결과 failed'); expect(check?.detail).toContain('package (EXTENSION_NOT_FOUND)');
});
it('활성 확장의 연결 실패는 경고하고 원문 진단을 출력하지 않는다', async () => {
  const store = memoryStore(); const now = new Date('2026-10-31T00:00:00.000Z');
  await store.recordExtensionInstall({ name: 'testext', version: '1', now });
  await store.recordExtensionConnection({ name: 'testext', status: 'failed', code: 'REFUSED', message: 'SECRET_CANARY', checkedAt: now });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store });
  const check = report.checks.find(entry => entry.id === 'extensions');
  expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining('연결 failed (REFUSED)') });
  expect(JSON.stringify(report)).not.toContain('SECRET_CANARY');
});
it('미기록 legacy 상태는 실패가 아니다', async () => {
  const store = memoryStore(); const now = new Date('2026-10-31T00:00:00.000Z');
  await store.recordExtensionInstall({ name: 'testext', version: '1', now });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'extensions', status: 'ok', detail: expect.stringContaining('설치 결과 미기록') }));
});
it('개별 공개 상태 조회 실패는 진단 실패다', async () => {
  const store = memoryStore(); await store.recordExtensionInstall({ name: 'testext', version: '1', now: new Date() });
  const report = await runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: { ...store, async getExtensionPublicStatus() { return { ok: false, code: 'DB_UNAVAILABLE', message: '상태 조회 실패' }; } } });
  expect(report.checks).toContainEqual({ id: 'extensions', status: 'fail', code: 'DB_UNAVAILABLE', detail: '상태 조회 실패' });
});

it('관측한 플러그인 package가 설치본보다 뒤처지면 경고하고 최신 관측에서 해소한다', async () => {
  const store = memoryStore();
  await store.recordExtensionInstall({ name: 'testext', version: '2.0.0', packageIdentity: { digest: 'a'.repeat(64), pluginVersion: '2.0.0' }, now: new Date() });
  let observed = { name: 'testext', version: '1.0.0', pluginVersion: '1.0.0', digest: 'b'.repeat(64) };
  const report = () => runDoctor(fakeStore(healthy()), { ...OPTIONS, store, extensionStore: store, readPackageObservation: async () => observed });
  expect((await report()).checks.find(check => check.id === 'extensions')).toMatchObject({ status: 'warn', code: 'PLUGIN_BEHIND', detail: expect.stringContaining('testext: 설치 2.0.0, 플러그인 패키지 1.0.0') });
  observed = { name: 'testext', version: '2.0.0', pluginVersion: '3.0.0', digest: 'a'.repeat(64) };
  expect((await report()).checks.find(check => check.id === 'extensions')).toMatchObject({ status: 'warn', code: 'EXTENSION_PACKAGE_CONFLICT' });
  observed = { name: 'testext', version: '2.0.0', pluginVersion: '2.0.0', digest: 'b'.repeat(64) };
  expect((await report()).checks.find(check => check.id === 'extensions')).toMatchObject({ status: 'warn', code: 'EXTENSION_PACKAGE_CONFLICT' });
  observed = { name: 'testext', version: '2.0.0', pluginVersion: '2.0.0', digest: 'a'.repeat(64) };
  expect((await report()).checks.find(check => check.id === 'extensions')).toMatchObject({ status: 'ok' });
});
