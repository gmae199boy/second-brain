import type { ExtensionStore } from '../ports/store.js';
import { validInstallProgress } from './install-progress.js';

export const replacementRequired = () => ({ ok: false as const, code: 'EXTENSION_REPLACEMENT_REQUIRED' as const, message: '현재 형식의 호환 패키지를 ext install --package로 설치한 뒤 다시 실행하세요' });

/** Call while holding the extension installation lock when available. */
export async function checkExtensionExecution(store: Pick<ExtensionStore, 'readExtensionQuiesce' | 'getExtensionInstallProgress'>, name: string, gateKind: 'command' | 'install' = 'install') {
  const gate = await store.readExtensionQuiesce(name);
  if (!gate.ok) return gate;
  const result = await store.getExtensionInstallProgress(name);
  if (!result.ok) return result;
  if (result.journal && validInstallProgress(result.journal.progress) && result.journal.progress.name === name && result.journal.progress.replacement) return replacementRequired();
  if (gate.owner !== null) return gateKind === 'command' ? { ok: false as const, code: 'EXTENSION_COMMAND_UNAVAILABLE' as const, message: '확장 명령을 실행할 수 없습니다' } : { ok: false as const, code: 'DB_LOCKED' as const, message: '중단된 확장 설치를 같은 패키지로 복구한 뒤 다시 실행하세요' };
  return { ok: true as const };
}
