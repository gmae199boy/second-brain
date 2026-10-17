import {
  runDoctor,
  type DoctorCheckSource,
  type DoctorReport,
} from './doctor/doctor.js';
import type { Clock } from './ports/clock.js';
import type { IdGen } from './ports/id-gen.js';
import type { Parser } from './ports/parser.js';
import type { RepositoryInspector } from './ports/repository.js';
import type { SchemaStore, Store } from './ports/store.js';
import type { TranscriptReader } from './ports/transcript.js';
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
}

export interface BrainDoctor {
  /** Check whether this brain is reachable and healthy, and report. */
  run(): Promise<DoctorReport>;
}

export interface BrainSessions {
  /** Read a harness transcript and append what is new (AD-4, AD-14). */
  ingest(input: IngestSessionInput): Promise<IngestSessionResult>;
}

export interface Brain {
  doctor: BrainDoctor;
  sessions: BrainSessions;
  close(): Promise<void>;
}

/**
 * Assemble the SDK surface from its ports. Calling this does no I/O; every
 * connection is made by the adapter factory the caller already built (AD-3).
 */
export function createBrain(dependencies: BrainDependencies): Brain {
  const {
    store,
    schemaVersion,
    clock,
    idGen,
    parsers,
    transcripts,
    repositories,
    machine,
    checks,
  } = dependencies;
  return {
    doctor: {
      run: () => runDoctor(store, { schemaVersion, checks }),
    },
    sessions: {
      ingest: (input) =>
        ingestSession(
          { store, clock, idGen, parsers, transcripts, repositories, machine },
          input,
        ),
    },
    close: () => store.close(),
  };
}
