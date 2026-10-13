import { runDoctor, type DoctorReport } from './admin/doctor.js';
import type { HealthStore } from './ports/store.js';

export interface BrainDependencies {
  /**
   * Only the health capability: the SDK surface of story 1 probes and closes,
   * so an adapter that has nothing else yet already fits (AD-10).
   */
  store: HealthStore;
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
