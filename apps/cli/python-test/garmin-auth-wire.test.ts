import { expect, it } from 'vitest';
import { AuthWire } from '../src/runtime/auth-wire.js';
const key=Buffer.alloc(32,107), session=Buffer.alloc(16,115), prompt=Buffer.alloc(16,112);
const pair=() => [new AuthWire(key,session,'ui','worker'),new AuthWire(key,session,'worker','ui')] as const;

it('Node와 Python이 같은 frame을 주고받는다', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const python = fileURLToPath(new URL('../../../extensions/garmin/.venv/bin/python',import.meta.url));
  const script = fileURLToPath(new URL('../../../extensions/garmin/tests/auth_wire_peer.py',import.meta.url));
  const [sender] = pair();
  const child = spawnSync(python,[script],{input:sender.encode(2,prompt,Buffer.from('synthetic')),env:{PYTHONDONTWRITEBYTECODE:'1'}});
  expect(child.status,child.stderr.toString()).toBe(0);
  expect(sender.decode(child.stdout,prompt)).toEqual({kind:3,prompt,payload:Buffer.from('ack')});
});
