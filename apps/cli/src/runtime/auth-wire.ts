import { createHmac, timingSafeEqual } from 'node:crypto';

// 인증된 OS peer와 bootstrap이 마련되기 전에는 이 codec을 사용하지 않는다.
const MAX_FRAME = 16 * 1024, HEADER = 42, TAG = 32, MAX_PAYLOAD = 4096;
const types = new Set([1, 2, 3, 4, 5]);
type Direction = 'ui' | 'worker';
export class AuthWireError extends Error { constructor() { super('AUTH_PROTOCOL'); } }
export class AuthWire {
  private readonly key: Buffer;
  private readonly session: Buffer;
  private sent = 0n; private received = 0n; private closed = false;
  private readonly seenResponses = new Set<string>();
  constructor(key: Uint8Array, session: Uint8Array, private readonly sendDirection: Direction, private readonly receiveDirection: Direction) {
    if (key.length !== 32 || session.length !== 16 || sendDirection === receiveDirection || !['ui','worker'].includes(sendDirection) || !['ui','worker'].includes(receiveDirection)) throw new AuthWireError();
    this.key = Buffer.from(key); this.session = Buffer.from(session);
  }
  close(): void { this.closed = true; this.key.fill(0); }
  encode(kind: number, prompt: Uint8Array, payload: Uint8Array): Buffer {
    if (this.closed || !types.has(kind) || prompt.length !== 16 || payload.length > MAX_PAYLOAD || this.sent >= 64n) return this.fail();
    const body = Buffer.alloc(HEADER + payload.length);
    body[0] = 1; body.writeBigUInt64BE(++this.sent,1); this.session.copy(body,9); Buffer.from(prompt).copy(body,25); body[41] = kind; Buffer.from(payload).copy(body,HEADER);
    const tag = createHmac('sha256',this.key).update(this.sendDirection).update(body).digest();
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length + tag.length);
    return Buffer.concat([size,body,tag]);
  }
  decode(frame: Uint8Array, expectedPrompt?: Uint8Array): {kind:number; prompt:Buffer; payload:Buffer} {
    try {
      const bytes = Buffer.from(frame);
      if (this.closed || bytes.length < 4) return this.fail();
      const length = bytes.readUInt32BE(0);
      if (length > MAX_FRAME || length < HEADER + TAG || bytes.length !== length + 4) return this.fail();
      const body = bytes.subarray(4,-TAG), tag = bytes.subarray(-TAG);
      const expected = createHmac('sha256',this.key).update(this.receiveDirection).update(body).digest();
      if (!timingSafeEqual(tag,expected)) return this.fail();
      const sequence = body.readBigUInt64BE(1), session = body.subarray(9,25), prompt = body.subarray(25,41), kind = body[41]!;
      if (body[0] !== 1 || sequence > 64n || sequence !== this.received + 1n || !session.equals(this.session) || !types.has(kind) || body.length - HEADER > MAX_PAYLOAD || (kind === 3 && this.seenResponses.has(prompt.toString('hex'))) || (expectedPrompt !== undefined && !prompt.equals(Buffer.from(expectedPrompt)))) return this.fail();
      this.received = sequence;
      if (kind === 3) this.seenResponses.add(prompt.toString('hex'));
      return {kind,prompt:Buffer.from(prompt),payload:Buffer.from(body.subarray(HEADER))};
    } catch { return this.fail(); }
  }
  private fail(): never { this.close(); throw new AuthWireError(); }
}
