import {
  SPOOL_LINE_MAX_BYTES,
  decodeSpoolLine,
  type SpoolRecord,
} from '../../domain/spool-record.js';
import type { Spool } from '../../ports/spool.js';
import { assertEqual, assertNotOk, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { sampleSpoolRecord } from '../fixtures.js';

/**
 * The spool contract: the rules of AD-9 that both the in-memory fake and the
 * file adapter keep.
 *
 * What is checked here is the *order and the ownership* — one append is one
 * file, a file is claimed once, `complete` removes it and `release` puts it
 * back — because that is what makes two drains running at the same moment safe
 * without either of them knowing about the other. What is not checked here is
 * anything about files: the `.open` name, the pid in a claim, the ten-minute
 * rule. Those are the file adapter's own answers to these same rules, and its
 * own tests hold it to them.
 */
export function spoolContract(): ContractCase<Spool>[] {
  return [
    contractCase<Spool>(
      'an appended file comes back from claim with its lines in order',
      async (make) => {
        await withSubject(make, async (spool) => {
          const records = [
            sampleSpoolRecord({ id: FIRST_ID }),
            sampleSpoolRecord({ id: SECOND_ID, cause: 'DB_UNAVAILABLE' }),
          ];
          const appended = await spool.append(records);
          assertOk(appended, 'append failed');

          const claimed = await spool.claim();
          assertOk(claimed, 'claim failed');
          if (claimed.claim === null) {
            assertTrue(false, 'claim found nothing after an append');
            return;
          }
          assertEqual(
            claimed.claim.lines.length,
            records.length,
            'a claimed file must hold one line per appended record',
          );
          // The records as they were given, ids and instants included: the
          // spool carries a record and never makes one of its own (AD-9).
          assertEqual(
            claimed.claim.lines.map(recordOf),
            records.map((record) => ({
              id: record.id,
              kind: record.kind,
              occurredAt: record.occurredAt.toISOString(),
              payload: record.payload,
            })),
            'the lines that came back are not the records that went in, in order',
          );
        });
      },
    ),

    contractCase<Spool>('each append is a file of its own', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord({ id: FIRST_ID })]), 'the first append failed');
        assertOk(
          await spool.append([sampleSpoolRecord({ id: SECOND_ID })]),
          'the second append failed',
        );

        // Two claims, two files, one record each. A shared file would hand
        // both records over at once — and two processes appending to one file
        // is the interleaving the whole design is there to prevent.
        const first = await spool.claim();
        assertOk(first, 'the first claim failed');
        const second = await spool.claim();
        assertOk(second, 'the second claim failed');
        assertTrue(first.claim !== null, 'the first claim found nothing');
        assertTrue(second.claim !== null, 'the second claim found nothing');
        assertEqual(first.claim?.lines.length, 1, 'the first file holds more than its append did');
        assertEqual(second.claim?.lines.length, 1, 'the second file holds more than its append did');
        assertTrue(
          first.claim?.handle !== second.claim?.handle,
          'two claims came back with the same file',
        );
      });
    }),

    contractCase<Spool>('an append of no records is refused, and leaves no file', async (make) => {
      await withSubject(make, async (spool) => {
        const appended = await spool.append([]);

        // There is no such thing as an empty write waiting. A file of no lines
        // would be handed to a claim with nothing in it, and `stats` would not
        // count it, so the two would disagree about what is in the spool.
        assertNotOk(appended, 'append of no records');
        assertTrue(appended.message !== '', 'a refused append must say why');

        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed after an append of no records');
        assertEqual(claimed.claim, null, 'an append of no records left a file behind');
        const stats = await spool.stats();
        assertOk(stats, 'stats failed after an append of no records');
        assertEqual(stats.records, 0, 'an append of no records left records behind');
      });
    }),

    contractCase<Spool>('a claimed file is not claimed a second time', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord()]), 'append failed');

        const first = await spool.claim();
        assertOk(first, 'the first claim failed');
        assertTrue(first.claim !== null, 'the first claim found nothing');

        const second = await spool.claim();
        assertOk(second, 'the second claim failed');
        // `null`, and not a failure: the other drain got there first, which is
        // the normal outcome of two of them running at once (AD-9).
        assertEqual(
          second.claim,
          null,
          'the one file in the spool was handed out twice',
        );
      });
    }),

    contractCase<Spool>('complete removes the file, so nothing claims it again', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord()]), 'append failed');
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed');
        if (claimed.claim === null) {
          assertTrue(false, 'claim found nothing after an append');
          return;
        }

        assertOk(await spool.complete(claimed.claim.handle), 'complete failed');

        const again = await spool.claim();
        assertOk(again, 'the claim after a complete failed');
        assertEqual(again.claim, null, 'a completed file is still in the spool');
        const stats = await spool.stats();
        assertOk(stats, 'stats failed');
        assertEqual(stats.records, 0, 'a completed file still counts towards the spool');
      });
    }),

    contractCase<Spool>('completing a file that is already gone is done, not an error', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord()]), 'append failed');
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed');
        if (claimed.claim === null) {
          assertTrue(false, 'claim found nothing after an append');
          return;
        }
        assertOk(await spool.complete(claimed.claim.handle), 'complete failed');

        // A drain whose claim went stale, was taken back and was completed by
        // somebody else has nothing left to remove. An implementation cannot
        // tell that apart from "already done", and both mean the same thing to
        // the caller (AD-9).
        assertOk(
          await spool.complete(claimed.claim.handle),
          'completing a file that is already gone must be a success',
        );
      });
    }),

    contractCase<Spool>('release puts the file back, so it can be claimed again', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord()]), 'append failed');
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed');
        if (claimed.claim === null) {
          assertTrue(false, 'claim found nothing after an append');
          return;
        }

        assertOk(await spool.release(claimed.claim.handle), 'release failed');

        const again = await spool.claim();
        assertOk(again, 'the claim after a release failed');
        if (again.claim === null) {
          assertTrue(false, 'a released file was not claimed again');
          return;
        }
        assertEqual(
          again.claim.lines,
          claimed.claim.lines,
          'a released file came back with other lines than it was claimed with',
        );
      });
    }),

    contractCase<Spool>('an empty spool has nothing to claim and nothing waiting', async (make) => {
      await withSubject(make, async (spool) => {
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed on an empty spool');
        assertEqual(claimed.claim, null, 'an empty spool handed out a file');

        const stats = await spool.stats();
        assertOk(stats, 'stats failed on an empty spool');
        assertEqual(stats.records, 0, 'an empty spool reported records');
        assertEqual(stats.earliest, null, 'an empty spool reported an instant');
      });
    }),

    contractCase<Spool>('stats count every waiting record and the earliest instant', async (make) => {
      await withSubject(make, async (spool) => {
        const older = new Date('2026-01-02T03:04:05.000Z');
        const newer = new Date('2026-01-02T03:05:00.000Z');
        assertOk(
          await spool.append([
            sampleSpoolRecord({ id: FIRST_ID, occurredAt: newer }),
            sampleSpoolRecord({ id: SECOND_ID, occurredAt: older }),
          ]),
          'the first append failed',
        );
        assertOk(
          await spool.append([sampleSpoolRecord({ id: THIRD_ID, occurredAt: newer })]),
          'the second append failed',
        );

        const waiting = await spool.stats();
        assertOk(waiting, 'stats failed');
        assertEqual(waiting.records, 3, 'stats did not count every appended record');
        assertEqual(
          waiting.earliest?.toISOString(),
          older.toISOString(),
          'stats did not report the earliest instant among the records',
        );

        // A claimed file is still waiting: it has not reached the database, and
        // a doctor report that stopped counting it would say the spool had
        // emptied when a drain merely picked it up (AD-9).
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed');
        assertTrue(claimed.claim !== null, 'claim found nothing after two appends');
        const held = await spool.stats();
        assertOk(held, 'stats failed while a file was claimed');
        assertEqual(held.records, 3, 'a claimed file must still count as waiting');
      });
    }),

    contractCase<Spool>('a record too long for one line is refused, and nothing is left', async (make) => {
      await withSubject(make, async (spool) => {
        // One path, far past the limit. Nothing a real record carries is this
        // big — attachment bytes never go in the spool (AD-23) — and the limit
        // exists so that one impossible record cannot make a whole file
        // unreadable.
        const huge = sampleSpoolRecord({
          transcriptPath: `/demo/${'t'.repeat(SPOOL_LINE_MAX_BYTES)}.jsonl`,
        });

        const appended = await spool.append([huge]);
        assertNotOk(appended, 'append of a record over the line limit');
        assertTrue(appended.message !== '', 'a refused append must say why');

        // And no file behind it, whole or partial.
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed after a refused append');
        assertEqual(claimed.claim, null, 'a refused append left a file behind');
        const stats = await spool.stats();
        assertOk(stats, 'stats failed after a refused append');
        assertEqual(stats.records, 0, 'a refused append left records behind');
      });
    }),

    contractCase<Spool>(
      'a record too long is refused before the readable ones in its batch are written',
      async (make) => {
        await withSubject(make, async (spool) => {
          const appended = await spool.append([
            sampleSpoolRecord({ id: FIRST_ID }),
            sampleSpoolRecord({
              id: SECOND_ID,
              transcriptPath: `/demo/${'t'.repeat(SPOOL_LINE_MAX_BYTES)}.jsonl`,
            }),
          ]);
          assertNotOk(appended, 'append of a batch with one impossible record');

          // Half a batch in a file is a batch nobody can tell is incomplete.
          const stats = await spool.stats();
          assertOk(stats, 'stats failed after a refused append');
          assertEqual(stats.records, 0, 'a refused append wrote part of its batch');
        });
      },
    ),

    contractCase<Spool>(
      'rewrite leaves the kept lines waiting and the failed ones aside',
      async (make) => {
        await withSubject(make, async (spool) => {
          assertOk(
            await spool.append([
              sampleSpoolRecord({ id: FIRST_ID }),
              sampleSpoolRecord({ id: SECOND_ID }),
              sampleSpoolRecord({ id: THIRD_ID }),
            ]),
            'append failed',
          );
          const claimed = await spool.claim();
          assertOk(claimed, 'claim failed');
          if (claimed.claim === null) {
            assertTrue(false, 'claim found nothing after an append');
            return;
          }
          const [first, second, third] = claimed.claim.lines;
          if (first === undefined || second === undefined || third === undefined) {
            assertTrue(false, 'a claimed file must hold one line per appended record');
            return;
          }

          // The middle record failed and has an attempt left; the last one is
          // out of attempts. The first went in, so it is in neither list.
          const rewritten = await spool.rewrite(claimed.claim.handle, {
            keep: [second],
            failed: [third],
          });
          assertOk(rewritten, 'rewrite failed');

          const stats = await spool.stats();
          assertOk(stats, 'stats failed after a rewrite');
          assertEqual(stats.records, 1, 'only the kept line may still be waiting');
          assertEqual(stats.failed, 1, 'the failed line must be counted apart (AD-9)');

          const again = await spool.claim();
          assertOk(again, 'claim failed after a rewrite');
          if (again.claim === null) {
            assertTrue(false, 'the kept line must be claimable again');
            return;
          }
          assertEqual(
            again.claim.lines.map(recordOf).map((record) => record.id),
            [SECOND_ID],
            'a rewrite must hand the kept lines to the next claim, and nothing else',
          );
        });
      },
    ),

    contractCase<Spool>('rewrite with nothing to keep leaves nothing waiting', async (make) => {
      await withSubject(make, async (spool) => {
        assertOk(await spool.append([sampleSpoolRecord({ id: FIRST_ID })]), 'append failed');
        const claimed = await spool.claim();
        assertOk(claimed, 'claim failed');
        if (claimed.claim === null) {
          assertTrue(false, 'claim found nothing after an append');
          return;
        }
        const [only] = claimed.claim.lines;
        if (only === undefined) {
          assertTrue(false, 'a claimed file must hold the appended record');
          return;
        }

        assertOk(
          await spool.rewrite(claimed.claim.handle, { keep: [], failed: [only] }),
          'rewrite failed',
        );

        const stats = await spool.stats();
        assertOk(stats, 'stats failed after a rewrite that kept nothing');
        assertEqual(stats.records, 0, 'a rewrite that keeps nothing leaves nothing waiting');
        assertEqual(stats.failed, 1, 'the line that was given up on must still be counted');

        const again = await spool.claim();
        assertOk(again, 'claim failed after a rewrite that kept nothing');
        assertEqual(
          again.claim,
          null,
          'a line moved aside must never be handed to a claim again (AD-9)',
        );
      });
    }),

    contractCase<Spool>(
      'the lines a rewrite kept go behind a newer file',
      async (make) => {
        await withSubject(make, async (spool) => {
          // Two files, oldest first, and the oldest keeps one of its two lines.
          // What it keeps goes to the back: a record that keeps failing must not
          // stand in front of everything written after it (AD-9).
          assertOk(
            await spool.append([
              sampleSpoolRecord({ id: FIRST_ID }),
              sampleSpoolRecord({ id: SECOND_ID }),
            ]),
            'the first append failed',
          );
          assertOk(
            await spool.append([sampleSpoolRecord({ id: THIRD_ID })]),
            'the second append failed',
          );

          const claimed = await spool.claim();
          assertOk(claimed, 'claim failed');
          if (claimed.claim === null) {
            assertTrue(false, 'claim found nothing after two appends');
            return;
          }
          const [, second] = claimed.claim.lines;
          if (second === undefined) {
            assertTrue(false, 'the oldest file must hold both of its records');
            return;
          }
          assertOk(
            await spool.rewrite(claimed.claim.handle, { keep: [second], failed: [] }),
            'rewrite failed',
          );

          const next = await spool.claim();
          assertOk(next, 'claim failed after a rewrite');
          if (next.claim === null) {
            assertTrue(false, 'the newer file must still be claimable');
            return;
          }
          assertEqual(
            next.claim.lines.map(recordOf).map((record) => record.id),
            [THIRD_ID],
            'a rewrite must put the kept lines behind the files already waiting',
          );

          const last = await spool.claim();
          assertOk(last, 'claim failed after the newer file');
          if (last.claim === null) {
            assertTrue(false, 'the kept line must be claimable once it is due');
            return;
          }
          assertEqual(
            last.claim.lines.map(recordOf).map((record) => record.id),
            [SECOND_ID],
            'the kept line comes after the newer file',
          );
        });
      },
    ),

    contractCase<Spool>(
      'a claim does not hand over kept lines before they are due',
      async (make) => {
        await withSubject(make, async (spool) => {
          assertOk(await spool.append([sampleSpoolRecord({ id: FIRST_ID })]), 'append failed');
          const claimed = await spool.claim();
          assertOk(claimed, 'claim failed');
          if (claimed.claim === null) {
            assertTrue(false, 'claim found nothing after an append');
            return;
          }
          // Far beyond any clock a test gives a spool: not due during the case.
          assertOk(
            await spool.rewrite(claimed.claim.handle, {
              keep: [...claimed.claim.lines],
              failed: [],
              keepDueAt: new Date('2100-01-01T00:00:00.000Z'),
            }),
            'rewrite failed',
          );

          const again = await spool.claim();
          assertOk(again, 'claim failed after a rewrite');
          assertEqual(
            again.claim,
            null,
            'a kept line must wait out its retry interval before any claim takes it',
          );

          const stats = await spool.stats();
          assertOk(stats, 'stats failed after a rewrite');
          assertEqual(stats.records, 1, 'a line waiting for its time is still waiting (AD-9)');
        });
      },
    ),

    contractCase<Spool>('stats counts nothing as failed on a fresh spool', async (make) => {
      await withSubject(make, async (spool) => {
        const stats = await spool.stats();
        assertOk(stats, 'stats failed on an empty spool');
        assertEqual(stats.failed, 0, 'a spool nobody has given up on has no failed lines');
      });
    }),
  ];
}

/** Three caller-minted ids, so a case can tell its records apart. */
const FIRST_ID = '01940000-0000-7000-8000-0000000000a1';
const SECOND_ID = '01940000-0000-7000-8000-0000000000a2';
const THIRD_ID = '01940000-0000-7000-8000-0000000000a3';

/** One line as the facts a case compares, so a failure names the difference. */
function recordOf(line: string): {
  id: string;
  kind: string;
  occurredAt: string;
  payload: SpoolRecord['payload'];
} {
  const decoded = decodeSpoolLine(line);
  assertOk(decoded, `a line the spool handed back could not be decoded: ${line}`);
  return {
    id: decoded.record.id,
    kind: decoded.record.kind,
    occurredAt: decoded.record.occurredAt.toISOString(),
    payload: decoded.record.payload,
  };
}
