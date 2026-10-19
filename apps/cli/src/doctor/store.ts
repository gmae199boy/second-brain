import type { SchemaStore, Store } from 'second_brain';

/**
 * The store a `diagnostic` command gets when the configuration could not be
 * read. It answers `DB_UNAVAILABLE` to everything, because that is the honest
 * answer: the file that says where the database is could not be read, so there
 * is no database to reach and none to go looking for either.
 *
 * It exists so that one broken configuration file produces one report with
 * every machine check in it, rather than an `exit 2` that says nothing about
 * the shim or the node (Decision 2026-10-14). Nothing is opened and nothing is
 * created — a doctor that made a database would report a brain nobody
 * installed (AD-20).
 *
 * It answers the session, identity and queue capabilities too, with the same
 * code. They are not there for `doctor run`, which asks for none of them: they
 * are there because `createBrain` takes one `Store`, and a type that let this
 * stand in for only part of it would mean two kinds of store to assemble a brain
 * from (AD-10). The opportunistic drain at the end of a command never reaches
 * them either — it does not run without a configuration (`dispatch.ts`) — and
 * `DB_UNAVAILABLE` is what it would be told if it did.
 */
export function failedConfigStore(message: string): Store & SchemaStore {
  const unavailable = { ok: false as const, code: 'DB_UNAVAILABLE' as const, message };
  return {
    async checkHealth() {
      return unavailable;
    },
    async readSchemaVersion() {
      return unavailable;
    },
    async ensureSelfUser() {
      return unavailable;
    },
    async readSelfUser() {
      return unavailable;
    },
    async ensureSession() {
      return unavailable;
    },
    async findSession() {
      return unavailable;
    },
    async ingest() {
      return unavailable;
    },
    async readSession() {
      return unavailable;
    },
    async addWork() {
      return unavailable;
    },
    async hasDueWork() {
      return unavailable;
    },
    async claimWork() {
      return unavailable;
    },
    async completeWork() {
      return unavailable;
    },
    async retryWork() {
      return unavailable;
    },
    async releaseWork() {
      return unavailable;
    },
    async recordFailure() {
      return unavailable;
    },
    async close() {
      // Nothing was ever opened.
    },
  };
}
