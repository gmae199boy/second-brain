import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Connector,
  DoctorCheck,
  DoctorReport,
  EnsureDefaultIndexConfigResult,
  EnsureVectorResult,
  MigrationResult,
} from 'second_brain';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
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
  runInstall,
  runInstallFlow,
  type Choice,
  type InstallDatabase,
  type InstallDeps,
  type InstallPrompts,
  type RecordedConfig,
} from '../src/install/flow.js';
import { shimPath } from '../src/install/shim.js';

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
  mirrorPath = MIRROR,
): WriteConfigInput {
  return { databaseUrl, timezone, databaseUrlEnv, mirrorPath };
}

/** The mirror path a run with nothing recorded and no flag settles on. */
const MIRROR = join(HOME, 'mirror');

/** The final configuration write of a run that recorded nothing before. */
function fresh(databaseUrl: string, mirrorPath = MIRROR): WriteConfigInput {
  return { databaseUrl, mirrorPath };
}

/**
 * What a run answers to the two questions every path now ends with: Enter for
 * the mirror path, which takes the default, and no to embeddings. They are
 * appended to whatever a test queues, so a test that cares about neither says
 * nothing about them; the per-kind queues keep the order right either way.
 */
const TAIL: Answers = { text: [''], confirm: [false] };

function answersWith(own: Answers, tail: Answers): Answers {
  return {
    confirm: [...(own.confirm ?? []), ...(tail.confirm ?? [])],
    select: [...(own.select ?? []), ...(tail.select ?? [])],
    text: [...(own.text ?? []), ...(tail.text ?? [])],
    multiselect: [...(own.multiselect ?? []), ...(tail.multiselect ?? [])],
  };
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
  /** One answer per `multiselect`: the values that stayed checked. */
  multiselect?: readonly (readonly string[])[];
}

interface Prompts extends InstallPrompts {
  asked: string[];
  /** The placeholder each `text` question offered, so masking is checkable. */
  placeholders: string[];
  /** What each `multiselect` started out with checked. */
  checked: readonly string[][];
}

/**
 * Questions with their answers queued up. Running out throws rather than
 * blocks, so a flow that asks in a loop fails the test instead of hanging.
 */
function fakePrompts(answers: Answers, onPause: () => void = (): void => {}): Prompts {
  const confirms = [...(answers.confirm ?? [])];
  const selects = [...(answers.select ?? [])];
  const texts = [...(answers.text ?? [])];
  const multiselects = [...(answers.multiselect ?? [])];
  const asked: string[] = [];
  const placeholders: string[] = [];
  const checked: string[][] = [];

  return {
    asked,
    placeholders,
    checked,
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
    async multiselect<T extends string>(
      question: string,
      _choices: readonly Choice<T>[],
      initial: readonly T[],
    ): Promise<readonly T[]> {
      asked.push(question);
      checked.push([...initial]);
      const answer = multiselects.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer as readonly T[];
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
  /** Every home the shim was written for, in order. */
  shimmed: string[];
  /** Every line joined, for "the password is nowhere in the output". */
  output(): string;
}

interface HarnessOptions {
  world?: World;
  answers?: Answers;
  /** Replaces the two answers every path ends with, for a test about them. */
  tail?: Answers;
  db?: DbWorld;
  isTTY?: boolean;
  /** The URL already in `<home>/.env`. */
  recorded?: string;
  /** The rest of what the folder already says, which a re-run must keep. */
  recordedTimezone?: string;
  recordedUrlEnv?: string;
  recordedMirrorPath?: string;
  /** The registry. Empty, like the real one, unless a test fills it. */
  connectors?: readonly Connector[];
  /** The shim was already there and says exactly this. */
  shimCurrent?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const runner = fakeRunner(options.world ?? {});
  const prompts = fakePrompts(answersWith(options.answers ?? {}, options.tail ?? TAIL), () => {
    runner.paused();
  });
  const shimmed: string[] = [];
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
              mirrorPath: options.recordedMirrorPath ?? MIRROR,
            },
    },
    database,
    shim: {
      write: async (home: string): Promise<{ path: string; changed: boolean }> => {
        shimmed.push(home);
        return { path: shimPath(home), changed: options.shimCurrent !== true };
      },
    },
    connectors: options.connectors ?? [],
    readyTimeoutMs: 5000,
  };

  return {
    deps,
    runner,
    prompts,
    database,
    written,
    lines,
    shimmed,
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
      fresh(CONTAINER_URL),
    ]);
    expect(kit.database.migrated).toEqual([CONTAINER_URL]);
    expect(kit.database.vectorUrls).toEqual([CONTAINER_URL]);
    expect(kit.database.indexConfigCalls).toHaveLength(1);
    expect(kit.output()).toContain('pgvector: ok');
  });

  it('names the image, the volume and the port in the question it asks first', async () => {
    const kit = harness({ answers: { select: ['docker'], confirm: [true] } });

    await runInstallFlow([], ENV, kit.deps);

    const question = kit.prompts.asked.find((asked) => asked.includes('Create the')) ?? '';
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
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
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
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
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
    // The two questions every path ends with, and nothing about the database.
    expect(kit.prompts.asked).toEqual(['Where should the mirror go?', 'Turn embeddings on?']);
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
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
    expect(kit.written.at(-1)).toEqual(fresh(CONTAINER_URL));
  });

  it('installs nothing and asks for a URL instead when the install is refused', async () => {
    const kit = harness({
      world: { dockerInstalled: false },
      answers: { select: ['docker'], confirm: [false], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.runner.calls).not.toContain('brew install --cask docker');
    expect(kit.prompts.asked).toContain('Postgres URL');
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
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
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
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

    expect(kit.prompts.asked.some((question) => question.includes('over the data already in the volume'))).toBe(
      true,
    );
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
    expect(kit.written.at(-1)).toEqual(fresh(CONTAINER_URL));
  });

  it('refuses to guess the password of a container it did not create', async () => {
    const kit = harness({ isTTY: false, world: { container: 'running' } });

    const exit = await runInstallFlow(['--docker', '--yes'], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('--database-url <url>');
    expect(kit.written).toEqual([]);
  });
});

describe('the installer flow and the mirror path', () => {
  it('offers the default and records it when the answer is just Enter', async () => {
    const kit = harness({ answers: { select: ['existing'], text: [EXISTING_URL] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    // The URL question's placeholder, then the mirror question's.
    expect(kit.prompts.placeholders[1]).toBe(MIRROR);
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
    expect(kit.output()).toContain(`the mirror goes in ${MIRROR}`);
  });

  it('records the absolute path the answer named', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      tail: { text: ['/tmp/notes/brain'], confirm: [false] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(EXISTING_URL, '/tmp/notes/brain')]);
  });

  it('expands a leading ~, which no shell expanded for a typed answer', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      tail: { text: ['~/notes/brain'], confirm: [false] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(EXISTING_URL, join(homedir(), 'notes/brain'))]);
  });

  it('expands a leading ~ on the flag too, and never asks', async () => {
    const kit = harness({ tail: { confirm: [false] } });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--mirror-path', '~/notes/brain'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual(['Turn embeddings on?']);
    expect(kit.written).toEqual([fresh(EXISTING_URL, join(homedir(), 'notes/brain'))]);
  });

  it('asks again after a relative answer, and takes the next one', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      tail: { text: ['notes/brain', '/tmp/notes/brain'], confirm: [false] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('CONFIG_INVALID');
    expect(kit.written).toEqual([fresh(EXISTING_URL, '/tmp/notes/brain')]);
  });

  it('exits 2 without writing for a relative flag and no terminal to ask in', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--mirror-path', 'notes/brain', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: --mirror-path notes/brain');
    expect(kit.written).toEqual([]);
    expect(kit.database.migrated).toEqual([]);
  });

  it('offers the recorded path as the default, and keeps it on Enter', async () => {
    const kit = harness({
      recorded: EXISTING_URL,
      recordedMirrorPath: '/tmp/notes/brain',
      answers: { select: ['existing'], text: [''] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[1]).toBe('/tmp/notes/brain');
    expect(kit.written).toEqual([
      kept(EXISTING_URL, 'Asia/Seoul', 'SECOND_BRAIN_DATABASE_URL', '/tmp/notes/brain'),
    ]);
  });

  it('keeps the recorded path without asking when there is no terminal', async () => {
    const kit = harness({
      isTTY: false,
      recorded: EXISTING_URL,
      recordedMirrorPath: '/tmp/notes/brain',
    });

    const exit = await runInstallFlow(['--database-url', EXISTING_URL, '--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([
      kept(EXISTING_URL, 'Asia/Seoul', 'SECOND_BRAIN_DATABASE_URL', '/tmp/notes/brain'),
    ]);
  });

  it('keeps the recorded path on the early Docker write as well', async () => {
    const kit = harness({
      world: { container: 'absent' },
      recorded: CONTAINER_URL,
      recordedMirrorPath: '/tmp/notes/brain',
      answers: { select: ['docker'], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    // The early write happens before the question, so it carries the recorded
    // path: writing the default there would move the mirror for a run that
    // then times out waiting for the container.
    expect(kit.written[0]).toEqual(
      kept(CONTAINER_URL, 'Asia/Seoul', 'SECOND_BRAIN_DATABASE_URL', '/tmp/notes/brain'),
    );
  });
});

describe('the installer flow and embeddings', () => {
  it('says they are not supported yet when the answer is yes, and writes nothing about them', async () => {
    const kit = harness({
      answers: { select: ['existing'], text: [EXISTING_URL] },
      tail: { text: [''], confirm: [true] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toContain('Turn embeddings on?');
    expect(kit.output()).toContain('not supported yet');
    // The same write as a run that said no: there is no key for this yet.
    expect(kit.written).toEqual([fresh(EXISTING_URL)]);
  });

  it('asks nothing and says one line when there is no terminal', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(['--database-url', EXISTING_URL, '--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.output()).toContain('embeddings are off');
  });
});

describe('the installer flow, the shim and the harnesses', () => {
  it('writes the shim for this home and says so', async () => {
    const kit = harness({ answers: { select: ['existing'], text: [EXISTING_URL] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.shimmed).toEqual([HOME]);
    expect(kit.output()).toContain(`wrote ${shimPath(HOME)} (mode 0755)`);
  });

  it('says the shim is current rather than claiming it wrote one', async () => {
    const kit = harness({
      shimCurrent: true,
      answers: { select: ['existing'], text: [EXISTING_URL] },
    });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.output()).toContain('is already current');
    expect(kit.output()).not.toContain('(mode 0755)');
  });

  it('says there is no harness to connect when the registry is empty', async () => {
    const kit = harness({ answers: { select: ['existing'], text: [EXISTING_URL] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('no harness to connect yet (epic 2)');
    expect(kit.prompts.checked).toEqual([]);
  });

  it('offers every detected harness checked, and connects the ones left checked', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const other = memoryConnector({ harness: 'other', label: 'Other' });
    const kit = harness({
      connectors: [demo, other],
      answers: { select: ['existing'], text: [EXISTING_URL] },
      tail: { text: [''], confirm: [false], multiselect: [['demo']] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([['demo', 'other']]);
    expect(demo.marked()).toHaveLength(1);
    expect(demo.entries()[0]).toContain(shimPath(HOME));
    expect(other.entries()).toEqual([]);
    expect(kit.output()).toContain('connected Demo in');
  });

  it('never offers a harness that is not installed here', async () => {
    const absent = memoryConnector({ harness: 'absent', detected: false });
    const kit = harness({
      connectors: [absent],
      answers: { select: ['existing'], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(kit.output()).toContain('no harness this build knows is installed here');
    expect(absent.entries()).toEqual([]);
  });

  it('says it is already connected the second time, writing nothing', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const run = async (): Promise<string> => {
      const kit = harness({
        connectors: [demo],
        answers: { select: ['existing'], text: [EXISTING_URL] },
        tail: { text: [''], confirm: [false], multiselect: [['demo']] },
      });
      expect(await runInstallFlow([], ENV, kit.deps)).toBe(0);
      return kit.output();
    };

    await run();
    const second = await run();

    expect(second).toContain('Demo was already connected in');
    expect(demo.marked()).toHaveLength(1);
  });

  it('connects only what --connect named when there is no terminal', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({ isTTY: false, connectors: [demo, other] });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--connect', 'demo', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(demo.marked()).toHaveLength(1);
    // A harness nobody asked about must not have its configuration written.
    expect(other.entries()).toEqual([]);
  });

  it('writes no harness configuration at all without a terminal and without the flag', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const kit = harness({ isTTY: false, connectors: [demo] });

    const exit = await runInstallFlow(['--database-url', EXISTING_URL, '--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(demo.entries()).toEqual([]);
    expect(kit.output()).toContain('no harness was connected');
  });

  it('takes --connect over the question in a terminal too', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({
      connectors: [demo, other],
      answers: { select: ['existing'], text: [EXISTING_URL] },
    });

    const exit = await runInstallFlow(['--connect', 'other'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(other.marked()).toHaveLength(1);
    expect(demo.entries()).toEqual([]);
  });

  it('exits 2 before touching anything for a harness nobody registered', async () => {
    const kit = harness({ isTTY: false, connectors: [memoryConnector({ harness: 'demo' })] });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--connect', 'nope', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(2);
    expect(kit.output()).toContain('USAGE: no connector for nope');
    expect(kit.output()).toContain('Known harnesses: demo.');
    expect(kit.written).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.database.doctored).toEqual([]);
  });

  it('exits 1 when a connector refuses, having finished everything else', async () => {
    const broken: MemoryConnector = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json is not JSON' },
    });
    const kit = harness({ isTTY: false, connectors: [broken] });

    const exit = await runInstallFlow(
      ['--database-url', EXISTING_URL, '--connect', 'demo', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(1);
    expect(kit.output()).toContain('HARNESS_UNREADABLE: settings.json is not JSON');
    // The database half of the install still happened and still counts.
    expect(kit.database.migrated).toEqual([EXISTING_URL]);
    expect(kit.output()).toContain('pgvector: ok');
  });
});

describe('the installer flags', () => {
  it.each([
    { argv: [], expected: { docker: false, connect: [], yes: false, help: false } },
    {
      argv: ['--docker', '--yes'],
      expected: { docker: true, connect: [], yes: true, help: false },
    },
    { argv: ['-y'], expected: { docker: false, connect: [], yes: true, help: false } },
    {
      argv: ['--database-url', 'postgres://x/y'],
      expected: {
        databaseUrl: 'postgres://x/y',
        docker: false,
        connect: [],
        yes: false,
        help: false,
      },
    },
    {
      argv: ['--mirror-path', '/tmp/notes', '--connect', 'demo', '--connect', 'other'],
      expected: {
        docker: false,
        mirrorPath: '/tmp/notes',
        connect: ['demo', 'other'],
        yes: false,
        help: false,
      },
    },
    {
      argv: ['--connect', 'demo', '--connect', 'demo'],
      expected: { docker: false, connect: ['demo'], yes: false, help: false },
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
    { argv: ['--mirror-path'], contains: 'needs a path' },
    { argv: ['--connect'], contains: 'needs a harness name' },
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

  it('refuses both database flags from commander too, not only from argv', async () => {
    // `brain setup run` builds the flags itself, so the contradiction has to be
    // caught in the flow as well: taking the URL and ignoring the container the
    // user also asked for is the one answer that must not happen.
    const kit = harness({ isTTY: false });

    const exit = await runInstall(
      { databaseUrl: EXISTING_URL, docker: true, connect: [], yes: true, help: false },
      ENV,
      kit.deps,
    );

    expect(exit).toBe(2);
    expect(kit.output()).toContain('pass one of them');
    expect(kit.written).toEqual([]);
    expect(kit.runner.calls).toEqual([]);
    expect(kit.database.doctored).toEqual([]);
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
