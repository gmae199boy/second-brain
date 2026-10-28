import { expect, it } from 'vitest';
import { withoutHarnessFolders } from './environment.js';

it.each(['postgresql://inherited.invalid/real-brain', ''])('removes an inherited database selector %j without mutating the source', inherited => {
  const source = { BRAIN_DATABASE_URL: inherited, SECOND_BRAIN_HOME: '/tmp/isolated-brain' };
  const env = withoutHarnessFolders(source);
  expect(env).not.toHaveProperty('BRAIN_DATABASE_URL');
  expect(env.SECOND_BRAIN_HOME).toBe(source.SECOND_BRAIN_HOME);
  expect(source.BRAIN_DATABASE_URL).toBe(inherited);
});

it.each(['postgresql://unused@127.0.0.1:1/unavailable', ''])('preserves an intentional URL fault override applied after isolation: %j', fault => {
  const env = { ...withoutHarnessFolders({ BRAIN_DATABASE_URL: 'postgresql://inherited.invalid/real-brain' }), BRAIN_DATABASE_URL: fault };
  expect(env.BRAIN_DATABASE_URL).toBe(fault);
});
