import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPOSE_FILE,
  DEFAULT_TEST_DATABASE_URL,
  TEST_DATABASE_URL_ENV,
  type CommandResult,
  prepareTestDatabase,
} from '../src/global-setup.js';

/** A fixed compose path, so an expected command line can be written in full. */
const COMPOSE = '/repo/compose.test.yaml';
const PS = `docker compose -f ${COMPOSE} ps --status running --quiet postgres`;
const UP = `docker compose -f ${COMPOSE} up -d --wait`;
const DOWN = `docker compose -f ${COMPOSE} down`;

/** What a fake command answers. Anything left out is "exit 0, no output". */
type Responder = (line: string) => Partial<CommandResult> | undefined;

interface Harness {
  /** Every command, as `command arg arg`, in the order it was run. */
  calls: string[];
  env: NodeJS.ProcessEnv;
  lines: string[];
  prepare: () => (() => void) | undefined;
}

function harness(options: { env?: NodeJS.ProcessEnv; answer?: Responder } = {}): Harness {
  const calls: string[] = [];
  const env: NodeJS.ProcessEnv = { ...options.env };
  const lines: string[] = [];
  return {
    calls,
    env,
    lines,
    prepare: () =>
      prepareTestDatabase({
        env,
        composeFile: COMPOSE,
        log: (line) => lines.push(line),
        run: (command, args) => {
          const line = [command, ...args].join(' ');
          calls.push(line);
          return { status: 0, stdout: '', stderr: '', ...options.answer?.(line) };
        },
      }),
  };
}

/** The message of the one failure, so the commands can be counted after it. */
function messageOf(prepare: () => unknown): string {
  try {
    prepare();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('preparation was expected to fail, and did not');
}

describe('prepareTestDatabase', () => {
  it('uses the database the variable already names, without calling docker', () => {
    const { calls, env, prepare } = harness({
      env: { [TEST_DATABASE_URL_ENV]: 'postgres://someone@elsewhere:5432/brain' },
    });

    expect(prepare()).toBeUndefined();
    expect(calls).toEqual([]);
    expect(env[TEST_DATABASE_URL_ENV]).toBe('postgres://someone@elsewhere:5432/brain');
  });

  it('treats a blank variable as unset', () => {
    const { calls, env, prepare } = harness({
      env: { [TEST_DATABASE_URL_ENV]: '   ' },
      answer: (line) => (line === PS ? { stdout: 'c0ffee\n' } : undefined),
    });

    expect(prepare()).toBeUndefined();
    expect(calls).toEqual(['docker info', PS]);
    expect(env[TEST_DATABASE_URL_ENV]).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it('uses a container that is already running and leaves it running', () => {
    const { calls, env, lines, prepare } = harness({
      answer: (line) => (line === PS ? { stdout: 'c0ffee\n' } : undefined),
    });

    expect(prepare()).toBeUndefined();
    expect(calls).toEqual(['docker info', PS]);
    expect(env[TEST_DATABASE_URL_ENV]).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(lines).toEqual([]);
  });

  it('starts a container when there is none, and stops that one again', () => {
    const { calls, env, lines, prepare } = harness();

    const teardown = prepare();
    expect(calls).toEqual(['docker info', PS, UP]);
    expect(env[TEST_DATABASE_URL_ENV]).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(lines).toHaveLength(1);

    expect(teardown).toBeTypeOf('function');
    teardown?.();
    expect(calls).toEqual(['docker info', PS, UP, DOWN]);
  });

  it('says so when stopping the container it started fails', () => {
    const { calls, prepare } = harness({
      answer: (line) =>
        line === DOWN ? { status: 1, stderr: 'Error: network brain_default has active endpoints' } : undefined,
    });

    const teardown = prepare();
    expect(teardown).toBeTypeOf('function');
    const message = messageOf(() => teardown?.());
    expect(message).toMatch(/Could not stop the test database/);
    expect(message).toMatch(/active endpoints/);
    expect(message).toMatch(/still running/);
    expect(message).toContain(DOWN);
    expect(calls).toEqual(['docker info', PS, UP, DOWN]);
  });

  it('stops the run with one message when docker is not there', () => {
    const { calls, env, prepare } = harness({
      answer: (line) =>
        line === 'docker info' ? { status: 1, stderr: 'spawn docker ENOENT' } : undefined,
    });

    const message = messageOf(prepare);
    expect(message).toMatch(/Docker is not available/);
    expect(message).toMatch(/pgvector/);
    // The example is a placeholder, not the container that just failed to start.
    expect(message).toContain('postgres://<user>:<password>@<host>:<port>/<database>');
    expect(message).not.toContain(DEFAULT_TEST_DATABASE_URL);
    expect(calls).toEqual(['docker info']);
    expect(env[TEST_DATABASE_URL_ENV]).toBeUndefined();
  });

  it('reports what compose said when starting fails, and cleans nothing up', () => {
    const { calls, env, prepare } = harness({
      answer: (line) =>
        line === UP ? { status: 1, stderr: 'Error: port 54329 is already allocated\n' } : undefined,
    });

    const message = messageOf(prepare);
    expect(message).toMatch(/exited with 1/);
    expect(message).toMatch(/port 54329 is already allocated/);
    expect(message).toMatch(/left in place/);
    expect(message).toContain(DOWN);
    expect(message).toMatch(/pgvector/);
    // The leftovers stay for inspection: nothing is torn down here.
    expect(calls).toEqual(['docker info', PS, UP]);
    expect(env[TEST_DATABASE_URL_ENV]).toBeUndefined();
  });

  it('finds the compose file of this repository by default', () => {
    expect(existsSync(COMPOSE_FILE)).toBe(true);
    expect(COMPOSE_FILE.endsWith('/compose.test.yaml')).toBe(true);
  });
});
