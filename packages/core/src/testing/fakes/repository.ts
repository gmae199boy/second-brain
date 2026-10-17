import type { Checkout, RepositoryInspector } from '../../ports/repository.js';

export interface MemoryRepositories extends RepositoryInspector {
  /** Every cwd `inspect` was asked about, in order. */
  inspects(): readonly string[];
}

/**
 * A `RepositoryInspector` over a map from cwd to checkout, so the ingest use
 * case can be driven with no git and no filesystem (AD-1).
 *
 * A cwd nobody put in the map is the "not a repository" row of the matrix, and
 * it answers `null` rather than throwing, exactly as the real one does. It
 * counts the calls because the rule worth proving is not only what the tags
 * come out as but *how often git is asked*: once, on the ingest that creates
 * the session, and never again (AD-12).
 */
export function memoryRepositories(
  checkouts: Readonly<Record<string, Checkout>> = {},
): MemoryRepositories {
  const known = new Map<string, Checkout>(Object.entries(checkouts));
  const asked: string[] = [];

  return {
    async inspect(cwd: string): Promise<Checkout | null> {
      asked.push(cwd);
      return known.get(cwd) ?? null;
    },
    inspects: () => [...asked],
  };
}
