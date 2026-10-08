import { runDoctor, type DoctorReport } from './admin/doctor.js';
import type { Store } from './ports/store.js';

export interface BrainDependencies {
  store: Store;
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
  const { store } = dependencies;
  return {
    admin: {
      doctor: () => runDoctor(store),
    },
    close: () => store.close(),
  };
}
