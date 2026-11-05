import type { ExtensionStore } from '../ports/store.js';
import type { Timer } from '../ports/clock.js';
import { isExtensionName } from './manifest.js';

/** The caller persists owner before entering and holds the extension command lock. */
export async function quiesceExtension(store: ExtensionStore, timer: Timer, input: { name: string; owner: string; now: Date; signal?: AbortSignal; refuseRunning?: boolean }) {
  if (!isExtensionName(input.name) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.owner)) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 정지 소유권이 올바르지 않습니다' };
  if (input.signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 정지 대기가 취소되었습니다' };
  const started = await store.beginExtensionQuiesce(input); if (!started.ok) return started;
  if (!started.acquired) return { ok: false as const, code: 'DB_LOCKED' as const, message: '다른 설치가 확장을 정지했습니다' };
  for (;;) {
    if (input.signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 정지 대기가 취소되었습니다' };
    const state = await store.readExtensionQuiesce(input.name); if (!state.ok) return state;
    if (state.owner !== input.owner) return { ok: false as const, code: 'DB_LOCKED' as const, message: '확장 정지 소유권이 바뀌었습니다' };
    if (state.running === 0) return { ok: true as const };
    if (input.refuseRunning) return { ok: false as const, code: 'DB_LOCKED' as const, message: '미정산 확장 일감이 남았습니다. 정지 기록을 보존하고 기존 실행과 자식의 종료를 확인한 뒤 해당 일감을 정산할 수 있도록 복구하고 같은 설치를 다시 실행하세요.' };
    try { await timer.sleep(100, input.signal ?? new AbortController().signal); } catch { if (input.signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 정지 대기가 취소되었습니다' }; throw new Error('확장 정지 대기 실패'); }
  }
}
