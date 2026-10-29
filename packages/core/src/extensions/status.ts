import type { ExtensionStore } from '../ports/store.js';
export async function extensionStatus({ store }: { store: ExtensionStore }, { name }: { name: string }) {
  const result = await store.getExtension(name);
  return result.ok ? { ok: true as const, name, extension: result.extension } : result;
}
export async function listExtensions({ store }: { store: ExtensionStore }) { return store.listExtensions(); }
