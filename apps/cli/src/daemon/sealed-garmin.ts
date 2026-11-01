import type { ProtectedLaunch, WorkItem } from 'second_brain';

// [ASSUMPTION] 설치 후보 경로다. D1의 봉인 설치와 검증 전에 활성화하지 않는다.
export const SEALED_GARMIN_WORKER = '/Library/Application Support/SecondBrain/libexec/garmin-worker';

type Admit = NonNullable<ProtectedLaunch['admit']>;
type Release = NonNullable<ProtectedLaunch['releaseAdmission']>;
type Bootstrap = NonNullable<ProtectedLaunch['bootstrap']>;

/** 보호 서비스가 소유하는 port만 받는다. 사용자 manifest와 URL은 입력이 아니다. */
export interface SealedGarminPorts {
  verifyInstalledWorker(path: typeof SEALED_GARMIN_WORKER): Promise<boolean>;
  snapshot(kind: 'garmin.auth' | 'garmin.collect', item: WorkItem): Promise<string>;
  admit: Admit;
  release: Release;
  bootstrap: Bootstrap;
}

/** 실제 서명·peer verifier가 연결되기 전에는 호출 가능한 보호 서비스가 없다. */
export function sealedGarminLaunches(ports: SealedGarminPorts): Readonly<Record<string, ProtectedLaunch>> {
  const { verifyInstalledWorker, snapshot, admit, release } = ports;
  const authorize = ports.bootstrap.authorize;
  const make = (kind: 'garmin.auth' | 'garmin.collect'): ProtectedLaunch => Object.freeze<ProtectedLaunch>({
    extension: 'garmin', declarations: Object.freeze({ 'garmin.tokenstore': 'string', 'garmin.timezone': 'string' }), errorCodes: Object.freeze(['AUTH_PEER_UNVERIFIED', 'COLLECT_INVALID', 'COLLECT_INVALID_ATTEMPT', 'COLLECT_CLIENT_UNAVAILABLE', 'COLLECT_STOPPED']),
    async prepare(item, token) {
      if (item.kind !== kind || !(await verifyInstalledWorker(SEALED_GARMIN_WORKER))) return { ok: false, code: 'EXTENSION_CONFIG_INVALID' };
      const settings = await snapshot(kind, item);
      return { ok: true, spec: { bootstrapPipe: true, command: SEALED_GARMIN_WORKER, args: [], env: {
        BRAIN_ABI_VERSION: '1', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token,
        BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId,
        BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: settings,
      } } };
    },
    ...(kind === 'garmin.auth' ? { requiresInputChannel: true } : {}),
    admit, releaseAdmission: release, bootstrap: Object.freeze({ authorize }),
  });
  return Object.freeze({ 'garmin.auth': make('garmin.auth'), 'garmin.collect': make('garmin.collect') });
}
