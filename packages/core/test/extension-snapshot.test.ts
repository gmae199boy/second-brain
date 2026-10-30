import { expect, it } from 'vitest';
import { createExtensionSnapshot } from '../src/extensions/snapshot.js';
const declarations = [
  { key: 'testext.limit', type: 'number' as const, required: ['work' as const], default: '10' },
  { key: 'testext.token', type: 'string' as const, required: ['work' as const], secret: true },
];
const base = { extension: 'testext', declarations, settings: {}, secrets: {} };
it('permits the initial auth without a token but requires it for work', () => {
  expect(createExtensionSnapshot({ ...base, stage: 'auth' })).toEqual({ ok: true, serialized: '{"version":1,"extension":"testext","values":{"testext.limit":10}}' });
  expect(createExtensionSnapshot({ ...base, stage: 'work' })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID', retryable: false });
});
it('resolves references without trimming and rejects invalid configured values in every stage', () => {
  const input = { ...base, stage: 'auth' as const, settings: { 'testext.token': 'MY_SECRET' }, secrets: { MY_SECRET: ' secret ' } };
  const result = createExtensionSnapshot(input);
  expect(result.ok && JSON.parse(result.serialized).values['testext.token']).toBe(' secret ');
  expect(createExtensionSnapshot({ ...input, secrets: { MY_SECRET: '' } }).ok).toBe(false);
  expect(createExtensionSnapshot({ ...input, settings: { 'testext.token': 'invalid-name' } }).ok).toBe(false);
});
it('uses the machine tokenstore path instead of settings or secret contents', () => {
  const result = createExtensionSnapshot({ extension: 'testext', stage: 'auth', declarations: [{ key: 'testext.tokenstore', type: 'string', required: ['auth'], machine: 'tokenstore' }], settings: { 'testext.tokenstore': 'untrusted' }, secrets: {}, machine: { tokenstore: '/runtime/tokenstore' } });
  expect(result.ok && JSON.parse(result.serialized).values).toEqual({ 'testext.tokenstore': '/runtime/tokenstore' });
});
