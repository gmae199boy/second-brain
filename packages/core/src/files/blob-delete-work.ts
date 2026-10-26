import type { Clock } from '../ports/clock.js';
import type { FileStore } from '../ports/file-store.js';
import type { AddWorkInput, AttachmentStore, WorkStore } from '../ports/store.js';
import type { WorkHandler } from '../queue/drain.js';

/**
 * The third kind of work Core owns: delete the bytes at one place and record
 * that they have gone (AD-7, AD-23).
 *
 * The target is a *place* and not a file. The same content has as many places as
 * there are copies of it — Brain's own blob, the user's original, a copy in
 * Drive — and only one of them is ever Brain's to delete, so a piece of work
 * about "this file" could not say which bytes it meant (Design Notes).
 *
 * What it does not do is decide whether the bytes *should* go. Hiding a file and
 * moving one to Drive are the two things that have a reason to delete a blob, and
 * both of them know things this handler cannot: which copy has been verified,
 * and whether the user asked for the original to be forgotten. So they put the
 * item on the queue and this does the deleting — outside every transaction,
 * because a write lock held over a filesystem call is the thing AD-7 exists to
 * prevent.
 */

/** The kind, as `work_items.kind` spells it. */
export const BLOB_DELETE_KIND = 'blob_delete';

/** The target kind: `work_items.target_id` is a `file_locations.id`. */
export const FILE_LOCATION_TARGET_KIND = 'file_location';

/**
 * The codes this handler names itself, and deliberately not rows of the code
 * table (`codes.ts`), for the reason `files/extract-work.ts` gives: a code in
 * that table is something a command tells a person to do about it, and these two
 * are the classification of one failed deletion as `brain failures list` shows
 * it.
 *
 * `FILE_LOCATION_NOT_FOUND` is a place nothing answers to. Rows of
 * `file_locations` are never deleted (0002), so the id was never a place: the
 * bug is in whatever queued it, and the record is how anybody finds out.
 *
 * `LOCATION_REFUSED` is a place this build may not touch — somebody else's file,
 * a copy in Drive, or a locator the `FileStore` will not accept. It is the
 * `FileStore` port's own code, used for the handler's own refusal as well,
 * because to a person reading the record the two are one answer: the bytes were
 * left alone.
 */
export const FILE_LOCATION_NOT_FOUND = 'FILE_LOCATION_NOT_FOUND';
export const LOCATION_REFUSED = 'LOCATION_REFUSED';

export interface BlobDeleteWorkInput {
  /** The id to give the new queue row. The caller mints it (AD-8). */
  id: string;
  /** The place whose bytes are to go: a `file_locations.id`. */
  locationId: string;
  /** When it was asked for, read once from `Clock` (AD-13). */
  at: Date;
}

/**
 * One `blob_delete` item, as the side that wants the bytes gone writes it.
 *
 * It exists so that the enqueueing paths — hiding a file, moving one to Drive —
 * name the kind and the target kind in one place rather than each spelling the
 * two strings out. Due at once, because a deletion somebody asked for is wanted
 * now and the drain at the end of that command is what does it (AD-7).
 */
export function blobDeleteWork({ id, locationId, at }: BlobDeleteWorkInput): AddWorkInput {
  return {
    id,
    kind: BLOB_DELETE_KIND,
    targetKind: FILE_LOCATION_TARGET_KIND,
    targetId: locationId,
    createdAt: at,
    nextAttemptAt: at,
  };
}

export interface BlobDeleteWorkDependencies {
  store: Pick<AttachmentStore, 'readFileLocation' | 'markFileLocationDeleted'> &
    Pick<WorkStore, 'resolveFailures'>;
  /** Brain's copy of the bytes. Deleted outside every transaction (AD-7). */
  files: Pick<FileStore, 'delete'>;
  clock: Clock;
}

/**
 * The handler for one `blob_delete` item.
 *
 * The order of the steps is the contract, and each one is there because the step
 * after it would otherwise be wrong:
 *
 *   1. read the place. An id nothing answers to is recorded at once and never
 *      retried: the rows are never deleted, so no later attempt would find it.
 *   2. a place already marked is done, and the `FileStore` is *not* called. The
 *      store is content addressed, so the same bytes collected again revive the
 *      same locator — and an item about a place that was emptied once must not
 *      delete somebody else's new blob (Design Notes).
 *   3. refuse anything that is not Brain's own local copy, before the call and
 *      not after it: a user's own file and a copy in Drive are not this build's
 *      to delete, and the cheapest way to honour that is never to ask.
 *   4. delete the bytes. `deleted: false` — nothing there — counts as success,
 *      because the state it leaves is the state this item wanted.
 *   5. mark the place, which is the second half of one deletion and happens
 *      *after* the bytes have gone. The other order would leave a blob that is
 *      recorded as deleted and that nothing, not even an orphan sweep, would
 *      ever look for (Design Notes). The in-between state — bytes gone, nothing
 *      recorded — is harmless: the next drain finds `deleted: false` and
 *      finishes the marking.
 *   6. close whatever this place's deletion failures were.
 *
 * What the drain then does with the answer is `queue/drain.ts`'s: a store that
 * is briefly away says `retryable: true` and waits, a refusal says `false` and
 * is recorded on the spot, and a database that would not take the mark hands its
 * own code back so the item is released with its attempt returned (AD-21).
 */
export function blobDeleteHandler({ store, files, clock }: BlobDeleteWorkDependencies): WorkHandler {
  return async (item) => {
    const id = item.targetId;

    const read = await store.readFileLocation(id);
    if (!read.ok) {
      if (read.code === FILE_LOCATION_NOT_FOUND) {
        return { ok: false, code: read.code, message: read.message, retryable: false };
      }
      // A read the database could not answer, under its own code: the item is
      // released with its attempt returned and the next drain asks again.
      return { ok: false, code: read.code, message: read.message };
    }
    const location = read.location;

    // `resolveFailures` here too, and not only on the path that deletes: the
    // closing of the records is dropped when it fails, so the attempt that
    // emptied this place may have left an open row behind. This is the only
    // thing a `failures retry` item about it can then do, and calling it twice
    // costs one zero-row write.
    if (location.deletedAt !== null) {
      await resolve(store, clock, id);
      return { ok: true };
    }

    if (location.storeKind !== 'local' || location.ownership !== 'brain') {
      return {
        ok: false,
        code: LOCATION_REFUSED,
        message: `${location.storeKind}·${location.ownership} 위치의 바이트는 지우지 않습니다`,
        retryable: false,
      };
    }

    const deleted = await files.delete({
      storeKind: location.storeKind,
      locator: location.locator,
      ownership: location.ownership,
    });
    if (!deleted.ok) {
      // A store that is there but cannot answer right now is somebody else's
      // hiccup: the item waits and tries again (AD-21). A location the port will
      // not accept — outside the root, through a link, or past its syntax — is
      // recorded at once, and the bytes it was pointing at are left untouched.
      return deleted.code === 'FILES_UNAVAILABLE'
        ? { ok: false, code: deleted.code, message: deleted.message, retryable: true }
        : { ok: false, code: deleted.code, message: deleted.message, retryable: false };
    }

    const marked = await store.markFileLocationDeleted({ id, deletedAt: clock.now() });
    if (!marked.ok) {
      // Under its own code, so a database that would not take the write releases
      // the item instead of spending an attempt. The bytes are already gone, so
      // the next drain's `delete` answers `deleted: false` and the marking is
      // the only thing left to do — the one place this handler is idempotent by
      // the file store's own answer rather than by a row.
      return { ok: false, code: marked.code, message: marked.message };
    }

    await resolve(store, clock, id);
    return { ok: true };
  };
}

/**
 * Close whatever this place's deletion failures were, because the bytes finally
 * went.
 *
 * Dropped if it does not work, exactly as the extraction handler drops it: the
 * deletion succeeded, and a bookkeeping row that could not be closed must not
 * turn it into work that is done again. The next success or `failures retry`
 * closes it.
 */
async function resolve(
  store: Pick<WorkStore, 'resolveFailures'>,
  clock: Clock,
  locationId: string,
): Promise<void> {
  try {
    await store.resolveFailures({
      targetKind: FILE_LOCATION_TARGET_KIND,
      targetId: locationId,
      stage: BLOB_DELETE_KIND,
      now: clock.now(),
    });
  } catch {
    // As above.
  }
}
