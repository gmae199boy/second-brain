import type { ExtensionStore } from '../ports/store.js';
export async function extensionStatus({ store }: { store: ExtensionStore }, { name }: { name: string }) {
  const result = await store.getExtension(name);
  if (!result.ok) return result;
  const python = await store.getExtensionPythonEnvironment(name);
  if (!python.ok) return python;
  const journal = await store.getExtensionInstallProgress(name);
  return journal.ok ? { ok: true as const, name, extension: result.extension, pythonEnvironment: python.environment, progress: journal.journal?.progress ?? null } : journal;
}
export async function listExtensions({ store }: { store: ExtensionStore }) { return store.listExtensions(); }
