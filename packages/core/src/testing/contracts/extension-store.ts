import type { ExtensionInstallProgress } from '../../extensions/install-progress.js';
import type { ExtensionStore } from '../../ports/store.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
export function extensionStoreContract(): ContractCase<ExtensionStore>[] {
  const now = new Date('2026-10-29T00:00:00.000Z'), next = new Date('2026-10-29T01:00:00.000Z');
  return [contractCase('수동 일감은 등록과 활성 상태를 원자적으로 확인하고 열린 요청을 합친다', async make => {
    await withSubject(make, async store => {
      const work = { id: '00000000-0000-7000-8000-000000000001', kind: 'testext.job', targetKind: 'extension', targetId: 'default', createdAt: now, nextAttemptAt: now };
      assertEqual(await store.enqueueExtensionWork({ name: 'testext', version: '1', work }), { ok: true, state: 'missing' }, '미설치');
      assertOk(await store.recordExtensionInstall({ name: 'testext', version: '1', now, workKinds: [work.kind] }), '설치');
      const [first, second] = await Promise.all([store.enqueueExtensionWork({ name: 'testext', version: '1', work }), store.enqueueExtensionWork({ name: 'testext', version: '1', work: { ...work, id: '00000000-0000-7000-8000-000000000002' } })]);
      assertOk(first, '첫 요청'); assertOk(second, '두 번째 요청');
      if (first.state !== 'queued' || second.state !== 'queued') throw new Error('일감이 큐에 없습니다');
      assertEqual(first.workId, second.workId, '동일 열린 일감');
      assertEqual([first.created, second.created].sort(), [false, true], '한 번만 생성');
      assertOk(await store.setExtensionEnabled({ name: 'testext', enabled: false, now }), '비활성');
      assertEqual(await store.enqueueExtensionWork({ name: 'testext', version: '1', work }), { ok: true, state: 'disabled' }, '비활성 거부');
      assertEqual(await store.enqueueExtensionWork({ name: 'testext', version: '2', work }), { ok: true, state: 'changed' }, '버전 변경 거부');
    });
  }), contractCase('inventory는 registry와 journal 이름을 정렬하고 중복 제거한다', async make => {
    await withSubject(make, async store => {
      const progress = (name: string): ExtensionInstallProgress => ({ name, packageDigest: 'a'.repeat(64), result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code: 'EXTENSION_NOT_FOUND', at: now.toISOString() }, stages: {}, authWorkId: null, scheduleIds: [] });
      assertEqual(await store.listExtensionInventory(), { ok: true, names: [] }, '빈 inventory');
      assertOk(await store.recordExtensionInstall({ name: 'zeta', version: '1', now }), 'registry 전용');
      assertOk(await store.recordExtensionInstall({ name: 'both', version: '1', now }), '양쪽 registry');
      assertOk(await store.writeExtensionInstallProgress({ expectedRevision: null, progress: progress('both') }), '양쪽 journal');
      assertOk(await store.writeExtensionInstallProgress({ expectedRevision: null, progress: progress('alpha') }), 'journal 전용');
      assertEqual(await store.listExtensionInventory(), { ok: true, names: ['alpha', 'both', 'zeta'] }, '정렬된 합집합');
      const installed = await store.listExtensions(); assertOk(installed, '설치 목록');
      assertEqual(installed.extensions.map(row => row.name), ['both', 'zeta'], '설치 목록 의미 유지');
    });
  }), contractCase('로그인 미완료 설치 기록을 공개 상태로 구분한다', async make => {
    await withSubject(make, async store => {
      const progress: ExtensionInstallProgress = { name: 'testext', packageDigest: 'a'.repeat(64), result: 'login_required', failedStage: null, lastFailure: null,
        stages: { login: { status: 'pending', code: 'LOGIN_REQUIRED', at: now.toISOString() } }, authWorkId: null, scheduleIds: [] };
      assertOk(await store.recordExtensionInstall({ name: 'testext', version: '1', now }), '설치 등록');
      assertOk(await store.writeExtensionInstallProgress({ expectedRevision: null, progress }), '로그인 기록');
      const status = await store.getExtensionPublicStatus('testext'); assertOk(status, '공개 조회');
      assertEqual([status.status.installed, status.status.enabled, status.status.installResult, status.status.login?.status, status.status.login?.code], [true, true, 'login_required', 'pending', 'LOGIN_REQUIRED'], '로그인 미완료');
    });
  }), contractCase('공개 상태와 활성 변경은 비밀을 제외하고 멱등이다', async make => {
    await withSubject(make, async store => {
      const missing = await store.getExtensionPublicStatus('testext'); assertOk(missing, '미설치 조회');
      assertEqual([missing.status.installed, missing.status.journalPresent, missing.status.enabled], [false, false, null], '미설치 상태');
      assertEqual(await store.setExtensionEnabled({ name: 'testext', enabled: false, now }), { ok: true, found: false, changed: false }, '미설치 변경');
      assertOk(await store.recordExtensionInstall({ name: 'testext', version: '1', now }), '설치');
      assertOk(await store.recordExtensionConnection({ name: 'testext', status: 'failed', code: 'REFUSED', message: 'password=secret-canary', checkedAt: now }), '연결 실패');
      assertEqual(await store.setExtensionEnabled({ name: 'testext', enabled: false, now }), { ok: true, found: true, changed: true }, '비활성');
      assertEqual(await store.setExtensionEnabled({ name: 'testext', enabled: false, now: next }), { ok: true, found: true, changed: false }, '반복 비활성');
      const disabled = await store.getExtensionPublicStatus('testext'); assertOk(disabled, '공개 상태');
      assertEqual([disabled.status.enabled, disabled.status.connection.code, JSON.stringify(disabled).includes('secret-canary')], [false, 'REFUSED', false], '안전한 상태');
      assertEqual(await store.setExtensionEnabled({ name: 'testext', enabled: true, now: next }), { ok: true, found: true, changed: true }, '활성');
      assertEqual(await store.setExtensionEnabled({ name: 'testext', enabled: true, now: next }), { ok: true, found: true, changed: false }, '반복 활성');
    });
  }), contractCase('설치 전 진행 기록을 저장하고 오래되거나 안전하지 않은 쓰기를 거부한다', async make => {
    await withSubject(make, async store => {
      const progress: ExtensionInstallProgress = { name: 'testext', packageDigest: 'a'.repeat(64), result: 'failed', failedStage: 'migration', lastFailure: { stage: 'migration', code: 'MIGRATION_FAILED', at: now.toISOString() }, stages: { package: { status: 'succeeded', code: null, at: now.toISOString() }, migration: { status: 'failed', code: 'MIGRATION_FAILED', at: next.toISOString() } }, authWorkId: null, scheduleIds: [] };
      assertEqual(await store.getExtensionInstallProgress('testext'), { ok: true, journal: null }, '기록 없음');
      assertEqual(await store.writeExtensionInstallProgress({ expectedRevision: null, progress }), { ok: true, written: true, revision: 1 }, '생성');
      assertEqual(await store.getExtension('testext'), { ok: true, extension: null }, '진행 기록은 설치 행을 만들지 않음');
      const publicJournal = await store.getExtensionPublicStatus('testext'); assertOk(publicJournal, '설치 전 공개 진행');
      assertEqual([publicJournal.status.installed, publicJournal.status.journalPresent, publicJournal.status.installResult, publicJournal.status.failedStage, publicJournal.status.lastFailure?.code], [false, true, 'failed', 'migration', 'MIGRATION_FAILED'], '설치 전 실패 구분');
      assertEqual(JSON.stringify(publicJournal).includes(progress.packageDigest), false, '패키지 내부 정보 제외');
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
