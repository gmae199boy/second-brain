import type { ProcessLauncher, ProcessSpec } from 'second_brain';
import { SEALED_GARMIN_WORKER } from './sealed-garmin.js';

/** OS 서비스가 인증된 요청을 전용 Garmin principal로 넘기는 port다. */
export interface SealedNativeLauncher {
  startGarmin(spec: ProcessSpec): ReturnType<ProcessLauncher['start']>;
}

const envKeys = ['BRAIN_ABI_VERSION', 'BRAIN_WORK_ID', 'BRAIN_ATTEMPT_TOKEN', 'BRAIN_WORK_KIND', 'BRAIN_TARGET_KIND', 'BRAIN_TARGET_ID', 'BRAIN_RUN_GENERATION', 'BRAIN_SETTINGS_SNAPSHOT'].sort();

/** 보호 경계 미연결 시 닫힌다. 일반 확장이나 임의 실행 명세는 전달하지 않는다. */
export function sealedProcessLauncher(native?: SealedNativeLauncher): ProcessLauncher {
  return {
    async start(spec) {
      const keys = Object.keys(spec.env).sort();
      if (!native || spec.command !== SEALED_GARMIN_WORKER || spec.cwd !== undefined || spec.bootstrapPipe !== true
        || spec.args.length !== 0 || keys.length !== envKeys.length || !keys.every((key, index) => key === envKeys[index])
        || (spec.env['BRAIN_WORK_KIND'] !== 'garmin.auth' && spec.env['BRAIN_WORK_KIND'] !== 'garmin.collect')) {
        return { ok: false, message: '보호 실행 경계를 확인할 수 없습니다' };
      }
      try {
        // mutable 사용자 명세의 후속 교체를 방지한다. backend는 OS peer를 다시 검증한다.
        return await native.startGarmin(Object.freeze({ bootstrapPipe: true, command: SEALED_GARMIN_WORKER,
          args: Object.freeze([]), env: Object.freeze({ ...spec.env }) }));
      } catch { return { ok: false, message: '보호 실행 경계를 확인할 수 없습니다' }; }
    },
  };
}
