import { expect, it } from 'vitest';
import { AuthWire } from '../src/runtime/auth-wire.js';
const key=Buffer.alloc(32,107), session=Buffer.alloc(16,115), prompt=Buffer.alloc(16,112);
const pair=() => [new AuthWire(key,session,'ui','worker'),new AuthWire(key,session,'worker','ui')] as const;
it('인증 frame의 방향, 순서, prompt와 무결성을 검사한다',() => {
  const [sender,receiver]=pair(); const frame=sender.encode(2,prompt,Buffer.from('synthetic'));
  expect(receiver.decode(frame,prompt)).toEqual({kind:2,prompt,payload:Buffer.from('synthetic')});
  expect(() => receiver.decode(frame,prompt)).toThrow('AUTH_PROTOCOL');
  const [s2,r2]=pair(); r2.decode(s2.encode(3,prompt,Buffer.from('one')),prompt);
  expect(() => r2.decode(s2.encode(3,prompt,Buffer.from('two')),prompt)).toThrow('AUTH_PROTOCOL');
  for (const alter of [(v:Buffer)=>v.subarray(0,-1),(v:Buffer)=>Buffer.concat([v.subarray(0,-1),Buffer.from([v[v.length-1]! ^ 1])]),(v:Buffer)=>Buffer.concat([Buffer.from([0,1,0,0]),v.subarray(4)])]) {
    const [s,r]=pair(); expect(() => r.decode(alter(s.encode(2,prompt,Buffer.from('x'))),prompt)).toThrow('AUTH_PROTOCOL');
  }
  const [s,r]=pair(); expect(() => r.decode(s.encode(2,prompt,Buffer.from('x')),Buffer.alloc(16,113))).toThrow('AUTH_PROTOCOL');
  const [reflection]=pair(); expect(() => reflection.decode(reflection.encode(2,prompt,Buffer.from('x')),prompt)).toThrow('AUTH_PROTOCOL');
});

