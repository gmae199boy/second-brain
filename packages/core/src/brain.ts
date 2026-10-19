import {
  runDoctor,
  type DoctorCheckSource,
  type DoctorReport,
} from './doctor/doctor.js';
import type { Clock } from './ports/clock.js';
import type { IdGen } from './ports/id-gen.js';
import type { Parser } from './ports/parser.js';
import type { RepositoryInspector } from './ports/repository.js';
import type { Spool } from './ports/spool.js';
import type { SchemaStore, Store } from './ports/store.js';
import type { TranscriptReader } from './ports/transcript.js';
import {
  drainQueue,
  type DrainQueueReport,
  type WorkHandlers,
} from './queue/drain.js';
import {
  ingestSession,
  type IngestSessionInput,
  type IngestSessionResult,
} from './sessions/ingest.js';

export interface BrainDependencies {
  /**
   * The persistence port, plus the schema-version capability `doctor.run`
   * asks for. It is the whole `Store` now that a verb writes conversation
   * data: an adapter that offers only health and the schema version can still
   * answer `doctor.run`, but it cannot ingest, and the type is where that is
   * decided rather than at the call (AD-10).
   */
  store: Store & SchemaStore;
  /**
   * Where a write goes when the database will not take it (AD-9). Every verb
   * that writes conversation data needs it, because a lock that is held too
   * long is not a failure of the verb — it is a write that has to wait, and
   * the spool is where it waits.
   */
  spool: Spool;
  /**
   * Schema version this build was made for. The caller passes the constant of
   * the adapter it built, because which schema is current is the adapter's
   * fact, not Core's.
   */
  schemaVersion: number;
  /** The one clock. Every stored instant is read from it once (AD-13). */
  clock: Clock;
  /** Record ids. UUIDv7, minted by this side, never by the database (AD-8). */
  idGen: IdGen;
  /** Every harness this build can read a transcript of (AD-4). */
  parsers: readonly Parser[];
  /** Reading a transcript file. Core has no filesystem of its own (AD-1). */
  transcripts: TranscriptReader;
  /**
   * Asking git what a working folder is, for the project and worktree tags of
   * a session (AD-12). Core has no git of its own (AD-1).
   */
  repositories: RepositoryInspector;
  /** The machine sessions ingested here ran on, recorded per session (AD-12). */
  machine: string;
  /**
   * Checks the runtime registers on top of the store's own — the shim, the node
   * behind it, the configuration file. Core has no filesystem, so these come
   * from whoever does.
   */
  checks?: readonly DoctorCheckSource[];
  /**
   * What this build's drain can actually do, by kind of work (AD-21).
   *
   * It is a dependency and not a constant because a handler needs the ports the
   * caller assembled — a transcript reader, a file store — and because the kinds
   * a build can do are a fact about the build, not about Core. This build ships
   * none, so every drain run answers `empty`; the kinds Core will own itself are
   * merged in below as they arrive (Boundaries).
   */
  workHandlers?: WorkHandlers;
}

export interface BrainDoctor {
  /** Check whether this brain is reachable and healthy, and report. */
  run(): Promise<DoctorReport>;
}

export interface BrainSessions {
  /** Read a harness transcript and append what is new (AD-4, AD-14). */
  ingest(input: IngestSessionInput): Promise<IngestSessionResult>;
}

/** What one call to `queue.drain` is given (AD-7, AD-21). */
export interface BrainQueueDrainInput {
  /** How long this run may keep claiming, in milliseconds (`DRAIN_BUDGET_MS`). */
  budgetMs: number;
  /**
   * Handlers for this call only, merged over the ones the brain was built with.
   * The seam exists for a test and for a caller that knows about a kind the
   * assembly did not — never to replace the build's own set silently.
   */
  handlers?: WorkHandlers;
}

export interface BrainQueue {
  /** Work the backlog within a time budget, and report what happened (AD-21). */
  drain(input: BrainQueueDrainInput): Promise<DrainQueueReport>;
}

export interface Brain {
  doctor: BrainDoctor;
  sessions: BrainSessions;
  queue: BrainQueue;
  close(): Promise<void>;
}

/**
 * Assemble the SDK surface from its ports. Calling this does no I/O; every
 * connection is made by the adapter factory the caller already built (AD-3).
 */
export function createBrain(dependencies: BrainDependencies): Brain {
  const {
    store,
    spool,
    schemaVersion,
    clock,
    idGen,
    parsers,
    transcripts,
    repositories,
    machine,
    checks,
    workHandlers,
  } = dependencies;
  // The kinds Core owns, and then the caller's. Empty on both sides today: this
  // build has no kinds of work (Boundaries), and the merge is here so that the
  // story adding the first one has one place to add it.
  const coreHandlers: WorkHandlers = {};
  const handlers: WorkHandlers = { ...coreHandlers, ...workHandlers };
  return {
    doctor: {
      run: () => runDoctor(store, { schemaVersion, checks }),
    },
    sessions: {
      ingest: (input) =>
        ingestSession(
          { store, spool, clock, idGen, parsers, transcripts, repositories, machine },
          input,
        ),
    },
    queue: {
      drain: (input) =>
        drainQueue(
          { store, spool, clock, idGen },
          {
            budgetMs: input.budgetMs,
            handlers: input.handlers === undefined ? handlers : { ...handlers, ...input.handlers },
          },
        ),
    },
    close: () => store.close(),
  };
}
