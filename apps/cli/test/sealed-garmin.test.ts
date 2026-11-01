import { expect, it } from 'vitest';
import type { ProtectedLaunch, WorkItem } from 'second_brain';
import { SEALED_GARMIN_WORKER, sealedGarminLaunches } from '../src/daemon/sealed-garmin.js';

it('봉인 registry는 검증 실패를 닫고 실행 경로·인자·환경을 고정한다', async () => {
  let verified = false, seen = '';
  const ports = {
    async verifyInstalledWorker(path) { seen = path; return verified; },
    async snapshot() { return '{"version":1,"extension":"garmin","values":{}}'; },
    async admit() { return { ok: true, admitted: true }; },
    async release() { return { ok: true, released: true }; },
    bootstrap: { async authorize() { return false; } },
    command: '/tmp/attacker', PATH: '/tmp', url: 'postgres://attacker',
  };
  const launches = sealedGarminLaunches(ports);
  const launch: ProtectedLaunch = launches['garmin.auth']!;
  const item = { id: 'fixture', kind: 'garmin.auth', targetKind: 'extension', targetId: 'garmin', attempts: 1 } as WorkItem;
  expect(await launch.prepare(item, 'attempt')).toEqual({ ok: false, code: 'EXTENSION_CONFIG_INVALID' });
  expect(seen).toBe(SEALED_GARMIN_WORKER);
  verified = true;
  const result = await launch.prepare(item, 'attempt');
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.spec.command).toBe(SEALED_GARMIN_WORKER);
  expect(result.spec.args).toEqual([]);
  expect(result.spec.bootstrapPipe).toBe(true);
  expect(result.spec.env).not.toHaveProperty('BRAIN_DATABASE_URL');
  expect(result.spec.env).not.toHaveProperty('PATH');
  expect(result.spec.env).not.toHaveProperty('url');
  expect(Object.isFrozen(launches)).toBe(true);
  expect(Object.isFrozen(launch)).toBe(true);
  expect(await launch.prepare({ ...item, kind: 'garmin.collect' }, 'attempt')).toEqual({ ok: false, code: 'EXTENSION_CONFIG_INVALID' });
});
