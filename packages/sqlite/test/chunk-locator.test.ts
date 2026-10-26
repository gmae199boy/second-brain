import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeChunkLocator, encodeChunkLocator } from '@second-brain/core';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';

/**
 * Core's locator codec against the column it was written for (AD-24).
 *
 * The unit tests say what the codec produces; this says that what it produces
 * is what `document_chunks` takes — the canonical text through
 * `document_chunks_locator_check` and the `page` copy through the `page is
 * (case ...)` half of it. It also holds the other direction: the database is
 * deliberately the wider of the two, so a spelling it accepts and the codec
 * refuses is written here on purpose, to show where the rest of the validation
 * lives.
 */

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01960000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

/** `sha256:` and 64 lower-case hex digits, which is what `files` accepts (AD-23). */
function hash(ordinal: number): string {
  return `sha256:${ordinal.toString(16).padStart(2, '0').repeat(32)}`;
}

const ids = { file: id(10), extraction: id(11) };
const SEEDED_AT = '2026-02-03T04:05:06.000Z';
const LATER = '2026-02-03T04:05:07.000Z';
const EXTRACTOR = 'doc/1+demo-0.0.0';

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type Row = Readonly<Record<string, string | number | null>>;

/** Quote every identifier, because `end` and `start` are column names. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function insert(connection: SqliteConnection, table: string, row: Row): void {
  const columns = Object.keys(row);
  connection.database
    .prepare(
      `insert into ${quote(table)} (${columns.map(quote).join(', ')})
            values (${columns.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(row) as SQLInputValue[]));
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-locator-'));
  directories.push(directory);
  const path = join(directory, 'brain.db');
  expect(await runSqliteMigrations({ path })).toMatchObject({ ok: true, to: 8 });
  return path;
}

describe('Core의 조각 위치 코덱과 document_chunks (AD-24)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    const opened = openSqlite({ path: await migratedPath(), busyTimeoutMs: 3000 });
    if (!opened.ok) throw new Error(`could not open the database: ${opened.message}`);
    connections.push(opened.connection);
    connection = opened.connection;
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
    insert(connection, 'document_extractions', {
      id: ids.extraction,
      file_id: ids.file,
      extractor_version: EXTRACTOR,
      attempt: 1,
      status: 'ok',
      started_at: SEEDED_AT,
      finished_at: LATER,
    });
  });

  const pieces = [
    { name: 'text 범위', input: { end: 12, start: 0, type: 'text' } },
    { name: 'docx 블록', input: { type: 'docx', block: 3 } },
    { name: 'bbox 없는 pdf 쪽', input: { page: 4, type: 'pdf' } },
    { name: '소수 bbox가 있는 pdf 쪽', input: { bbox: [0.1, 0.2, 0.5, 0.75], page: 7, type: 'pdf' } },
  ];

  it('코덱이 낸 위치와 page 사본을 모두 받아들이고, 읽은 값이 코덱 문자열과 같다', () => {
    const written: { page: number | null; chunk_locator: string }[] = [];
    pieces.forEach(({ input }, ordinal) => {
      const encoded = encodeChunkLocator(input);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;
      insert(connection, 'document_chunks', {
        id: id(500 + ordinal),
        extraction_id: ids.extraction,
        ordinal,
        page: encoded.page,
        body: `a piece of the document (${ordinal})`,
        chunk_locator: encoded.text,
      });
      written.push({ page: encoded.page, chunk_locator: encoded.text });
    });
    expect(written).toHaveLength(pieces.length);
    expect(
      connection.database
        .prepare('select page, chunk_locator from document_chunks order by ordinal')
        .all(),
    ).toEqual(written);
  });

  it('저장된 철자를 코덱이 다시 읽으면 같은 위치가 된다', () => {
    const rows = connection.database
      .prepare('select chunk_locator from document_chunks order by ordinal')
      .all() as { chunk_locator: string }[];
    expect(rows).toHaveLength(pieces.length);
    rows.forEach(({ chunk_locator }, ordinal) => {
      const piece = pieces[ordinal];
      expect(piece).toBeDefined();
      const decoded = decodeChunkLocator(chunk_locator);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || piece === undefined) return;
      expect(decoded.text).toBe(chunk_locator);
      expect(encodeChunkLocator(piece.input)).toEqual(decoded);
    });
  });

  it.each([
    { name: '키 순서가 다른 철자', locator: '{"type":"text","end":12,"start":0}' },
    { name: '필수 키가 없는 철자', locator: '{"type":"text"}' },
  ])('DB는 받지만 Core가 거부하는 철자: $name', ({ locator }) => {
    const ordinal = 100 + locator.length;
    insert(connection, 'document_chunks', {
      id: id(600 + locator.length),
      extraction_id: ids.extraction,
      ordinal,
      page: null,
      body: 'a piece written by something other than the codec',
      chunk_locator: locator,
    });
    expect(
      connection.database
        .prepare('select chunk_locator from document_chunks where ordinal = ?')
        .get(ordinal),
    ).toEqual({ chunk_locator: locator });
    expect(decodeChunkLocator(locator)).toMatchObject({ ok: false });
  });
});
