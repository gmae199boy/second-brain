import { it } from 'vitest';
import { extensionStoreContract } from '@second-brain/core/testing';
import { subject } from './fixture.js';
for (const c of extensionStoreContract()) it(c.name, () => c.run(subject));

it('기존 registry를 34로 이행하고 패키지 신원을 저장·조회한다', async () => {
  const { expect } = await import('vitest');
  const { database, clock } = await import('./fixture.js');
  const { runMigrations, postgresStore } = await import('../src/index.js');
  const db = await database(false);
  try {
    expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 33 })).toMatchObject({ ok: true, to: 33 });
    await db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','0.1.0',now(),false,now())");
    const before = await db.rows("select name,version,enabled,installed_at from brain.extensions where name='testext'");
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 33, to: 47 });
    expect(await db.rows("select name,version,enabled,installed_at from brain.extensions where name='testext'")).toEqual(before);
    const store = postgresStore({ databaseUrl: db.appUrl });
    try {
      expect(await store.getExtension('testext')).toMatchObject({ ok: true, extension: { packageDigest: null, pluginVersion: null, enabled: false } });
      expect(await store.recordExtensionInstall({ name: 'testext', version: '0.2.0', packageIdentity: { digest: 'a'.repeat(64), pluginVersion: '1.2.0' }, now: clock.now() })).toEqual({ ok: true });
      expect(await store.getExtension('testext')).toMatchObject({ ok: true, extension: { version: '0.2.0', packageDigest: 'a'.repeat(64), pluginVersion: '1.2.0', enabled: false } });
      expect(await store.listExtensions()).toMatchObject({ ok: true, extensions: [{ packageDigest: 'a'.repeat(64), pluginVersion: '1.2.0' }] });
      expect(await store.getExtensionPublicStatus('testext')).toMatchObject({ ok: true, status: { packageDigest: 'a'.repeat(64), pluginVersion: '1.2.0' } });
      await expect(db.query("update brain.extensions set plugin_version=null where name='testext'")).rejects.toThrow();
    } finally { await store.close(); }
  } finally { await db.drop(); }
});
