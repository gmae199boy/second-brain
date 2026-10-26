import type { AttachmentStore } from '../ports/store.js';
import type { IdGen } from '../ports/id-gen.js';

/** Derived names are retried by the next drain after any failure. */
export async function fillFileNames({ store, idGen }: { store: AttachmentStore; idGen: IdGen }): Promise<void> {
  const candidates = await store.listMissingFileNames({ limit: 500 });
  if (!candidates.ok || candidates.names.length === 0) return;
  await store.writeFileNames({ names: candidates.names.map(name => ({ ...name, id: idGen.next() })) });
}
