import type { SchemaVersion } from '../../domain/schema-version.js';
import type { ReadSchemaVersionResult, SchemaStore } from '../../ports/store.js';

/** 2026-01-01T00:00:00Z, so the default `appliedAt` is reproducible. */
const DEFAULT_APPLIED_AT = new Date('2026-01-01T00:00:00.000Z');

export interface MemorySchemaStoreOptions {
  /**
   * Version the fake database is at. `null` means it holds no version row,
   * which is what an unmigrated database looks like. Defaults to `1`.
   */
  version?: number | null;
  /** When that version was applied. Defaults to a fixed instant. */
  appliedAt?: Date;
  /**
   * Answer with this instead, for the unreachable case. Overrides `version`.
   */
  result?: ReadSchemaVersionResult;
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
  const answer: ReadSchemaVersionResult = result ?? { ok: true, version: stored };

  let closes = 0;
  let reads = 0;

  return {
    async readSchemaVersion(): Promise<ReadSchemaVersionResult> {
      reads += 1;
      // A fresh value every call, so a caller cannot move the fake's state.
      if (!answer.ok) return { ...answer };
      return {
        ok: true,
        version:
          answer.version === null
            ? null
            : { version: answer.version.version, appliedAt: new Date(answer.version.appliedAt) },
      };
    },

    async close(): Promise<void> {
      closes += 1;
    },

    closes: () => closes,
    reads: () => reads,
  };
}
