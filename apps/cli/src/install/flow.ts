import type {
  DoctorReport,
  EnsureDefaultIndexConfigResult,
  EnsureVectorResult,
  MigrationResult,
} from 'second_brain';
import { CHECK_IDS, formatCheck } from '../commands/admin-doctor.js';
import type { WriteConfigInput } from '../config/codec.js';
import { configFilePath, configHome, envFilePath } from '../config/paths.js';
import {
  CONTAINER_HOST,
  CONTAINER_IMAGE,
  CONTAINER_NAME,
  CONTAINER_PORT,
  CONTAINER_VOLUME,
  READY_TIMEOUT_MS,
  brewPresent,
  containerLogsCommand,
  containerState,
  containerUrl,
  createContainer,
  dockerPresent,
  dockerRunning,
  installDockerDesktop,
  openDockerDesktop,
  startContainer,
  volumeExists,
  waitForReady,
  type CommandRunner,
} from './docker.js';

/**
 * The installer's one flow, as a function of its dependencies. Every question,
 * every external command and every database write is injected, so the whole I/O
 * matrix can be driven from a test with no Docker, no terminal and no database
 * — and so story 7 can hand the same flow to `brain setup run`.
 *
 * The order is AD-19's, minus the steps that are story 7's: environment, Docker,
 * the database, the configuration, the migrations, the vector extension, the
 * default index config, doctor. Mirror path, embedding and harness wiring are
 * deliberately not asked about here.
 */

/** 0 it worked, 1 it ran and something failed, 2 it could not run at all. */
export type InstallExitCode = 0 | 1 | 2;

/** One option of a question with a fixed set of answers. */
export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * The questions, behind an interface, because the flow must be testable without
 * a terminal and because a non-interactive run must not be able to reach them
 * by accident: nothing here is called unless `isTTY` is true.
 */
export interface InstallPrompts {
  confirm(question: string, initial: boolean): Promise<boolean>;
  select<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    initial: T,
  ): Promise<T>;
  /** Free text. Comes back empty when the user only pressed Enter. */
  text(question: string, placeholder: string): Promise<string>;
  /** Wait for the user to say they are ready. */
  pause(message: string): Promise<void>;
}

/**
 * What a configuration folder already says. Everything in it has to be read
 * back and written out again: `writeConfig` renders the whole file from its
 * input, so passing only the URL would quietly reset a time zone or a variable
 * name the user chose, and move the key to a second name in `.env`.
 */
export interface RecordedConfig {
  databaseUrl: string;
  timezone: string;
  databaseUrlEnv: string;
}

/** The configuration codec, as the flow uses it (AD-18: only the codec writes). */
export interface InstallConfigIo {
  write(home: string, input: WriteConfigInput): Promise<void>;
  /** What `<home>` already holds, or `undefined` when it holds nothing usable. */
  read(home: string): Promise<RecordedConfig | undefined>;
}

/** The four database steps. Injected so the flow test needs no Postgres. */
export interface InstallDatabase {
  migrate(databaseUrl: string): Promise<MigrationResult>;
  ensureVector(databaseUrl: string): Promise<EnsureVectorResult>;
  ensureIndexConfig(
    databaseUrl: string,
    id: string,
  ): Promise<EnsureDefaultIndexConfigResult>;
  doctor(databaseUrl: string): Promise<DoctorReport>;
}

export interface InstallDeps {
  run: CommandRunner;
  prompts: InstallPrompts;
  /** Both ends are a terminal. Anything else means no question may be asked. */
  isTTY: boolean;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Milliseconds since the epoch. */
  now(): number;
  /** A fresh container password. Never printed (AD-18). */
  password(): string;
  /** A UUIDv7 for the index config row (AD-8). */
  nextId(): string;
  config: InstallConfigIo;
  database: InstallDatabase;
  /** Budget for the container's first start. The tests shorten it. */
  readyTimeoutMs?: number;
}

/** The flags a non-interactive run needs, since it cannot be asked anything. */
export interface InstallFlags {
  /** Use this Postgres. Mutually exclusive with `docker`. */
  databaseUrl?: string;
  /** Make the local container. */
  docker: boolean;
  /** Consent, given in advance, to everything the chosen path has to do. */
  yes: boolean;
  help: boolean;
}

/** How many times a URL that cannot be reached is asked for again. */
const URL_ATTEMPTS = 3;

/** How many times the user is asked to start the Docker daemon. */
const DAEMON_ATTEMPTS = 3;

/** Where the database came from, or why the flow stopped before it knew. */
type Chosen = { ok: true; databaseUrl: string } | { ok: false; exit: 1 | 2 };

/**
 * Run the installer. `argv` is the user's arguments, without the node and
 * script entries.
 */
export async function runInstallFlow(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: InstallDeps,
): Promise<InstallExitCode> {
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    deps.log(parsed.message);
    for (const line of usage()) deps.log(line);
    return 2;
  }
  const flags = parsed.flags;
  if (flags.help) {
    for (const line of usage()) deps.log(line);
    return 0;
  }

  const home = configHome(env);

  // A question needs an answer and a place to be read. Without both, the flags
  // are the only consent there is, and saying which ones are missing is the
  // only useful thing left to do (I/O matrix).
  if (!deps.isTTY && !(flags.yes && (flags.databaseUrl !== undefined || flags.docker))) {
    for (const line of nonInteractiveGuidance()) deps.log(line);
    return 2;
  }

  // Read before anything is asked: the recorded URL is what a re-run offers as
  // its default, and what tells a re-run the password of its own container.
  // The rest of it is what a re-run must not overwrite with defaults.
  const recorded = await deps.config.read(home);

  const chosen = await chooseDatabase(flags, home, recorded, deps);
  if (!chosen.ok) return chosen.exit;
  const { databaseUrl } = chosen;

  // The one gate every path goes through, whichever way the URL was arrived at.
  // A configuration folder written against a URL that does not work is worse
  // than no folder at all: the next command would read it and blame itself.
  const reached = await reachable(databaseUrl, deps);
  if (!reached.ok) {
    deps.log(`DB_UNAVAILABLE: ${reached.message}`);
    deps.log('Nothing was written.');
    return 1;
  }
  deps.log('the database answered');

  await deps.config.write(home, settings(databaseUrl, recorded));
  deps.log(`wrote ${configFilePath(home)} and ${envFilePath(home)} (mode 0600)`);

  const migrated = await deps.database.migrate(databaseUrl);
  if (!migrated.ok) {
    deps.log(`${migrated.code}: ${migrated.message}`);
    if (migrated.code === 'MIGRATION_FAILED') {
      deps.log(`The migration the database refused is ${migrated.file}.`);
    }
    return 1;
  }
  deps.log(
    migrated.applied.length === 0
      ? `the schema is already at version ${String(migrated.to)}`
      : `applied ${migrated.applied.join(', ')}, schema version ${String(migrated.to)}`,
  );

  const vector = await deps.database.ensureVector(databaseUrl);
  if (!vector.ok) {
    deps.log(`${vector.code}: ${vector.message}`);
    return 1;
  }
  deps.log(
    vector.installed === null
      ? `the vector extension is not installed: ${vector.reason}`
      : `the vector extension is installed (${vector.installed})`,
  );

  const indexConfig = await deps.database.ensureIndexConfig(databaseUrl, deps.nextId());
  if (!indexConfig.ok) {
    deps.log(`${indexConfig.code}: ${indexConfig.message}`);
    return 1;
  }
  deps.log(
    indexConfig.created
      ? 'created the default chunk index config'
      : 'the default chunk index config was already there',
  );

  // Doctor has the last word, and its verdict is the exit code: an install that
  // finished every step and still cannot report a healthy brain did not work.
  const report = await deps.database.doctor(databaseUrl);
  const checks = report.checks.map((check) => ({
    ...check,
    id: CHECK_IDS[check.id] ?? check.id,
  }));
  for (const check of checks) deps.log(formatCheck(check));
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

/**
 * One URL plus everything the folder already decided, which is what the codec
 * has to be handed every time: it renders both files whole, so anything left
 * out is written back as its default.
 */
function settings(
  databaseUrl: string,
  recorded: RecordedConfig | undefined,
): WriteConfigInput {
  return {
    databaseUrl,
    timezone: recorded?.timezone,
    databaseUrlEnv: recorded?.databaseUrlEnv,
  };
}

/** Which database this install uses: the flags', the user's, or a new one. */
async function chooseDatabase(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<Chosen> {
  // Nothing to ask and nothing to check here: the one gate above does the
  // checking, for this path and every other.
  if (flags.databaseUrl !== undefined) {
    return { ok: true, databaseUrl: flags.databaseUrl };
  }

  if (flags.docker) return dockerDatabase(flags, home, recorded, deps);

  const answer = await deps.prompts.select(
    'Which Postgres should this brain use?',
    [
      {
        value: 'docker',
        label: 'Make one locally with Docker',
        hint: `${CONTAINER_IMAGE} as ${CONTAINER_NAME}`,
      },
      { value: 'existing', label: 'Connect to a Postgres I already have' },
    ] as const,
    recorded === undefined ? 'docker' : 'existing',
  );
  return answer === 'docker'
    ? dockerDatabase(flags, home, recorded, deps)
    : askForUrl(recorded?.databaseUrl, deps);
}

/**
 * Ask for a URL until one answers, or until the attempts run out. The recorded
 * URL is offered as the default with its password masked, and an empty answer
 * takes it: the password is never shown, and never has to be retyped.
 */
async function askForUrl(recorded: string | undefined, deps: InstallDeps): Promise<Chosen> {
  for (let attempt = 1; attempt <= URL_ATTEMPTS; attempt += 1) {
    const typed = (
      await deps.prompts.text(
        'Postgres URL',
        recorded === undefined ? 'postgres://user:password@host:5432/brain' : maskUrl(recorded),
      )
    ).trim();
    const databaseUrl = typed === '' ? recorded : typed;
    if (databaseUrl === undefined || databaseUrl === '') {
      deps.log('A URL is needed to go on.');
      continue;
    }

    const reached = await reachable(databaseUrl, deps);
    if (reached.ok) return { ok: true, databaseUrl };
    deps.log(`DB_UNAVAILABLE: ${reached.message}`);
    deps.log('Nothing was written.');
  }
  deps.log(`No URL answered in ${String(URL_ATTEMPTS)} attempts, so nothing was changed.`);
  return { ok: false, exit: 1 };
}

/**
 * The local container. Nothing here removes or replaces anything: a container
 * that is there is started and used, and a volume that is there keeps the
 * cluster — and therefore the password — it already has. That last one is why
 * the volume is looked at before a password is invented: the image reads
 * `POSTGRES_PASSWORD` only when it initialises a cluster, so a freshly
 * generated one over an old volume would be written to `.env` and then refused
 * by the very database it names.
 */
async function dockerDatabase(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<Chosen> {
  const docker = await ensureDocker(flags, deps);
  if (!docker.ok) {
    // A no to installing Docker is not the end of the install: the other way to
    // a database is right there, so offer it now rather than making the user
    // start again (I/O matrix). Anything else that went wrong is still the end.
    if (docker.refused && deps.isTTY) return askForUrl(recorded?.databaseUrl, deps);
    return { ok: false, exit: 1 };
  }

  const state = await containerState(deps.run);
  // A container that exists has its cluster; only an absent one leaves the
  // question of whether the volume outlived it.
  const hadCluster = state !== 'absent' || (await volumeExists(deps.run));
  let password: string | undefined;

  if (state === 'running') {
    deps.log(`the container ${CONTAINER_NAME} is already running`);
  } else if (state === 'stopped') {
    deps.log(`starting the container ${CONTAINER_NAME}, which is already there`);
    const started = await startContainer(deps.run);
    if (started.code !== 0) {
      deps.log(`docker start ${CONTAINER_NAME} failed with exit code ${String(started.code)}.`);
      return { ok: false, exit: 1 };
    }
  } else {
    if (!flags.yes) {
      const agreed = await deps.prompts.confirm(
        hadCluster
          ? `Create the container ${CONTAINER_NAME} from ${CONTAINER_IMAGE}, on ${CONTAINER_HOST}:${String(CONTAINER_PORT)}, over the data already in the volume ${CONTAINER_VOLUME}?`
          : `Create the container ${CONTAINER_NAME} from ${CONTAINER_IMAGE}, on ${CONTAINER_HOST}:${String(CONTAINER_PORT)}, keeping its data in the volume ${CONTAINER_VOLUME}?`,
        true,
      );
      if (!agreed) {
        deps.log('Nothing was created.');
        // Same as a no to installing Docker: the other way is offered here.
        if (deps.isTTY) return askForUrl(recorded?.databaseUrl, deps);
        return { ok: false, exit: 1 };
      }
    }

    // A password for a cluster that is about to be initialised. Over an
    // existing volume the image ignores it and the old one stands, which is
    // exactly why it is not the URL's password below.
    password = deps.password();
    deps.log(`creating the container ${CONTAINER_NAME}`);
    const created = await createContainer(deps.run, password);
    if (created.code !== 0) {
      deps.log(`docker run failed with exit code ${String(created.code)}.`);
      return { ok: false, exit: 1 };
    }

    if (!hadCluster) {
      // Write it down now, before anything else can fail. This password exists
      // nowhere but in this variable and inside the cluster that was just
      // initialised with it: if the readiness wait times out, or the database
      // does not answer the gate below, losing it would leave a container
      // nobody — this installer included — can ever log into again.
      await deps.config.write(home, settings(containerUrl(password), recorded));
      deps.log(`recorded the container URL in ${envFilePath(home)} (mode 0600)`);
    }
  }

  const ready = await awaitContainer(deps);
  if (!ready.ok) return ready;

  // A cluster this run initialised is the only one whose password is known here.
  if (!hadCluster && password !== undefined) {
    return { ok: true, databaseUrl: containerUrl(password) };
  }
  if (recorded !== undefined) return { ok: true, databaseUrl: recorded.databaseUrl };

  // The data predates this run — another install's, or this folder was wiped.
  // The password is inside the cluster and is not ours to read, and the way to
  // a new one goes through removing data, which is not on the table.
  deps.log(
    `${CONTAINER_NAME} already holds a database, and no URL is recorded in ${envFilePath(home)}, so its password is not known here.`,
  );
  if (!deps.isTTY) {
    deps.log(
      `Pass the URL with --database-url <url>, or remove ${CONTAINER_NAME} and the volume ${CONTAINER_VOLUME} yourself first.`,
    );
    return { ok: false, exit: 1 };
  }
  return askForUrl(undefined, deps);
}

/** Wait for the container, or say where to look and leave it standing. */
async function awaitContainer(deps: InstallDeps): Promise<{ ok: true } | { ok: false; exit: 1 }> {
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  deps.log(`waiting for ${CONTAINER_NAME} to accept connections`);
  const ready = await waitForReady(
    { run: deps.run, now: deps.now, sleep: deps.sleep },
    timeoutMs,
  );
  if (ready.ready) return { ok: true };

  deps.log(
    `${CONTAINER_NAME} did not accept connections within ${String(Math.round(timeoutMs / 1000))}s.`,
  );
  deps.log(`See why with: ${containerLogsCommand()}`);
  deps.log('The container was left as it is.');
  return { ok: false, exit: 1 };
}

/**
 * A `docker` that is installed and whose daemon answers. A no to installing it
 * comes back as `refused`, which the caller turns into the existing-URL
 * question; everything else is a plain failure.
 */
async function ensureDocker(
  flags: InstallFlags,
  deps: InstallDeps,
): Promise<{ ok: true } | { ok: false; refused: boolean }> {
  if (!(await dockerPresent(deps.run))) {
    if (!flags.yes) {
      const agreed = await deps.prompts.confirm(
        'Docker is not installed. Install Docker Desktop with brew install --cask docker?',
        true,
      );
      if (!agreed) {
        deps.log('Nothing was installed.');
        if (!deps.isTTY) {
          deps.log('Pass the URL of a Postgres you already have with --database-url <url>.');
        }
        return { ok: false, refused: true };
      }
    }

    if (!(await brewPresent(deps.run))) {
      deps.log('Homebrew is not installed, so Docker Desktop cannot be installed from here.');
      deps.log('Install it from https://brew.sh, or install Docker Desktop yourself, then run this again.');
      return { ok: false, refused: false };
    }

    deps.log('installing Docker Desktop with brew install --cask docker');
    const installed = await installDockerDesktop(deps.run);
    if (installed.code !== 0) {
      deps.log(`brew install --cask docker failed with exit code ${String(installed.code)}.`);
      return { ok: false, refused: false };
    }

    // Installing it is not starting it: the first run puts up permission
    // dialogs that only the person at the keyboard can answer.
    deps.log('opening Docker Desktop, which will ask you for permission on its first run');
    await openDockerDesktop(deps.run);
  }

  if (await dockerRunning(deps.run)) return { ok: true };

  if (!deps.isTTY) {
    deps.log('Docker is installed but its daemon is not answering. Start Docker and run this again.');
    return { ok: false, refused: false };
  }

  for (let attempt = 1; attempt <= DAEMON_ATTEMPTS; attempt += 1) {
    deps.log('Docker is installed but its daemon is not answering yet.');
    await deps.prompts.pause('Open Docker, finish anything it asks for, then press Enter');
    if (await dockerRunning(deps.run)) return { ok: true };
  }
  deps.log('Docker never answered, so nothing was changed. Start it and run this again.');
  return { ok: false, refused: false };
}

/**
 * Whether a URL leads to a database that answers, read off doctor's own `db`
 * check so that "reachable" means exactly what doctor will say it means.
 */
async function reachable(
  databaseUrl: string,
  deps: InstallDeps,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const report = await deps.database.doctor(databaseUrl);
  const check = report.checks.find((candidate) => candidate.id === 'db');
  if (check?.status === 'ok') return { ok: true };
  return { ok: false, message: check?.detail ?? 'the database did not answer' };
}

export type ParsedFlags =
  | { ok: true; flags: InstallFlags }
  | { ok: false; message: string };

/**
 * The installer's own arguments. It is not a command of the dispatcher, so
 * commander never sees these; there are four of them and an unknown one is
 * refused rather than ignored.
 */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: InstallFlags = { docker: false, yes: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--database-url': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--database-url needs a URL after it.' };
        }
        flags.databaseUrl = value;
        index += 1;
        continue;
      }
      case '--docker':
        flags.docker = true;
        continue;
      case '--yes':
      case '-y':
        flags.yes = true;
        continue;
      case '--help':
      case '-h':
        flags.help = true;
        continue;
      default:
        return { ok: false, message: `unknown argument ${String(argument)}.` };
    }
  }

  if (flags.databaseUrl !== undefined && flags.docker) {
    return {
      ok: false,
      message: '--database-url and --docker ask for two different databases; pass one of them.',
    };
  }
  return { ok: true, flags };
}

export function usage(): readonly string[] {
  return [
    'Usage: second-brain [--database-url <url> | --docker] [--yes]',
    '  --database-url <url>  use this Postgres instead of asking',
    '  --docker              make a local Postgres container instead of asking',
    '  --yes                 agree in advance to what the chosen path has to do',
  ];
}

function nonInteractiveGuidance(): readonly string[] {
  return [
    'This is not a terminal, so nothing can be asked. Say what to do with flags:',
    '  --database-url <url> --yes   use a Postgres that already exists',
    `  --docker --yes               make the container ${CONTAINER_NAME} locally`,
  ];
}

/**
 * A URL with its password replaced, for the one place a URL is shown: the
 * default of the question that asks for it. A URL that cannot be parsed is not
 * shown at all, since the whole point is that nothing leaks.
 */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(the recorded URL)';
  }
}
