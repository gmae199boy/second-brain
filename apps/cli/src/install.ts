#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configHome } from './config/paths.js';

/**
 * The installer, as its own entry point. It is deliberately not a command of
 * the dispatcher: the dispatcher reads the configuration and connects to the
 * database before any command runs, and at install time neither exists yet, so
 * every command ends in `CONFIG_MISSING`. Story 7 registers `brain setup run`
 * against `runInstaller` below, which is why the work lives in a function and
 * not at the top of this file.
 *
 * `tooling/bootstrap` starts this file, with the node that is running it, once
 * the clone under `<home>/app` has been built. For now it only says where it
 * is; dependencies, the database, the configuration and the migrations are
 * story 6.
 */

/** The package whose version is shown. Beside `src/` and beside `dist/` both. */
const MANIFEST = new URL('../package.json', import.meta.url);

/** The name the user typed to get here. */
const NAME = 'second-brain';

/** The opening screen: what this is, which version, and where it will write. */
export function installerIntro(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [
    `${NAME} ${version()}`,
    `Configuration folder: ${configHome(env)}`,
    'The installer itself is still being built, so nothing was changed yet.',
  ];
}

/**
 * Run the installer and hand back an exit code. Nothing is read and nothing is
 * written, so the only code it can return today is 0.
 */
export function runInstaller(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = defaultWrite,
): number {
  for (const line of installerIntro(env)) write(line);
  return 0;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
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
  process.exitCode = runInstaller();
}
