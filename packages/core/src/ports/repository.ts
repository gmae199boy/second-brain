/**
 * What a working folder turns out to be part of. The three facts the identity
 * of AD-12 is made from, and nothing else: Core has no git and no filesystem,
 * so whoever implements this port is the only side that knows how to ask.
 */
export interface Checkout {
  /**
   * The URL of the remote this checkout was cloned from, as git prints it, or
   * `null` for a repository with no remote. It is handed over raw — it may
   * carry a user and a password — because normalizing it is Core's one
   * function's job (`normalizeRemoteIdentity`), not the adapter's.
   */
  remoteUrl: string | null;
  /**
   * The absolute path of the git common directory: the one directory every
   * worktree of the same repository shares. It is the identity of a repository
   * with no remote, which is what makes two worktrees of a local-only clone one
   * project (AD-12).
   */
  commonDir: string;
  /**
   * The absolute path of the top of this working folder. A session opened in a
   * sub-folder belongs to the top, not to the sub-folder.
   */
  worktreePath: string;
}


export type InspectUnknownReason = 'git_missing' | 'timeout' | 'permission' | 'unexpected';

export type InspectResult =
  | { kind: 'checkout'; checkout: Checkout }
  | { kind: 'not_repository' }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: InspectUnknownReason; message: string };

export type FolderListing =
  | { kind: 'listed'; folders: readonly string[] }
  | { kind: 'missing' }
  | Extract<InspectResult, { kind: 'unknown' }>;

/** Capture proceeds when git cannot answer; unknown results need deferred work. */
export interface RepositoryInspector {
  /** Answers with a value and never throws. */
  inspect(cwd: string): Promise<InspectResult>;
  /** Immediate directories, following links, in path order. Never throws. */
  listFolders(path: string): Promise<FolderListing>;
}
