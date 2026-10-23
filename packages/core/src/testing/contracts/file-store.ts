import { brainLocator, contentHashOfBytes, isBrainLocator, type FileLocation } from '../../domain/file.js';
import type { FileStore } from '../../ports/file-store.js';
import { assertEqual, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

export function fileStoreContract(): ContractCase<FileStore>[] {
  return [contractCase('파일은 내용으로 주소를 정하고 원본을 왕복하며 삭제는 멱등이다', async make => withSubject(make, async store => {
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,1,2]);
    for (const [head, ext] of [
      [[255,216,255], '.jpg'], [[71,73,70,56,57,97], '.gif'],
      [[82,73,70,70,0,0,0,0,87,69,66,80], '.webp'], [[1,2,3], ''],
    ] as const) {
      const data = Uint8Array.from(head);
      const stored = await store.put(data); assertOk(stored, '형식별 저장');
      const hash = contentHashOfBytes(data).slice(7);
      assertEqual(stored.location.locator, `${hash.slice(0,2)}/${hash.slice(2,4)}/${hash}${ext}`, '바이트 머리 확장자');
    }
    const put = await store.put(bytes);
    assertOk(put, '파일 저장');
    assertEqual(put.contentHash, contentHashOfBytes(bytes), '바이트 해시');
    assertEqual(put.sizeBytes, bytes.length, '바이트 크기');
    assertEqual(put.location, { storeKind: 'local', ownership: 'brain', locator: brainLocator(put.contentHash.slice(7), bytes) }, '파일 위치');
    assertTrue(isBrainLocator(put.location.locator), 'locator 문법');
    const again = await store.put(bytes);
    assertOk(again, '다시 저장');
    assertEqual(again.location, put.location, '같은 내용의 위치');
    const got = await store.get(put.location);
    assertOk(got, '원본 읽기');
    assertEqual(Array.from(got.bytes), Array.from(bytes), '원본 바이트');
    assertEqual(await store.exists(put.location), { ok: true, exists: true }, '존재');
    const url = await store.url(put.location);
    assertOk(url, 'URL');
    assertTrue(url.url.length > 0, 'URL 비어 있지 않음');
    assertEqual(await store.delete(put.location), { ok: true, deleted: true }, '첫 삭제');
    assertEqual(await store.delete(put.location), { ok: true, deleted: false }, '다시 삭제');
    assertEqual(await store.exists(put.location), { ok: true, exists: false }, '없는 파일');
    const missing = await store.get(put.location);
    assertTrue(!missing.ok && missing.code === 'FILE_NOT_FOUND', '없는 원본');
  })), contractCase('저장소 밖 위치는 모든 읽기와 삭제에서 거부한다', async make => withSubject(make, async store => {
    const put = await store.put(Uint8Array.of(1));
    assertOk(put, '저장');
    const invalid: FileLocation[] = [
      { ...put.location, ownership: 'external' }, { ...put.location, storeKind: 'drive' },
      { ...put.location, locator: '../outside' }, { ...put.location, locator: 'invalid' }, { ...put.location, locator: put.location.locator + '\n' },
    ];
    for (const l of invalid) for (const op of [store.get, store.delete, store.exists, store.url]) {
      const result = await op(l);
      assertTrue(!result.ok && result.code === 'LOCATION_REFUSED', '위치 거부');
    }
    assertEqual(await store.exists(put.location), { ok: true, exists: true }, '원본 보존');
  }))];
}
