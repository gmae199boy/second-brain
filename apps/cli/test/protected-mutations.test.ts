import { expect, it, vi } from 'vitest';
import { protectedMutations, type ProtectedAttempt, type ProtectedMutationStore } from '../src/daemon/protected-mutations.js';
const first: ProtectedAttempt = { work: 'a', token: 'x', run: 1, state: 'spawning', lease: 'l', epoch: 1, revoked: false };
const second: ProtectedAttempt = { work: 'b', token: 'y', run: 1, state: 'spawning', lease: 'm', epoch: 2, revoked: false };
const action = { type: 'hold' as const, group: 'extension:fixture' };
it('모든 현재 시도의 ACK 뒤에만 범위 mutation을 기록한다', async () => {
  const order: string[] = [];
  const store: ProtectedMutationStore = { list: async () => [first,second], commit: async () => { order.push('commit'); return {status:'committed',result:{type:'hold',held:true}}; }, applied: async () => null };
  const manager = protectedMutations(store, { revoke: async attempt => { order.push(attempt.work); return true; } });
  expect(await manager.execute(action)).toBe('done');expect(order).toEqual(['a','b','commit']);
});
it('하나의 ACK가 실패하거나 identity가 불명이면 mutation하지 않는다', async () => {
  const commit=vi.fn(async () => ({status:'committed' as const,result:{type:'hold' as const,held:true}}));
  const store: ProtectedMutationStore = { list: async () => [first,second], commit, applied: async () => null };
  expect(await protectedMutations(store, { revoke: async attempt => attempt.work==='a' }).execute(action)).toBe('unavailable');
  expect(commit).not.toHaveBeenCalled();
  store.list=async () => [{...first,lease:null,epoch:null}];
  expect(await protectedMutations(store, { revoke: async () => true }).execute(action)).toBe('unavailable');expect(commit).not.toHaveBeenCalled();
});
it('claim 경합과 commit 응답 불명은 재조회로만 처리한다', async () => {
  let reads=0;const calls: string[]=[];
  const store: ProtectedMutationStore = { list: async () => ++reads===1?[first]:[first,second], commit: async () => ({status:reads===1?'changed':'unknown'}), applied: async () => ({type:'hold',held:true}) };
  expect(await protectedMutations(store, { revoke: async attempt => {calls.push(attempt.work);return true;} }).execute(action)).toBe('done');
  expect(calls).toEqual(['a','a','b']);
  store.applied=async()=>null;store.commit=async()=> ({status:'unknown'});
  expect(await protectedMutations(store, { revoke: async () => true }).execute(action)).toBe('unavailable');
});
