import { describe, expect, it } from 'vitest';
import type {
  DoctorCheck,
  DoctorReport,
  EnsureDefaultIndexConfigResult,
  EnsureVectorResult,
  MigrationResult,
} from 'second_brain';
import type { WriteConfigInput } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_NAME,
  CONTAINER_VOLUME,
  type CommandRequest,
  type CommandResult,
} from '../src/install/docker.js';
import {
  maskUrl,
  parseFlags,
  runInstallFlow,
  type Choice,
  type InstallDatabase,
  type InstallDeps,
  type InstallPrompts,
  type RecordedConfig,
} from '../src/install/flow.js';

/**
 * The whole installer flow against fakes: no Docker, no terminal, no database.
 * Every row of the plan's I/O matrix is one test here, and what is asserted is
 * the order of the external commands, which questions were asked, what was
 * written, and the exit code.
 */

const HOME = '/tmp/brain-install-flow';
const ENV: NodeJS.ProcessEnv = { [HOME_ENV]: HOME };

/** The URL of the container the flow creates, with the fake password in it. */
const PASSWORD = 'fake-password';
const CONTAINER_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:54320/brain`;
const EXISTING_URL = 'postgres://postgres:secret@db.example:5432/brain';

/**
 * What the codec must be handed once a folder already exists: the URL plus
 * everything else the folder said, because `writeConfig` renders both files
 * whole and anything left out goes back to its default.
 */
function kept(
  databaseUrl: string,
  timezone = 'Asia/Seoul',
  databaseUrlEnv = 'SECOND_BRAIN_DATABASE_URL',
): WriteConfigInput {
  return { databaseUrl, timezone, databaseUrlEnv };
}

/** What the fake `docker`/`brew` world looks like for one run. */
interface World {
  dockerInstalled?: boolean;
  daemonUp?: boolean;
  /** The daemon comes up once the user has been asked to start it. */
  daemonUpAfterPause?: boolean;
  brewInstalled?: boolean;
  container?: 'absent' | 'running' | 'stopped';
  /** The named volume is there although the container is not. */
  volume?: boolean;
  /** How many `pg_isready` probes before it answers. `Infinity` never does. */
  readyAfter?: number;
  installFails?: boolean;
  createFails?: boolean;
  startFails?: boolean;
}

interface Runner {
  (request: CommandRequest): Promise<CommandResult>;
  /** Every command, as `name arg arg …`, in the order it was run. */
  calls: string[];
  /** Only the `docker` ones, which is what "no container was touched" means. */
  dockerCalls(): string[];
  paused(): void;
}

function fakeRunner(world: World): Runner {
  let dockerInstalled = world.dockerInstalled ?? true;
  let daemonUp = world.daemonUp ?? true;
  let container = world.container ?? 'absent';
  const volume = world.volume ?? false;
  const brewInstalled = world.brewInstalled ?? true;
  const readyAfter = world.readyAfter ?? 1;
  let probes = 0;

  const calls: string[] = [];
  const runner = async (request: CommandRequest): Promise<CommandResult> => {
    const line = [request.command, ...request.args].join(' ');
    calls.push(line);

    if (request.command === 'brew') {
      if (request.args[0] === '--version') {
        return { code: brewInstalled ? 0 : 127, stdout: brewInstalled ? '4.0.0\n' : '' };
      }
      if (world.installFails === true) return { code: 1, stdout: '' };
      dockerInstalled = true;
      return { code: 0, stdout: '' };
    }
    if (request.command === 'open') return { code: 0, stdout: '' };

    if (request.command !== 'docker') {
      throw new Error(`the flow ran something unexpected: ${line}`);
    }
    if (!dockerInstalled) return { code: 127, stdout: '' };

    switch (request.args[0]) {
      case '--version':
        return { code: 0, stdout: '29.0.0\n' };
      case 'info':
        return daemonUp ? { code: 0, stdout: '29.0.0\n' } : { code: 1, stdout: '' };
      case 'container':
        return container === 'absent'
          ? { code: 1, stdout: '' }
          : { code: 0, stdout: `${container === 'running' ? 'running' : 'exited'}\n` };
      case 'volume':
        // A container that exists brought its volume with it.
        return volume || container !== 'absent'
          ? { code: 0, stdout: `${CONTAINER_VOLUME}\n` }
          : { code: 1, stdout: '' };
      case 'run':
        if (world.createFails === true) return { code: 1, stdout: '' };
        container = 'running';
        return { code: 0, stdout: 'deadbeef\n' };
      case 'start':
        if (world.startFails === true) return { code: 1, stdout: '' };
        container = 'running';
        return { code: 0, stdout: `${CONTAINER_NAME}\n` };
      case 'exec': {
        probes += 1;
        return probes >= readyAfter ? { code: 0, stdout: '' } : { code: 1, stdout: '' };
      }
      default:
        throw new Error(`the flow ran a docker command nobody expected: ${line}`);
    }
  };

  return Object.assign(runner, {
    calls,
    dockerCalls: (): string[] => calls.filter((call) => call.startsWith('docker ')),
    paused: (): void => {
      if (world.daemonUpAfterPause === true) daemonUp = true;
    },
  });
}

interface Answers {
  confirm?: readonly boolean[];
  select?: readonly string[];
  text?: readonly string[];
}

interface Prompts extends InstallPrompts {
  asked: string[];
  /** The placeholder each `text` question offered, so masking is checkable. */
  placeholders: string[];
}

/**
 * Questions with their answers queued up. Running out throws rather than
 * blocks, so a flow that asks in a loop fails the test instead of hanging.
 */
function fakePrompts(answers: Answers, onPause: () => void = (): void => {}): Prompts {
  const confirms = [...(answers.confirm ?? [])];
  const selects = [...(answers.select ?? [])];
  const texts = [...(answers.text ?? [])];
  const asked: string[] = [];
  const placeholders: string[] = [];

  return {
    asked,
    placeholders,
    async confirm(question: string): Promise<boolean> {
      asked.push(question);
      const answer = confirms.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer;
    },
    async select<T extends string>(
      question: string,
      _choices: readonly Choice<T>[],
      _initial: T,
    ): Promise<T> {
      asked.push(question);
      const answer = selects.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer as T;
    },
    async text(question: string, placeholder: string): Promise<string> {
      asked.push(question);
      placeholders.push(placeholder);
      const answer = texts.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer;
    },
    async pause(message: string): Promise<void> {
      asked.push(message);
      onPause();
    },
  };
}

interface DbWorld {
  /** URLs that do not answer. Everything else does. */
  unreachable?: readonly string[];
  migrate?: MigrationResult;
  vector?: EnsureVectorResult;
  indexConfig?: EnsureDefaultIndexConfigResult;
  /** The final doctor's pgvector verdict. */
  vectorFails?: boolean;
}

interface Database extends InstallDatabase {
  migrated: string[];
  vectorUrls: string[];
  indexConfigCalls: { url: string; id: string }[];
  doctored: string[];
}

function fakeDatabase(world: DbWorld = {}): Database {
  const unreachable = new Set(world.unreachable ?? []);
  const migrated: string[] = [];
  const vectorUrls: string[] = [];
  const indexConfigCalls: { url: string; id: string }[] = [];
  const doctored: string[] = [];

  const report = (url: string): DoctorReport => {
    if (unreachable.has(url)) {
      return {
        checks: [
          { id: 'db', status: 'fail', code: 'DB_UNAVAILABLE', detail: 'connection refused' },
          { id: 'vector', status: 'skip' },
        ],
      };
    }
    const vector: DoctorCheck =
      world.vectorFails === true
        ? { id: 'vector', status: 'fail', detail: 'not installed (not available on this server)' }
        : { id: 'vector', status: 'ok', detail: '0.8.7' };
    return { checks: [{ id: 'db', status: 'ok', detail: '18.1' }, vector] };
  };

  return {
    migrated,
    vectorUrls,
    indexConfigCalls,
    doctored,
    async migrate(databaseUrl) {
      migrated.push(databaseUrl);
      return world.migrate ?? { ok: true, from: 0, to: 1, applied: ['0001_initial.sql'] };
    },
    async ensureVector(databaseUrl) {
      vectorUrls.push(databaseUrl);
      return (
        world.vector ?? { ok: true, installed: '0.8.7', available: '0.8.7', reason: '' }
      );
    },
    async ensureIndexConfig(databaseUrl, id) {
      indexConfigCalls.push({ url: databaseUrl, id });
      return world.indexConfig ?? { ok: true, id, created: true };
    },
    async doctor(databaseUrl) {
      doctored.push(databaseUrl);
      return report(databaseUrl);
    },
  };
}

interface Harness {
  deps: InstallDeps;
  runner: Runner;
  prompts: Prompts;
  database: Database;
  written: WriteConfigInput[];
  lines: string[];
  /** Every line joined, for "the password is nowhere in the output". */
  output(): string;
}

interface HarnessOptions {
  world?: World;
  answers?: Answers;
  db?: DbWorld;
  isTTY?: boolean;
  /** The URL already in `<home>/.env`. */
  recorded?: string;
  /** The rest of what the folder already says, which a re-run must keep. */
  recordedTimezone?: string;
  recordedUrlEnv?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const runner = fakeRunner(options.world ?? {});
  const prompts = fakePrompts(options.answers ?? {}, () => {
    runner.paused();
  });
  const database = fakeDatabase(options.db);
  const written: WriteConfigInput[] = [];
  const lines: string[] = [];
  let clock = 0;
  let nextId = 0;

  const deps: InstallDeps = {
    run: runner,
    prompts,
    isTTY: options.isTTY ?? true,
    log: (line: string): void => {
      lines.push(line);
    },
    // Time only moves when the flow waits, so the readiness budget is spent
    // deterministically and no test actually sleeps.
    sleep: async (ms: number): Promise<void> => {
      clock += ms;
    },
    now: () => clock,
    password: () => PASSWORD,
    nextId: () => {
      nextId += 1;
      return `01940000-0000-7000-8000-${String(nextId).padStart(12, '0')}`;
    },
    config: {
      write: async (home, input): Promise<void> => {
        expect(home).toBe(HOME);
        written.push(input);
      },
      read: async (): Promise<RecordedConfig | undefined> =>
        options.recorded === undefined
          ? undefined
          : {
              databaseUrl: options.recorded,
              timezone: options.recordedTimezone ?? 'Asia/Seoul',
              databaseUrlEnv: options.recordedUrlEnv ?? 'SECOND_BRAIN_DATABASE_URL',
            },
    },
    database,
    readyTimeoutMs: 5000,
  };

  return {
    deps,
    runner,
    prompts,
    database,
    written,
    lines,
    output: () => lines.join('\n'),
  };
}

describe('the installer flow, with Docker and no container yet', () => {
  it('creates the container, writes the configuration and ends on a green doctor', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.dockerCalls().map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual([
      'docker --version',
      'docker info',
      'docker container',
      'docker volume',
      'docker run',
      'docker exec',
    ]);
    // Twice: the moment the container existed, and again with the folder.
    expect(kit.written).toEqual([
      { databaseUrl: CONTAINER_URL },
      { databaseUrl: CONTAINER_URL },
    ]);
    expect(kit.database.migrated).toEqual([CONTAINER_URL]);
    expect(kit.database.vectorUrls).toEqual([CONTAINER_URL]);
    expect(kit.database.indexConfigCalls).toHaveLength(1);
    expect(kit.output()).toContain('pgvector: ok');
  });

  it('names the image, the volume and the port in the question it asks first', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    await runInstallFlow([], ENV, kit.deps);

    const question = kit.prompts.asked.at(-1) ?? '';
    expect(question).toContain(CONTAINER_IMAGE);
    expect(question).toContain(CONTAINER_VOLUME);
    expect(question).toContain('127.0.0.1:54320');
  });

  it('creates the container with a named volume, restart policy and loopback port', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    await runInstallFlow([], ENV, kit.deps);

    const run = kit.runner.calls.find((call) => call.startsWith('docker run')) ?? '';
    expect(run).toContain(`--name ${CONTAINER_NAME}`);
    expect(run).toContain('--restart unless-stopped');
    expect(run).toContain('--publish 127.0.0.1:54320:5432');
    expect(run).toContain(`--volume ${CONTAINER_VOLUME}:/var/lib/postgresql`);
    expect(run).toContain(CONTAINER_IMAGE);
  });

  it('never prints the password or the URL it put in .env', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.written[0]?.databaseUrl).toContain(PASSWORD);
    expect(kit.output()).not.toContain(PASSWORD);
    expect(kit.output()).not.toContain(CONTAINER_URL);
  });

  it('creates nothing and offers the other way when the container is refused', async () => {
    const kit = harness({
      answers: { select: ['docker'], confirm: [false], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(false);
    expect(kit.written).toEqual([{ databaseUrl: EXISTING_URL }]);
  });

  it('exits 1 after the refusal when no URL is given either', async () => {
    const kit = harness({
      answers: { select: ['docker'], confirm: [false], text: ['', '', ''] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.written).toEqual([]);
  });
});

describe('the installer flow against a Postgres that already exists', () => {
  it('runs no docker command at all', async () => {
    const kit = harness({ answers: { select: ['existing'], text: [EXISTING_URL] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls).toEqual([]);
    expect(kit.written).toEqual([{ databaseUrl: EXISTING_URL }]);
  });

  it('offers the recorded URL with its password masked, and takes an empty answer', async () => {
    const kit = harness({
      recorded: EXISTING_URL,
      answers: { select: ['existing'], text: [''] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[0]).toBe(
      'postgres://postgres:***@db.example:5432/brain',
    );
    expect(kit.output()).not.toContain('secret');
    expect(kit.written).toEqual([kept(EXISTING_URL)]);
  });

  it('says DB_UNAVAILABLE, asks again, and writes nothing when none of them answer', async () => {
    const kit = harness({
      db: { unreachable: [EXISTING_URL] },
      answers: { select: ['existing'], text: [EXISTING_URL, EXISTING_URL, EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('DB_UNAVAILABLE: connection refused');
    expect(kit.prompts.placeholders).toHaveLength(3);
    expect(kit.written).toEqual([]);
    expect(kit.database.migrated).toEqual([]);
  });

  it('takes the URL it is given and never asks, when the flag is there', async () => {
    const kit = harness();

    const exit = await runInstallFlow(['--database-url', EXISTING_URL], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([{ databaseUrl: EXISTING_URL }]);
  });

  it('exits 1 without writing when the URL on the flag does not answer', async () => {
    const kit = harness({ db: { unreachable: [EXISTING_URL] }, isTTY: false });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(1);
    expect(kit.output()).toContain('DB_UNAVAILABLE');
    expect(kit.written).toEqual([]);
  });
});

describe('the installer flow when Docker is missing', () => {
  it('asks, installs Docker Desktop, opens it, waits, and carries on', async () => {
    const kit = harness({
      world: {
        dockerInstalled: false,
        daemonUp: false,
        daemonUpAfterPause: true,
      },
      answers: { select: ['docker'], confirm: [true, true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls).toContain('brew install --cask docker');
    expect(kit.runner.calls).toContain('open -a Docker');
    expect(kit.prompts.asked.some((question) => question.includes('press Enter'))).toBe(true);
    expect(kit.written.at(-1)).toEqual({ databaseUrl: CONTAINER_URL });
  });

  it('installs nothing and asks for a URL instead when the install is refused', async () => {
    const kit = harness({
      world: { dockerInstalled: false },
      answers: { select: ['docker'], confirm: [false], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls).not.toContain('brew install --cask docker');
    expect(kit.prompts.asked.at(-1)).toBe('Postgres URL');
    expect(kit.written).toEqual([{ databaseUrl: EXISTING_URL }]);
  });

  it('names the flag instead of asking, when there is no terminal to ask in', async () => {
    const kit = harness({
      isTTY: false,
      world: { dockerInstalled: false, daemonUp: false },
    });

    // `--yes` is consent, so this one never reaches the question; the refusal
    // path is a terminal's, and without one the flag is all there is to say.
    const exit = await runInstallFlow(['--docker'], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('--database-url <url> --yes');
  });

  it('says how to get Homebrew when there is none, and installs nothing', async () => {
    const kit = harness({
      world: { dockerInstalled: false, brewInstalled: false },
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('brew.sh');
    expect(kit.runner.calls).not.toContain('brew install --cask docker');
    expect(kit.written).toEqual([]);
  });
});

describe('the installer flow when the Docker daemon is not running', () => {
  it('asks the user to start it and goes on once it answers', async () => {
    const kit = harness({
      world: { daemonUp: false, daemonUpAfterPause: true },
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('daemon is not answering');
  });

  it('gives up after three tries and changes nothing', async () => {
    const kit = harness({
      world: { daemonUp: false },
      answers: { select: ['docker'] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.written).toEqual([]);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(false);
  });
});

describe('the installer flow run a second time', () => {
  it('reuses the running container and its recorded URL, creating nothing', async () => {
    const kit = harness({
      world: { container: 'running' },
      recorded: CONTAINER_URL,
      answers: { select: ['docker'] },
      db: {
        migrate: { ok: true, from: 1, to: 1, applied: [] },
        indexConfig: { ok: true, id: 'the-first-one', created: false },
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(false);
    expect(kit.runner.calls.some((call) => call.startsWith('docker start'))).toBe(false);
    expect(kit.written).toEqual([kept(CONTAINER_URL)]);
    expect(kit.output()).toContain('already at version 1');
    expect(kit.output()).toContain('already there');
  });

  it('starts a container that is there but stopped, and still creates nothing', async () => {
    const kit = harness({
      world: { container: 'stopped' },
      recorded: CONTAINER_URL,
      answers: { select: ['docker'] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls).toContain(`docker start ${CONTAINER_NAME}`);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(false);
  });

  it('asks for the URL when the container is there but nothing is recorded', async () => {
    const kit = harness({
      world: { container: 'running' },
      answers: { select: ['docker'], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('is not known here');
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(false);
    expect(kit.written).toEqual([{ databaseUrl: EXISTING_URL }]);
  });
});

describe('the installer flow over a folder that already has settings', () => {
  it('keeps a time zone and a variable name it did not choose', async () => {
    const kit = harness({
      recorded: EXISTING_URL,
      recordedTimezone: 'Europe/Berlin',
      recordedUrlEnv: 'MY_BRAIN_URL',
      answers: { select: ['existing'], text: [''] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept(EXISTING_URL, 'Europe/Berlin', 'MY_BRAIN_URL')]);
  });

  it('keeps them on the Docker path too, including the early record', async () => {
    const kit = harness({
      world: { container: 'absent' },
      recorded: EXISTING_URL,
      recordedTimezone: 'Europe/Berlin',
      recordedUrlEnv: 'MY_BRAIN_URL',
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([
      kept(CONTAINER_URL, 'Europe/Berlin', 'MY_BRAIN_URL'),
      kept(CONTAINER_URL, 'Europe/Berlin', 'MY_BRAIN_URL'),
    ]);
  });
});

describe('the installer flow over a volume that outlived its container', () => {
  it('uses the recorded URL, not a freshly made password', async () => {
    const kit = harness({
      world: { container: 'absent', volume: true },
      recorded: CONTAINER_URL,
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(true);
    expect(kit.written).toEqual([kept(CONTAINER_URL)]);
  });

  it('says the data is already there in the question it asks', async () => {
    const kit = harness({
      world: { container: 'absent', volume: true },
      recorded: CONTAINER_URL,
      answers: { select: ['docker'], confirm: [true] },
    });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.prompts.asked.at(-1)).toContain('over the data already in the volume');
  });

  it('refuses to invent a password when nothing is recorded, and keeps the volume', async () => {
    const kit = harness({
      isTTY: false,
      world: { container: 'absent', volume: true },
    });

    const exit = await runInstallFlow(['--docker', '--yes'], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain(CONTAINER_VOLUME);
    expect(kit.written).toEqual([]);
    expect(kit.runner.calls.some((call) => call.startsWith('docker volume rm'))).toBe(false);
  });
});

describe('the installer flow when the container never comes up', () => {
  it('says where to look, leaves the container alone, and exits 1', async () => {
    const kit = harness({
      world: { readyAfter: Number.POSITIVE_INFINITY },
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain(`docker logs ${CONTAINER_NAME}`);
    expect(kit.output()).toContain('left as it is');
    expect(kit.runner.calls.some((call) => call.startsWith('docker rm'))).toBe(false);
    // The password was written down the moment the container existed, so the
    // next run can still reach the cluster this one initialised. It exists
    // nowhere else.
    expect(kit.written).toEqual([{ databaseUrl: CONTAINER_URL }]);
  });

  it('probes over TCP, which the init-time socket-only server does not answer', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    await runInstallFlow([], ENV, kit.deps);

    const probe = kit.runner.calls.find((call) => call.startsWith('docker exec')) ?? '';
    expect(probe).toContain('pg_isready --host 127.0.0.1');
  });

  it('probes more than once, within the budget', async () => {
    const kit = harness({
      world: { readyAfter: 3 },
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls.filter((call) => call.startsWith('docker exec'))).toHaveLength(3);
  });
});

describe('the installer flow when a database step fails', () => {
  it('reports MIGRATION_FAILED with the file, and not DB_UNAVAILABLE', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      db: {
        migrate: {
          ok: false,
          code: 'MIGRATION_FAILED',
          message: 'relation "workspaces" already exists',
          file: '0001_initial.sql',
        },
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('MIGRATION_FAILED: relation "workspaces" already exists');
    expect(kit.output()).toContain('0001_initial.sql');
    expect(kit.output()).not.toContain('DB_UNAVAILABLE');
    expect(kit.database.vectorUrls).toEqual([]);
  });

  it('finishes every step and exits 1 when pgvector cannot be installed', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      db: {
        vector: {
          ok: true,
          installed: null,
          available: null,
          reason: 'the server does not offer the vector extension',
        },
        vectorFails: true,
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.database.indexConfigCalls).toHaveLength(1);
    expect(kit.output()).toContain('pgvector: fail');
  });
});

describe('the installer flow with no terminal', () => {
  it('names the flags it needs and exits 2 when it has none', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('--database-url <url> --yes');
    expect(kit.output()).toContain('--docker --yes');
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([]);
  });

  it('exits 2 when a flag is given without the consent to use it', async () => {
    const kit = harness({ isTTY: false });

    expect(await runInstallFlow(['--docker'], ENV, kit.deps)).toBe(2);
    expect(kit.runner.calls).toEqual([]);
  });

  it('creates the container without asking, given --docker --yes', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(['--docker', '--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.runner.calls.some((call) => call.startsWith('docker run'))).toBe(true);
    expect(kit.written.at(-1)).toEqual({ databaseUrl: CONTAINER_URL });
  });

  it('refuses to guess the password of a container it did not create', async () => {
    const kit = harness({ isTTY: false, world: { container: 'running' } });

    const exit = await runInstallFlow(['--docker', '--yes'], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('--database-url <url>');
    expect(kit.written).toEqual([]);
  });
});

describe('the installer flags', () => {
  it.each([
    { argv: [], expected: { docker: false, yes: false, help: false } },
    { argv: ['--docker', '--yes'], expected: { docker: true, yes: true, help: false } },
    { argv: ['-y'], expected: { docker: false, yes: true, help: false } },
    {
      argv: ['--database-url', 'postgres://x/y'],
      expected: { databaseUrl: 'postgres://x/y', docker: false, yes: false, help: false },
    },
  ])('reads $argv', ({ argv, expected }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags).toEqual(expected);
  });

  it.each([
    { argv: ['--nope'], contains: 'unknown argument' },
    { argv: ['--database-url'], contains: 'needs a URL' },
    { argv: ['--database-url', '--yes'], contains: 'needs a URL' },
    { argv: ['--database-url', 'postgres://x/y', '--docker'], contains: 'one of them' },
  ])('refuses $argv', ({ argv, contains }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(contains);
  });

  it('prints the usage and exits 2 on an argument it does not know', async () => {
    const kit = harness();

    const exit = await runInstallFlow(['--nope'], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('Usage: second-brain');
    expect(kit.written).toEqual([]);
  });

  it('prints the usage and exits 0 for --help', async () => {
    const kit = harness();

    expect(await runInstallFlow(['--help'], ENV, kit.deps)).toBe(0);
    expect(kit.written).toEqual([]);
  });
});

describe('maskUrl', () => {
  it.each([
    { url: 'postgres://user:secret@host:5432/brain', masked: 'postgres://user:***@host:5432/brain' },
    { url: 'postgres://host:5432/brain', masked: 'postgres://host:5432/brain' },
    { url: 'not a url', masked: '(the recorded URL)' },
  ])('turns $url into $masked', ({ url, masked }) => {
    expect(maskUrl(url)).toBe(masked);
  });
});
