import { describe, expect, it } from 'vitest';
import { errorEnvelope, okEnvelope } from '../src/envelope.js';
import {
  OUTPUT_CODECS,
  encodeHookLine,
  encodeHookOutput,
  encodeTextLine,
} from '../src/output/codecs.js';
import {
  TOOL_NOTE_TARGET_LIMIT,
  maskOutputText,
  maskOutputValue,
  maskToolNoteTarget,
  sessionForOutput,
  toolNoteForOutput,
} from '../src/output/mask.js';
import type { Clock } from '../src/ports/clock.js';

/**
 * Core's output masking, from the side only a unit test can reach: the deep
 * walk, the truncated tail, idempotence, and the envelope being masked where
 * it is built rather than where it is written (AD-11, 마스킹 B).
 *
 * The end-to-end half — a real transcript through a real database and out of
 * every registered codec — is `apps/cli/test/output-codecs.test.ts`.
 *
 * Every secret here is invented and valid nowhere.
 */

const SECRET = 'sk-AAAAAAAAAAAAAAAAAAAA';
const clock: Clock = { now: () => new Date('2026-01-02T03:04:05.000Z') };

describe('maskOutputValue', () => {
  it('masks every string value, however deep, and leaves the keys alone', () => {
    const input = {
      password: 'plain',
      nested: { list: [`키는 ${SECRET}`, { body: 'password: hunter2x' }] },
    };

    const masked = maskOutputValue(input);

    expect(masked).toEqual({
      // The key is `password` and it is still `password`: a key is the shape
      // of the answer, not its content.
      password: 'plain',
      nested: {
        list: ['키는 [REDACTED:api_key]', { body: 'password: [REDACTED:password]' }],
      },
    });
  });

  it('leaves numbers, booleans and null exactly as they are', () => {
    expect(maskOutputValue({ count: 4096, ok: true, nothing: null, list: [1, 2] })).toEqual({
      count: 4096,
      ok: true,
      nothing: null,
      list: [1, 2],
    });
  });

  it('does not change what it was given', () => {
    const input = { body: `키는 ${SECRET}` };

    maskOutputValue(input);

    expect(input.body).toBe(`키는 ${SECRET}`);
  });

  it('masks a non-plain object the way JSON would emit it', () => {
    // Anything with a `toJSON` is masked through that value, because that is
    // what `JSON.stringify` writes — a `Date` is its ISO string.
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(maskOutputValue({ when }).when).toBe('2026-01-02T03:04:05.000Z');
    expect(JSON.stringify(maskOutputValue({ when }))).toBe(JSON.stringify({ when }));
  });

  it('masks the credentials of a URL, which JSON writes as its href', () => {
    // Handed back untouched, a `URL` let the whole credential out: nothing
    // masked it and `JSON.stringify` serialised it anyway (follow-up review).
    const url = new URL('https://deploy:pw9911@registry.example/x');

    const masked = maskOutputValue({ url });

    expect(JSON.stringify(masked)).not.toContain('pw9911');
    expect(masked.url).toBe('https://deploy:[REDACTED:url_credentials]@registry.example/x');
  });

  it('masks the string fields of a class instance, as JSON sees them', () => {
    class Report {
      constructor(
        readonly note: string,
        readonly count: number,
      ) {}
    }

    const masked = maskOutputValue({ report: new Report(`키는 ${SECRET}`, 2) });

    expect(masked.report).toEqual({ note: '키는 [REDACTED:api_key]', count: 2 });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it('turns a Map or a Set into the empty object JSON makes of them', () => {
    const masked = maskOutputValue({
      map: new Map([['password', 'hunter2x']]),
      set: new Set(['hunter2x']),
    });

    expect(masked).toEqual({ map: {}, set: {} });
    expect(JSON.stringify(masked)).toBe(
      JSON.stringify({ map: new Map([['password', 'hunter2x']]), set: new Set(['hunter2x']) }),
    );
  });
});

describe('the truncated tail of a tool note target', () => {
  /** A target of exactly the limit, ending in the opening of a longer key. */
  const HALF_KEY = 'sk-AAAAAAAAA';
  const cut = `echo ${'x'.repeat(TOOL_NOTE_TARGET_LIMIT - 6 - HALF_KEY.length)} ${HALF_KEY}`;

  it('leaves a target shorter than the limit as the pattern list left it', () => {
    expect(cut.length).toBe(TOOL_NOTE_TARGET_LIMIT);
    const shorter = 'echo hello world';
    expect(maskToolNoteTarget(shorter)).toBe(shorter);
    // Its last token is a word, and it keeps it: only a cut target loses one.
    expect(maskToolNoteTarget('FOO=bar run.js')).toBe('FOO=[REDACTED:shell_assignment] run.js');
    expect(maskToolNoteTarget(`echo ${HALF_KEY}`)).toBe(`echo ${HALF_KEY}`);
  });

  it('masks the last token of a target that reached the limit', () => {
    // `sk-AAAAAAAAA` is nine characters short of anything the list would
    // recognise, and it is still the front half of a key (review #21).
    const masked = maskToolNoteTarget(cut);

    expect(masked).not.toContain(HALF_KEY);
    expect(masked).toBe(`${cut.slice(0, cut.length - HALF_KEY.length)}[REDACTED:truncated]`);
  });

  it('masks nothing when the cut target ends on a space or on a marker', () => {
    // A token of length zero. There is nothing of a secret in either.
    const endsOnSpace = `${'y'.repeat(TOOL_NOTE_TARGET_LIMIT - 1)} `;
    expect(maskToolNoteTarget(endsOnSpace)).toBe(endsOnSpace);

    const head = 'z'.repeat(TOOL_NOTE_TARGET_LIMIT);
    const endsOnSecret = `${head} ${SECRET}`;
    expect(maskToolNoteTarget(endsOnSecret)).toBe(`${head} [REDACTED:api_key]`);
  });

  it('starts the token after the later of the last space and the last marker', () => {
    const head = 'w'.repeat(TOOL_NOTE_TARGET_LIMIT);
    const target = `${head} ${SECRET}/tail`;

    // The key and what is stuck to it are one token with no space in it, so
    // the marker's end — not the space before the key — is where the tail
    // begins.
    expect(maskToolNoteTarget(target)).toBe(`${head} [REDACTED:api_key][REDACTED:truncated]`);
  });

  it('masks the target column of a tool note and nothing else of it', () => {
    const note = { tool: 'Bash', target: 'OPENAI_API_KEY=xyz123 node run.js', ok: true };

    expect(toolNoteForOutput(note)).toEqual({
      tool: 'Bash',
      // `API_KEY` is the English keyword form, which comes before the shell
      // one in the list and so names the span.
      target: 'OPENAI_API_KEY=[REDACTED:password] node run.js',
      ok: true,
    });
    expect(note.target).toBe('OPENAI_API_KEY=xyz123 node run.js');
  });
});

describe('masking the same thing twice changes nothing', () => {
  const samples = [
    `키는 ${SECRET} 이다`,
    'password: Pa!ss2024',
    '비밀번호 Tiger2024',
    `${'x'.repeat(TOOL_NOTE_TARGET_LIMIT)} sk-AAAAAAAAA`,
  ];

  it.each(samples)('maskOutputText is a no-op on its own output for %j', (text) => {
    const once = maskOutputText(text);
    expect(maskOutputText(once)).toBe(once);
  });

  it.each(samples)('maskToolNoteTarget is a no-op on its own output for %j', (text) => {
    const once = maskToolNoteTarget(text);
    expect(maskToolNoteTarget(once)).toBe(once);
  });

  it('maskOutputValue is a no-op on its own output', () => {
    const once = maskOutputValue({ body: `키는 ${SECRET}`, list: ['password: hunter2x'] });
    expect(maskOutputValue(once)).toEqual(once);
  });
});

describe('the envelope codec masks as the envelope is built', () => {
  it('masks data, warnings and meta of a successful answer', () => {
    const envelope = okEnvelope(clock, { body: `키는 ${SECRET}` }, [], {
      hint: 'password: hunter2x',
    });

    expect(envelope.data).toEqual({ body: '키는 [REDACTED:api_key]' });
    expect(envelope.meta?.hint).toBe('password: [REDACTED:password]');
    // The instant is this clock's and never a caller's text.
    expect(envelope.now).toContain('2026-01-02T');
  });

  it('masks the message and the hint of a failure', () => {
    const envelope = errorEnvelope(clock, {
      code: 'INVALID_ARGUMENT',
      message: `키가 ${SECRET} 입니다`,
      hint: `${SECRET} 를 지우세요`,
    });

    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(envelope.error?.message).toBe('키가 [REDACTED:api_key] 입니다');
    expect(envelope.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('drops a retry whose arguments masking changed', () => {
    // `retry` is meant to be run, not read. A masked argument would make it a
    // command that writes `[REDACTED:…]` into real data, so there is no retry
    // to offer and the caller retypes the call (follow-up review).
    const envelope = errorEnvelope(clock, {
      code: 'INVALID_ARGUMENT',
      message: '키가 틀렸습니다',
      retry: { ns: 'sessions', verb: 'ingest', args: { note: SECRET, confirm: true } },
    });

    expect(envelope.error?.retry).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    // The failure itself still says what happened.
    expect(envelope.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('keeps a retry no pattern touched, down to the last argument', () => {
    const retry = {
      ns: 'sessions',
      verb: 'ingest',
      args: { harness: 'claude-code', path: '/demo/repo/a.jsonl', confirm: true },
    };

    const envelope = errorEnvelope(clock, {
      code: 'CONFIRMATION_REQUIRED',
      message: '확인이 필요합니다',
      retry,
    });

    expect(envelope.error?.retry).toEqual(retry);
  });
});

describe('the registry of the ways out', () => {
  it('names every codec once', () => {
    const names = OUTPUT_CODECS.map((codec) => codec.name);
    expect(names).toEqual(['envelope', 'hook', 'text']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every secret of the probe out of every codec', () => {
    // The probe is the stored session, unmasked: the tool note rule is the
    // codec's to apply, not the test's (follow-up review).
    const probe = {
      texts: [`키는 ${SECRET} 이고 비밀번호 Tiger2024`, 'password: Pa!ss2024'],
      toolNotes: [{ tool: 'Bash', target: 'OPENAI_API_KEY=xyz123 node run.js' }],
    };

    for (const codec of OUTPUT_CODECS) {
      const rendered = codec.render(probe);
      for (const secret of [SECRET, 'Tiger2024', 'Pa!ss2024', 'xyz123']) {
        expect(rendered, `${secret} came out of the ${codec.name} codec`).not.toContain(secret);
      }
    }
  });

  it('applies the shell rule in every codec, even for a name no keyword covers', () => {
    // `MY_CREDENTIAL` is no keyword of the list, so the body rule alone sees
    // nothing here: only the target column's shell rule catches it, and only a
    // codec that called `sessionForOutput` ran that rule.
    const probe = {
      texts: [],
      toolNotes: [{ tool: 'Bash', target: 'MY_CREDENTIAL=abc123 node run.js' }],
    };

    for (const codec of OUTPUT_CODECS) {
      const rendered = codec.render(probe);
      expect(rendered, `abc123 came out of the ${codec.name} codec`).not.toContain('abc123');
      // The name stays: that is what makes the note readable afterwards.
      expect(rendered).toContain('MY_CREDENTIAL');
    }
  });

  it('leaves ordinary code and prose in every codec', () => {
    const kept = ['let token = parse(input);', 'secret: see the README'];
    const probe = { texts: kept, toolNotes: [{ tool: 'Bash', target: 'node run.js --model=demo' }] };

    for (const codec of OUTPUT_CODECS) {
      const rendered = codec.render(probe);
      for (const text of [...kept, 'node run.js --model=demo']) {
        expect(rendered, `the ${codec.name} codec masked ${text}`).toContain(text);
      }
    }
  });
});

describe('sessionForOutput', () => {
  it('runs every tool note of a read through the target rule and nothing else', () => {
    const read = {
      session: { id: 'session-1' },
      messages: [{ body: 'password: hunter2x' }],
      toolNotes: [
        { tool: 'Bash', target: 'OPENAI_API_KEY=xyz123 node run.js', ok: true },
        { tool: 'Read', target: 'notes/import.md', ok: true },
      ],
    };

    const out = sessionForOutput(read);

    expect(out.toolNotes.map((note) => note.target)).toEqual([
      'OPENAI_API_KEY=[REDACTED:password] node run.js',
      'notes/import.md',
    ]);
    // The bodies are the codec's to mask, and the session row is untouched.
    expect(out.messages).toEqual(read.messages);
    expect(out.session).toEqual(read.session);
    // The input is never changed.
    expect(read.toolNotes[0]?.target).toBe('OPENAI_API_KEY=xyz123 node run.js');
  });
});

describe('the hook and text encoders', () => {
  it('masks every string value of a hook line of JSON', () => {
    expect(encodeHookOutput({ systemMessage: `키는 ${SECRET}`, count: 1 })).toBe(
      JSON.stringify({ systemMessage: '키는 [REDACTED:api_key]', count: 1 }),
    );
  });

  it('masks one line of hook stderr and one line of ordinary output', () => {
    expect(encodeHookLine(`brain: 키는 ${SECRET}`)).toBe('brain: 키는 [REDACTED:api_key]');
    expect(encodeTextLine('password: hunter2x')).toBe('password: [REDACTED:password]');
  });
});
