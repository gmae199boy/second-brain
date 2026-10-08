/**
 * Health of the vector capability, reported with a neutral name: Core never
 * learns which extension provides it. Adapters map their own concept onto this.
 */
export interface StoreVectorHealth {
  /** Version the server offers, or `null` when it offers none. */
  available: string | null;
  /** Version installed in this database, or `null` when it is not installed. */
  installed: string | null;
}

/**
 * Result of a health probe. Expected failures are values, never exceptions
 * (see Conventions: Core returns coded values and reserves throwing for bugs).
 */
export type StoreHealth =
  | {
      ok: true;
      serverVersion: string;
      vector: StoreVectorHealth;
    }
  | {
      ok: false;
      code: 'DB_UNAVAILABLE';
      message: string;
    };

/**
 * The persistence port. Story 1 only needs a health probe and a teardown;
 * later stories widen this port but keep `checkHealth` and `close`.
 */
export interface Store {
  /** Probe the store. Never throws: unreachable stores come back as `ok: false`. */
  checkHealth(): Promise<StoreHealth>;
  /** Release every resource the store holds. */
  close(): Promise<void>;
}
