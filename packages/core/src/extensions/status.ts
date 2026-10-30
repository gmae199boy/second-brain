import type { ExtensionStore } from '../ports/store.js';
export async function extensionStatus({ store }: { store: ExtensionStore }, { name }: { name: string }) {
  const result = await store.getExtension(name);
  if (!result.ok) return result;
  const python = await store.getExtensionPythonEnvironment(name);
  return python.ok ? { ok: true as const, name, extension: result.extension, pythonEnvironment: python.environment } : python;
}
export async function listExtensions({ store }: { store: ExtensionStore }) { return store.listExtensions(); }
