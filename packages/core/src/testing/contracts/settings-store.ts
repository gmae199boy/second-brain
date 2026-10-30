import type { SettingsStore } from '../../ports/store.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

export function settingsStoreContract(): ContractCase<SettingsStore>[] {
  const updatedAt = new Date('2026-10-28T01:02:03.456Z');
  return [contractCase('missing keys return null and settings preserve keys, values and timestamps', async make => {
    await withSubject(make, async store => {
      assertEqual(await store.getSetting({ key: 'timezone' }), { ok: true, setting: null }, 'missing key');
      const first = { key: 'timezone', value: 'America/New_York', updatedAt };
      assertOk(await store.setSetting(first), 'insert');
      assertEqual(await store.getSetting({ key: first.key }), { ok: true, setting: first }, 'read inserted');
      const second = { ...first, value: 'Asia/Seoul', updatedAt: new Date(updatedAt.getTime() + 1000) };
      assertOk(await store.setSetting(second), 'overwrite');
      assertEqual(await store.getSetting({ key: first.key }), { ok: true, setting: second }, 'overwrite changes only value and timestamp');
      const other = { key: 'probe.other', value: '한글 설정값'.repeat(10000), updatedAt };
      assertOk(await store.setSetting(other), 'long Korean value');
      assertEqual(await store.getSetting({ key: other.key }), { ok: true, setting: other }, 'long value roundtrip');
      assertEqual(await store.getSetting({ key: first.key }), { ok: true, setting: second }, 'independent keys');
      const all = await store.getSettings({ keys: [first.key, other.key, 'missing'] });
      assertOk(all, 'bulk read');
      if (all.ok) assertEqual(all.settings.sort((a, b) => a.key.localeCompare(b.key)), [other, second], 'bulk read returns the requested existing keys');
    });
  })];
}
