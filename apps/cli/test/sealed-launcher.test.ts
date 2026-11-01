import { expect, it } from 'vitest';
import type { ProcessSpec } from 'second_brain';
import { sealedProcessLauncher } from '../src/daemon/sealed-launcher.js';
import { SEALED_GARMIN_WORKER } from '../src/daemon/sealed-garmin.js';

it('보호 launcher는 임의 실행물·환경·일반 확장을 전용 principal로 넘기지 않는다', async () => {
  let calls = 0;
  const launcher = sealedProcessLauncher({ async startGarmin(spec) { calls++; expect(Object.isFrozen(spec.env)).toBe(true); return { ok: false, message: 'fixture' }; } });
  const spec: ProcessSpec = { bootstrapPipe: true, command: SEALED_GARMIN_WORKER, args: [], env: {
    BRAIN_ABI_VERSION: '1', BRAIN_WORK_ID: 'work', BRAIN_ATTEMPT_TOKEN: 'attempt', BRAIN_WORK_KIND: 'garmin.auth',
    BRAIN_TARGET_KIND: 'extension', BRAIN_TARGET_ID: 'garmin', BRAIN_RUN_GENERATION: '1', BRAIN_SETTINGS_SNAPSHOT: '{}',
  } };
  for (const input of [{ ...spec, command: '/tmp/attacker' }, { ...spec, args: ['fixture'] }, { ...spec, cwd: '/tmp' }, { ...spec, env: { ...spec.env, PATH: '/tmp' } }, { ...spec, env: { ...spec.env, BRAIN_WORK_KIND: 'other.work' } }]) {
    expect(await launcher.start(input)).toMatchObject({ ok: false });
  }
  expect(calls).toBe(0);
  expect(await sealedProcessLauncher().start(spec)).toMatchObject({ ok: false });
  expect(await launcher.start(spec)).toEqual({ ok: false, message: 'fixture' });
  expect(calls).toBe(1);
});
