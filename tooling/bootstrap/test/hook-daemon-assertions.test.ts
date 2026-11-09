import { expect, it } from 'vitest';
import { maskOutputValue } from '../../../packages/core/src/output/mask.js';
import { assertDaemonIdentity } from './hook-daemon-assertions.js';

const phoneSha = 'abcdef01012345678abcdefabcdefabcdefabcde';
const ordinarySha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
it('checks independent public codec expectations without changing raw commits', () => {
  const raw = { phone: phoneSha, ordinary: ordinarySha };
  expect(maskOutputValue(raw)).toEqual({ phone: 'abcdef[REDACTED:phone_number]abcdefabcdefabcdefabcde', ordinary: ordinarySha });
  expect(raw).toEqual({ phone: phoneSha, ordinary: ordinarySha });
  expect(phoneSha).toHaveLength(40); expect(ordinarySha).toHaveLength(40);
  assertDaemonIdentity({pid:42,commit:phoneSha}, {pid:42,commit:'abcdef[REDACTED:phone_number]abcdefabcdefabcdefabcde',alive:true}, 42, phoneSha, phoneSha, true);
  assertDaemonIdentity({pid:42,commit:ordinarySha}, {pid:42,commit:ordinarySha,alive:true}, 42, ordinarySha, ordinarySha, true);
});
it('rejects stale or different processes and full commits', () => {
  const raw = {pid:42,commit:ordinarySha}; const status = {pid:42,commit:ordinarySha,alive:true};
  expect(()=>assertDaemonIdentity({...raw,pid:41},status,42,ordinarySha,ordinarySha,true)).toThrow();
  expect(()=>assertDaemonIdentity(raw,{...status,pid:41},42,ordinarySha,ordinarySha,true)).toThrow();
  expect(()=>assertDaemonIdentity({...raw,commit:phoneSha},status,42,ordinarySha,ordinarySha,true)).toThrow();
  expect(()=>assertDaemonIdentity(raw,status,42,phoneSha,ordinarySha,true)).toThrow();
  expect(()=>assertDaemonIdentity(raw,status,42,ordinarySha,ordinarySha,false)).toThrow();
  expect(()=>assertDaemonIdentity(raw,{...status,commit:phoneSha},42,ordinarySha,ordinarySha,true)).toThrow();
});
