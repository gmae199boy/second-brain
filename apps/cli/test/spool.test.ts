import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPOOL_CLAIM_STALE_MS,
  encodeSpoolLine,
  type Clock,
  type SpoolRecord,
} from 'second_brain';
import { sampleSpoolRecord, spoolContract } from 'second_brain/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileSpool } from '../src/runtime/spool.js';
import { tempHomes } from './temp-home.js';

/**
 * The file spool against the real filesystem (AD-9).
 *
 * Nothing is mocked but the clock and the question "is that process alive":
 * the whole mechanism *is* the file names and the renames between them, so a
 * fake filesystem would prove nothing. The one case that needs a second
 * process — a drain killed between the claim and the replay — gets one.
 */

const claimerPath = fileURLToPath(new URL('./fixtures/spool-claimer.mjs', import.meta.url));
const distSpool = fileURLToPath(new URL('../dist/runtime/spool.js', import.meta.url));

const temporary = tempHomes();

async function scratch(): Promise<string> {
  const folder = await temporary.create('brain-spool-');
  return folder;
}

/** A spool folder path inside a scratch directory, not yet created. */
async function spoolFolder(): Promise<string> {
  return join(await scratch(), 'spool');
}

/** A clock a test moves by hand, for the ten-minute rule. */
function movableClock(start: Date): Clock & { advance(ms: number): void } {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const INSTANT = new Date('2026-01-02T03:06:00.000Z');

afterEach(() => temporary.cleanup());

describe('the spool contract against the file spool', () => {
  for (const testCase of spoolContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () =>
        fileSpool({ folder: await spoolFolder(), clock: { now: () => INSTANT } }),
      );
    });
  }
});

describe('the files the spool writes', () => {
  it('makes the folder on the first append, and not before', async () => {
    const folder = await spoolFolder();

    // Building it opens nothing: a brain whose database has always been
    // reachable never has a spool folder at all (AD-3).
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    expect(existsSync(folder)).toBe(false);

    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    expect(existsSync(folder)).toBe(true);
  });

  it('leaves one whole `.jsonl` file per append, and no `.open` behind', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT }, pid: 4242 });

    const appended = await spool.append([sampleSpoolRecord()]);
    expect(appended).toMatchObject({ ok: true });

    const names = await readdir(folder);
    expect(names).toHaveLength(1);
    const [name] = names;
    // `<compact occurred_at>-<pid>-<serial>`: the instant first, so the name
    // order is the time order, and the pid so two processes cannot collide.
    // The serial itself is this process's own count and no test's business.
    expect(name).toMatch(/^20260102T030600000Z-4242-\d+\.jsonl$/);
    expect(await readFile(join(folder, name ?? ''), 'utf8')).toBe(
      encodedLine(sampleSpoolRecord()),
    );
  });

  it('numbers two appends in the same millisecond apart', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT }, pid: 4242 });

    await spool.append([sampleSpoolRecord()]);
    await spool.append([sampleSpoolRecord()]);

    const names = await readdir(folder);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toMatch(/^20260102T030600000Z-4242-\d+\.jsonl$/);
    }
  });

  it('keeps two spools of one process over one folder apart', async () => {
    // One process builds more than one `fileSpool` over the same folder: the
    // dispatcher's, which the SDK writes through, and the one the `spool`
    // doctor check reports on. With a counter per spool they would both mint
    // `<instant>-<pid>-0`, and the rename that publishes the second file would
    // replace the first — a write lost with both appends answering ok.
    const folder = await spoolFolder();
    const clock = { now: () => INSTANT };
    const ofTheSdk = fileSpool({ folder, clock, pid: 4242 });
    const ofTheCheck = fileSpool({ folder, clock, pid: 4242 });

    expect(await ofTheSdk.append([sampleSpoolRecord({ id: FIRST_ID })])).toMatchObject({
      ok: true,
    });
    expect(await ofTheCheck.append([sampleSpoolRecord({ id: SECOND_ID })])).toMatchObject({
      ok: true,
    });

    expect(await readdir(folder)).toHaveLength(2);
    expect(await ofTheSdk.stats()).toMatchObject({ ok: true, records: 2 });
  });

  it('names a file after the first record it holds, so the order is the time order', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT }, pid: 1 });

    await spool.append([sampleSpoolRecord({ occurredAt: new Date('2026-01-02T04:00:00.000Z') })]);
    await spool.append([sampleSpoolRecord({ occurredAt: new Date('2026-01-02T03:00:00.000Z') })]);

    // Oldest first, whichever order the appends happened in: a drain walks the
    // names and gets the records in the order they were made.
    const claimed = await spool.claim();
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    expect(claimed.claim.handle).toContain('20260102T030000000Z');
  });

  it('writes the mode 0600 under a 0700 folder', async () => {
    // The spool holds writes nobody else has a copy of, so it is this user's
    // alone — the same rule the store file and the file store follow (AD-10).
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord()]);

    const { stat } = await import('node:fs/promises');
    expect(((await stat(folder)).mode & 0o777).toString(8)).toBe('700');
    const [name] = await readdir(folder);
    expect(((await stat(join(folder, name ?? ''))).mode & 0o777).toString(8)).toBe('600');
  });

  it('refuses to write where the folder cannot be made, and says why', async () => {
    // The matrix row: a plain file where the spool folder belongs.
    const parent = await scratch();
    const folder = join(parent, 'spool');
    await writeFile(folder, 'not a folder\n', 'utf8');
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });

    const appended = await spool.append([sampleSpoolRecord()]);

    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.message).toContain('spool');
    // And a report about it is a failed check rather than a throw.
    expect(await spool.stats()).toMatchObject({ ok: false });
  });
});

describe('a spool file that is still being written', () => {
  it('is never claimed and never counted', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    // One append, so the folder exists, then the `.open` name by hand: a
    // process that is mid-write is exactly this, and no test can catch the
    // real window because the rename is atomic.
    await spool.append([sampleSpoolRecord()]);
    const claimed = await spool.claim();
    expect(claimed).toMatchObject({ ok: true });
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.complete(claimed.claim.handle);

    await writeFile(
      join(folder, '20260102T030600000Z-9999-0.jsonl.open'),
      encodedLine(sampleSpoolRecord()),
      'utf8',
    );

    expect(await spool.claim()).toEqual({ ok: true, claim: null });
    expect(await spool.stats()).toEqual({ ok: true, records: 0, earliest: null, failed: 0 });
    // And it is still there: only the process writing it may touch it.
    expect(await readdir(folder)).toEqual(['20260102T030600000Z-9999-0.jsonl.open']);
  });
});

describe('a claim nobody will finish', () => {
  beforeAll(() => {
    if (!existsSync(distSpool)) {
      throw new Error(`${distSpool} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('is taken back once the process that made it is gone', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord()]);

    // A real second process, with a real pid, claiming through the real
    // adapter — and then killed, which is what a drain that was stopped mid
    // replay leaves behind.
    const child = spawn(process.execPath, [claimerPath, folder], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle = await firstLine(child);
    expect(handle).toContain('.claiming');
    expect(handle).toContain(`.${String(child.pid)}-`);
    // Nothing else may take it while that process is alive.
    expect(await spool.claim()).toEqual({ ok: true, claim: null });

    child.kill('SIGKILL');
    await closed(child);

    const again = await spool.claim();
    expect(again.ok).toBe(true);
    if (!again.ok || again.claim === null) throw new Error('the dead claim was not taken back');
    expect(again.claim.lines).toEqual([encodedLine(sampleSpoolRecord()).trimEnd()]);
  });

  it('is taken back after ten minutes even when the process is alive', async () => {
    const folder = await spoolFolder();
    const clock = movableClock(INSTANT);
    // A claimer this test says is alive for ever, so age is the only thing
    // that can give the file back.
    const drain = fileSpool({ folder, clock, pid: 111, isAlive: () => true });
    const other = fileSpool({ folder, clock, pid: 222, isAlive: () => true });
    await drain.append([sampleSpoolRecord()]);
    expect(await drain.claim()).toMatchObject({ ok: true, claim: { lines: [expect.any(String)] } });

    // One millisecond short, and it is still that drain's file.
    clock.advance(SPOOL_CLAIM_STALE_MS - 1);
    expect(await other.claim()).toEqual({ ok: true, claim: null });

    clock.advance(1);
    const taken = await other.claim();
    expect(taken.ok).toBe(true);
    if (!taken.ok || taken.claim === null) throw new Error('the stale claim was not taken back');
    // And it is the second drain's claim now, under its own pid.
    expect(taken.claim.handle).toContain('.222-');
  });

  it('still counts towards the spool while it is held', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord()]);
    expect(await spool.claim()).toMatchObject({ ok: true });

    // A record somebody is in the middle of replaying has still not reached
    // the database, so doctor must not report the spool as empty (AD-9).
    expect(await spool.stats()).toMatchObject({ ok: true, records: 1 });
  });
});

describe('two drains over one spool', () => {
  it('gives each file to exactly one of them', async () => {
    const folder = await spoolFolder();
    const clock = { now: () => INSTANT };
    const writer = fileSpool({ folder, clock, pid: 1 });
    await writer.append([sampleSpoolRecord({ id: FIRST_ID })]);
    await writer.append([sampleSpoolRecord({ id: SECOND_ID })]);

    const left = fileSpool({ folder, clock, pid: 101, isAlive: () => true });
    const right = fileSpool({ folder, clock, pid: 202, isAlive: () => true });
    const [a, b] = await Promise.all([left.claim(), right.claim()]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const handles = [a.claim?.handle, b.claim?.handle].filter(
      (handle): handle is string => handle !== undefined,
    );
    // Two files, so both got one — and never the same one, whichever way the
    // two renames happened to interleave.
    expect(handles).toHaveLength(2);
    expect(new Set(handles).size).toBe(2);
  });

  it('leaves one of them empty-handed rather than failing, for a single file', async () => {
    const folder = await spoolFolder();
    const clock = { now: () => INSTANT };
    const writer = fileSpool({ folder, clock, pid: 1 });
    await writer.append([sampleSpoolRecord()]);

    const left = fileSpool({ folder, clock, pid: 101, isAlive: () => true });
    const right = fileSpool({ folder, clock, pid: 202, isAlive: () => true });
    const [a, b] = await Promise.all([left.claim(), right.claim()]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // One claim, one `null`. Losing the race is not a failure: the other drain
    // has the file, and `ENOENT` on the rename is how that is found out.
    const claims = [a.claim, b.claim].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
  });

  it('puts a released file back where the other one finds it', async () => {
    const folder = await spoolFolder();
    const clock = { now: () => INSTANT };
    const left = fileSpool({ folder, clock, pid: 101, isAlive: () => true });
    const right = fileSpool({ folder, clock, pid: 202, isAlive: () => true });
    await left.append([sampleSpoolRecord()]);

    const claimed = await left.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    expect(await right.claim()).toEqual({ ok: true, claim: null });
    expect(await left.release(claimed.claim.handle)).toEqual({ ok: true });

    const taken = await right.claim();
    expect(taken.ok).toBe(true);
    if (!taken.ok || taken.claim === null) throw new Error('the released file was not claimed');
    expect(taken.claim.lines).toEqual(claimed.claim.lines);
    // Back under the name it had, so nothing accumulates: one file in, one out.
    expect(await readdir(folder)).toHaveLength(1);
  });

  it('treats a file somebody else already completed as completed', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord()]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');

    expect(await spool.complete(claimed.claim.handle)).toEqual({ ok: true });
    // A drain whose claim went stale, was reclaimed and was completed by
    // somebody else has nothing left to remove. That is done, not broken.
    expect(await spool.complete(claimed.claim.handle)).toEqual({ ok: true });
  });

  it('refuses a release of something that is not a claimed name', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });

    expect(await spool.release(join(folder, 'nonsense.jsonl'))).toMatchObject({ ok: false });
  });
});

describe('what the spool reports to doctor', () => {
  it('counts every waiting record and the earliest instant among them', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    const older = new Date('2026-01-02T03:04:05.000Z');
    await spool.append([
      sampleSpoolRecord({ id: FIRST_ID, occurredAt: INSTANT }),
      sampleSpoolRecord({ id: SECOND_ID, occurredAt: older }),
    ]);
    await spool.append([sampleSpoolRecord({ id: THIRD_ID, occurredAt: INSTANT })]);

    expect(await spool.stats()).toEqual({ ok: true, records: 3, earliest: older, failed: 0 });
  });

  it('reports an empty folder, and a folder that is not there, as nothing waiting', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });

    expect(await spool.stats()).toEqual({ ok: true, records: 0, earliest: null, failed: 0 });

    await spool.append([sampleSpoolRecord()]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.complete(claimed.claim.handle);

    expect(await spool.stats()).toEqual({ ok: true, records: 0, earliest: null, failed: 0 });
  });

  it('counts a line it cannot read, and reports the count with no instant', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord()]);
    // A line from a build this one does not know, which is the shape an
    // unreadable line really takes.
    const [name] = await readdir(folder);
    await writeFile(
      join(folder, name ?? ''),
      encodedLine(sampleSpoolRecord()).replace('"schema_version":1', '"schema_version":99'),
      'utf8',
    );

    // Counted, because it is still a write that has not landed; no instant,
    // because nothing here could read one. Saying the count is more than
    // refusing to say either (NFR-2).
    expect(await spool.stats()).toEqual({ ok: true, records: 1, earliest: null, failed: 0 });
  });
});

describe('a file only some of whose lines went back in', () => {
  it('leaves the kept lines waiting and the given-up ones in failed/', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([
      sampleSpoolRecord({ id: FIRST_ID }),
      sampleSpoolRecord({ id: SECOND_ID }),
      sampleSpoolRecord({ id: THIRD_ID }),
    ]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    const [, second, third] = claimed.claim.lines;
    if (second === undefined || third === undefined) throw new Error('three lines were expected');

    expect(await spool.rewrite(claimed.claim.handle, { keep: [second], failed: [third] })).toEqual({
      ok: true,
    });

    // The claimed file is gone, one `.jsonl` is waiting, and the line nobody
    // will try again is under `failed/`.
    const names = (await readdir(folder)).sort();
    expect(names.filter((name) => name.endsWith('.claiming'))).toEqual([]);
    expect(names.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    expect(names).toContain('failed');
    expect(await spool.stats()).toMatchObject({ ok: true, records: 1, failed: 1 });

    const again = await spool.claim();
    if (!again.ok || again.claim === null) throw new Error('the kept line was not claimable');
    expect(again.claim.lines).toEqual([second]);
  });

  it('names the kept lines by when they are due, and hands them over only then', async () => {
    const folder = await spoolFolder();
    const clock = movableClock(INSTANT);
    const spool = fileSpool({ folder, clock });
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');

    const due = new Date(INSTANT.getTime() + 60_000);
    expect(
      await spool.rewrite(claimed.claim.handle, {
        keep: [...claimed.claim.lines],
        failed: [],
        keepDueAt: due,
      }),
    ).toEqual({ ok: true });

    // The name starts with the due instant and carries the retry mark, so it
    // sorts behind every file already waiting (AD-9).
    const names = await readdir(folder);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^20260102T030700000Z-\d+-\d+-r\.jsonl$/);

    // Not before its time, and then like any other file.
    expect(await spool.claim()).toEqual({ ok: true, claim: null });
    expect(await spool.stats()).toMatchObject({ ok: true, records: 1 });
    clock.advance(60_000);
    const again = await spool.claim();
    if (!again.ok || again.claim === null) throw new Error('the kept line was not claimable when due');
    expect(again.claim.lines).toEqual(claimed.claim.lines);
  });

  it('writes no waiting file when there is nothing to keep', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    const [only] = claimed.claim.lines;
    if (only === undefined) throw new Error('one line was expected');

    expect(await spool.rewrite(claimed.claim.handle, { keep: [], failed: [only] })).toEqual({
      ok: true,
    });

    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, failed: 1 });
    expect(await spool.claim()).toEqual({ ok: true, claim: null });
  });

  it('counts a failed file a killed process left half published', async () => {
    // A process killed between writing `failed/<…>.jsonl.open` and renaming it
    // leaves a file nothing will ever publish. It is counted all the same: a
    // write that will never reach the database must not be silent (NFR-2).
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.complete(claimed.claim.handle);
    const failedFolder = join(folder, 'failed');
    await mkdir(failedFolder, { recursive: true });
    await writeFile(
      join(failedFolder, '20260102T030600000Z-9999-0.jsonl.open'),
      encodedLine(sampleSpoolRecord()),
      'utf8',
    );

    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, failed: 1 });
  });

  it('refuses a handle that is not a claimed file', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });

    expect(await spool.rewrite(join(folder, 'not-a-claim.jsonl'), { keep: [], failed: [] })).toMatchObject({
      ok: false,
    });
  });

  it('never hands a line under failed/ to a claim, and counts it apart', async () => {
    const folder = await spoolFolder();
    const spool = fileSpool({ folder, clock: { now: () => INSTANT } });
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.rewrite(claimed.claim.handle, { keep: [], failed: claimed.claim.lines });

    // `failed/` is a folder inside the spool, and no claim may reach into it:
    // those lines are kept so nothing is lost, not so they are tried again.
    expect(await spool.claim()).toEqual({ ok: true, claim: null });
    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, failed: 1 });
  });
});

describe('a `.open` file nobody will finish writing', () => {
  it('is moved to failed/ once its process is gone and it is old enough', async () => {
    const folder = await spoolFolder();
    const clock = movableClock(INSTANT);
    const spool = fileSpool({ folder, clock, pid: 1, isAlive: (pid) => pid !== 9999 });
    // One append, so the folder exists, then the orphan by hand: the real
    // window cannot be caught, because the rename that ends it is atomic.
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.complete(claimed.claim.handle);
    const orphan = '20260102T030600000Z-9999-0.jsonl.open';
    await writeFile(join(folder, orphan), encodedLine(sampleSpoolRecord()), 'utf8');
    // Its age is measured against the one clock, so the file has to carry an
    // instant that clock can reach (AD-13).
    await utimes(join(folder, orphan), INSTANT, INSTANT);

    // One millisecond short of the stale window, and it is left alone: a
    // process may still be writing it, and only that process may touch it.
    clock.advance(SPOOL_CLAIM_STALE_MS - 1);
    expect(await spool.claim()).toEqual({ ok: true, claim: null });
    expect(await readdir(folder)).toEqual([orphan]);

    clock.advance(1);
    expect(await spool.claim()).toEqual({ ok: true, claim: null });

    // Moved rather than replayed (Decision 6, 2026-10-19): the last line of a
    // `.open` file may be half a line, and the process that was writing it has
    // already told its caller the write failed. It is kept, and counted.
    expect(await readdir(folder)).toEqual(['failed']);
    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, failed: 1 });
  });

  it('is left alone while its process is alive, however old it is', async () => {
    const folder = await spoolFolder();
    const clock = movableClock(INSTANT);
    const spool = fileSpool({ folder, clock, pid: 1, isAlive: () => true });
    await spool.append([sampleSpoolRecord({ id: FIRST_ID })]);
    const claimed = await spool.claim();
    if (!claimed.ok || claimed.claim === null) throw new Error('nothing was claimed');
    await spool.complete(claimed.claim.handle);
    const orphan = '20260102T030600000Z-9999-0.jsonl.open';
    await writeFile(join(folder, orphan), encodedLine(sampleSpoolRecord()), 'utf8');
    await utimes(join(folder, orphan), INSTANT, INSTANT);

    clock.advance(SPOOL_CLAIM_STALE_MS * 10);
    expect(await spool.claim()).toEqual({ ok: true, claim: null });

    expect(await readdir(folder)).toEqual([orphan]);
  });
});

/** Three ids, so a case can tell its records apart. */
const FIRST_ID = '01940000-0000-7000-8000-0000000000d1';
const SECOND_ID = '01940000-0000-7000-8000-0000000000d2';
const THIRD_ID = '01940000-0000-7000-8000-0000000000d3';

/** One record as the line the adapter must have written, newline included. */
function encodedLine(record: SpoolRecord): string {
  const encoded = encodeSpoolLine(record);
  if (!encoded.ok) throw new Error(encoded.message);
  return encoded.line;
}

/** The first line a child printed, so a test can take the handle it claimed. */
function firstLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const at = buffered.indexOf('\n');
      if (at >= 0) resolve(buffered.slice(0, at));
    });
    child.once('error', reject);
    child.once('close', () => {
      reject(new Error(`the claimer printed nothing: ${errors}`));
    });
  });
}

function closed(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.once('close', () => resolve());
  });
}
