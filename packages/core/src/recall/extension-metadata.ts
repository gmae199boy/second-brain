import { isExtensionName } from '../extensions/manifest.js';
import type { ExtensionPublicStatus, ExtensionStore } from '../ports/store.js';
import type { EnvelopeMeta, ExtensionMetadata } from '../envelope.js';

type StatusStore = Pick<ExtensionStore, 'listExtensionInventory' | 'getExtensionPublicStatus'>;
export function extensionMetadata(status: ExtensionPublicStatus): ExtensionMetadata {
  const work_state = status.replacementRequired ? 'replacement_required' : status.quiesced ? 'quiesced' : status.interruptedWorkCount > 0 ? 'interrupted' : status.heldScheduleCount > 0 ? 'held' : status.failedStage || status.installResult === 'failed' ? 'failed' : Object.values(status.stages).some(stage => stage?.status === 'pending') ? 'pending' : 'unknown';
  return { source: status.name, installed: status.installed, enabled: status.enabled, searchable: status.installed ? true : null, work_state };
}

/** Only the registry's public projection enters response metadata. */
export async function withExtensionMetadata<T extends { ok: boolean; meta?: EnvelopeMeta }>(store: StatusStore, result: T, sources: readonly string[] = []): Promise<(T & { meta?: EnvelopeMeta }) | { ok: false; code: string; message: string; meta?: EnvelopeMeta }> {
  if (!Array.isArray(sources) || sources.some(name => typeof name !== 'string' || !isExtensionName(name))) return result.ok ? { ok:false, code:'INVALID_ARGUMENT', message:'확장 source가 올바르지 않습니다' } : result;
  const inventory = await store.listExtensionInventory();
  if (!inventory.ok) return result.ok ? inventory : result;
  const names = [...new Set([...sources, ...inventory.names])].sort();
  const extensions: ExtensionMetadata[] = [];
  for (const name of names) {
    const found = await store.getExtensionPublicStatus(name);
    if (!found.ok) {
      if (result.ok) return found;
      return extensions.length ? { ...result, meta: { ...result.meta, extensions } } : result;
    }
    extensions.push(extensionMetadata(found.status));
  }
  return { ...result, meta: { ...result.meta, extensions } };
}
