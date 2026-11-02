import { closeSync, readSync, writeSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { createRequire } from 'node:module';
import { sealedQueueList } from './sealed-queue-client.js';

// 이 진입점은 신뢰된 native 조립에서만 사용한다. FD 6의 ACK 전에는 사용자 입력을 읽지 않는다.
const maxFrame = 1024 * 1024;
function readExactly(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const count = readSync(fd, buffer, offset, size - offset, null); if (!count) throw new Error('closed'); offset += count; }
  return buffer;
}
function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) { const count = writeSync(fd, buffer, offset, buffer.length - offset); if (!count) throw new Error('closed'); offset += count; }
}
function frame(data: string): Buffer {
  const body = Buffer.from(data); if (!body.length || body.length > maxFrame) throw new Error('frame');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
}
async function main(): Promise<void> {
  const verifiedPeer = createRequire(import.meta.url)('./peer.node') as {bootstrap(): boolean; peer(): boolean};
  if (process.argv.length !== 3 || process.argv[2] !== '--sealed-queue-client') throw new Error('argv');
  if (!verifiedPeer.bootstrap()) throw new Error('peer');
  writeAll(5, Buffer.from([1]));
  if (readExactly(6, 1)[0] !== 1 || !verifiedPeer.bootstrap()) throw new Error('bootstrap');
  closeSync(6);
  const chunks: Buffer[] = []; let length = 0;
  for (;;) {const chunk = Buffer.alloc(4096); const count = readSync(0, chunk, 0, chunk.length, null); if (!count) break; length += count; if (length > 16384) throw new Error('input'); chunks.push(chunk.subarray(0,count));}
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('options');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(k => !['all','kind','limit'].includes(k)) || (options.all !== undefined && typeof options.all !== 'boolean') || (options.kind !== undefined && typeof options.kind !== 'string') || (options.limit !== undefined && typeof options.limit !== 'string')) throw new Error('options');
  let responseFrame: string | undefined;
  const result = await sealedQueueList(options, {async request(request) {
    if (!verifiedPeer.peer()) throw new Error('peer');
    writeAll(5, frame(request));
    if (!verifiedPeer.peer()) throw new Error('peer');
    const size = readExactly(5,4).readUInt32BE(); if (!size || size > maxFrame) throw new Error('frame');
    const response = new TextDecoder('utf-8',{fatal:true}).decode(readExactly(5,size));
    if (!verifiedPeer.peer()) throw new Error('peer');
    responseFrame=response;return response;
  }});
  writeAll(1, Buffer.from(JSON.stringify({result,response:responseFrame ?? null})+'\n'));
  if (!verifiedPeer.peer()) throw new Error('peer');
  writeAll(5, frame('ack'));
  if (readSync(5, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error('trailing');
}
main().catch(() => { process.exitCode = 2; });
