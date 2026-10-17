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

/**
 * Asking git what a folder is, as a port (AD-1).
 *
 * Its shape is `TranscriptReader`'s: it answers with a value and never throws.
 * `null` is not a failure here — a folder that is not a repository, a path that
 * is gone, a bare repository, a machine with no git, a call that took too long:
 * every one of them means the same thing to the caller, which is that this
 * session gets no tags and is ingested anyway (Decision 2026-10-18). Capture
 * comes before the tags.
 */
export interface RepositoryInspector {
  /** What the folder is part of, or `null`. Never throws. */
  inspect(cwd: string): Promise<Checkout | null>;
}
