import { describe, expect, it } from 'vitest';
import {
  formatSessionToken,
  parseSessionToken,
  SESSION_TOKEN_SEPARATOR,
} from '../src/domain/session-token.js';
import type { Session, SessionStartSource } from '../src/domain/session.js';
import { BRAIN_MARKER, type ConnectResult, type Connector } from '../src/ports/connector.js';
import type { Clock } from '../src/ports/clock.js';
import type { IdGen } from '../src/ports/id-gen.js';
import type { Embedder } from '../src/ports/embedder.js';
import type { Parser } from '../src/ports/parser.js';
import type { Reranker } from '../src/ports/reranker.js';
import type { Spool } from '../src/ports/spool.js';
import type {
  SchemaStore,
  TranscriptFileStore,
  UserStore,
  WorkStore,
} from '../src/ports/store.js';
import {
  clockContract,
  connectorContract,
  embedderContract,
  fixedClock,
  idGenContract,
  memoryConnector,
  memoryEmbedder,
  memoryParser,
  memoryReranker,
  memorySchemaStore,
  memorySpool,
  memoryStore,
  memoryTranscript,
  parserContract,
  rerankerContract,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sampleSessionToken,
  sampleSpoolRecord,
  schemaStoreContract,
  sequenceIdGen,
  sessionStoreContract,
  spoolContract,
  steppingClock,
  storeContract,
  transcriptFileStoreContract,
  unknownSessionToken,
  unreadableTranscript,
  userStoreContract,
  workStoreContract,
  type ConnectorSubject,
  type ContractCase,
  type ParserSubject,
  type SessionStoreSubject,
  type SubjectFactory,
} from '../src/testing/index.js';

const INSTANT = new Date('2026-01-02T03:04:05.000Z');

/** Run a whole contract and report, by name, which cases the subject failed. */
async function failedCases<T>(
  cases: ContractCase<T>[],
  make: SubjectFactory<T>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run(make);
    } catch {
      failed.push(testCase.name);
    }
  }
  return failed;
}

// --- the frame itself: the memory fakes pass every contract ------------------

describe('the health contract against the memory store', () => {
  for (const testCase of storeContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryStore());
    });
  }

  it('accepts an unreachable store as a value', async () => {
    const make = async () =>
      memoryStore({
        health: { ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED' },
      });
    expect(await failedCases(storeContract(), make)).toEqual([]);
  });
});

describe('the session contract against the memory store', () => {
  for (const testCase of sessionStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryStore());
    });
  }
});

describe('the identity contract against the memory store', () => {
  for (const testCase of userStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryStore());
    });
  }
});

describe('the queue contract against the memory store', () => {
  for (const testCase of workStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryStore());
    });
  }
});

describe('the transcript history contract against the memory store', () => {
  for (const testCase of transcriptFileStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryStore());
    });
  }
});

describe('the schema contract against the memory schema store', () => {
  for (const testCase of schemaStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memorySchemaStore());
    });
  }

  it('accepts a database that holds no version row yet', async () => {
    const make = async () => memorySchemaStore({ version: null });
    expect(await failedCases(schemaStoreContract(), make)).toEqual([]);
  });

  it('accepts an unreachable store as a value', async () => {
    const make = async () =>
      memorySchemaStore({
        result: { ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED' },
      });
    expect(await failedCases(schemaStoreContract(), make)).toEqual([]);
  });
});

/** The sample transcript as it stood after its first `count` messages. */
function memoryPrefix(count: number): string {
  const parsed = JSON.parse(memoryTranscript) as Record<string, unknown>;
  const messages = parsed['messages'] as unknown[];
  return JSON.stringify({ ...parsed, messages: messages.slice(0, count) });
}

/** The same transcript with the body of a message in front of the cursor's changed. */
function memoryRewritten(): string {
  return memoryTranscript.replace(
    'Where did we leave the import notes?',
    'Where did we put the import notes?',
  );
}

/** Everything the parser contract needs about the memory parser. */
function parserSubject(parser = memoryParser()): ParserSubject {
  return {
    parser,
    readable: [memoryTranscript, JSON.stringify({ messages: [] })],
    unreadable: [unreadableTranscript, JSON.stringify({ notes: [] })],
    // Two turns, then the whole conversation: what a second hook on a longer
    // transcript hands over.
    grown: [{ before: memoryPrefix(2), after: memoryTranscript }],
    // And the same conversation with its front rewritten, which is what a
    // compact or a fork leaves behind.
    rewritten: [{ before: memoryPrefix(2), after: memoryRewritten() }],
  };
}

describe('the parser contract against the memory parser', () => {
  const make = async (): Promise<ParserSubject> => parserSubject();

  for (const testCase of parserContract()) {
    it(testCase.name, async () => {
      await testCase.run(make);
    });
  }
});

const SHIM = '/memory/.second_brain/bin/brain';

/** A fresh in-memory harness, with a Brain-shaped view of its target. */
function connectorSubject(connector = memoryConnector()): ConnectorSubject {
  return {
    connector,
    shimPath: SHIM,
    entries: async () => connector.entries(),
    marked: async () => connector.marked(),
    addForeignEntry: async (entry: string) => {
      connector.addForeignEntry(entry);
    },
  };
}

describe('the connector contract against the memory connector', () => {
  for (const testCase of connectorContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => connectorSubject());
    });
  }

  it('leaves entries nobody from Brain wrote exactly where they were', async () => {
    const connector = memoryConnector();
    connector.addForeignEntry('the user put this here');

    await connector.connect({ shimPath: SHIM });
    await connector.connect({ shimPath: SHIM });

    expect(connector.entries()).toEqual([
      'the user put this here',
      `${BRAIN_MARKER} hook -> ${SHIM}`,
    ]);
    expect(connector.marked()).toHaveLength(1);
  });

  it('replaces its own entry rather than adding a second one for a new shim', async () => {
    const connector = memoryConnector();
    await connector.connect({ shimPath: '/memory/old/bin/brain' });

    const again = await connector.connect({ shimPath: SHIM });

    expect(again).toEqual({ ok: true, target: '/memory/demo/settings.json', changed: true });
    expect(connector.marked()).toEqual([`${BRAIN_MARKER} hook -> ${SHIM}`]);
  });

  it('reports a refusal as a value, writing nothing', async () => {
    const connector = memoryConnector({
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json is not JSON' },
    });

    const result = await connector.connect({ shimPath: SHIM });

    expect(result).toEqual({
      ok: false,
      code: 'HARNESS_UNREADABLE',
      message: 'settings.json is not JSON',
    });
    expect(connector.entries()).toEqual([]);
  });
});

describe('the contracts catch a wrong connector', () => {
  it('catches a connector that registers again every time', async () => {
    const make = async (): Promise<ConnectorSubject> => {
      const inner = memoryConnector();
      const entries: string[] = [];
      const connector: Connector = {
        harness: inner.harness,
        label: inner.label,
        parser: inner.parser,
        detect: () => inner.detect(),
        async connect(input): Promise<ConnectResult> {
          // Never looks for the marker: a second connect registers twice.
          entries.push(`${BRAIN_MARKER} hook -> ${input.shimPath}`);
          return { ok: true, target: '/memory/demo/settings.json', changed: true };
        },
      };
      return {
        connector,
        shimPath: SHIM,
        entries: async () => entries,
        marked: async () => entries.filter((entry) => entry.includes(BRAIN_MARKER)),
        addForeignEntry: async (entry: string) => {
          entries.push(entry);
        },
      };
    };

    expect(await failedCases(connectorContract(), make)).toContain(
      'connecting twice changes nothing the second time',
    );
  });

  it('catches a connector whose harness is not the one its parser names', async () => {
    const make = async (): Promise<ConnectorSubject> => {
      const inner = memoryConnector({ harness: 'demo' });
      return connectorSubject({ ...inner, harness: 'something-else' });
    };

    expect(await failedCases(connectorContract(), make)).toContain(
      'the connector names its harness and its parser',
    );
  });
});

describe('the embedder contract against the memory embedder', () => {
  for (const testCase of embedderContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryEmbedder({ dimensions: 16 }));
    });
  }
});

describe('the spool contract against the memory spool', () => {
  for (const testCase of spoolContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memorySpool());
    });
  }

  it('accepts a spool that cannot be written to as a value', async () => {
    // The row of the matrix where there is a plain file where the folder
    // belongs: every verb answers, and none of them throws.
    const make = async (): Promise<Spool> =>
      memorySpool({
        appendFailure: 'the spool folder is a file',
        claimFailure: 'the spool folder is a file',
        statsFailure: 'the spool folder is a file',
      });
    const spool = await make();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: false });
    expect(await spool.claim()).toMatchObject({ ok: false });
    expect(await spool.stats()).toMatchObject({ ok: false });
  });

  it('takes back a claim nobody will ever finish', async () => {
    // A drain that was killed between the claim and the replay. The fake has
    // no process to kill (AD-1), so it says the same thing by ageing the claim
    // past `SPOOL_CLAIM_STALE_MS`; the file adapter's own tests kill a real
    // child process.
    const spool = memorySpool();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    expect(await spool.claim()).toMatchObject({ ok: true, claim: { lines: [expect.any(String)] } });
    expect(await spool.claim()).toMatchObject({ ok: true, claim: null });

    spool.abandonClaims();

    expect(await spool.claim()).toMatchObject({ ok: true, claim: { lines: [expect.any(String)] } });
  });
});

describe('the contracts catch a wrong spool', () => {
  it('catches a spool that hands the same file to two claims', async () => {
    const make = async (): Promise<Spool> => {
      const inner = memorySpool();
      return {
        ...inner,
        async claim() {
          // Never renames and never marks: every claim sees the first file
          // again, so two drains replay the same records (AD-9 broken).
          const files = inner.files();
          const first = files[0];
          if (first === undefined) return { ok: true, claim: null };
          return { ok: true, claim: { handle: `${first.stem}.claiming`, lines: [...first.lines] } };
        },
      };
    };

    expect(await failedCases(spoolContract(), make)).toContain(
      'a claimed file is not claimed a second time',
    );
  });
});

describe('the contracts catch a wrong transcript history', () => {
  it('catches a store that lets the size go backwards', async () => {
    const make = async (): Promise<TranscriptFileStore> => {
      const inner = memoryStore();
      return {
        ...inner,
        async recordTranscriptFile(input) {
          // Takes whatever it is given: a read that finished late would then
          // wind the history back, and the next scan would re-read a stretch
          // of transcript that is already stored (Table Contract broken).
          return inner.recordTranscriptFile({ ...input, reset: true });
        },
      };
    };

    expect(await failedCases(transcriptFileStoreContract(), make)).toContain(
      'a smaller size is dropped unless it is a reset',
    );
  });
});

describe('the reranker contract against the memory reranker', () => {
  for (const testCase of rerankerContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryReranker());
    });
  }
});

describe('the clock contract against the memory clocks', () => {
  for (const testCase of clockContract()) {
    it(`${testCase.name} (fixed)`, async () => {
      await testCase.run(async () => fixedClock(INSTANT));
    });
    it(`${testCase.name} (stepping)`, async () => {
      await testCase.run(async () => steppingClock(INSTANT, 1));
    });
  }
});

describe('the id contract against the sequence generator', () => {
  for (const testCase of idGenContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => sequenceIdGen({ timestampMs: INSTANT.getTime() }));
    });
  }

  it('stays monotonic past the 4,096 ids one millisecond can hold', async () => {
    const idGen = sequenceIdGen({ timestampMs: INSTANT.getTime() });
    const ids = Array.from({ length: 5000 }, () => idGen.next());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

// --- the frame catches a wrong implementation -------------------------------
//
// One deliberately wrong fake per row of the I/O matrix, so a contract that
// quietly passes everything would show up here as an empty failure list.

describe('the contracts catch a wrong store', () => {
  it('catches a store that creates a new session row every time', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      let serial = 0;
      return {
        ...inner,
        async ensureSession(input) {
          serial += 1;
          // Ignores find-or-create: every call mints another row (AD-12 broken).
          const result = await inner.ensureSession({
            ...input,
            key: {
              ...input.key,
              harnessSessionId: `${input.key.harnessSessionId}-${String(serial)}`,
            },
          });
          return result;
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ensureSession creates the row once and keeps the first id',
    );
  });

  it('catches a store that reads the messages in the order they were inserted', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      // The order the rows went in, which is the mistake migration 0006 is
      // about: a message the parser only started keeping arrives in a later
      // batch, and reading by arrival puts it at the end of a conversation it
      // happened in the middle of (AD-8).
      const arrived: string[] = [];
      return {
        ...inner,
        async ingest(batch) {
          for (const message of batch.messages) {
            if (!arrived.includes(message.harnessMessageId)) {
              arrived.push(message.harnessMessageId);
            }
          }
          return inner.ingest(batch);
        },
        async readSession(token) {
          const result = await inner.readSession(token);
          if (!result.ok) return result;
          return {
            ...result,
            messages: [...result.messages].sort(
              (left, right) =>
                arrived.indexOf(left.harnessMessageId) -
                arrived.indexOf(right.harnessMessageId),
            ),
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'a message uttered in the middle of a stored conversation is read in its place',
    );
  });

  it('catches a store that compares the cursor by the order the rows arrived', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      // The same mistake on the other column: "did the cursor move forward?"
      // answered with insertion order. Two overlapping reads disagree about
      // exactly that, and the shorter one's last message is the newest row
      // (migration 0006).
      const arrived: string[] = [];
      let cursor: Session['cursor'] = null;
      return {
        ...inner,
        async ingest(batch) {
          for (const message of batch.messages) {
            if (!arrived.includes(message.harnessMessageId)) {
              arrived.push(message.harnessMessageId);
            }
          }
          const result = await inner.ingest(batch);
          const proposed = batch.tracking.cursor;
          if (
            proposed !== null &&
            (batch.tracking.cursorReset ||
              cursor === null ||
              arrived.indexOf(proposed.lastHarnessMessageId) >=
                arrived.indexOf(cursor.lastHarnessMessageId))
          ) {
            cursor = proposed;
          }
          return result;
        },
        async readSession(token) {
          const result = await inner.readSession(token);
          if (!result.ok) return result;
          return { ...result, session: { ...result.session, cursor } };
        },
        async findSession(key) {
          const result = await inner.findSession(key);
          if (!result.ok || result.session === null) return result;
          return { ...result, session: { ...result.session, cursor } };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'the cursor is compared by when the messages were uttered, not by when they arrived',
    );
  });

  it('catches a queue whose claim does not raise the attempt', async () => {
    const make = async (): Promise<WorkStore> => {
      const inner = memoryStore();
      return {
        ...inner,
        async claimWork(input) {
          const claim = await inner.claimWork(input);
          if (!claim.ok || claim.item === null) return claim;
          // The attempt counted in the row but not in the answer, which is the
          // same mistake as not counting it: a drain that read it would retry
          // for ever rather than record on the tenth (Decision 1, AD-21).
          return { ...claim, item: { ...claim.item, attempts: claim.item.attempts - 1 } };
        },
      };
    };

    expect(await failedCases(workStoreContract(), make)).toContain(
      'claimWork raises attempts inside the claim',
    );
  });

  it('catches a queue that finishes an item under somebody else\'s claim', async () => {
    const make = async (): Promise<WorkStore> => {
      const inner = memoryStore();
      const held = new Map<string, string>();
      return {
        ...inner,
        async claimWork(input) {
          const claim = await inner.claimWork(input);
          if (claim.ok && claim.item !== null) held.set(claim.item.id, input.claimedBy);
          return claim;
        },
        async completeWork(input) {
          // By id alone, ignoring whose claim it is: the late answer of a
          // worker that lost the row overwrites the live worker's state, and
          // "processed exactly once" is gone (Design Notes).
          const owner = held.get(input.id);
          return inner.completeWork({ ...input, claimedBy: owner ?? input.claimedBy });
        },
      };
    };

    expect(await failedCases(workStoreContract(), make)).toContain(
      "finishing with somebody else's claim is lost",
    );
  });

  it('catches a store that makes a second owner', async () => {
    const make = async (): Promise<UserStore> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ensureSelfUser(input) {
          // Creates a row every time rather than finding one, so the same
          // person ends up with two ids (AD-12 broken).
          const created = await inner.ensureSelfUser(input);
          if (!created.ok) return created;
          return {
            ok: true,
            created: true,
            user: { id: input.id, name: input.name, isSelf: true, createdAt: input.createdAt },
          };
        },
      };
    };

    expect(await failedCases(userStoreContract(), make)).toContain(
      'a second ensureSelfUser keeps the first row, whatever it proposes',
    );
  });

  it('catches a store that re-inserts the messages of every batch', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ingest(batch) {
          // Counts every batch as new, so a replay doubles the session (AD-8).
          const result = await inner.ingest(batch);
          if (!result.ok) return result;
          return {
            ...result,
            inserted: {
              messages: batch.messages.length,
              toolNotes: batch.toolNotes.length,
            },
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ingest adds nothing the second time the same batch arrives',
    );
  });

  it('catches a store that still counts masking records on an ingest', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ingest(batch) {
          // A store that kept story 2.9's third count. Ingest masks nothing
          // now, so a `redactions` number is a number about something that
          // never happened (마스킹 B, AD-11).
          const result = await inner.ingest(batch);
          if (!result.ok) return result;
          return {
            ...result,
            inserted: { ...result.inserted, redactions: 0 } as typeof result.inserted,
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ingest counts messages and tool notes, and nothing else',
    );
  });

  it('catches a store that throws for an unknown session', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      return {
        ...inner,
        async readSession(token) {
          const result = await inner.readSession(token);
          // Expected failures must be values, never exceptions (Conventions).
          if (!result.ok) throw new Error(`no session for ${token}`);
          return result;
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'readSession reports an unknown token as a value',
    );
  });

  it('catches a store that drops the cursor reset warning', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ingest(batch) {
          const result = await inner.ingest(batch);
          return result.ok ? { ...result, warnings: [] } : result;
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ingest warns with CURSOR_RESET when the parser read from the start',
    );
  });

  it('catches a store that lets an older batch wind the cursor back', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      const cursors = new Map<string, NonNullable<Session['cursor']>>();
      return {
        ...inner,
        async ingest(batch) {
          const result = await inner.ingest(batch);
          if (result.ok && batch.tracking.cursor !== null) {
            // The batch's cursor every time, whatever the session had: the
            // next read would then parse a stretch of the transcript that is
            // already stored (AD-4).
            cursors.set(formatSessionToken(batch.key), batch.tracking.cursor);
          }
          return result;
        },
        async readSession(token) {
          const result = await inner.readSession(token);
          const wound = cursors.get(token);
          if (!result.ok || wound === undefined) return result;
          return { ...result, session: { ...result.session, cursor: wound } };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'the cursor does not go backwards unless the parse was reset',
    );
  });

  it('catches a store that lets an overlapping reset wind the cursor back', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      const cursors = new Map<string, Session['cursor']>();
      return {
        ...inner,
        async ingest(batch) {
          const result = await inner.ingest(batch);
          // Every reset's cursor, whatever the session had moved to since that
          // read began: the rule before `cursorBase`, which lets the shorter of
          // two overlapping reads undo the longer one (#17).
          if (result.ok && batch.tracking.cursorReset) {
            cursors.set(formatSessionToken(batch.key), batch.tracking.cursor);
          }
          return result;
        },
        async readSession(token) {
          const result = await inner.readSession(token);
          if (!result.ok || !cursors.has(token)) return result;
          return {
            ...result,
            session: { ...result.session, cursor: cursors.get(token) ?? null },
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'two reset batches from one base leave the cursor where the longer read put it',
    );
  });

  it('catches a store that lets a later batch overwrite the start source', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      const sources = new Map<string, SessionStartSource>();
      return {
        ...inner,
        async ingest(batch) {
          const result = await inner.ingest(batch);
          // The last value wins, so a `resume` the session learned first is
          // replaced by the `startup` of a later read (#18).
          if (result.ok && batch.tracking.startSource !== null) {
            sources.set(formatSessionToken(batch.key), batch.tracking.startSource);
          }
          return result;
        },
        async readSession(token) {
          const result = await inner.readSession(token);
          const latest = sources.get(token);
          if (!result.ok || latest === undefined) return result;
          return { ...result, session: { ...result.session, startSource: latest } };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ingest records the start source the batch carried and never overwrites it',
    );
  });

  it('catches a store that makes a new project for every session', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ensureSession(input) {
          const result = await inner.ensureSession(input);
          if (!result.ok || input.checkout === null) return result;
          // Takes the proposed ids every time rather than finding the identity
          // that is already stored, so the same repository becomes a project
          // per session and two worktrees of one clone never meet (AD-12).
          return {
            ...result,
            session: {
              ...result.session,
              projectId: input.checkout.projectId,
              worktreeId: input.checkout.worktreeId,
            },
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'a second session of the same repository joins the project it already has',
    );
  });

  it('catches a store that lets a later checkout retag a stored session', async () => {
    const make = async (): Promise<SessionStoreSubject> => {
      const inner = memoryStore();
      const retagged = new Map<string, { projectId: string; worktreeId: string }>();
      return {
        ...inner,
        async ensureSession(input) {
          const result = await inner.ensureSession(input);
          if (!result.ok) return result;
          // The tags of whatever the last call carried, even for a session that
          // was already there: the one thing the tags may never do is change
          // after the session was created (AD-12).
          if (!result.created && input.checkout !== null) {
            retagged.set(formatSessionToken(input.key), {
              projectId: input.checkout.projectId,
              worktreeId: input.checkout.worktreeId,
            });
          }
          const tags = retagged.get(formatSessionToken(input.key));
          if (tags === undefined) return result;
          return { ...result, session: { ...result.session, ...tags } };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ensureSession keeps the key, the tags and the immutable columns',
    );
  });
});

describe('the contracts catch a wrong schema store', () => {
  it('catches a store that throws when the version row is missing', async () => {
    const make = async (): Promise<SchemaStore> => {
      const inner = memorySchemaStore({ version: null });
      return {
        ...inner,
        async readSchemaVersion() {
          const result = await inner.readSchemaVersion();
          // An empty database is a value, not an exception (Conventions).
          if (result.ok && result.version === null) throw new Error('no schema_version row');
          return result;
        },
      };
    };

    expect(await failedCases(schemaStoreContract(), make)).toContain(
      'readSchemaVersion answers with a well formed value instead of throwing',
    );
  });

  it('catches a store that reports a version without saying when it was applied', async () => {
    const make = async (): Promise<SchemaStore> => {
      const inner = memorySchemaStore();
      return {
        ...inner,
        async readSchemaVersion() {
          const result = await inner.readSchemaVersion();
          if (!result.ok || result.version === null) return result;
          return {
            ok: true,
            version: { version: result.version.version, appliedAt: new Date(Number.NaN) },
          };
        },
      };
    };

    expect(await failedCases(schemaStoreContract(), make)).toContain(
      'readSchemaVersion answers with a well formed value instead of throwing',
    );
  });
});

describe('the contracts catch a wrong parser', () => {
  it('catches a parser that gives two messages the same harness id', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          const result = inner.parse(content, cursor);
          if (!result.ok) return result;
          const first = result.messages[0];
          if (first === undefined) return result;
          // Every message under the first one's id. A message carries no
          // number, so `(session, harness message id)` is the whole of what
          // identifies it (migration 0006): a store would take the rest for
          // replays of the first and drop them without a word (AD-4, NFR-2).
          return {
            ...result,
            messages: result.messages.map((message) => ({
              ...message,
              harnessMessageId: first.harnessMessageId,
            })),
          };
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'the harness message ids of one parse do not repeat',
    );
  });

  it('catches a parser that answers differently every time', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      let calls = 0;
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          calls += 1;
          const result = inner.parse(content, cursor);
          if (!result.ok) return result;
          return { ...result, messages: result.messages.slice(0, calls) };
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'parsing the same transcript twice is identical',
    );
  });

  it('catches a parser that repeats a (message, ordinal) pair', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          const result = inner.parse(content, cursor);
          if (!result.ok) return result;
          return {
            ...result,
            toolNotes: result.toolNotes.map((note) => ({ ...note, ordinal: 0 })),
          };
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'tool notes are unique per message and ordinal, and point at a parsed message',
    );
  });

  it('catches a parser that throws instead of refusing', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          const result = inner.parse(content, cursor);
          if (!result.ok) throw new Error('cannot read this transcript');
          return result;
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'content the parser cannot read fails as a value',
    );
  });

  it('catches a parser whose incremental read leaves the cursor message out', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          const result = inner.parse(content, cursor);
          if (!result.ok || cursor === undefined || cursor === null) return result;
          // Starts *after* the cursor message instead of at it. The store would
          // never see a message again -- which is fine until the cursor message
          // is one whose tool notes arrived late, and then those notes point at
          // a message the batch does not carry (AD-4).
          return { ...result, messages: result.messages.slice(1) };
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'a cursor the content still fits is read from, and nothing before it',
    );
  });

  it('catches a parser that reads from the front without saying it reset', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      const wrong: Parser = {
        harness: inner.harness,
        version: inner.version,
        parse(content, cursor) {
          const result = inner.parse(content, cursor);
          // A reset nobody is told about: the session would look as though it
          // had been read incrementally all along (Conventions).
          return result.ok ? { ...result, cursorReset: false } : result;
        },
      };
      return parserSubject(wrong);
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'a cursor the content does not fit reads from the front and says so',
    );
  });
});

describe('the contracts catch a wrong embedder, reranker, clock and id generator', () => {
  it('catches an embedder whose vectors are not as wide as it promises', async () => {
    const make = async (): Promise<Embedder> => {
      const inner = memoryEmbedder({ dimensions: 16 });
      return {
        model: inner.model,
        dimensions: inner.dimensions,
        async embed(texts) {
          const result = await inner.embed(texts);
          if (!result.ok) return result;
          return { ...result, vectors: result.vectors.map((vector) => vector.slice(0, 4)) };
        },
      };
    };

    expect(await failedCases(embedderContract(), make)).toContain(
      'one vector per text, each as wide as promised',
    );
  });

  it('catches a reranker that repeats a document', async () => {
    const make = async (): Promise<Reranker> => {
      const inner = memoryReranker();
      return {
        model: inner.model,
        async rerank(query, documents) {
          const result = await inner.rerank(query, documents);
          if (!result.ok) return result;
          return { ...result, ranking: result.ranking.map((entry) => ({ ...entry, index: 0 })) };
        },
      };
    };

    expect(await failedCases(rerankerContract(), make)).toContain(
      'the ranking is a subset of the input, with no repeats',
    );
  });

  it('catches a reranker whose scores climb', async () => {
    const make = async (): Promise<Reranker> => {
      const inner = memoryReranker();
      return {
        model: inner.model,
        async rerank(query, documents) {
          const result = await inner.rerank(query, documents);
          if (!result.ok) return result;
          return { ...result, ranking: [...result.ranking].reverse() };
        },
      };
    };

    expect(await failedCases(rerankerContract(), make)).toContain(
      'the scores never rise along the ranking',
    );
  });

  it('accepts an embedder that fails as an EMBED_FAILED value', async () => {
    const make = async (): Promise<Embedder> => ({
      model: 'demo-embed',
      dimensions: 16,
      embed: async () => ({ ok: false, code: 'EMBED_FAILED', message: 'quota exhausted' }),
    });

    expect(await failedCases(embedderContract(), make)).toEqual([]);
  });

  it('catches an embedder that fails with another code', async () => {
    const make = async (): Promise<Embedder> => ({
      model: 'demo-embed',
      dimensions: 16,
      embed: async () =>
        ({ ok: false, code: 'TIMEOUT', message: 'slow' }) as unknown as Awaited<
          ReturnType<Embedder['embed']>
        >,
    });

    expect(await failedCases(embedderContract(), make)).toContain(
      'one vector per text, each as wide as promised',
    );
  });

  it('accepts a reranker that fails as a RERANK_FAILED value', async () => {
    const make = async (): Promise<Reranker> => ({
      model: 'demo-rerank',
      rerank: async () => ({ ok: false, code: 'RERANK_FAILED', message: 'no answer' }),
    });

    expect(await failedCases(rerankerContract(), make)).toEqual([]);
  });

  it('catches a reranker that fails with another code', async () => {
    const make = async (): Promise<Reranker> => ({
      model: 'demo-rerank',
      rerank: async () =>
        ({ ok: false, code: 'TIMEOUT', message: 'slow' }) as unknown as Awaited<
          ReturnType<Reranker['rerank']>
        >,
    });

    expect(await failedCases(rerankerContract(), make)).toContain(
      'the ranking is a subset of the input, with no repeats',
    );
  });

  it('catches a clock that goes backwards', async () => {
    const make = async (): Promise<Clock> => {
      let time = INSTANT.getTime();
      return {
        now() {
          time -= 1000;
          return new Date(time);
        },
      };
    };

    expect(await failedCases(clockContract(), make)).toContain('now never goes backwards');
  });

  it('catches an id generator that is not UUIDv7', async () => {
    const make = async (): Promise<IdGen> => {
      let serial = 0;
      return {
        next() {
          serial += 1;
          // UUIDv4 shaped: the right length, the wrong version.
          return `01940000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
        },
      };
    };

    expect(await failedCases(idGenContract(), make)).toContain(
      'a thousand ids in a row are all UUIDv7',
    );
  });

  it('catches an id generator that repeats and does not sort', async () => {
    const make = async (): Promise<IdGen> => {
      const ids = ['01940000-0000-7000-8000-000000000002', '01940000-0000-7000-8000-000000000001'];
      let index = 0;
      return {
        next() {
          const id = ids[index % ids.length] ?? ids[0];
          index += 1;
          return id as string;
        },
      };
    };

    const failed = await failedCases(idGenContract(), make);
    expect(failed).toContain('a thousand ids in a row are all different');
    expect(failed).toContain('ids sort in the order they were made');
  });
});

// --- the session token, the one identifier that leaves the process ----------

describe('session tokens', () => {
  it('round-trips a key', () => {
    const token = formatSessionToken({ harness: 'demo', harnessSessionId: 'session-0001' });
    expect(token).toBe('demo:session-0001');
    const parsed = parseSessionToken(token);
    expect(parsed).toEqual({
      ok: true,
      key: { harness: 'demo', harnessSessionId: 'session-0001' },
    });
  });

  it('keeps a harness session id that carries the separator', () => {
    const key = { harness: 'demo', harnessSessionId: `a${SESSION_TOKEN_SEPARATOR}b` };
    const parsed = parseSessionToken(formatSessionToken(key));
    expect(parsed).toEqual({ ok: true, key });
  });

  it('fails as a value for a token without a separator', () => {
    const parsed = parseSessionToken('session-0001');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('SESSION_TOKEN_INVALID');
    expect(parsed.message.length).toBeGreaterThan(0);
  });

  it.each(['', ':', 'demo:', ':session-0001'])(
    'fails as a value for the malformed token %j',
    (token) => {
      const parsed = parseSessionToken(token);
      expect(parsed.ok).toBe(false);
    },
  );

  it('throws for a key that cannot round-trip, because that is a bug', () => {
    expect(() => formatSessionToken({ harness: 'a:b', harnessSessionId: 'c' })).toThrow(TypeError);
    expect(() => formatSessionToken({ harness: '', harnessSessionId: 'c' })).toThrow(TypeError);
    expect(() => formatSessionToken({ harness: 'demo', harnessSessionId: '' })).toThrow(TypeError);
  });

  it('reads the session back by the token the caller formatted', async () => {
    const store = memoryStore();
    await store.ensureSelfUser(sampleSelfUserInput());
    await store.ensureSession(sampleEnsureSessionInput());
    await store.ingest(sampleIngestBatch());

    const read = await store.readSession(sampleSessionToken);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.messages).toHaveLength(4);
    expect(read.toolNotes).toHaveLength(2);

    const missing = await store.readSession(unknownSessionToken);
    expect(missing.ok).toBe(false);
  });
});
