import type { SchemaVersion } from '../../domain/schema-version.js';
import type { ReadSchemaVersionsResult, SchemaStore } from '../../ports/store.js';

/** 2026-01-01T00:00:00Z, so the default `appliedAt` is reproducible. */
const DEFAULT_APPLIED_AT = new Date('2026-01-01T00:00:00.000Z');

export interface MemorySchemaStoreOptions {
  /**
   * Version the fake database is at. `null` means it holds no version row,
   * which is what an unmigrated database looks like. Defaults to `1`.
   */
  version?: number | null;
  versions?: Readonly<Record<string, SchemaVersion>>;
  /** When that version was applied. Defaults to a fixed instant. */
  appliedAt?: Date;
  /**
   * Answer with this instead, for the unreachable case. Overrides `version`.
   */
  result?: ReadSchemaVersionsResult;
}

export interface MemorySchemaStore extends SchemaStore {
  /** How many times the owning test's subject was closed. */
  closes(): number;
  /** How many times the version was read. */
  reads(): number;
}

/**
 * The in-memory `SchemaStore`: what the write guard is measured against. Like
 * every fake in here it only ever answers with values the caller supplied
 * (AD-1), and it never throws, because the contract forbids it.
 */
export function memorySchemaStore(options: MemorySchemaStoreOptions = {}): MemorySchemaStore {
  const { version = 1, appliedAt = DEFAULT_APPLIED_AT, result } = options;

  const stored: SchemaVersion | null =
    version === null ? null : { version, appliedAt: new Date(appliedAt.getTime()) };
  const answer: ReadSchemaVersionsResult = result ?? { ok: true, versions: options.versions ?? (stored === null ? {} : { core: stored }) };

  let closes = 0;
  let reads = 0;

  return {
    async readSchemaVersions(): Promise<ReadSchemaVersionsResult> {
      reads += 1;
      // A fresh value every call, so a caller cannot move the fake's state.
      if (!answer.ok) return { ...answer };
      return {
        ok: true,
        versions: Object.fromEntries(Object.entries(answer.versions).map(([owner, value]) =>
          [owner, { version: value.version, appliedAt: new Date(value.appliedAt) }])),
      };
    },

    async close(): Promise<void> {
      closes += 1;
    },

    closes: () => closes,
    reads: () => reads,
  };
}
