import { expect, it, vi } from 'vitest';
import type { ProcessInspector } from 'second_brain';
import { createNativeBridgeAdapter } from '../src/daemon/sealed-native-bridge.js';

it('일반 그룹 신호는 native bridge를 시작하지 않고 일반 inspector에 전달한다', async () => {
  const start = vi.fn(async () => { throw new Error('unexpected'); });
  const signalGroup = vi.fn(async () => 'sent' as const);
  const inspector: ProcessInspector = {
    bootTime: async () => ({ state: 'unknown' }),
    startedAt: async () => ({ state: 'unknown' }),
    groupMembers: async () => ({ state: 'unknown' }),
    signalGroup,
  };
  const adapter = createNativeBridgeAdapter(start, inspector);
  expect(await adapter.inspector.signalGroup(123, 'SIGTERM')).toBe('failed');
  expect(await adapter.inspector.groupMembers(123)).toEqual({state:'unknown'});
  expect(adapter.registerOrdinary(123)).toBe(true);
  expect(await adapter.inspector.signalGroup(123, 'SIGTERM')).toBe('sent');
  expect(signalGroup).toHaveBeenCalledWith(123, 'SIGTERM');
  expect(start).not.toHaveBeenCalled();
  adapter.releaseOrdinary(123);
  expect(await adapter.inspector.signalGroup(123, 'SIGTERM')).toBe('failed');
});
