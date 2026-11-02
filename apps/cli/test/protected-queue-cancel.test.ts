import { describe, expect, it, vi } from 'vitest';
import { handleQueueCancelFrame } from '../src/daemon/protected-queue-cancel.js';

const id = '065a3af7-3a06-4e25-a093-82fa3641f7c7';
const request = JSON.stringify({operation:'queue.cancel.v1',id});

describe('보호 일감 취소 프레임', () => {
  it('기존 Core 취소 상태를 제한된 공개 결과로 반환한다', async () => {
    for (const state of ['cancelled','requested','already_closed'] as const) {
      const cancel = vi.fn(async () => ({ok:true as const,id,state,attemptToken:'private'}));
      expect(JSON.parse(await handleQueueCancelFrame(request,{cancel}))).toEqual({ok:true,id,state});
      expect(cancel).toHaveBeenCalledExactlyOnceWith({id});
    }
    const cancel = vi.fn(async () => ({ok:false as const,code:'WORK_NOT_FOUND' as const,message:'지정한 일감이 없습니다'}));
    expect(JSON.parse(await handleQueueCancelFrame(request,{cancel}))).toEqual({ok:false,code:'WORK_NOT_FOUND',message:'지정한 일감이 없습니다'});
  });
  it('중복·추가 필드와 비 UUID 입력은 취소 use case에 전달하지 않는다', async () => {
    const cancel = vi.fn(async () => ({ok:true as const,id,state:'requested' as const}));
    for (const frame of [
      `{"operation":"queue.cancel.v1","id":"${id}","id":"${id}"}`,
      JSON.stringify({operation:'queue.cancel.v1',id,token:'private'}),
      JSON.stringify({operation:'queue.cancel.v1',id:'not-uuid'}),
      JSON.stringify({operation:'queue.hold.v1',id}),
    ]) expect(JSON.parse(await handleQueueCancelFrame(frame,{cancel}))).toEqual({ok:false,code:'INVALID_REQUEST'});
    expect(cancel).not.toHaveBeenCalled();
  });
  it('불일치 결과와 예외는 내부 내용을 노출하지 않는다', async () => {
    for (const cancel of [
      async () => ({ok:true as const,id:'00000000-0000-0000-0000-000000000000',state:'requested' as const}),
      async (): Promise<never> => {throw new Error('secret');},
    ]) expect(JSON.parse(await handleQueueCancelFrame(request,{cancel}))).toEqual({ok:false,code:'DB_UNAVAILABLE',message:'저장소를 확인할 수 없습니다'});
  });
});
