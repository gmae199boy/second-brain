import { fileURLToPath } from 'node:url';

/**
 * What `packages/claude-code/test/fixtures/secrets-session.jsonl` carries, as
 * three lists, so the two tests that read it cannot drift apart: one checks
 * that the database holds all of it (`sessions-ingest.test.ts`), the other
 * that none of the secrets leaves through an output codec
 * (`output-codecs.test.ts`).
 *
 * Every credential in here is invented. They have the shape of the real thing
 * and none of them is valid anywhere.
 */

/** The fixture itself: invented credentials, and the things that only look like them. */
export const SECRETS_FIXTURE = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/secrets-session.jsonl', import.meta.url),
);

/**
 * Every secret the conversation pastes. All of them are stored verbatim
 * (마스킹 B) and none of them may come out of a codec (AD-11).
 */
export const SECRETS = [
  'sk-AAAAAAAAAAAAAAAAAAAA',
  'Tiger2024',
  'Hippo7714',
  'Walrus3382',
  'Pa!ss2024',
  'swordfish99',
  'pw9911',
  'xyz123',
] as const;

/**
 * The front half of the key the parser's 500-unit cut left behind, which is
 * what the stored tool note target ends in.
 *
 * No pattern recognises it — it is nine characters too short — and it is still
 * the opening of a key, which is the whole of the truncated-tail rule (2.7
 * follow-up review #21).
 */
export const TRUNCATED_HALF_KEY = 'sk-BBBBBBB';

/**
 * The regression table as the fixture writes it: identifiers, paths, an
 * address, a Korean sentence about a password, and the three lines version 1
 * of the pattern list used to mask (inputs A3, change D4).
 *
 * All of them are in the stored conversation and all of them survive a codec.
 */
export const KEPT_IN_FIXTURE = [
  '9f1c0e2a7b3d4e5f60718293a4b5c6d7e8f90123',
  'notes/import.md',
  'packages/core/src/index.ts',
  'max_tokens: 4096',
  'someone@demo.example',
  '192.168.0.1:8080',
  '1760745600000',
  '비밀번호는 바꿨어요',
  'let token = parse(input);',
  'secret: see the README',
  '{"token": 123}',
  'NODE_ENV=production',
] as const;
