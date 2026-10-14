import {
  runDoctor,
  type DoctorCheckSource,
  type DoctorReport,
} from './admin/doctor.js';
import type { HealthStore, SchemaStore } from './ports/store.js';

export interface BrainDependencies {
  /**
   * The health and schema-version capabilities: what `admin.doctor` asks of a
   * source and nothing more, so an adapter that has only these two already fits
   * (AD-10).
   */
  store: HealthStore & SchemaStore;
  /**
   * Schema version this build was made for. The caller passes the constant of
   * the adapter it built, because which schema is current is the adapter's
   * fact, not Core's.
   */
  schemaVersion: number;
  /**
   * Checks the runtime registers on top of the store's own — the shim, the node
   * behind it, the configuration file. Core has no filesystem, so these come
   * from whoever does.
   */
  checks?: readonly DoctorCheckSource[];
}

export interface BrainAdmin {
  doctor(): Promise<DoctorReport>;
}

export interface Brain {
  admin: BrainAdmin;
  close(): Promise<void>;
}

/**
 * Assemble the SDK surface from its ports. Calling this does no I/O; every
 * connection is made by the adapter factory the caller already built (AD-3).
 */
export function createBrain(dependencies: BrainDependencies): Brain {
  const { store, schemaVersion, checks } = dependencies;
  return {
    admin: {
      doctor: () => runDoctor(store, { schemaVersion, checks }),
    },
    close: () => store.close(),
  };
}
