import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import { assertKoreanLines } from './language.js';
import { tempHomes } from './temp-home.js';

/**
 * `brain files redact` end to end: the built binary, a real SQLite file, and a
 * real `@`-attached text document under a temporary home.
 *
 * What only this level can show is the whole of the story: the gate saying how
 * many messages share the content before anything is written, the keyword
 * indexes going quiet, the blob the next drain deletes, the user's own file
 * left untouched, and the same bytes collected again never reviving the blob.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const temporary = tempHomes();
afterEach(() => temporary.cleanup());

beforeAll(() => {
  if (!existsSync(binPath)) {
    throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

/** A neutral word that appears in the document body and nowhere else. */
const NEEDLE = 'redactneedle';
const DOC_NAME = 'shared-note.txt';
const DOC_TEXT = `${NEEDLE} 공유 문서의 첫 줄입니다.\n`;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
  });
  delete environment['SECOND_BRAIN_DATABASE_URL'];
  delete environment['BRAIN_TEST_DATABASE_URL'];
  return environment;
}

function runBrain(
  args: readonly string[],
  home: string,
  stdin = '',
  environment: NodeJS.ProcessEnv = {},
): Promise<Run> {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env: { ...childEnvironment(home), ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(stdin);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function installedHome(): Promise<string> {
  const home = await temporary.create('brain-files-redact-');
  const install = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [installPath, '--yes'], {
      cwd: repoRoot,
      env: childEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  expect(install.code, install.stdout + install.stderr).toBe(0);
  return home;
}

function stopPayload(transcriptPath: string, sessionId = 'files-redact-session'): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: '/demo/repo',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

/**
 * A transcript where two user turns each `@`-attach the same text document, so
 * one `files` row is shared by two messages.
 */
async function fixture(home: string) {
  const sourceHome = join(home, 'source-home');
  const project = join(sourceHome, 'project');
  await mkdir(project, { recursive: true });
  const document = join(project, DOC_NAME);
  await writeFile(document, DOC_TEXT);
  const content = { type: 'text', file: { content: DOC_TEXT, numLines: 1, startLine: 1, totalLines: 1 } };
  const lines: unknown[] = [
    { type: 'user', uuid: 'turn-one', timestamp: '2026-10-26T00:00:00.000Z',
      message: { content: [{ type: 'text', text: '문서 읽기' }] } },
    { type: 'attachment', uuid: 'attach-one', parentUuid: 'turn-one',
      attachment: { type: 'file', filename: document, content } },
    { type: 'user', uuid: 'turn-two', timestamp: '2026-10-26T00:01:00.000Z',
      message: { content: [{ type: 'text', text: '같은 문서 다시' }] } },
    { type: 'attachment', uuid: 'attach-two', parentUuid: 'turn-two',
      attachment: { type: 'file', filename: document, content } },
  ];
  const transcript = join(home, 'files-redact.jsonl');
  await writeFile(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const original = { path: document, bytes: await readFile(document), mtime: (await stat(document)).mtimeMs };
  /**
   * A third turn attaching the same document, so the next collection meets an
   * attachment position nothing has filled: that is the one path that would
   * really call `files.put` again and revive a deleted blob.
   */
  const addTurn = async () => {
    const more: unknown[] = [
      { type: 'user', uuid: 'turn-three', timestamp: '2026-10-26T00:02:00.000Z',
        message: { content: [{ type: 'text', text: '세 번째로 같은 문서' }] } },
      { type: 'attachment', uuid: 'attach-three', parentUuid: 'turn-three',
        attachment: { type: 'file', filename: document, content } },
    ];
    await appendFile(transcript, more.map((line) => JSON.stringify(line)).join('\n') + '\n');
  };
  return { sourceHome, transcript, payload: stopPayload(transcript), original, addTurn };
}

function databaseIn(home: string): string {
  return join(home, 'brain.db');
}

/** Everything these cases read back, in one read-only open. */
function read(home: string) {
  const db = new DatabaseSync(databaseIn(home), { readOnly: true });
  try {
    const one = (sql: string, ...values: string[]): Record<string, unknown> | undefined =>
      db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
    const count = (sql: string, ...values: string[]): number =>
      Number((one(sql, ...values) as { n: number } | undefined)?.n ?? -1);
    const file = one('select id, content_hash, redacted_at, current_extraction_id, home_location_id from files') ?? {};
    return {
      fileId: String(file.id ?? ''),
      contentHash: String(file.content_hash ?? ''),
      redactedAt: file.redacted_at as string | null,
      currentExtraction: file.current_extraction_id as string | null,
      homeLocator: String((one('select locator from file_locations where ownership = ?', 'brain') ?? {}).locator ?? ''),
      locationDeletedAt: (one('select deleted_at from file_locations where ownership = ?', 'brain') ?? {}).deleted_at as string | null,
      files: count('select count(*) as n from files'),
      // A locator the ingest invents wrongly for a masked hash would be a
      // *second* live `brain` place whose blob nothing ever deletes, so the
      // count has to be part of what a re-collection leaves unchanged.
      locations: count('select count(*) as n from file_locations'),
      brainLocations: count("select count(*) as n from file_locations where ownership = 'brain'"),
      names: count('select count(*) as n from file_names'),
      metadata: count('select count(*) as n from file_metadata'),
      extractions: count('select count(*) as n from document_extractions'),
      chunks: count('select count(*) as n from document_chunks'),
      attachments: count('select count(*) as n from message_attachments'),
      redactions: db.prepare('select message_id, tool_note_id, file_id, start, "end", kind, content_hash from redactions').all(),
      chunkMatches: count('select count(*) as n from document_chunks_fts where document_chunks_fts match ?', `"${NEEDLE}"`),
      nameMatches: count('select count(*) as n from file_names_fts where file_names_fts match ?', `"${DOC_NAME}"`),
      openExtractWork: count("select count(*) as n from work_items where kind = 'document_extract' and completed_at is null"),
      blobWork: db.prepare("select target_id, completed_at is null as open from work_items where kind = 'blob_delete'").all(),
      messages: (db.prepare('select id from messages order by occurred_at, id').all() as { id: string }[]).map((row) => row.id),
      failures: db.prepare("select stage, code, resolved_at from failures where target_kind = 'file'").all(),
    };
  } finally {
    db.close();
  }
}

/** The collected state these cases start from: one shared file, read and named. */
async function seeded() {
  const home = await installedHome();
  const source = await fixture(home);
  const environment = { HOME: source.sourceHome };
  expect((await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, source.payload, environment)).code).toBe(0);
  expect((await runBrain(['queue', 'drain', '--json'], home, '', environment)).code).toBe(0);
  const before = read(home);
  expect(before.files).toBe(1);
  expect(before.attachments).toBe(2);
  expect(before.messages).toHaveLength(2);
  expect(before.chunkMatches).toBe(1);
  expect(before.nameMatches).toBeGreaterThan(0);
  expect(before.extractions).toBe(1);
  expect(before.redactedAt).toBe(null);
  expect(existsSync(join(home, 'files', before.homeLocator))).toBe(true);
  return { home, source, environment, before };
}

describe('brain files redact', () => {
  it('확인 없이는 공유 메시지 수를 말하고 아무것도 쓰지 않는다', async () => {
    const { home, environment, before } = await seeded();
    const bytes = await readFile(databaseIn(home));

    const gated = await runBrain(['files', 'redact', before.fileId, '--json'], home, '', environment);
    expect(gated.code).toBe(3);
    const envelope = JSON.parse(gated.stdout) as {
      error: { code: string; message: string; retry_argv?: string[]; retry?: { args: Record<string, unknown> } };
    };
    expect(envelope.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(envelope.error.message).toContain('메시지 2개');
    expect(envelope.error.retry_argv).toContain('--yes');
    expect(envelope.error.retry?.args).toEqual({ file: before.fileId, confirm: true });
    // A read of the sharing count is all it did: every row is where it was.
    expect(read(home)).toEqual(before);
    expect(await readFile(databaseIn(home))).toEqual(bytes);

    const text = await runBrain(['files', 'redact', before.fileId], home, '', environment);
    expect(text.code).toBe(3);
    assertKoreanLines(text.stderr, { allow: ['brain files redact'] });

    // A well-formed hash no file answers to: the format is fine, so this gets
    // past the check and the database says there is no such row.
    const hashed = await runBrain(['files', 'redact', `sha256:${'0'.repeat(64)}`, '--yes', '--json'], home, '', environment);
    expect(hashed.code).toBe(1);
    expect((JSON.parse(hashed.stdout) as { error: { code: string } }).error.code).toBe('FILE_NOT_FOUND');

    for (const argument of ['not-a-file', `sha256:${'A'.repeat(64)}`]) {
      const bad = await runBrain(['files', 'redact', argument, '--yes', '--json'], home, '', environment);
      expect(bad.code, argument).toBe(2);
      expect((JSON.parse(bad.stdout) as { error: { code: string } }).error.code).toBe('USAGE');
    }

    // An id in upper case is the same id: the check takes either case, so it
    // must not be handed to the store as a row nothing answers to.
    const upper = await runBrain(['files', 'redact', before.fileId.toUpperCase(), '--json'], home, '', environment);
    expect(upper.code, upper.stdout).toBe(3);
    expect((JSON.parse(upper.stdout) as { error: { message: string } }).error.message).toContain('메시지 2개');
    expect(read(home)).toEqual(before);
  }, 60_000);

  it('가리기와 drain은 조각·이름·블롭을 지우고 사용자 원본은 건드리지 않는다', async () => {
    const { home, source, environment, before } = await seeded();

    const masked = await runBrain(['files', 'redact', before.fileId, '--yes', '--json'], home, '', environment);
    expect(masked.code, masked.stdout + masked.stderr).toBe(0);
    const data = (JSON.parse(masked.stdout) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      file_id: before.fileId, messages: 2, already_redacted: false,
      extractions_removed: 1, chunks_removed: 1, metadata_removed: 0,
      blob_deletes_queued: 1, failures_resolved: 0,
    });
    expect(Number(data.names_removed)).toBeGreaterThan(0);

    const afterRedact = read(home);
    expect(afterRedact.redactedAt).not.toBe(null);
    expect(afterRedact.currentExtraction).toBe(null);
    expect([afterRedact.names, afterRedact.metadata, afterRedact.extractions, afterRedact.chunks]).toEqual([0, 0, 0, 0]);
    expect([afterRedact.chunkMatches, afterRedact.nameMatches]).toEqual([0, 0]);
    expect(afterRedact.redactions).toEqual([{ message_id: null, tool_note_id: null,
      file_id: before.fileId, start: null, end: null, kind: 'manual', content_hash: before.contentHash }]);
    // The attachment rows stay: the messages really did carry it.
    expect(afterRedact.attachments).toBe(2);
    expect(afterRedact.blobWork).toHaveLength(1);

    expect((await runBrain(['queue', 'drain', '--json'], home, '', environment)).code).toBe(0);
    const afterDrain = read(home);
    expect(afterDrain.locationDeletedAt).not.toBe(null);
    expect(existsSync(join(home, 'files', before.homeLocator))).toBe(false);
    // Nothing derived came back, and no reading was queued for it.
    expect([afterDrain.names, afterDrain.extractions, afterDrain.chunks]).toEqual([0, 0, 0]);
    expect([afterDrain.chunkMatches, afterDrain.nameMatches]).toEqual([0, 0]);
    expect(afterDrain.openExtractWork).toBe(0);

    // The user's own file is a record of where the bytes came from, never ours.
    expect(await readFile(source.original.path)).toEqual(source.original.bytes);
    expect((await stat(source.original.path)).mtimeMs).toBe(source.original.mtime);

    // Asking again is the repair path, not an error.
    const again = await runBrain(['files', 'redact', before.fileId, '--yes', '--json'], home, '', environment);
    expect(again.code, again.stdout).toBe(0);
    expect((JSON.parse(again.stdout) as { data: Record<string, unknown> }).data).toMatchObject({
      already_redacted: true, extractions_removed: 0, chunks_removed: 0, names_removed: 0,
      blob_deletes_queued: 0,
    });
    expect(read(home).redactions).toHaveLength(1);

    // The content hash is the name a person can work out from the original
    // bytes, and it has to do the same thing as the id. A home of its own,
    // because the by-id run above has already masked this one.
    const other = await seeded();
    expect(other.before.contentHash).toBe(before.contentHash);
    const byHash = await runBrain(['files', 'redact', other.before.contentHash, '--yes', '--json'],
      other.home, '', other.environment);
    expect(byHash.code, byHash.stdout + byHash.stderr).toBe(0);
    expect((JSON.parse(byHash.stdout) as { data: Record<string, unknown> }).data)
      .toEqual({ ...data, file_id: other.before.fileId });
    expect(read(other.home).redactedAt).not.toBe(null);
  }, 90_000);

  it('성공 출력은 한국어로 공유 수와 다음 drain을 말한다', async () => {
    const { home, environment, before } = await seeded();

    const masked = await runBrain(['files', 'redact', before.fileId, '--yes'], home, '', environment);
    expect(masked.code, masked.stdout + masked.stderr).toBe(0);
    assertKoreanLines(masked.stdout);
    expect(masked.stdout).toContain('메시지 2개');
    // The bytes are still on the disk until the queue runs, and the line says so.
    expect(masked.stdout).toContain('brain queue drain');
    expect(existsSync(join(home, 'files', before.homeLocator))).toBe(true);

    const again = await runBrain(['files', 'redact', before.fileId, '--yes'], home, '', environment);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    assertKoreanLines(again.stdout);
    expect(again.stdout).toContain('이미 가린 파일');
    expect(again.stdout).toContain('메시지 2개');
  }, 60_000);

  it('가린 뒤 다시 수집해도 블롭·이름·조각이 되살아나지 않는다', async () => {
    const { home, source, environment, before } = await seeded();
    expect((await runBrain(['files', 'redact', before.fileId, '--yes', '--json'], home, '', environment)).code).toBe(0);
    expect((await runBrain(['queue', 'drain', '--json'], home, '', environment)).code).toBe(0);
    expect(existsSync(join(home, 'files', before.homeLocator))).toBe(false);

    // The same transcript again, and then a third turn attaching the same
    // document: a position nothing has filled, which is what would really put.
    expect((await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, source.payload, environment)).code).toBe(0);
    await source.addTurn();
    expect((await runBrain(['sessions', 'ingest', 'claude-code', '--json'], home, source.payload, environment)).code).toBe(0);
    for (const _ of [0, 1]) {
      expect((await runBrain(['queue', 'drain', '--json'], home, '', environment)).code).toBe(0);
    }
    const retried = await runBrain(['failures', 'retry', '--json'], home, '', environment);
    expect(retried.code, retried.stdout + retried.stderr).toBe(0);

    const after = read(home);
    // The blob is not written back to the locator whose row says it is gone.
    expect(existsSync(join(home, 'files', before.homeLocator))).toBe(false);
    expect(after.files).toBe(1);
    // The third attachment row is there and points at the masked file.
    expect(after.attachments).toBe(3);
    // And at the same places: a locator the ingest invented differently would
    // be a second live `brain` row whose blob nothing would ever delete.
    expect([after.locations, after.brainLocations]).toEqual([before.locations, before.brainLocations]);
    expect(after.homeLocator).toBe(before.homeLocator);
    expect(after.locationDeletedAt).not.toBe(null);
    expect([after.names, after.extractions, after.chunks]).toEqual([0, 0, 0]);
    expect([after.chunkMatches, after.nameMatches]).toEqual([0, 0]);
    expect(after.openExtractWork).toBe(0);
    expect(after.redactions).toHaveLength(1);
  }, 90_000);

  it('messages redact는 가리지 않은 첨부를 경고하고 파일을 가린 뒤에는 조용하다', async () => {
    const { home, environment, before } = await seeded();
    const message = before.messages[0]!;

    const warned = await runBrain(['messages', 'redact', message, '--detected', '--yes', '--json'], home, '', environment);
    expect(warned.code, warned.stdout + warned.stderr).toBe(0);
    const first = JSON.parse(warned.stdout) as { warnings: string[]; data: { unredacted_attachments: number } };
    expect(first.warnings).toContain('ATTACHMENT_NOT_REDACTED');
    expect(first.data.unredacted_attachments).toBe(1);

    const spoken = await runBrain(['messages', 'redact', message, '--detected', '--yes'], home, '', environment);
    expect(spoken.code).toBe(0);
    assertKoreanLines(spoken.stdout, { allow: ['brain files redact', 'ATTACHMENT_NOT_REDACTED'] });

    expect((await runBrain(['files', 'redact', before.fileId, '--yes', '--json'], home, '', environment)).code).toBe(0);
    const quiet = await runBrain(['messages', 'redact', message, '--detected', '--yes', '--json'], home, '', environment);
    expect(quiet.code, quiet.stdout + quiet.stderr).toBe(0);
    const second = JSON.parse(quiet.stdout) as { warnings: string[]; data: { unredacted_attachments: number } };
    expect(second.warnings).not.toContain('ATTACHMENT_NOT_REDACTED');
    expect(second.data.unredacted_attachments).toBe(0);
  }, 60_000);
});
