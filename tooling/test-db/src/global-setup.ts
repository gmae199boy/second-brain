import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Dev-only vitest `globalSetup` for the project whose tests need Postgres. It
 * runs once, before any test file of that project, and makes
 * `BRAIN_TEST_DATABASE_URL` point at a usable database:
 *
 * - the variable is already set -> that database is used and Docker is never
 *   called, so a developer who runs their own Postgres keeps it;
 * - the test container is already running -> it is used and left running,
 *   because somebody else started it;
 * - otherwise it is started with `compose.test.yaml` and stopped again when
 *   the run ends, so the run leaves the machine as it found it;
 * - and if none of that is possible the run stops here with one message,
 *   instead of sixteen tests failing with the same note each.
 *
 * Nothing is ever mocked or skipped: these tests want a real database.
 *
 * The work is split in two. `prepareTestDatabase` takes the runner and the
 * environment as arguments, so the five cases above are testable without
 * Docker; the default export is what vitest calls, and runs the real `docker`.
 */

/** The database `compose.test.yaml` publishes. */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:54329/postgres';

/** The variable the Postgres tests read, named once for both readers. */
export const TEST_DATABASE_URL_ENV = 'BRAIN_TEST_DATABASE_URL';

/**
 * The compose file, found relative to this module rather than to the working
 * directory, so it is the same file whether vitest was launched from the
 * repository root or from a package folder. `src/` and `dist/` sit equally
 * deep, so one path serves the sources and the build.
 */
export const COMPOSE_FILE = fileURLToPath(new URL('../../../compose.test.yaml', import.meta.url));

/** The service in that file, and the only one. */
const SERVICE = 'postgres';

/** What to do about it, said once, whichever way the preparation failed. */
const GUIDANCE = [
  'The Postgres integration tests use a real database on purpose: they are never mocked or skipped.',
  '',
  'Start Docker and run the tests again — they bring the test database up and down on their own —',
  'or point the variable at a Postgres of your own that has pgvector installed:',
  '',
  // Deliberately not the compose URL: that is the database that could not be
  // started, so copying it would only fail again on the same port.
  `  export ${TEST_DATABASE_URL_ENV}=postgres://<user>:<password>@<host>:<port>/<database>`,
].join('\n');

/** One finished command: what it exited with and what it said. */
export interface CommandResult {
  /** The exit code. A command that could not be started at all counts as failed. */
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one command to completion. Injected so the tests can answer for it. */
export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

export interface PrepareOptions {
  run: CommandRunner;
  /** Mutated in place: the prepared URL is written back into it. */
  env: NodeJS.ProcessEnv;
  /** Defaults to the repository's `compose.test.yaml`. */
  composeFile?: string;
  /** Says what is being waited for, since a first start pulls the image. */
  log?: (line: string) => void;
}

/**
 * Stops what this run started, and throws if it could not. Absent when the run
 * started nothing.
 */
export type Teardown = () => void;

/**
 * Make `BRAIN_TEST_DATABASE_URL` usable in `env`, or throw with the one
 * message that says how to make it possible. Hands back the way to undo a
 * container this call started, and nothing when it started none.
 */
export function prepareTestDatabase(options: PrepareOptions): Teardown | undefined {
  const { run, env, composeFile = COMPOSE_FILE, log } = options;

  const existing = env[TEST_DATABASE_URL_ENV]?.trim();
  if (existing !== undefined && existing !== '') return undefined;

  // `docker info` fails both when the command is missing and when the daemon
  // is not running, which are the same thing from here.
  const info = run('docker', ['info']);
  if (info.status !== 0) {
    throw new Error(
      ['Docker is not available, so the test database cannot be started.', '', GUIDANCE].join('\n'),
    );
  }

  const compose = ['compose', '-f', composeFile];

  // A running container prints its id; an empty answer means there is none.
  const running = run('docker', [...compose, 'ps', '--status', 'running', '--quiet', SERVICE]);
  if (running.status === 0 && running.stdout.trim() !== '') {
    env[TEST_DATABASE_URL_ENV] = DEFAULT_TEST_DATABASE_URL;
    return undefined;
  }

  log?.('Starting the test database, and stopping it again when the tests end.');
  const up = run('docker', [...compose, 'up', '-d', '--wait']);
  if (up.status !== 0) {
    // Whatever half started stays up, so it can be looked at — which is worth
    // saying, or the leftovers are a surprise found later.
    throw new Error(
      [
        summarize('Could not start the test database: `docker compose up`', up),
        '',
        'Whatever it did start is left in place, to be looked at. Remove it with:',
        '',
        `  ${downCommand(composeFile)}`,
        '',
        GUIDANCE,
      ].join('\n'),
    );
  }

  env[TEST_DATABASE_URL_ENV] = DEFAULT_TEST_DATABASE_URL;
  return () => {
    const down = run('docker', [...compose, 'down']);
    if (down.status !== 0) {
      // Saying nothing would leave a container running that this run promised
      // to stop, and nothing on screen to say so.
      throw new Error(
        [
          summarize('Could not stop the test database this run started: `docker compose down`', down),
          '',
          'It is still running. Stop it by hand with:',
          '',
          `  ${downCommand(composeFile)}`,
        ].join('\n'),
      );
    }
  };
}

/** The command that removes the container, for a message to point at. */
function downCommand(composeFile: string): string {
  return `docker compose -f ${composeFile} down`;
}

/** A compose failure, with the tail of what compose said about it. */
function summarize(subject: string, result: CommandResult): string {
  const said = [result.stderr, result.stdout]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== '')
    .join('\n')
    .split('\n')
    .slice(-10)
    .join('\n');
  const headline = `${subject} exited with ${result.status}.`;
  return said === '' ? headline : `${headline}\n\n${said}`;
}

/** The real runner: a command that cannot even start is a failed command. */
function runCommand(command: string, args: readonly string[]): CommandResult {
  const finished = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    status: finished.status ?? 1,
    stdout: finished.stdout ?? '',
    stderr: finished.stderr || (finished.error?.message ?? ''),
  };
}

/** What vitest calls. Returning a function makes it the teardown. */
export default function setupTestDatabase(): Teardown | undefined {
  return prepareTestDatabase({
    run: runCommand,
    env: process.env,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
