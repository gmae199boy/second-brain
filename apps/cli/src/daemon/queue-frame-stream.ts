/** 인증된 native 연결에서 받은 일반 조회 frame만 제품 handler에 전달한다. */
import { TextDecoder } from 'node:util';

// [ASSUMPTION] 일반 데이터 frame의 1 MiB 상한은 실제 목록 부하에서 재평가한다.
const FRAME_MAX = 1024 * 1024;
export interface QueueFrameHandler { requestQueueFrame(frame: string): Promise<string> }
export function encodeQueueFrame(frame: string): Buffer {
  const body=Buffer.from(frame,'utf8');
  if(!body.length || body.length>FRAME_MAX) throw new Error('invalid frame');
  const result=Buffer.allocUnsafe(body.length+4);result.writeUInt32BE(body.length,0);body.copy(result,4);return result;
}
/** 인증과 FD 소유권은 호출한 native 보호 조립이 보장해야 한다. 실패 시 연결을 닫는다. */
export async function serveQueueFrames(
  source: AsyncIterable<Uint8Array>,
  write: (frame: Buffer) => Promise<void>,
  handler: QueueFrameHandler,
): Promise<void> {
  const header=Buffer.alloc(4);let headerLength=0;let body: Buffer | undefined;let bodyLength=0;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  for await(const chunk of source) {
    let offset=0;
    while(offset<chunk.length) {
      if(!body) {
        const take=Math.min(4-headerLength,chunk.length-offset);
        header.set(chunk.subarray(offset,offset+take),headerLength);headerLength+=take;offset+=take;
        if(headerLength<4)continue;
        const size=header.readUInt32BE(0);if(!size || size>FRAME_MAX)throw new Error('invalid frame');
        body=Buffer.allocUnsafe(size);bodyLength=0;headerLength=0;
      }
      const take=Math.min(body.length-bodyLength,chunk.length-offset);
      body.set(chunk.subarray(offset,offset+take),bodyLength);bodyLength+=take;offset+=take;
      if(bodyLength===body.length) {
        const request=decoder.decode(body);body=undefined;bodyLength=0;
        const response=await handler.requestQueueFrame(request);
        await write(encodeQueueFrame(response));
      }
    }
  }
  if(headerLength || body)throw new Error('truncated frame');
}
