import type { ExtensionInstallProgress } from '../../extensions/install-progress.js';
import type { ExtensionStore } from '../../ports/store.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
export function extensionStoreContract(): ContractCase<ExtensionStore>[] {
  const now = new Date('2026-10-29T00:00:00.000Z'), next = new Date('2026-10-29T01:00:00.000Z');
  return [contractCase('설치 전 진행 기록을 저장하고 오래되거나 안전하지 않은 쓰기를 거부한다', async make => {
    await withSubject(make, async store => {
      const progress: ExtensionInstallProgress = { name: 'testext', packageDigest: 'a'.repeat(64), result: 'failed', failedStage: 'migration', lastFailure: { stage: 'migration', code: 'MIGRATION_FAILED', at: now.toISOString() }, stages: { package: { status: 'succeeded', code: null, at: now.toISOString() }, migration: { status: 'failed', code: 'MIGRATION_FAILED', at: next.toISOString() } }, authWorkId: null, scheduleIds: [] };
      assertEqual(await store.getExtensionInstallProgress('testext'), { ok: true, journal: null }, '기록 없음');
      assertEqual(await store.writeExtensionInstallProgress({ expectedRevision: null, progress }), { ok: true, written: true, revision: 1 }, '생성');
      assertEqual(await store.getExtension('testext'), { ok: true, extension: null }, '진행 기록은 설치 행을 만들지 않음');
      assertEqual(await store.getExtensionInstallProgress('testext'), { ok: true, journal: { revision: 1, progress } }, '기록 재조회');
      const nextProgress = structuredClone(progress); nextProgress.result = 'cancelled';
      const races = await Promise.all([store.writeExtensionInstallProgress({ expectedRevision: 1, progress: nextProgress }), store.writeExtensionInstallProgress({ expectedRevision: 1, progress })]);
      assertEqual(races.filter(r => r.ok && r.written).length, 1, '동시 쓰기 하나만 성공');
      const stored = await store.getExtensionInstallProgress('testext'); assertOk(stored, '성공한 기록 조회');
      assertEqual(stored.journal?.revision, 2, 'revision은 한 번 증가');
      assertEqual(await store.writeExtensionInstallProgress({ expectedRevision: null, progress }), { ok: true, written: false, revision: 2 }, '오래된 생성 거부');
      const unsafe = { ...progress, diagnostic: 'password=secret' };
      const rejected = await store.writeExtensionInstallProgress({ expectedRevision: 2, progress: unsafe });
      assertEqual(rejected.ok, false, '임의 진단 거부');
      assertEqual(await store.getExtensionInstallProgress('testext'), stored, '거부된 쓰기는 기록을 바꾸지 않음');
      if (stored.journal) stored.journal.progress.stages = {};
      const reread = await store.getExtensionInstallProgress('testext'); assertOk(reread, '독립 조회');
      assertEqual(Object.keys(reread.journal?.progress.stages ?? {}).length, 2, '조회 결과는 저장소와 독립');
    });
  }), contractCase('extension registry keeps installation, activation and connection as independent facts', async make => {
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
