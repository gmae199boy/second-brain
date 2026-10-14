/**
 * How long a write may wait for the database-wide write lock before it gives up
 * (AD-7). The numbers live in Core, not in the adapter, because the right
 * budget is a property of the calling path rather than of SQLite: the driver is
 * synchronous, so waiting for the lock blocks the whole process, and a hook
 * that runs on every turn cannot afford what a one-off command can.
 */
export const BUSY_TIMEOUT_MS = {
  /**
   * A hook on the critical path of a turn. Short on purpose: the person is
   * waiting, and a write that cannot get in goes to the spool (AD-9).
   */
  turn: 3000,
  /** A command the person ran and is watching. It may wait. */
  command: 10_000,
  /** The background drain. Nobody is waiting on it, so it waits instead. */
  drain: 10_000,
} as const;

/** The calling paths that have a budget of their own. */
export type BusyTimeoutPath = keyof typeof BUSY_TIMEOUT_MS;
