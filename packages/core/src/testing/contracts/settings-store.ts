import type { SettingsStore } from '../../ports/store.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

export function settingsStoreContract(): ContractCase<SettingsStore>[] {
  const updatedAt = new Date('2026-10-28T01:02:03.456Z');
  return [contractCase('missing keys return null and settings preserve keys, values and timestamps', async make => {
    await withSubject(make, async store => {
      assertEqual(await store.getSetting({ userId: null, key: 'timezone' }), { ok: true, setting: null }, 'missing key');
      const first = { key: 'timezone', value: 'America/New_York', updatedAt };
      assertOk(await store.setSetting({ ...first, userId: null }), 'insert');
      assertEqual(await store.getSetting({ userId: null, key: first.key }), { ok: true, setting: first }, 'read inserted');
      const second = { ...first, value: 'Asia/Seoul', updatedAt: new Date(updatedAt.getTime() + 1000) };
      assertOk(await store.setSetting({ ...second, userId: null }), 'overwrite');
      assertEqual(await store.getSetting({ userId: null, key: first.key }), { ok: true, setting: second }, 'overwrite changes only value and timestamp');
      assertOk(await store.insertSetting({ ...first, userId: null }), 'insert does not overwrite');
      assertEqual(await store.getSetting({ userId: null, key: first.key }), { ok: true, setting: second }, 'existing value preserved');
      const other = { key: 'probe.other', value: '한글 설정값'.repeat(10000), updatedAt };
      assertOk(await store.setSetting({ ...other, userId: null }), 'long Korean value');
      assertEqual(await store.getSetting({ userId: null, key: other.key }), { ok: true, setting: other }, 'long value roundtrip');
      assertEqual(await store.getSetting({ userId: null, key: first.key }), { ok: true, setting: second }, 'independent keys');
      const all = await store.getSettings({ userId: null, keys: [first.key, other.key, 'missing'] });
      assertOk(all, 'bulk read');
      if (all.ok) assertEqual(all.settings.sort((a, b) => a.key.localeCompare(b.key)), [other, second], 'bulk read returns the requested existing keys');
    });
  }), contractCase('user A and B remain isolated from each other and share only global fallback', async make => {
    await withSubject(make, async store => {
      const a = '01940000-0000-7000-8000-00000000000a', b = '01940000-0000-7000-8000-00000000000b';
      const row = (key: string, value: string) => ({ key, value, updatedAt });
      for (const [userId, value] of [[null, 'global'], [a, 'A'], [b, 'B']] as const) assertOk(await store.setSetting({ userId, ...row('probe.shared', value) }), 'seed');
      assertOk(await store.setSetting({ userId: null, ...row('probe.fallback', 'fallback') }), 'global fallback');
      assertOk(await store.setSetting({ userId: b, ...row('probe.fallback', 'B-only') }), 'other user');
      assertEqual(await store.getSetting({ userId: a, key: 'probe.shared' }), { ok: true, setting: row('probe.shared', 'A') }, 'A wins');
      assertEqual(await store.getSetting({ userId: a, key: 'probe.fallback' }), { ok: true, setting: row('probe.fallback', 'fallback') }, 'A does not see B');
      assertEqual(await store.getSettings({ userId: a, keys: ['probe.fallback', 'probe.shared'] }), { ok: true, settings: [row('probe.fallback', 'fallback'), row('probe.shared', 'A')] }, 'bulk A');
      assertOk(await store.insertSetting({ userId: a, ...row('probe.fallback', 'A-new') }), 'insert absent A');
      assertEqual(await store.getSetting({ userId: a, key: 'probe.fallback' }), { ok: true, setting: row('probe.fallback', 'A-new') }, 'inserted A single read and timestamp');
      assertEqual(await store.getSettings({ userId: a, keys: ['probe.fallback'] }), { ok: true, settings: [row('probe.fallback', 'A-new')] }, 'inserted A bulk read and timestamp');
      assertEqual(await store.getSettings({ userId: b, keys: ['probe.fallback'] }), { ok: true, settings: [row('probe.fallback', 'B-only')] }, 'B preserved after A insert');
      assertEqual(await store.getSettings({ userId: null, keys: ['probe.fallback'] }), { ok: true, settings: [row('probe.fallback', 'fallback')] }, 'global preserved after A insert');
      assertOk(await store.setSetting({ userId: a, ...row('probe.shared', 'A2') }), 'overwrite A');
      assertOk(await store.insertSetting({ userId: a, ...row('probe.shared', 'ignored') }), 'preserve A');
      for (const [userId, value] of [[a, 'A2'], [b, 'B'], [null, 'global']] as const) {
        assertEqual(await store.getSetting({ userId, key: 'probe.shared' }), { ok: true, setting: row('probe.shared', value) }, 'scope unchanged');
        assertEqual(await store.getSettings({ userId, keys: ['probe.shared'] }), { ok: true, settings: [row('probe.shared', value)] }, 'bulk scope unchanged');
      }
    });
  })];
}
