import { expect, it } from 'vitest';
import type { WorkItem } from 'second_brain';
import { ordinaryWorkerHost } from '../src/daemon/ordinary-worker-host.js';

it('비특권 host는 OS 검증을 요구하고 보호 kind와 세션 교체를 거부한다', async () => {
  let session = 'one', pid = 42, accepted = false, starts = 0;
  let request: unknown;
  const host = ordinaryWorkerHost({ expectedUid: 501, supervisorUid: 502, protectedExtensions: ['garmin'],
    async verifyPeer() { return accepted; }, native: {
      async peer() { return { uid: 501, pid, startId: 'fixture-start', session }; },
      async kinds() { return ['demo.work', 'garmin.auth']; },
      async start(input) { request = input; starts++; return { ok: false, message: 'fixture' }; },
    },
  });
  const item = { id: 'work', kind: 'demo.work', targetKind: 'test', targetId: 'target', attempts: 1 } as WorkItem;
  expect(await host.kinds()).toEqual([]);
  accepted = true;
  expect(await host.kinds()).toEqual(['demo.work']);
  expect(await host.start({ ...item, kind: 'garmin.auth' }, 'token')).toMatchObject({ ok: false });
  expect(await host.start(item, 'token')).toEqual({ ok: false, message: 'fixture' });
  expect(request).toEqual({ id: 'work', token: 'token', kind: 'demo.work', targetKind: 'test', targetId: 'target', generation: 1 });
  pid = 43;
  expect(await host.start(item, 'token')).toMatchObject({ ok: false });
  pid = 42; session = 'replaced';
  expect(await host.start(item, 'token')).toMatchObject({ ok: false });
  expect(starts).toBe(1);
});

it('동일 principal과 미연결 host는 일감을 청구하지 않는다', async () => {
  const host = ordinaryWorkerHost({ expectedUid: 501, supervisorUid: 501, protectedExtensions: [], async verifyPeer() { return true; } });
  expect(await host.kinds()).toEqual([]);
});
