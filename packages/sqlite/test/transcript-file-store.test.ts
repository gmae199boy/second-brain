import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sampleTranscriptFileInput,
  transcriptFileStoreContract,
} from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

/**
 * The transcript-history capability against the file this package writes: the
 * contract, and the column values a contract cannot see — the cursor stored as
 * two columns, and the instant in the canonical spelling of AD-13.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-transcripts-'));
  directories.push(directory);
  const path = join(directory, 'brain.db');
  const migrated = await runSqliteMigrations({ path });
  expect(migrated.ok).toBe(true);
  return path;
}

/** Every row of `transcript_files`, read without writing. */
function rows(path: string): Record<string, unknown>[] {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(opened.message);
  try {
    return opened.connection.database
      .prepare('select * from transcript_files order by path')
      .all() as Record<string, unknown>[];
  } finally {
    void opened.connection.close();
  }
}

describe('the transcript history contract against the SQLite store', () => {
  for (const testCase of transcriptFileStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => sqliteStore({ path: await migratedPath() }));
    });
  }
});

describe('what the SQLite adapter puts in the columns', () => {
  it('stores the cursor as its two columns and the instant in the stored form', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      const input = sampleTranscriptFileInput();
      expect(await store.recordTranscriptFile(input)).toMatchObject({ ok: true });
    } finally {
      await store.close();
    }

    expect(rows(path)).toEqual([
      {
        id: sampleTranscriptFileInput().id,
        harness: 'demo',
        path: sampleTranscriptFileInput().path,
        size_bytes: 1024,
        fingerprint: sampleTranscriptFileInput().fingerprint,
        last_harness_message_id: 'm2',
        cursor_fingerprint: `sha256:${'b'.repeat(64)}`,
        // Exactly 24 characters, never an offset (AD-13).
        scanned_at: '2026-02-03T04:05:06.000Z',
      },
    ]);
  });

  it('stores both halves of a missing cursor as null, which the check requires', async () => {
    // The table's own `check ((last_harness_message_id is null) = (cursor_fingerprint
    // is null))`: half a cursor is a cursor no parse could start from, so a row
    // that tried to store one would be refused by the database (0001).
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect(
        await store.recordTranscriptFile(sampleTranscriptFileInput({ cursor: null })),
      ).toMatchObject({ ok: true });
    } finally {
      await store.close();
    }

    expect(rows(path)[0]).toMatchObject({
      last_harness_message_id: null,
      cursor_fingerprint: null,
    });
  });

  it('answers DB_UNAVAILABLE for a file that is not there, and never makes one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-transcripts-'));
    directories.push(directory);
    const store = sqliteStore({ path: join(directory, 'missing.db') });
    try {
      expect(await store.listTranscriptFiles({ harness: 'demo' })).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
      expect(await store.recordTranscriptFile(sampleTranscriptFileInput())).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
    } finally {
      await store.close();
    }
  });
});
