/**
 * Somebody a session belongs to. In slice 1 there is exactly one row and it is
 * me: `sessions.user_id` points at it, so the question "whose turn was this?"
 * has an answer in the database rather than in a convention (AD-12).
 *
 * The row is created by the installer, not by a migration: a migration cannot
 * read the operating system's user name and cannot mint a UUIDv7. It travels
 * with the database — a brain copied to another machine keeps its owner — and
 * merging two brains is epic 5's import, which maps the incoming "me" onto the
 * receiving one.
 */
export interface User {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** The operating system user name the installer found. Never updated here. */
  name: string;
  /** The owner of this brain. At most one row may have it (AD-12). */
  isSelf: boolean;
  createdAt: Date;
}
