import { describe, expect, it } from 'vitest';
import {
  SECRET_PATTERNS,
  SECRET_PATTERN_VERSION,
  maskSecrets,
} from '../src/domain/secret-patterns.js';
import { contentHash } from '../src/domain/sha256.js';

/**
 * Core's pattern list, from both sides: what it must catch, and the far longer
 * list of what it must leave alone.
 *
 * The second list is the one that matters. A message is never rewritten once it
 * is stored, so a pattern that masks a git SHA or a file path has deleted
 * something nobody can get back — which is why the regression table of the
 * ticket is a case of its own here (inputs A3).
 *
 * Every secret in this file is invented. They have the shape of the real thing
 * and none of them is valid anywhere.
 */

/** The spans of one masking, as `kind[start,end)`, for a readable expectation. */
function spansOf(text: string, field: 'body' | 'tool_target' = 'body'): string[] {
  return maskSecrets(text, field).spans.map(
    (span) => `${span.kind}[${String(span.start)},${String(span.end)})`,
  );
}

function maskedBody(text: string): string {
  return maskSecrets(text, 'body').text;
}

describe('the pattern list itself', () => {
  it('is at version 2', () => {
    // Bumped by 마스킹 B: the value set, the Korean separators and the English
    // value-shape rules all changed (change D4).
    expect(SECRET_PATTERN_VERSION).toBe('2');
  });

  it('is built the way the masking function needs: global, unicode, with indices', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.kind, `${pattern.kind} must be English snake_case`).toMatch(
        /^[a-z][a-z0-9_]*$/,
      );
      for (const flag of ['g', 'd', 'u']) {
        expect(pattern.expression.flags, `${pattern.kind} is missing the ${flag} flag`).toContain(
          flag,
        );
      }
      expect(pattern.fields.length, `${pattern.kind} runs over no field`).toBeGreaterThan(0);
    }
  });
});

describe('the provider tokens', () => {
  it.each([
    ['api_key', 'sk-AAAAAAAAAAAAAAAAAAAA'],
    ['stripe_key', 'sk_live_AAAAAAAAAAAAAAAA'],
    ['stripe_key', 'sk_test_BBBBBBBBBBBBBBBB'],
    ['github_token', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['github_token', 'ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'],
    ['github_token', 'github_pat_11ABCDEFG0aaaaaaaaaaaa'],
    ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws_access_key', 'ASIAIOSFODNN7EXAMPLE'],
    ['slack_token', 'xoxb-1234567890-abcdefghij'],
    ['google_api_key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
  ])('masks a %s whole', (kind, secret) => {
    expect(maskedBody(`앞에 ${secret} 뒤에`)).toBe(`앞에 [REDACTED:${kind}] 뒤에`);
  });

  it('leaves a longer opaque string that merely starts the same way alone', () => {
    // The lookbehind: cutting a token out of the middle of a longer word would
    // mangle a word rather than remove a secret.
    expect(maskedBody('xsk-AAAAAAAAAAAAAAAAAAAA')).toBe('xsk-AAAAAAAAAAAAAAAAAAAA');
    expect(maskedBody('prefixAKIAIOSFODNN7EXAMPLE')).toBe('prefixAKIAIOSFODNN7EXAMPLE');
  });

  it('keeps the scheme of a bearer header and masks only the credential', () => {
    expect(maskedBody('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe(
      'Authorization: Bearer [REDACTED:bearer_token]',
    );
    // Case does not matter, and a short word after it is not a credential.
    expect(maskedBody('bearer ABCDEFGHIJKLMNOPQRSTUVWX')).toBe('bearer [REDACTED:bearer_token]');
    expect(maskedBody('Bearer token')).toBe('Bearer token');
  });
});

describe('the keyword forms', () => {
  it('keeps the name and the separator, masking only the value', () => {
    expect(maskedBody('password: hunter2x, 다음')).toBe('password: [REDACTED:password], 다음');
    expect(maskedBody('비밀번호는 Tiger2024')).toBe('비밀번호는 [REDACTED:password]');
    expect(maskedBody('"api_key": "abc123def"')).toBe('"api_key": "[REDACTED:password]"');
    expect(maskedBody('DB_PASSWORD=swordfish99')).toBe('DB_PASSWORD=[REDACTED:password]');
    expect(maskedBody('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')).toBe(
      'AWS_SECRET_ACCESS_KEY=[REDACTED:password]',
    );
  });

  it('stops the value at a space, a comma or a quote', () => {
    // `\S+` would swallow the rest of a sentence that has no space in it, and
    // in Korean that is most of a sentence (inputs A4).
    expect(maskedBody('passwd=abc,def')).toBe('passwd=[REDACTED:password],def');
    expect(maskedBody("secret: 'abc' 그리고")).toBe("secret: '[REDACTED:password]' 그리고");
    expect(maskedBody('암호: abc 그 뒤')).toBe('암호: [REDACTED:password] 그 뒤');
  });

  it('does not mask a Korean sentence about a password', () => {
    // "비밀번호는 바꿨어" is somebody saying they changed it. Masking the next
    // word would delete a sentence rather than a secret.
    expect(maskedBody('비밀번호는 바꿨어')).toBe('비밀번호는 바꿨어');
    expect(maskedBody('암호화는 AES로 한다')).toBe('암호화는 AES로 한다');
    expect(maskedBody('패스워드는 기억이 안 나')).toBe('패스워드는 기억이 안 나');
  });

  it('does not take a name that merely contains a keyword for an assignment', () => {
    expect(maskedBody('max_tokens: 4096')).toBe('max_tokens: 4096');
    expect(maskedBody('max_tokens')).toBe('max_tokens');
    expect(maskedBody('tokenizer: fast')).toBe('tokenizer: fast');
  });

  it('keeps a value whole through the punctuation version 1 stopped at', () => {
    // Version 1's value set ended at `!`, `?`, `.` and `:`, so the back half of
    // a password stayed in the output. Those characters are inside a value now.
    expect(maskedBody('password: Pa!ss2024')).toBe('password: [REDACTED:password]');
    expect(maskedBody('passwd=a.b:c?d')).toBe('passwd=[REDACTED:password]');
  });

  it('still stops the value at a comma, a semicolon or Hangul', () => {
    expect(maskedBody('password: hunter2x, 다음')).toBe('password: [REDACTED:password], 다음');
    expect(maskedBody('password=hunter2x;echo')).toBe('password=[REDACTED:password];echo');
    expect(maskedBody('token: abc123그리고')).toBe('token: [REDACTED:password]그리고');
  });

  it('reads the three Korean separators version 2 added', () => {
    // A bare space and the common particles. Version 1 knew only `:`, `=`, `은`
    // and `는`, and let the rest out of Brain (change D4).
    expect(maskedBody('비밀번호 Tiger2024')).toBe('비밀번호 [REDACTED:password]');
    expect(maskedBody('비밀번호가 Tiger2024')).toBe('비밀번호가 [REDACTED:password]');
    expect(maskedBody('비밀번호를 Tiger2024')).toBe('비밀번호를 [REDACTED:password]');
    expect(maskedBody('암호 = Tiger2024')).toBe('암호 = [REDACTED:password]');
  });

  it('leaves an English keyword whose value is code or prose alone', () => {
    // Unquoted values only, and three shapes: a call, digits, and a word with
    // another word after it. Over-masking costs nothing stored, but a masked
    // line of code is a line nobody can read (change D4).
    expect(maskedBody('let token = parse(input);')).toBe('let token = parse(input);');
    expect(maskedBody('secret: see the README')).toBe('secret: see the README');
    expect(maskedBody('{"token": 123}')).toBe('{"token": 123}');
  });

  it('masks a value that only begins like a call', () => {
    // The whole value has to be the call. `foo(bar)baz` is not one, and a
    // credential is not spared for opening with an identifier and a bracket.
    expect(maskedBody('token=foo(bar)baz')).toBe('token=[REDACTED:password]');
  });

  it('masks a word at the end of a line whatever the next line says', () => {
    // The sentence rule reads a space or a tab, never a newline: the word
    // after a line break is a different sentence. It used to depend on how
    // the caller had joined the lines, so one codec masked and another did not.
    expect(maskedBody('secret: hunterpass\nok done')).toBe(
      'secret: [REDACTED:password]\nok done',
    );
    expect(maskedBody('secret: hunterpass')).toBe('secret: [REDACTED:password]');
  });

  it('masks a quoted value whatever shape it has', () => {
    // The quotes say somebody meant the string, so the shape rules step aside.
    expect(maskedBody('secret: "see"')).toBe('secret: "[REDACTED:password]"');
    expect(maskedBody("token='123'")).toBe("token='[REDACTED:password]'");
  });

  it('takes an unmatched closing bracket off the end of a value', () => {
    // `{"token": 1a}` ends in the object's brace, and `parse(input)` does not:
    // that bracket is matched, which is what lets the call rule see a call.
    expect(maskedBody('{"token": 1a}')).toBe('{"token": [REDACTED:password]}');
    expect(maskedBody('(password=x2)')).toBe('(password=[REDACTED:password])');
  });
});

describe('the block and URL forms', () => {
  it('masks a whole PEM block, header and footer included', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(maskedBody(`앞\n${block}\n뒤`)).toBe('앞\n[REDACTED:private_key]\n뒤');
    expect(maskedBody(`앞\n${block.replace('RSA ', '')}\n뒤`)).toBe(
      '앞\n[REDACTED:private_key]\n뒤',
    );
  });

  it('ends the block at the first END line, whatever that line is labelled', () => {
    // A footer with another label is still a footer. Demanding a matching one
    // would run the mask to the end of the text and take the prose with it.
    const body =
      '-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END CERTIFICATE-----\nnormal text after';
    expect(maskedBody(body)).toBe('[REDACTED:private_key]\nnormal text after');
  });

  it('masks to the end of the text when the block has no END line', () => {
    // Half of a private key is still a private key, and the rest of it is
    // somewhere in the same message.
    const started = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB';
    expect(maskedBody(`보세요 ${started}`)).toBe('보세요 [REDACTED:private_key]');
  });

  it('masks only the password of a URL that carries credentials', () => {
    expect(maskedBody('https://user:pw123@host.example/x')).toBe(
      'https://user:[REDACTED:url_credentials]@host.example/x',
    );
    expect(maskedBody('postgres://owner:s3cr3t@db.example:5432/brain')).toBe(
      'postgres://owner:[REDACTED:url_credentials]@db.example:5432/brain',
    );
    expect(maskedBody('https://host.example/x')).toBe('https://host.example/x');
  });
});

describe('the Korean personal numbers and the card check', () => {
  it('masks a resident registration number, with or without its dash', () => {
    expect(maskedBody('주민번호 900101-1234567 입니다')).toBe(
      '주민번호 [REDACTED:resident_registration_number] 입니다',
    );
    expect(maskedBody('9001011234567')).toBe('[REDACTED:resident_registration_number]');
  });

  it('masks a mobile number, with or without its dashes', () => {
    expect(maskedBody('010-1234-5678로 전화')).toBe('[REDACTED:phone_number]로 전화');
    expect(maskedBody('01098765432')).toBe('[REDACTED:phone_number]');
    // A landline is not this pattern, and neither is a longer run of digits.
    expect(maskedBody('02-123-4567')).toBe('02-123-4567');
  });

  it('masks a card number only when the digits pass Luhn', () => {
    expect(maskedBody('카드 4111 1111 1111 1111 입니다')).toBe('카드 [REDACTED:card_number] 입니다');
    expect(maskedBody('5500-0000-0000-0004')).toBe('[REDACTED:card_number]');
    // The same shape with one digit changed is not a card number, and an order
    // number that happens to be sixteen digits long must survive.
    expect(maskedBody('4111 1111 1111 1112')).toBe('4111 1111 1111 1112');
    expect(maskedBody('4000123456789010')).toBe('4000123456789010');
  });
});

describe('the shell assignment, which is for tool note targets alone', () => {
  it('masks the value of an upper-case assignment in a target', () => {
    expect(maskSecrets('export SECRET_FILE="/tmp/a b" ls', 'tool_target').text).toBe(
      'export SECRET_FILE="[REDACTED:shell_assignment]" ls',
    );
    expect(maskSecrets('FOO=bar baz', 'tool_target').text).toBe(
      'FOO=[REDACTED:shell_assignment] baz',
    );
  });

  it('leaves a lower-case name and an option alone', () => {
    // Upper-case snake only, so `--model=x` and a URL are not matches (A5).
    expect(maskSecrets('node run.js --model=demo-model', 'tool_target').text).toBe(
      'node run.js --model=demo-model',
    );
    expect(maskSecrets('foo=bar', 'tool_target').text).toBe('foo=bar');
  });

  it('never runs over a body', () => {
    // A message is never rewritten once stored, so masking an ordinary setting
    // in a body would be a deletion nobody could undo (Decision 2026-10-18).
    expect(maskedBody('NODE_ENV=production 으로 돌렸다')).toBe('NODE_ENV=production 으로 돌렸다');
    expect(maskedBody('PWD=/Users/demo/repo')).toBe('PWD=/Users/demo/repo');
  });
});

describe('the regression table: what must never be masked', () => {
  const keep = [
    // A git SHA, a UUIDv7 and a stored hash: the three identifiers a coding
    // conversation is full of. WeKnora's "opaque token over 40 characters"
    // rule would take all three, which is why it is not in the list (A3).
    '9f1c0e2a7b3d4e5f60718293a4b5c6d7e8f90123',
    '01940000-0000-7000-8000-000000000001',
    `sha256:${'a'.repeat(64)}`,
    'someone@demo.example',
    '10.0.12.7',
    '192.168.0.1:8080',
    '/Users/demo/repo/src/a.ts',
    'packages/core/src/index.ts',
    '@scope/name',
    'lodash@4.17.21',
    'max_tokens: 4096',
    'max_tokens',
    // A comparison, not an assignment: the separator is one character, so the
    // rest of the operator would otherwise be masked as the value.
    'if (password === input)',
    'token == expected',
    'secret == null',
    '비밀번호는 바꿨어',
    '암호화는 AES로 한다',
    // Thirteen digits of epoch milliseconds, which is neither a card number nor
    // a resident registration number.
    '1760745600000',
    // The identifiers an envelope carries on every single answer: masking any
    // of them would make the output unusable rather than safe (change D1).
    'claude-code:4f1e7a90-1c2b-4d3e-8f55-000000000000',
    '2026-10-19T01:06:00.000+09:00',
    '2026-10-19T01:06:00.000-08:00',
  ];

  it.each(keep)('leaves %j in a body exactly as it was', (text) => {
    const result = maskSecrets(text, 'body');
    expect(result.text).toBe(text);
    expect(result.spans).toEqual([]);
  });

  it.each(keep)('leaves %j in a tool note target exactly as it was', (text) => {
    const result = maskSecrets(text, 'tool_target');
    expect(result.text).toBe(text);
    expect(result.spans).toEqual([]);
  });

  it('leaves an environment setting in a body alone', () => {
    // The one row of the table that is about the body only: in a target the
    // shell pattern does mask it.
    const result = maskSecrets('NODE_ENV=production', 'body');
    expect(result.text).toBe('NODE_ENV=production');
    expect(result.spans).toEqual([]);
  });

  it('leaves an ordinary conversation alone', () => {
    const body = 'They are in notes/import.md.\nI added the open question at the end.';
    expect(maskSecrets(body, 'body')).toEqual({ text: body, spans: [] });
  });
});

describe('where the spans sit', () => {
  it('counts code points and not UTF-16 units', () => {
    // An emoji is one position, not two: a record whose range was counted in
    // UTF-16 would point at the wrong part of the body for ever (Conventions).
    const body = '한글😀 sk-AAAAAAAAAAAAAAAAAAAA';
    expect(spansOf(body)).toEqual(['api_key[4,27)']);
    expect([...body].slice(4, 27).join('')).toBe('sk-AAAAAAAAAAAAAAAAAAAA');
  });

  it('reports the range over the body as it stood before the masking', () => {
    const body = '키는 sk-AAAAAAAAAAAAAAAAAAAA 이다';
    const result = maskSecrets(body, 'body');
    expect(result.text).toBe('키는 [REDACTED:api_key] 이다');
    expect(result.spans).toEqual([
      {
        start: 3,
        end: 26,
        kind: 'api_key',
        removed: contentHash('sk-AAAAAAAAAAAAAAAAAAAA'),
      },
    ]);
  });

  it('reports the hash of what went and never the text', () => {
    const result = maskSecrets('password: hunter2x', 'body');
    expect(result.spans[0]?.removed).toBe(contentHash('hunter2x'));
    expect(JSON.stringify(result)).not.toContain('hunter2x');
  });

  it('reports every span in the order the body holds them', () => {
    expect(spansOf('a sk-AAAAAAAAAAAAAAAAAAAA b 010-1234-5678 c')).toEqual([
      'api_key[2,25)',
      'phone_number[28,41)',
    ]);
  });
});

describe('spans that overlap', () => {
  it('leaves one marker and one record where two patterns saw the same secret', () => {
    // The keyword gave the value away and the token pattern matched the value:
    // one span, and the kind of the more specific pattern (I/O matrix).
    const result = maskSecrets('token=sk-AAAAAAAAAAAAAAAAAAAA', 'body');
    expect(result.text).toBe('token=[REDACTED:api_key]');
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.kind).toBe('api_key');
  });

  it('unions a pattern that reaches further than the one that started first', () => {
    // The PEM block starts first and runs past everything inside it, so what is
    // inside it never becomes a span of its own.
    const body = '-----BEGIN RSA PRIVATE KEY-----\npassword: hunter2x\n-----END RSA PRIVATE KEY-----';
    const result = maskSecrets(body, 'body');
    expect(result.text).toBe('[REDACTED:private_key]');
    expect(result.spans).toHaveLength(1);
  });
});

describe('masking is a function, and masking a masked text changes nothing', () => {
  const samples = [
    '키는 sk-AAAAAAAAAAAAAAAAAAAA 이다',
    'password: hunter2x, 다음',
    '비밀번호는 Tiger2024',
    'https://user:pw123@host.example/x',
    'token=sk-AAAAAAAAAAAAAAAAAAAA',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
    '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
    '주민번호 900101-1234567, 010-1234-5678',
  ];

  it.each(samples)('gives the same answer twice for %j', (text) => {
    expect(maskSecrets(text, 'body')).toEqual(maskSecrets(text, 'body'));
  });

  it.each(samples)('finds nothing left to mask in the masked %j', (text) => {
    // Ingest reads the same transcript again and again, and a marker that grew
    // a marker every time would make the stored body drift (AD-8).
    const once = maskSecrets(text, 'body').text;
    const twice = maskSecrets(once, 'body');
    expect(twice.text).toBe(once);
    expect(twice.spans).toEqual([]);
  });

  it.each(['OPENAI_API_KEY=xyz123 node run.js', 'curl https://u:pw123@host/x'])(
    'finds nothing left to mask in the masked target %j',
    (target) => {
      const once = maskSecrets(target, 'tool_target').text;
      expect(maskSecrets(once, 'tool_target')).toEqual({ text: once, spans: [] });
    },
  );

  it('still masks a secret that runs on past a marker already in the text', () => {
    // Only a span wholly inside a marker is the marker's own text. A key block
    // with no `END` that runs over a marker is a key, and must go whole.
    const text = '-----BEGIN PRIVATE KEY-----\nAAAA [REDACTED:api_key] BBBB';
    const result = maskSecrets(text, 'body');
    expect(result.text).toBe('[REDACTED:private_key]');
    expect(result.spans).toHaveLength(1);
  });

  it('answers an empty text with an empty result', () => {
    expect(maskSecrets('', 'body')).toEqual({ text: '', spans: [] });
  });
});
