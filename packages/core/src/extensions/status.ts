import type { ExtensionStore } from '../ports/store.js';
export async function extensionStatus({ store }: { store: ExtensionStore }, { name }: { name: string }) {
  const result = await store.getExtension(name);
  if (!result.ok) return result;
  const python = await store.getExtensionPythonEnvironment(name);
  if (!python.ok) return python;
  const journal = await store.getExtensionInstallProgress(name);
  return journal.ok ? { ok: true as const, name, extension: result.extension ? { ...result.extension, connectionMessage: result.extension.connectionStatus === 'failed' ? '확장 실행에 실패했습니다' : null } : null, pythonEnvironment: python.environment, progress: journal.journal?.progress ?? null } : journal;
}
export async function listExtensions({ store }: { store: ExtensionStore }) {
  const list = await store.listExtensions();
  if (!list.ok) return list;
  const statuses = await Promise.all(list.extensions.map(row => store.getExtensionPublicStatus(row.name)));
  const failure = statuses.find(result => !result.ok);
  if (failure && !failure.ok) return failure;
  return { ok: true as const, extensions: statuses.flatMap(result => result.ok ? [result.status] : []) };
}

export async function publicExtensionStatus({ store }: { store: ExtensionStore }, { name }: { name: string }) {
  return store.getExtensionPublicStatus(name);
}
export async function setExtensionEnabled({ store, clock }: { store: ExtensionStore; clock: { now(): Date } }, input: { name: string; enabled: boolean }) {
  const result = await store.setExtensionEnabled({ ...input, now: clock.now() });
  if (!result.ok) return result;
  if (!result.found) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '설치된 확장이 없습니다' };
  return { ok: true as const, name: input.name, enabled: input.enabled, changed: result.changed };
}
