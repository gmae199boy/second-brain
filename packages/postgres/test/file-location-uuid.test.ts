import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { postgresStore } from '../src/index.js';
import { postgresAttachmentStore } from '../src/attachments.js';
import { database } from './fixture.js';

const fileId = 'abcdef01-2345-6789-abcd-ef0123456789';
const locationId = 'abcdef02-2345-6789-abcd-ef0123456789';
const missing = 'abcdef03-2345-6789-abcd-ef0123456789';
const at = new Date('2026-01-02T03:04:05.000Z');
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const db = await database(); cleanups.push(() => db.drop());
  await db.query(`insert into brain.files (id, content_hash, size_bytes, first_seen_at) values ('${fileId}', 'sha256:${'a'.repeat(64)}', 1, '2026-01-01Z')`);
  await db.query(`insert into brain.file_locations (id, file_id, store_kind, locator, ownership, first_seen_at) values
    ('${locationId}', '${fileId}', 'local', 'z', 'external', '2026-01-01Z'),
    ('abcdef04-2345-6789-abcd-ef0123456789', '${fileId}', 'local', 'b', 'brain', '2026-01-01Z'),
    ('abcdef05-2345-6789-abcd-ef0123456789', '${fileId}', 'local', 'a', 'brain', '2026-01-01Z')`);
  const store = postgresStore({ databaseUrl: db.appUrl }); cleanups.push(() => store.close());
  const client = new pg.Client({ connectionString: db.appUrl }); await client.connect(); cleanups.push(() => client.end());
  return { db, store, client };
}
const notFound = { ok: false, code: 'FILE_LOCATION_NOT_FOUND', message: '파일 위치가 없습니다' };
const spellings = (id: string) => [id, missing, id.toUpperCase(), `Ab${id.slice(2)}`, `{${id}}`, id.replaceAll('-', ''), ` ${id}`, `${id} `, `${id}\n`, 'not-a-uuid', '', null, undefined];
const columns = 'id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt"';

it('matches the original text predicates for read, list, and first/repeated mark, including runtime boundary values', async () => {
  const { db, store, client } = await fixture();
  for (const [location, file] of spellings(locationId).map((value, i) => [value, spellings(fileId)[i]] as const)) {
    // The oracle uses the baseline SQL against the same database, independently
    // of the production predicate and without committing its write.
    const read = await client.query(`select ${columns} from brain.file_locations where id::text = $1`, [location]);
    const list = await client.query(`select ${columns} from brain.file_locations where file_id::text = $1 order by ownership collate "C", locator collate "C"`, [file]);
    expect(await store.readFileLocation(location as string)).toEqual(read.rows[0] ? { ok: true, location: read.rows[0] } : notFound);
    expect(await store.listFileLocations(file as string)).toEqual({ ok: true, locations: list.rows });
    const before = await db.rows('select id, deleted_at from brain.file_locations order by id');
    for (let repetition = 0; repetition < 2; repetition++) {
      await client.query('begin');
      const updated = await client.query('update brain.file_locations set deleted_at = $1 where id::text = $2 and deleted_at is null returning id', [at, location]);
      const selected = await client.query('select deleted_at from brain.file_locations where id::text = $1', [location]);
      await client.query('rollback');
      const row = selected.rows[0];
      expect(await store.markFileLocationDeleted({ id: location as string, deletedAt: at })).toEqual(row ? { ok: true, deletedAt: row.deleted_at, marked: updated.rowCount! > 0 } : notFound);
    }
    const after = await db.rows('select id, deleted_at from brain.file_locations order by id');
    if (location !== locationId) expect(after).toEqual(before);
    else {
      expect(after.filter(row => row.id !== locationId)).toEqual(before.filter(row => row.id !== locationId));
      expect(after.find(row => row.id === locationId)?.deleted_at).not.toBeNull();
    }
  }
});

it('validates the timestamp before a missing or noncanonical mark and leaves rows intact', async () => {
  const { db, store } = await fixture();
  const before = await db.rows('select * from brain.file_locations order by id');
  for (const id of [missing, locationId.toUpperCase(), '', null, undefined]) {
    expect(await store.markFileLocationDeleted({ id: id as string, deletedAt: new Date(NaN) })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('file_locations.deleted_at') });
  }
  expect(await db.rows('select * from brain.file_locations order by id')).toEqual(before);
});

it('preserves connect failure precedence and write failures even for noncanonical IDs', async () => {
  const unavailable = postgresAttachmentStore(() => ({ ok: false, message: 'synthetic connect failure' }));
  const failure = { ok: false, code: 'DB_UNAVAILABLE', message: 'synthetic connect failure' };
  expect(await unavailable.readFileLocation('bad')).toEqual(failure);
  expect(await unavailable.listFileLocations('bad')).toEqual(failure);
  expect(await unavailable.markFileLocationDeleted({ id: 'bad', deletedAt: new Date(NaN) })).toEqual(failure);
  const { db, store } = await fixture();
  const before = await db.rows('select * from brain.file_locations order by id');
  await db.query('revoke update on brain.file_locations from brain_app');
  for (const id of [locationId, 'bad', missing, null, undefined]) {
    expect(await store.markFileLocationDeleted({ id: id as string, deletedAt: at })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('permission denied') });
  }
  expect(await db.rows('select * from brain.file_locations order by id')).toEqual(before);
});
