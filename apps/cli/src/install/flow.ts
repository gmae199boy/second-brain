import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  Connector,
  DoctorReport,
  EnsureDefaultIndexConfigResult,
  EnsureVectorResult,
  MigrationResult,
} from 'second_brain';
import { CHECK_IDS, formatCheck } from '../commands/admin-doctor.js';
import { defaultMirrorPath, type WriteConfigInput } from '../config/codec.js';
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
 * — and so `brain setup run` runs this very flow rather than a second one.
 *
 * The order is AD-19's, whole: environment, Docker, the database, the mirror
 * path, embeddings, the configuration, the migrations, the vector extension,
 * the default index config, the shim, the harnesses, doctor.
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
  /** Any number of the choices. `initial` is what starts out checked. */
  multiselect<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    initial: readonly T[],
  ): Promise<readonly T[]>;
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
  /** Absolute. A re-run offers it as the default and must never reset it. */
  mirrorPath: string;
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

/** Writing the shim, injected so the flow test touches no filesystem. */
export interface InstallShim {
  /** Write `<home>/bin/brain`, or leave it alone when it already says this. */
  write(home: string): Promise<{ path: string; changed: boolean }>;
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
  shim: InstallShim;
  /** Every harness this build can connect to. Empty until epic 2. */
  connectors: readonly Connector[];
  /** Budget for the container's first start. The tests shorten it. */
  readyTimeoutMs?: number;
}

/** The flags a non-interactive run needs, since it cannot be asked anything. */
export interface InstallFlags {
  /** Use this Postgres. Mutually exclusive with `docker`. */
  databaseUrl?: string;
  /** Make the local container. */
  docker: boolean;
  /** Where the mirror goes. `~` is expanded; a relative path is refused. */
  mirrorPath?: string;
  /** Harnesses to connect, by name. The only consent there is without a TTY. */
  connect: readonly string[];
  /** Consent, given in advance, to everything the chosen path has to do. */
  yes: boolean;
  help: boolean;
}

/** How many times a URL that cannot be reached is asked for again. */
const URL_ATTEMPTS = 3;

/** How many times the user is asked to start the Docker daemon. */
const DAEMON_ATTEMPTS = 3;

/** How many times a mirror path that cannot be used is asked for again. */
const MIRROR_ATTEMPTS = 3;

/** Both database flags at once, refused the same way on both ways in. */
const TWO_DATABASES =
  '--database-url and --docker ask for two different databases; pass one of them.';

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

  return runInstall(flags, env, deps);
}

/**
 * The flow itself, from flags that are already parsed. `brain setup run` comes
 * in here with flags commander built, so the installer and the command run the
 * same steps in the same order rather than two readings of the same intent.
 */
export async function runInstall(
  flags: InstallFlags,
  env: NodeJS.ProcessEnv,
  deps: InstallDeps,
): Promise<InstallExitCode> {
  const home = configHome(env);

  // Checked here and not only in `parseFlags`, because commander is the other
  // way in: `brain setup run --docker --database-url …` would otherwise take
  // the URL and quietly ignore the container the user also asked for.
  if (flags.databaseUrl !== undefined && flags.docker) {
    deps.log(`USAGE: ${TWO_DATABASES}`);
    return 2;
  }

  // Named before anything is asked or written: a harness nobody registered is
  // a typo, and finding that out after the database is set up would leave the
  // user to guess whether the install took.
  const unknown = flags.connect.filter(
    (name) => !deps.connectors.some((connector) => connector.harness === name),
  );
  if (unknown.length > 0) {
    deps.log(`USAGE: no connector for ${unknown.join(', ')}. ${knownHarnesses(deps)}`);
    return 2;
  }

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

  const mirror = await chooseMirrorPath(flags, home, recorded, deps);
  if (!mirror.ok) return mirror.exit;
  deps.log(`the mirror goes in ${mirror.path}`);

  await askAboutEmbeddings(deps);

  await deps.config.write(home, settings(databaseUrl, recorded, mirror.path));
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

  // The shim before the harnesses, because connecting one means registering
  // this exact path with it.
  const shim = await deps.shim.write(home);
  deps.log(shim.changed ? `wrote ${shim.path} (mode 0755)` : `${shim.path} is already current`);

  const connected = await connectHarnesses(flags, shim.path, deps);

  // Doctor has the last word, and its verdict is the exit code: an install that
  // finished every step and still cannot report a healthy brain did not work.
  const report = await deps.database.doctor(databaseUrl);
  const checks = report.checks.map((check) => ({
    ...check,
    id: CHECK_IDS[check.id] ?? check.id,
  }));
  for (const check of checks) deps.log(formatCheck(check));
  return checks.some((check) => check.status === 'fail') || !connected ? 1 : 0;
}

/**
 * One URL plus everything the folder already decided, which is what the codec
 * has to be handed every time: it renders both files whole, so anything left
 * out is written back as its default. The mirror path is the newest trap of
 * that kind: a re-run that passed only the URL would silently move the mirror
 * back under the configuration folder.
 */
function settings(
  databaseUrl: string,
  recorded: RecordedConfig | undefined,
  mirrorPath?: string,
): WriteConfigInput {
  return {
    databaseUrl,
    timezone: recorded?.timezone,
    databaseUrlEnv: recorded?.databaseUrlEnv,
    mirrorPath: mirrorPath ?? recorded?.mirrorPath,
  };
}

/** Where this install's mirror goes. Nothing here creates the folder (epic 4). */
async function chooseMirrorPath(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<{ ok: true; path: string } | { ok: false; exit: 2 }> {
  const fallback = recorded?.mirrorPath ?? defaultMirrorPath(home);

  if (flags.mirrorPath !== undefined) {
    const given = expandHome(flags.mirrorPath);
    if (isAbsolute(given)) return { ok: true, path: given };
    deps.log(`CONFIG_INVALID: --mirror-path ${flags.mirrorPath} is not an absolute path.`);
    // A terminal can be asked again; a script cannot, and taking the default
    // instead would put the mirror somewhere the flag plainly did not ask for.
    if (!deps.isTTY) return { ok: false, exit: 2 };
  } else if (!deps.isTTY) {
    return { ok: true, path: fallback };
  }

  for (let attempt = 1; attempt <= MIRROR_ATTEMPTS; attempt += 1) {
    const typed = (await deps.prompts.text('Where should the mirror go?', fallback)).trim();
    const chosen = typed === '' ? fallback : expandHome(typed);
    if (isAbsolute(chosen)) return { ok: true, path: chosen };
    deps.log(`CONFIG_INVALID: ${chosen} is not an absolute path.`);
  }
  deps.log(`No usable mirror path in ${String(MIRROR_ATTEMPTS)} attempts, so nothing was written.`);
  return { ok: false, exit: 2 };
}

/**
 * The embedding question of AD-19, asked and then answered for the user: epic 6
 * owns embeddings, and until it lands saying yes can only mean "not yet". It
 * writes nothing either way — there is no configuration key to write, and
 * inventing one now would be a key epic 6 has to migrate away from.
 */
async function askAboutEmbeddings(deps: InstallDeps): Promise<void> {
  if (!deps.isTTY) {
    deps.log('embeddings are off (not supported yet)');
    return;
  }
  const wanted = await deps.prompts.confirm('Turn embeddings on?', false);
  deps.log(
    wanted
      ? 'Embeddings are not supported yet, so they stay off. Nothing was written.'
      : 'embeddings are off',
  );
}

/**
 * Register the shim with the harnesses the user chose. Only `connect` writes a
 * harness's own file (AD-19), so everything here is a question and a log line.
 * Comes back false when a connector refused, which the exit code picks up.
 */
async function connectHarnesses(
  flags: InstallFlags,
  shimPath: string,
  deps: InstallDeps,
): Promise<boolean> {
  if (deps.connectors.length === 0) {
    deps.log('no harness to connect yet (epic 2)');
    return true;
  }

  const chosen = await chooseHarnesses(flags, deps);
  if (chosen.length === 0) {
    deps.log('no harness was connected');
    return true;
  }

  let allConnected = true;
  for (const connector of chosen) {
    const result = await connector.connect({ shimPath });
    if (!result.ok) {
      deps.log(`${result.code}: ${result.message}`);
      allConnected = false;
      continue;
    }
    deps.log(
      result.changed
        ? `connected ${connector.label} in ${result.target}`
        : `${connector.label} was already connected in ${result.target}`,
    );
  }
  return allConnected;
}

/** Which harnesses to connect: the ones checked, or the ones the flags named. */
async function chooseHarnesses(
  flags: InstallFlags,
  deps: InstallDeps,
): Promise<readonly Connector[]> {
  // Without a terminal the flags are the only consent there is, and a harness
  // nobody asked about must not have its configuration written (AD-19).
  if (!deps.isTTY) {
    return deps.connectors.filter((connector) => flags.connect.includes(connector.harness));
  }

  const named = deps.connectors.filter((connector) => flags.connect.includes(connector.harness));
  if (named.length > 0) return named;

  const detected: Connector[] = [];
  for (const connector of deps.connectors) {
    if (await connector.detect()) detected.push(connector);
  }
  if (detected.length === 0) {
    deps.log('no harness this build knows is installed here');
    return [];
  }

  // Everything detected starts out checked: connecting is what the user came
  // for, and unchecking is the cheaper correction of the two.
  const answer = await deps.prompts.multiselect(
    'Which harnesses should this brain connect to?',
    detected.map((connector) => ({ value: connector.harness, label: connector.label })),
    detected.map((connector) => connector.harness),
  );
  return detected.filter((connector) => answer.includes(connector.harness));
}

/**
 * A leading `~` as the user's home directory. A path typed into a question
 * never passes a shell, so nobody expands it but us.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function knownHarnesses(deps: InstallDeps): string {
  if (deps.connectors.length === 0) return 'This build registers no connector yet (epic 2).';
  return `Known harnesses: ${deps.connectors.map((connector) => connector.harness).join(', ')}.`;
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
  const connect: string[] = [];
  const flags: InstallFlags = { docker: false, connect, yes: false, help: false };

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
      case '--mirror-path': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--mirror-path needs a path after it.' };
        }
        flags.mirrorPath = value;
        index += 1;
        continue;
      }
      case '--connect': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--connect needs a harness name after it.' };
        }
        // Repeatable: one `--connect` per harness, so no separator has to be
        // invented and a name with a comma in it stays one name.
        if (!connect.includes(value)) connect.push(value);
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
    return { ok: false, message: TWO_DATABASES };
  }
  return { ok: true, flags };
}

export function usage(): readonly string[] {
  return [
    'Usage: second-brain [--database-url <url> | --docker] [--mirror-path <path>]',
    '                    [--connect <harness>]… [--yes]',
    '  --database-url <url>  use this Postgres instead of asking',
    '  --docker              make a local Postgres container instead of asking',
    '  --mirror-path <path>  absolute path for the mirror folder',
    '  --connect <harness>   connect this harness; repeat for more than one',
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
