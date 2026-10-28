import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import { createPool, type PgSchema } from '../src/connect.js';
import { postgresWorkStore } from '../src/work.js';
import { clock, subject } from './fixture.js';

const now = clock.now();
const workId = '00000000-0000-7000-8000-000000000001';
const tokenA = '00000000-0000-7000-8000-000000000002';
const tokenB = '00000000-0000-7000-8000-000000000003';
const input = { id: workId, attemptToken: tokenA, now };

async function fixture(run: (f: Awaited<ReturnType<typeof arrange>>) => Promise<void>) {
  const store = await subject();
  const owner = new pg.Client({ connectionString: store.db.url });
  const role = `brain_fence_${randomBytes(8).toString('hex')}`;
  const clients: pg.Client[] = [];
  let roleCreated = false;
  try {
    await owner.connect();
    // This role is deliberately created after the migrations, with no core table grants.
    await owner.query(`create role ${role} login nosuperuser nobypassrls password 'fence-test'`);
    roleCreated = true;
    await owner.query(`create schema fence_test;
      create table fence_test.contract (id uuid primary key, work_item_id uuid not null, attempt_token uuid, body text not null);
      create trigger contract_attempt_fence before insert on fence_test.contract
        for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token');
      grant usage on schema fence_test to brain_app, ${role};
      grant insert on fence_test.contract to brain_app, ${role};
      grant usage on schema brain to ${role}`);
    const connect = async (url: string) => {
      const client = new pg.Client({ connectionString: url });
      clients.push(client); await client.connect();
      await client.query("set statement_timeout = '5s'");
      return client;
    };
    const roleUrl = new URL(store.db.url); roleUrl.username = role; roleUrl.password = 'fence-test';
    const writers = [await connect(store.db.appUrl), await connect(roleUrl.toString())];
    const f = await arrange(store, owner, role, writers);
    await run(f);
  } finally {
    await Promise.all(clients.map(async c => { await c.query('rollback').catch(() => {}); await c.end(); }));
    try {
      if (roleCreated) {
        await owner.query(`drop owned by ${role}`);
        await owner.query(`drop role ${role}`);
      }
    } finally { await owner.end(); await store.close(); }
  }
}
async function arrange(store: Awaited<ReturnType<typeof subject>>, owner: pg.Client, role: string, writers: pg.Client[]) {
  expect(await store.addWork({ id: workId, kind: 'process_probe', targetKind: 'probe', targetId: 'fence', createdAt: now, nextAttemptAt: now }))
    .toMatchObject({ ok: true, created: true });
  const claim = async (attemptToken: string) => {
    expect(await store.claimSupervisedWork({ now, claimedBy: 'fence-supervisor', kinds: ['process_probe'], attemptToken }))
      .toMatchObject({ ok: true, item: { id: workId }, attemptToken });
  };
  await claim(tokenA);
  return { store, owner, role, writers, claim };
}
function insert(client: pg.Client, token: string | null = tokenA, work: string | null = workId, table = 'contract') {
  return client.query(`insert into fence_test.${table} (id, work_item_id, attempt_token, body) values ($1, $2, $3, $4)`,
    [randomUUID(), work, token, 'result']);
}
async function current(client: pg.Client, work: string | null = workId, token: string | null = tokenA) {
  return (await client.query('select brain.attempt_is_current($1, $2) as current', [work, token])).rows[0].current;
}
async function refused(owner: pg.Client, writers: pg.Client[], token: string | null = tokenA, work: string | null = workId) {
  const before = (await owner.query('select count(*)::int as n from fence_test.contract')).rows;
  for (const writer of writers) {
    expect(await current(writer, work, token)).toBe(false);
    await expect(insert(writer, token, work)).rejects.toMatchObject({ code: 'BRS01', message: 'reject_stale_attempt: invariant refused' });
  }
  expect((await owner.query('select count(*)::int as n from fence_test.contract')).rows).toEqual(before);
}

it('accepts the current token for both roles, including after lease expiry and a cancellation request', async () => {
  await fixture(async ({ store, owner, writers }) => {
    for (const writer of writers) {
      expect(await current(writer)).toBe(true);
      await insert(writer);
    }
    // Advancing caller time beyond the lease still leaves this attempt current.
    expect(await store.claimSupervisedWork({ now: new Date(now.getTime() + 600_001), kinds: ['process_probe'], claimedBy: 'other', attemptToken: tokenB }))
      .toMatchObject({ ok: true, item: null });
    expect(await store.requestWorkCancel({ id: workId, now })).toEqual({ ok: true, state: 'requested' });
    for (const writer of writers) { expect(await current(writer)).toBe(true); await insert(writer); }
    expect((await owner.query('select count(*)::int as n from fence_test.contract')).rows).toEqual([{ n: 4 }]);
  });
});

it.each(['died', 'cancelled', 'unknown', 'succeeded', 'failed'] as const)('rejects token A after %s for both roles', async outcome => {
  await fixture(async ({ store, owner, writers }) => {
    if (outcome === 'cancelled') expect(await store.requestWorkCancel({ id: workId, now })).toMatchObject({ ok: true, state: 'requested' });
    const result = outcome === 'succeeded' || outcome === 'failed'
      ? await store.finishSupervisedWork({ ...input, outcome })
      : await store.settleSupervisedAttempt({ ...input, outcome });
    expect(result).toEqual({ ok: true, outcome: 'done' });
    if (outcome === 'unknown') expect(await store.readWorkItem(workId)).toMatchObject({ currentAttemptToken: tokenA, completedAt: null });
    await refused(owner, writers);
    expect(await store.finishSupervisedWork({ ...input, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'lost' });
    expect((await owner.query('select * from fence_test.contract')).rows).toEqual([]);
  });
});

it('rejects reclaimed token A and admits replacement token B for both roles', async () => {
  await fixture(async ({ store, owner, writers, claim }) => {
    expect(await store.settleSupervisedAttempt({ ...input, outcome: 'died' })).toEqual({ ok: true, outcome: 'done' });
    await refused(owner, writers);
    await claim(tokenB);
    await refused(owner, writers);
    for (const writer of writers) { expect(await current(writer, workId, tokenB)).toBe(true); await insert(writer, tokenB); }
    expect((await owner.query('select attempt_token from fence_test.contract')).rows).toEqual([{ attempt_token: tokenB }, { attempt_token: tokenB }]);
  });
});

it('refuses wrong pairs, missing work or tokens and null arguments', async () => {
  await fixture(async ({ store, owner, writers }) => {
    const other = randomUUID();
    expect(await store.addWork({ id: other, kind: 'process_probe', targetKind: 'probe', targetId: 'other', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    await refused(owner, writers, tokenA, other);
    await refused(owner, writers, tokenA, randomUUID());
    await refused(owner, writers, randomUUID());
    await refused(owner, writers, null);
    await refused(owner, writers, tokenA, null);
    await refused(owner, writers, null, null);
    for (const writer of writers) {
      expect(await current(writer, null, tokenA)).toBe(false);
      expect(await current(writer, null, null)).toBe(false);
    }
    expect((await owner.query('select * from fence_test.contract')).rows).toEqual([]);
  });
});

it('supports default and renamed columns and reports missing configured columns', async () => {
  await fixture(async ({ owner, writers, role }) => {
    await owner.query(`create table fence_test.defaults (like fence_test.contract including all);
      create trigger defaults_attempt_fence before insert on fence_test.defaults for each row execute function brain.reject_stale_attempt();
      create table fence_test.renamed (id uuid primary key, job uuid, token uuid, body text);
      create trigger renamed_attempt_fence before insert on fence_test.renamed for each row execute function brain.reject_stale_attempt('job', 'token');
      grant insert on fence_test.defaults, fence_test.renamed to brain_app, ${role}`);
    for (const writer of writers) {
      await insert(writer, tokenA, workId, 'defaults');
      await writer.query('insert into fence_test.renamed values ($1, $2, $3, $4)', [randomUUID(), workId, tokenA, 'renamed']);
      await expect(writer.query('insert into fence_test.renamed values ($1, $2, $3, $4)', [randomUUID(), workId, null, 'null']))
        .rejects.toMatchObject({ code: 'BRS01' });
    }
    for (const [work, token] of [['missing_work', 'attempt_token'], ['work_item_id', 'missing_token']]) {
      await owner.query(`drop trigger contract_attempt_fence on fence_test.contract;
        create trigger contract_attempt_fence before insert on fence_test.contract
          for each row execute function brain.reject_stale_attempt('${work}', '${token}')`);
      for (const writer of writers) await expect(insert(writer)).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('missing configured column') });
    }
    expect((await owner.query('select * from fence_test.contract')).rows).toEqual([]);
  });
});

it('uses the database verdict when finishing a current attempt', async () => {
  await fixture(async ({ store, owner, writers }) => {
    expect(await current(writers[0]!)).toBe(true);
    const before = await owner.query('select * from brain.work_items');
    const attempts = await owner.query('select * from brain.work_attempts');
    await owner.query(`set role brain_owner;
      create or replace function brain.attempt_is_current(work_item_id uuid, attempt_token uuid)
      returns boolean language plpgsql volatile security definer set search_path = '' as $$ begin return false; end $$;
      reset role`);
    expect(await store.finishSupervisedWork({ ...input, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'lost' });
    expect((await owner.query('select * from brain.work_items')).rows).toEqual(before.rows);
    expect((await owner.query('select * from brain.work_attempts')).rows).toEqual(attempts.rows);
  });
});

it('keeps AD-22, definer ownership, empty search paths and privileges for a later role', async () => {
  await fixture(async ({ owner, role, writers }) => {
    const forbidden = /\b(?:serial|identity|current_timestamp|clock_timestamp|gen_random_uuid)\b|\bnow\s*\(/i;
    expect(await readFile(new URL('../migrations/0004_attempt_fence.sql', import.meta.url), 'utf8')).not.toMatch(forbidden);
    const { rows } = await owner.query(`select p.proname, p.prosecdef, p.provolatile, p.proconfig, r.rolname as owner, pg_get_functiondef(p.oid) as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
      where n.nspname = 'brain' and p.proname in ('attempt_is_current', 'reject_stale_attempt') order by p.proname`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ prosecdef: true, owner: 'brain_owner' });
      expect(row.proconfig).toContain('search_path=""');
      expect(row.body).not.toMatch(forbidden);
    }
    expect(rows[0]).toMatchObject({ proname: 'attempt_is_current', provolatile: 'v' });
    for (const name of ['brain_app', role]) {
      expect((await owner.query(`select has_function_privilege($1, 'brain.attempt_is_current(uuid,uuid)', 'EXECUTE') as execute`, [name])).rows)
        .toEqual([{ execute: true }]);
    }
    for (const table of ['brain.work_items', 'brain.work_attempts']) {
      expect((await owner.query("select has_table_privilege($1, $2, 'SELECT') as allowed", [role, table])).rows).toEqual([{ allowed: false }]);
    }
    expect((await owner.query('select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname=$1', [role])).rows)
      .toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
    // A trigger still works without schema access to brain at execution time.
    await owner.query(`revoke usage on schema brain from ${role}`);
    await insert(writers[1]!);
  });
});

async function waitBlocked(owner: pg.Client, name: string) {
  await expect.poll(async () => (await owner.query(`select exists (
    select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
    where a.datname = current_database() and a.application_name = $1 and not l.granted
      and cardinality(pg_blocking_pids(a.pid)) > 0) as blocked`, [name])).rows[0].blocked,
  { timeout: 2000 }).toBe(true);
}

it('waits for uncommitted settlement, then refuses the stale INSERT', async () => {
  await fixture(async ({ store, owner, writers }) => {
    let release!: () => void;
    let settled!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { settled = resolve; });
    const updates = new Set<unknown>();
    const barrier: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (node.kind === 'RawNode' && node.sqlFragments.join('').includes('update brain.work_items')) updates.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (updates.delete(queryId)) { settled(); await gate; }
        return result;
      },
    };
    const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: store.db.appUrl }) }), plugins: [barrier] });
    const settling = postgresWorkStore(() => ({ ok: true, connection: { db } }));
    const pending = settling.settleSupervisedAttempt({ ...input, outcome: 'died' });
    const inserts: Promise<unknown>[] = [];
    try {
      await acquired;
      for (const [i, writer] of writers.entries()) {
        await writer.query(`set application_name = 'fence-insert-${i}'`);
        // Attach the rejection handler before releasing the transaction barrier.
        inserts.push(expect(insert(writer)).rejects.toMatchObject({ code: 'BRS01' }));
        await waitBlocked(owner, `fence-insert-${i}`);
      }
      release();
      expect(await pending).toEqual({ ok: true, outcome: 'done' });
      await Promise.all(inserts);
      expect((await owner.query('select * from fence_test.contract')).rows).toEqual([]);
    } finally { release(); await Promise.allSettled([pending, ...inserts]); await db.destroy(); }
  });
});

it('holds both rows through INSERT commit, then allows finish to complete', async () => {
  await fixture(async ({ store, owner, writers }) => {
    const writer = writers[1]!;
    await writer.query('begin');
    await insert(writer);
    const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: store.db.appUrl, applicationName: 'fence-finish' }) }) });
    const finishing = postgresWorkStore(() => ({ ok: true, connection: { db } }));
    const pending = finishing.finishSupervisedWork({ ...input, outcome: 'succeeded' });
    try {
      await waitBlocked(owner, 'fence-finish');
      expect((await owner.query('select * from fence_test.contract')).rows).toEqual([]);
      await writer.query('commit');
      expect(await pending).toEqual({ ok: true, outcome: 'done' });
      expect((await owner.query('select count(*)::int as n from fence_test.contract')).rows).toEqual([{ n: 1 }]);
      await refused(owner, writers);
    } finally { await writer.query('rollback'); await pending; await db.destroy(); }
  });
});

it('also holds a share lock on the attempt row until the INSERT commits', async () => {
  await fixture(async ({ owner, writers }) => {
    const [locker, writer] = writers as [pg.Client, pg.Client];
    await writer.query('begin');
    await insert(writer);
    await locker.query("set application_name = 'fence-attempt-lock'");
    await locker.query('begin');
    const pending = locker.query('select token from brain.work_attempts where token = $1 for update', [tokenA]);
    try {
      await waitBlocked(owner, 'fence-attempt-lock');
      await writer.query('commit');
      expect((await pending).rows).toEqual([{ token: tokenA }]);
    } finally {
      await writer.query('rollback'); await pending; await locker.query('rollback');
    }
  });
});
