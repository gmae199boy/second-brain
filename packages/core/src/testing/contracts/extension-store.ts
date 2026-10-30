import type { ExtensionStore } from '../../ports/store.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
export function extensionStoreContract(): ContractCase<ExtensionStore>[] {
  const now = new Date('2026-10-29T00:00:00.000Z'), next = new Date('2026-10-29T01:00:00.000Z');
  return [contractCase('extension registry keeps installation, activation and connection as independent facts', async make => {
    await withSubject(make, async store => {
      assertEqual(await store.getExtensionPythonEnvironment('testext'), { ok: true, environment: null }, '환경 기록 없음');
      assertOk(await store.recordExtensionPythonEnvironment({ name: 'testext', status: 'failed', code: 'EXTENSION_UV_NOT_FOUND', checkedAt: now }), '설치 전 환경 실패 기록');
      assertEqual(await store.getExtensionPythonEnvironment('testext'), { ok: true, environment: { status: 'failed', code: 'EXTENSION_UV_NOT_FOUND', checkedAt: now } }, '환경 실패');
      assertOk(await store.recordExtensionPythonEnvironment({ name: 'testext', status: 'succeeded', code: null, checkedAt: next }), '환경 성공');
      assertEqual(await store.getExtensionPythonEnvironment('testext'), { ok: true, environment: { status: 'succeeded', code: null, checkedAt: next } }, '환경 성공이 실패를 대체함');
      assertEqual(await store.getExtension('testext'), { ok: true, extension: null }, 'missing');
      assertEqual(await store.listExtensions(), { ok: true, extensions: [] }, 'empty');
      assertOk(await store.recordExtensionInstall({ name: 'testext', version: '0.1', now }), 'install');
      const first = { name: 'testext', version: '0.1', installedAt: now, enabled: true, enabledChangedAt: now, connectionStatus: null, connectionCheckedAt: null, connectionCode: null, connectionMessage: null };
      assertEqual(await store.getExtension('testext'), { ok: true, extension: first }, 'installed without check');
      assertOk(await store.recordExtensionConnection({ name: 'testext', status: 'failed', checkedAt: next, code: 'REFUSED', message: '연결 거절' }), 'failed check');
      assertOk(await store.recordExtensionInstall({ name: 'testext', version: '0.2', now: next }), 'reinstall');
      const expected = { ...first, version: '0.2', connectionStatus: 'failed', connectionCheckedAt: next, connectionCode: 'REFUSED', connectionMessage: '연결 거절' };
      assertEqual(await store.getExtension('testext'), { ok: true, extension: expected }, 'reinstall updates version only');
      assertOk(await store.recordExtensionInstall({ name: 'alpha', version: '1', now }), 'other');
      const list = await store.listExtensions(); assertOk(list, 'list');
      assertEqual(list.extensions.map(r => r.name), ['alpha', 'testext'], 'name ordering');
      list.extensions[1]!.version = 'mutated'; list.extensions[1]!.installedAt.setTime(0);
      assertEqual(await store.getExtension('testext'), { ok: true, extension: expected }, 'independent result');
      assertOk(await store.recordExtensionConnection({ name: 'testext', status: 'connected', checkedAt: next, code: null, message: null }), 'connected');
      assertEqual(await store.getExtension('testext'), { ok: true, extension: { ...expected, connectionStatus: 'connected', connectionCode: null, connectionMessage: null } }, 'clear previous failure');
    });
  })];
}
