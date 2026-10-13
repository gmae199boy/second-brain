import { describe, expect, it } from 'vitest';
import {
  formatSessionToken,
  parseSessionToken,
  SESSION_TOKEN_SEPARATOR,
} from '../src/domain/session-token.js';
import type { Clock } from '../src/ports/clock.js';
import type { IdGen } from '../src/ports/id-gen.js';
import type { Embedder } from '../src/ports/embedder.js';
import type { Reranker } from '../src/ports/reranker.js';
import type { SessionStore } from '../src/ports/store.js';
import {
  clockContract,
  embedderContract,
  fixedClock,
  idGenContract,
  memoryEmbedder,
  memoryParser,
  memoryReranker,
  memoryStore,
  memoryTranscript,
  parserContract,
  rerankerContract,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSessionToken,
  sequenceIdGen,
  sessionStoreContract,
  steppingClock,
  storeContract,
  unknownSessionToken,
  unreadableTranscript,
  type ContractCase,
  type ParserSubject,
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

describe('the parser contract against the memory parser', () => {
  const make = async (): Promise<ParserSubject> => ({
    parser: memoryParser(),
    readable: [memoryTranscript, JSON.stringify({ messages: [] })],
    unreadable: [unreadableTranscript, JSON.stringify({ notes: [] })],
  });

  for (const testCase of parserContract()) {
    it(testCase.name, async () => {
      await testCase.run(make);
    });
  }
});

describe('the embedder contract against the memory embedder', () => {
  for (const testCase of embedderContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => memoryEmbedder({ dimensions: 16 }));
    });
  }
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
    const make = async (): Promise<SessionStore> => {
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

  it('catches a store that re-inserts the messages of every batch', async () => {
    const make = async (): Promise<SessionStore> => {
      const inner = memoryStore();
      return {
        ...inner,
        async ingest(batch) {
          // Counts every batch as new, so a replay doubles the session (AD-8).
          const result = await inner.ingest(batch);
          if (!result.ok) return result;
          return {
            ...result,
            inserted: { messages: batch.messages.length, toolNotes: batch.toolNotes.length },
          };
        },
      };
    };

    expect(await failedCases(sessionStoreContract(), make)).toContain(
      'ingest adds nothing the second time the same batch arrives',
    );
  });

  it('catches a store that throws for an unknown session', async () => {
    const make = async (): Promise<SessionStore> => {
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
    const make = async (): Promise<SessionStore> => {
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
});

describe('the contracts catch a wrong parser', () => {
  it('catches a parser whose seq does not start at 0', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      return {
        parser: {
          harness: inner.harness,
          version: inner.version,
          parse(content) {
            const result = inner.parse(content);
            if (!result.ok) return result;
            return {
              ...result,
              messages: result.messages.map((message) => ({
                ...message,
                seq: message.seq + 1,
              })),
            };
          },
        },
        readable: [memoryTranscript],
        unreadable: [],
      };
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'seq starts at 0 and grows by one',
    );
  });

  it('catches a parser that answers differently every time', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      let calls = 0;
      return {
        parser: {
          harness: inner.harness,
          version: inner.version,
          parse(content) {
            calls += 1;
            const result = inner.parse(content);
            if (!result.ok) return result;
            return { ...result, messages: result.messages.slice(0, calls) };
          },
        },
        readable: [memoryTranscript],
        unreadable: [],
      };
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'parsing the same transcript twice is identical',
    );
  });

  it('catches a parser that repeats a (message, ordinal) pair', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      return {
        parser: {
          harness: inner.harness,
          version: inner.version,
          parse(content) {
            const result = inner.parse(content);
            if (!result.ok) return result;
            return {
              ...result,
              toolNotes: result.toolNotes.map((note) => ({ ...note, ordinal: 0 })),
            };
          },
        },
        readable: [memoryTranscript],
        unreadable: [],
      };
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'tool notes are unique per message and ordinal, and point at a parsed message',
    );
  });

  it('catches a parser that throws instead of refusing', async () => {
    const make = async (): Promise<ParserSubject> => {
      const inner = memoryParser();
      return {
        parser: {
          harness: inner.harness,
          version: inner.version,
          parse(content) {
            const result = inner.parse(content);
            if (!result.ok) throw new Error('cannot read this transcript');
            return result;
          },
        },
        readable: [memoryTranscript],
        unreadable: [unreadableTranscript],
      };
    };

    expect(await failedCases(parserContract(), make)).toContain(
      'content the parser cannot read fails as a value',
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
    await store.ensureSession(sampleEnsureSessionInput());
    await store.ingest(sampleIngestBatch());

    const read = await store.readSession(sampleSessionToken);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.messages).toHaveLength(3);
    expect(read.toolNotes).toHaveLength(2);

    const missing = await store.readSession(unknownSessionToken);
    expect(missing.ok).toBe(false);
  });
});
