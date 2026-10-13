import { randomBytes } from 'node:crypto';

/**
 * Everything the installer does with `docker` and `brew`, in one file, behind an
 * injected runner. Nothing here is a shell string: a command is a name plus an
 * array of arguments, so a password or a path never reaches a shell to be
 * re-read as syntax. The runner is the same shape `tooling/bootstrap` uses, and
 * is injected for the same reason — the whole flow has to be drivable from a
 * test with no Docker and no terminal.
 */

/** One external command. An array of arguments, never a shell string. */
export interface CommandRequest {
  command: string;
  args: readonly string[];
  /** Read stdout instead of letting the child write to the terminal. */
  capture?: boolean;
  /**
   * Swallow stderr as well. Only for a probe whose failure is a normal answer:
   * `docker container inspect` on a machine with no container is how the
   * installer learns there is none, and printing the daemon's complaint about
   * it makes a successful install look like a broken one.
   */
  quiet?: boolean;
}

export interface CommandResult {
  /** 127 when the command could not be started at all. */
  code: number;
  /** Empty unless the request asked to capture. */
  stdout: string;
}

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

/** The image the installer starts. It ships pgvector (Stack). */
export const CONTAINER_IMAGE = 'pgvector/pgvector:pg18';

/** Container name. It is also how a re-run recognises its own container. */
export const CONTAINER_NAME = 'second-brain-db';

/** Named volume, so the data outlives the container. */
export const CONTAINER_VOLUME = 'second-brain-pgdata';

/**
 * Where the volume goes. Postgres 18 images declare `/var/lib/postgresql` as
 * their volume and put the cluster in a versioned folder underneath, so the
 * mount belongs on the declared path — mounting `.../data` would leave the real
 * cluster in an anonymous volume that a `docker rm` throws away.
 */
export const CONTAINER_DATA_PATH = '/var/lib/postgresql';

/**
 * Published on the loopback interface only, and not on 54329: that one belongs
 * to the test container of `compose.test.yaml`, and an install must never land
 * on a database whose data dies with `compose down`.
 */
export const CONTAINER_HOST = '127.0.0.1';
export const CONTAINER_PORT = 54320;

export const CONTAINER_USER = 'postgres';
export const CONTAINER_DATABASE = 'brain';

/** How long the container is given to answer `pg_isready` (I/O matrix). */
export const READY_TIMEOUT_MS = 60_000;

/** Pause between two readiness probes. */
export const READY_POLL_MS = 1000;

/** How Docker Desktop is installed, and how it is opened for its first run. */
export const DOCKER_INSTALL_ARGS = ['install', '--cask', 'docker'] as const;

/** What a container called `CONTAINER_NAME` is doing, as far as we care. */
export type ContainerState = 'absent' | 'running' | 'stopped';

/** Whether the `docker` command is on the PATH at all. */
export async function dockerPresent(run: CommandRunner): Promise<boolean> {
  const found = await run({
    command: 'docker',
    args: ['--version'],
    capture: true,
    quiet: true,
  });
  return found.code === 0;
}

/**
 * Whether the daemon answers. `docker info` is the probe because the command
 * being installed says nothing about Docker Desktop being started.
 */
export async function dockerRunning(run: CommandRunner): Promise<boolean> {
  const info = await run({
    command: 'docker',
    args: ['info', '--format', '{{.ServerVersion}}'],
    capture: true,
    quiet: true,
  });
  return info.code === 0;
}

export async function brewPresent(run: CommandRunner): Promise<boolean> {
  const found = await run({
    command: 'brew',
    args: ['--version'],
    capture: true,
    quiet: true,
  });
  return found.code === 0;
}

/** Install Docker Desktop. The caller has already asked and been told yes. */
export async function installDockerDesktop(run: CommandRunner): Promise<CommandResult> {
  return run({ command: 'brew', args: [...DOCKER_INSTALL_ARGS] });
}

/**
 * Open Docker Desktop, so the user can finish the permission dialogs its first
 * start puts up. Opening it is all this can do; the waiting is the caller's.
 */
export async function openDockerDesktop(run: CommandRunner): Promise<CommandResult> {
  return run({ command: 'open', args: ['-a', 'Docker'] });
}

/**
 * What the installer's container is doing. Anything that is neither running nor
 * missing counts as stopped, because the one thing to do with it is start it:
 * a created, exited, dead or paused container is never replaced or removed
 * here. It may hold the only copy of someone's brain.
 */
export async function containerState(run: CommandRunner): Promise<ContainerState> {
  const found = await run({
    command: 'docker',
    args: ['container', 'inspect', '--format', '{{.State.Status}}', CONTAINER_NAME],
    capture: true,
    quiet: true,
  });
  if (found.code !== 0) return 'absent';
  return found.stdout.trim() === 'running' ? 'running' : 'stopped';
}

/**
 * Whether the named volume is already there. It matters because the image only
 * reads `POSTGRES_PASSWORD` when it initialises a cluster: a volume that
 * already holds one keeps the password it was made with, so a container created
 * over it will not accept a freshly generated one. The installer has to know
 * that before it invents a password and writes it down.
 */
export async function volumeExists(run: CommandRunner): Promise<boolean> {
  const found = await run({
    command: 'docker',
    args: ['volume', 'inspect', '--format', '{{.Name}}', CONTAINER_VOLUME],
    capture: true,
    quiet: true,
  });
  return found.code === 0;
}

/**
 * Create and start the container. The password is only ever an argument of this
 * one command and a value in `.env`; it is never printed and never stored in
 * `config.toml` (AD-18).
 */
export async function createContainer(
  run: CommandRunner,
  password: string,
): Promise<CommandResult> {
  return run({
    command: 'docker',
    args: [
      'run',
      '--detach',
      '--name',
      CONTAINER_NAME,
      '--restart',
      'unless-stopped',
      '--publish',
      `${CONTAINER_HOST}:${String(CONTAINER_PORT)}:5432`,
      '--volume',
      `${CONTAINER_VOLUME}:${CONTAINER_DATA_PATH}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_USER=${CONTAINER_USER}`,
      '--env',
      `POSTGRES_DB=${CONTAINER_DATABASE}`,
      CONTAINER_IMAGE,
    ],
    capture: true,
  });
}

/** Start a container that is there but not running. */
export async function startContainer(run: CommandRunner): Promise<CommandResult> {
  return run({ command: 'docker', args: ['start', CONTAINER_NAME], capture: true });
}

export interface WaitForReadyDeps {
  run: CommandRunner;
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ReadyResult {
  ready: boolean;
  /** How many probes were made. At least one, even on a zero budget. */
  attempts: number;
}

/**
 * Wait for the container's Postgres to accept connections, up to the budget.
 * `pg_isready` runs inside the container, over TCP and not over the unix
 * socket: the image's entrypoint starts a socket-only server while it
 * initialises the cluster, and a socket probe answers "ready" to that one — so
 * a first install would walk on and find the database refusing connections a
 * moment later. The init server does not listen on TCP, so `-h 127.0.0.1` only
 * answers once the real server is up.
 */
export async function waitForReady(
  deps: WaitForReadyDeps,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<ReadyResult> {
  const deadline = deps.now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const probe = await deps.run({
      command: 'docker',
      args: [
        'exec',
        CONTAINER_NAME,
        'pg_isready',
        '--host',
        '127.0.0.1',
        '--username',
        CONTAINER_USER,
        '--dbname',
        CONTAINER_DATABASE,
      ],
      capture: true,
      quiet: true,
    });
    if (probe.code === 0) return { ready: true, attempts };
    if (deps.now() + READY_POLL_MS > deadline) return { ready: false, attempts };
    await deps.sleep(READY_POLL_MS);
  }
}

/** The command that shows why a container that never came up did not. */
export function containerLogsCommand(): string {
  return `docker logs ${CONTAINER_NAME}`;
}

/**
 * A password for the new container. 32 bytes of randomness in base64url, which
 * holds nothing a URL or a `.env` line has to escape.
 */
export function randomPassword(): string {
  return randomBytes(32).toString('base64url');
}

/** The URL of the container this file creates. */
export function containerUrl(password: string): string {
  return `postgres://${CONTAINER_USER}:${encodeURIComponent(password)}@${CONTAINER_HOST}:${String(CONTAINER_PORT)}/${CONTAINER_DATABASE}`;
}
