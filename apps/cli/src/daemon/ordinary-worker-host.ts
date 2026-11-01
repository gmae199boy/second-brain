import type { ProcessLauncher, SupervisorOptions, WorkItem } from 'second_brain';

type Host = NonNullable<NonNullable<SupervisorOptions['sealedService']>['ordinaryWorkerHost']>;
interface Peer { uid: number; pid: number; startId: string; session: string }
/** 같은 연결의 OS 신원 증거와 사용자 principal 실행만 제공한다. */
export interface NativeOrdinaryHost {
  peer(): Promise<Peer>;
  kinds(): Promise<readonly string[]>;
  start(input: { id: string; token: string; kind: string; targetKind: string; targetId: string; generation: number }): ReturnType<ProcessLauncher['start']>;
}

/** 검증되지 않은 host는 일반 일감을 청구하지 않는다. OS 검증 구현은 D4에서 연결한다. */
export function ordinaryWorkerHost(options: {
  native?: NativeOrdinaryHost;
  expectedUid: number;
  supervisorUid: number;
  verifyPeer(peer: Peer): Promise<boolean>;
  protectedExtensions: readonly string[];
}): Host {
  // session 문자열은 재연결 감지용이며 OS 신원 증거가 아니다. D4가 같은 연결을 고정한다.
  let pinnedPeer: Peer | undefined;
  let allowed = new Set<string>();
  const verified = async (): Promise<boolean> => {
    if (!options.native || !Number.isSafeInteger(options.expectedUid) || options.expectedUid <= 0
      || options.expectedUid === options.supervisorUid) return false;
    const peer = await options.native.peer();
    if (peer.uid !== options.expectedUid || !Number.isSafeInteger(peer.pid) || peer.pid <= 0 || !peer.session
      || !peer.startId || !(await options.verifyPeer(peer))
      || (pinnedPeer !== undefined && (pinnedPeer.uid !== peer.uid || pinnedPeer.pid !== peer.pid || pinnedPeer.startId !== peer.startId || pinnedPeer.session !== peer.session))) return false;
    pinnedPeer = { ...peer };
    return true;
  };
  return {
    async kinds() {
      try {
        if (!(await verified()) || !options.native) { allowed = new Set(); return []; }
        const result = await options.native.kinds();
        allowed = new Set(result.filter(kind => typeof kind === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(kind)
          && !options.protectedExtensions.some(extension => kind.startsWith(`${extension}.`))));
        return [...allowed];
      } catch { allowed = new Set(); return []; }
    },
    async start(item: WorkItem, token: string) {
      try {
        if (!allowed.has(item.kind) || !(await verified()) || !options.native) return { ok: false, message: '비특권 실행 경계를 확인할 수 없습니다' };
        return await options.native.start({ id: item.id, token, kind: item.kind, targetKind: item.targetKind, targetId: item.targetId, generation: item.attempts });
      } catch { return { ok: false, message: '비특권 실행 경계를 확인할 수 없습니다' }; }
    },
  };
}
