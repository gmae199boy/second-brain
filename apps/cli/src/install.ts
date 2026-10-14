#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  select,
  text,
  type Option,
} from '@clack/prompts';
import {
  ensureDefaultIndexConfig,
  ensureVectorExtension,
  postgresStore,
  runDoctor,
  runMigrations,
  type DoctorReport,
} from 'second_brain';
import { readConfig, writeConfig } from './config/codec.js';
import { configHome } from './config/paths.js';
import { connectors } from './connectors/index.js';
import type { CommandRequest, CommandResult } from './install/docker.js';
import { randomPassword } from './install/docker.js';
import {
  runInstall,
  runInstallFlow,
  type Choice,
  type InstallDeps,
  type InstallExitCode,
  type InstallFlags,
  type InstallPrompts,
  type RecordedConfig,
} from './install/flow.js';
import { writeShim } from './install/shim.js';
import { uuidV7IdGen } from './runtime/id-gen.js';

/**
 * The installer, as its own entry point. It is deliberately not a command of
 * the dispatcher: the dispatcher reads the configuration and connects to the
 * database before any command runs, and at install time neither exists yet, so
 * every command ends in `CONFIG_MISSING`. `brain setup run` is the same flow as
 * a standalone command (`commands/setup-run.ts`), which is why the work lives
 * in the functions below and not at the top of this file.
 *
 * `tooling/bootstrap` starts this file, with the node that is running it, once
 * the clone under `<home>/app` has been built. This file is the real world —
 * the terminal, the clock, `docker`, the database — and `install/flow.ts` is
 * the flow that uses it, so the whole flow is testable without any of it.
 */

/** The package whose version is shown. Beside `src/` and beside `dist/` both. */
const MANIFEST = new URL('../package.json', import.meta.url);

/** The name the user typed to get here. */
const NAME = 'second-brain';

/** The opening screen: what this is, which version, and where it will write. */
export function installerIntro(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [
    `${NAME} ${version()}`,
    `node ${process.versions.node}`,
    `Configuration folder: ${configHome(env)}`,
  ];
}

/**
 * Run the installer and hand back an exit code: 0 it worked, 1 it ran and
 * something failed, 2 it could not run at all. `argv` is the user's arguments,
 * without the node and script entries.
 */
export async function runInstaller(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: InstallDeps = systemInstallDeps(),
): Promise<InstallExitCode> {
  return guarded(env, deps, () => runInstallFlow(argv, env, deps));
}

/**
 * The same installer, from flags somebody else parsed. `brain setup run` takes
 * this door: commander has already read its options, and re-rendering them as
 * an argument list only to parse them again would be two readings of one
 * intent, which is how two spellings of the same flag come about.
 */
export async function runInstallerWithFlags(
  flags: InstallFlags,
  env: NodeJS.ProcessEnv = process.env,
  deps: InstallDeps = systemInstallDeps(),
): Promise<InstallExitCode> {
  return guarded(env, deps, () => runInstall(flags, env, deps));
}

/** The intro, and Ctrl-C turned back into an exit code rather than a stack. */
async function guarded(
  env: NodeJS.ProcessEnv,
  deps: InstallDeps,
  run: () => Promise<InstallExitCode>,
): Promise<InstallExitCode> {
  for (const line of installerIntro(env)) deps.log(line);
  try {
    return await run();
  } catch (error) {
    if (error instanceof Cancelled) {
      deps.log('Stopped at your request. Nothing more was changed.');
      return 1;
    }
    throw error;
  }
}

/** A question the user answered with Ctrl-C. Not a failure of anything. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/** The real world, in one place, so the tests can replace all of it. */
export function systemInstallDeps(): InstallDeps {
  const idGen = uuidV7IdGen();
  return {
    run: runCommand,
    prompts: clackPrompts(),
    // Both ends have to be a terminal: a question needs an answer and a place
    // to be read. Anything else counts as not interactive at all.
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    log: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    sleep: async (ms: number): Promise<void> => {
      await delay(ms);
    },
    now: () => Date.now(),
    password: randomPassword,
    nextId: () => idGen.next(),
    config: {
      write: writeConfig,
      read: async (home: string): Promise<RecordedConfig | undefined> => {
        // An empty environment on purpose: a stale variable in some shell must
        // not pass for the URL this folder has on record.
        const read = await readConfig(home, {});
        if (!read.ok) return undefined;
        // The time zone and the variable name come back too, because the codec
        // renders the whole folder from what it is given: a re-run that passed
        // only the URL would reset them to their defaults.
        const { databaseUrl, timezone, databaseUrlEnv, mirrorPath } = read.config;
        return { databaseUrl, timezone, databaseUrlEnv, mirrorPath };
      },
    },
    database: {
      migrate: (databaseUrl: string) => runMigrations({ databaseUrl }),
      ensureVector: (databaseUrl: string) => ensureVectorExtension({ databaseUrl }),
      ensureIndexConfig: (databaseUrl: string, id: string) =>
        ensureDefaultIndexConfig({ databaseUrl, id }),
      doctor: doctorAt,
    },
    // The node running this process, and the entry point beside the shim
    // module: whatever node started the installer is the node the hooks get.
    shim: { write: (home: string) => writeShim(home) },
    connectors,
  };
}

/**
 * Doctor against a URL the installer chose, not one the configuration names:
 * the installer runs outside the dispatcher, so it builds its own store rather
 * than reading back a folder it may not have written yet.
 */
async function doctorAt(databaseUrl: string): Promise<DoctorReport> {
  const store = postgresStore({ databaseUrl });
  try {
    return await runDoctor(store);
  } finally {
    await store.close();
  }
}

/**
 * The questions, on `@clack/prompts`. Ctrl-C comes back from clack as a symbol
 * rather than an error, so it is turned into one here: the flow has one way out
 * and does not have to check every answer for it.
 */
function clackPrompts(): InstallPrompts {
  return {
    async confirm(question: string, initial: boolean): Promise<boolean> {
      return answered<boolean>(await confirm({ message: question, initialValue: initial }));
    },
    async select<T extends string>(
      question: string,
      choices: readonly Choice<T>[],
      initial: T,
    ): Promise<T> {
      // `Option` is a conditional type over the value, which stays unresolved
      // while the value is a type parameter; the shape is the one it asks for.
      const options = choices.map((choice) => ({ ...choice })) as Option<T>[];
      return answered<T>(
        await select<T>({ message: question, options, initialValue: initial }),
      );
    },
    async text(question: string, placeholder: string): Promise<string> {
      return answered<string>(
        await text({ message: question, placeholder, defaultValue: '' }),
      );
    },
    async multiselect<T extends string>(
      question: string,
      choices: readonly Choice<T>[],
      initial: readonly T[],
    ): Promise<readonly T[]> {
      const options = choices.map((choice) => ({ ...choice })) as Option<T>[];
      return answered<T[]>(
        await multiselect<T>({
          message: question,
          options,
          initialValues: [...initial],
          // Unchecking everything is a real answer: it means connect nothing.
          required: false,
        }),
      );
    },
    async pause(message: string): Promise<void> {
      answered<string>(await text({ message, placeholder: 'Enter', defaultValue: '' }));
    },
  };
}

/** The answer, or `Cancelled` when the user pressed Ctrl-C. */
function answered<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('cancelled');
    throw new Cancelled();
  }
  return value as T;
}

function runCommand(request: CommandRequest): Promise<CommandResult> {
  const captured = request.capture === true;
  // Only the answer is read; stderr still goes to the terminal, so a command
  // that fails says why instead of turning into a bare refusal — unless the
  // request is a probe whose failure is a normal answer, and whose complaint
  // on the way past would read as a broken install.
  const errors = request.quiet === true ? 'ignore' : 'inherit';
  return new Promise((resolve) => {
    const child = spawn(request.command, [...request.args], {
      stdio: captured ? ['ignore', 'pipe', errors] : 'inherit',
    });

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // A command that is not installed is not an exception here, it is an
    // answer: 127, the shell's own code for it.
    child.once('error', () => resolve({ code: 127, stdout }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function version(): string {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version?: string };
  return manifest.version ?? '0.0.0';
}

/**
 * True when node was told to run this file, rather than something importing
 * it. `realpathSync` on both sides because `/tmp` on a Mac is a symlink.
 */
function invokedDirectly(here: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(here));
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await runInstaller();
}
