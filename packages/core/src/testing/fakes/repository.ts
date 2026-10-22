import type { Checkout, FolderListing, InspectResult, RepositoryInspector } from '../../ports/repository.js';

export interface MemoryRepositories extends RepositoryInspector {
  setFolders(path: string, result: FolderListing): void;
  inspects(): readonly string[];
  set(cwd: string, result: Checkout | InspectResult): void;
}

/** Mutable answers allow a test to restore git between capture and drain. */
export function memoryRepositories(
  checkouts: Readonly<Record<string, Checkout | InspectResult>> = {},
): MemoryRepositories {
  const known = new Map<string, Checkout | InspectResult>(Object.entries(checkouts));
  const listings = new Map<string, FolderListing>();
  const asked: string[] = [];
  return {
    async listFolders(path) { return listings.get(path) ?? { kind: 'listed', folders: [] }; },
    setFolders: (path, result) => { listings.set(path, result); },
    async inspect(cwd): Promise<InspectResult> {
      asked.push(cwd);
      const result = known.get(cwd);
      if (result === undefined) return { kind: 'not_repository' };
      return 'kind' in result ? result : { kind: 'checkout', checkout: result };
    },
    set: (cwd, result) => { known.set(cwd, result); },
    inspects: () => [...asked],
  };
}
