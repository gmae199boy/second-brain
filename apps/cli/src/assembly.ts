import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  SQLITE_SCHEMA_VERSION,
  type BrainDependencies,
  type Clock,
  type IdGen,
  type SchemaStore,
  type Store,
  type WorkHandlers,
} from 'second_brain';
import type { ReadConfigResult } from './config/codec.js';
import { spoolPath } from './config/paths.js';
import { runtimeChecks } from './doctor/checks.js';
import { harnessParsers, harnesses, transcriptFolders } from './harnesses.js';
import { localFileStore } from './runtime/file-store.js';
import { gitRepositoryInspector } from './runtime/git.js';
import { fileSourceReader } from './runtime/source-file.js';
import { fileSpool } from './runtime/spool.js';
import { fileTranscriptReader } from './runtime/transcript.js';

/**
 * The one place a `Brain` is assembled from this machine's adapters.
 *
 * It exists because there are now two callers and they must not drift apart.
 * The dispatcher builds one per invocation; the daemon builds one per round of
 * its loop, over a store it opened itself (`daemon/run.ts`). A second copy of
 * this object would be a second answer to questions like "which folders may be
 * scanned" and "where does a write that could not land go" — and the one that
 * drifted would be whichever of the two nobody was reading.
 *
 * Building it opens nothing (AD-3): every adapter here is a factory, and the
 * store is already open because whoever called this chose its lock budget.
 *
 * Stories 9.4 and 9.5 extend this function and the daemon loop rather than
 * adding a third assembly.
 */
export interface BrainAssembly {
  /** The configuration folder this brain belongs to (AD-18). */
  home: string;
  /** This invocation's environment, which is where the harness folders are. */
  env: NodeJS.ProcessEnv;
  /**
   * What reading the configuration answered. A failure is passed in rather
   * than refused here: `doctor run` is assembled over an unreadable
   * configuration on purpose (Decision 2026-10-14), and the `files` root and
   * the `config` check both have to say so.
   */
  config: ReadConfigResult;
  /** Already open, at the lock budget the caller chose (AD-7). */
  store: Store & SchemaStore;
  clock: Clock;
  idGen: IdGen;
  /** Kinds beyond Core's own. Empty for every real invocation (AD-21). */
  workHandlers: WorkHandlers;
}

/**
 * The ports one `createBrain` call needs, for this machine and this folder.
 *
 * The `spool` is on the returned object as well as inside the brain, because
 * the dispatcher's spool branch writes a mark with no brain in its hands
 * (AD-9): it is one spool per invocation, so two `fileSpool` calls over the
 * same folder would be two serial counters minting the same file name.
 */
export function brainDependencies(assembly: BrainAssembly): BrainDependencies {
  const { home, env, config, store, clock, idGen, workHandlers } = assembly;
  return {
    store,
    // Under `home` and not under a configured path: a write that could not
    // reach the database has to have somewhere to go even when the
    // configuration is the thing that is broken, and `home` is known from the
    // environment alone (AD-9, AD-18). Building this opens nothing — the folder
    // is made by the first `append` that needs it (AD-3).
    spool: fileSpool({ folder: spoolPath(home), clock }),
    files: localFileStore({ root: config.ok ? config.config.filesPath : join(home, 'files') }),
    sources: fileSourceReader(),
    userHome: env['HOME']?.startsWith('/') === true ? env['HOME'] : null,
    schemaVersion: SQLITE_SCHEMA_VERSION,
    clock,
    idGen,
    // Parsers and connectors come from the same harness registry.
    parsers: harnessParsers(harnesses),
    transcripts: fileTranscriptReader(),
    // Every registered harness folder is scanned by default.
    transcriptFolders: transcriptFolders(env),
    // Asking git what the first message's folder is, for the project and
    // worktree tags of a session this run may create (AD-12).
    repositories: gitRepositoryInspector(),
    // Recorded on every session this machine ingests (AD-12). The host name,
    // because it is the one name a person reading a report would recognise.
    machine: hostname(),
    // One list, for the dispatcher and the installer both: see `doctor/checks`.
    checks: runtimeChecks({ home, config }),
    // Kinds beyond Core's own, which `createBrain` merges in. Empty for every
    // real invocation of this build (AD-21).
    workHandlers,
  };
}
