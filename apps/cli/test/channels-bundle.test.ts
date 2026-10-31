import { expect, it } from 'vitest';
import { channelFixture } from './channel-fixture.js';

type Fixture = Awaited<ReturnType<typeof channelFixture>>;
// 실제 자식 프로세스 정리 기한이 지나도록 흐르는 시계를 사용한다.
const bundleFixture = () => channelFixture('success', 'running');
async function file(f: Fixture, bytes: Uint8Array, filename = 'report.bin') {
  const saved = await f.files.put(bytes); if (!saved.ok) throw Error(saved.message);
  return { location: saved.location, filename };
}
async function insert(f: Fixture, bundle: import('second_brain').ChannelBundle) {
  const input = { ...f.input, id: f.ids.next(), producerResultId: f.ids.next(), bundle };
  const created = await f.store.createChannelRequest(input); if (!created.ok) throw Error(created.message);
  return input;
}
const timeout = 30000;
async function done(f: Fixture, id: string) {
  await expect.poll(async () => f.store.readChannelRequest(id), { timeout }).toMatchObject({ request: { status: 'sent' } });
}
async function failed(f: Fixture, id: string) {
  await expect.poll(async () => f.db.rows<{ outcome: string }>(`select outcome from brain.work_items where target_id='${id}'`), { timeout }).toMatchObject([{ outcome: 'failed' }]);
}
it('요약·두 앨범·전문을 순서대로 전송하고 바이트·가림·응답 id·DB 원문을 보존한다', async () => {
  const f = await bundleFixture();
  try {
    const photo = await file(f, Buffer.from([0, 255, 1, 2]), 'photo.jpg');
    const doc = await file(f, Buffer.from([4, 3, 2, 0, 255]), 'full.txt');
    const bundle = { summary: 'password: secret123456', albums: [{ photos: [photo], caption: 'password: secret123456' }, { photos: [photo, photo], caption: 'password: secret123456' }], document: doc };
    const input = await insert(f, bundle); await f.start(); await done(f, input.id);
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendDocument']);
    for (const r of f.requests) expect(r.body).not.toContain('secret123456');
    expect(f.requests[0]!.body).toContain('[REDACTED:');
    for (const r of f.requests.slice(1)) expect(r.contentType).toContain('multipart/form-data; boundary=');
    expect(f.requests[1]!.bytes.includes(Buffer.from([0, 255, 1, 2]))).toBe(true);
    expect(f.requests[2]!.bytes.includes(Buffer.from([0, 255, 1, 2]))).toBe(true);
    expect(f.requests[2]!.body).toContain('attach://photo0'); expect(f.requests[2]!.body).toContain('attach://photo1');
    expect(f.requests[3]!.bytes.includes(Buffer.from([4, 3, 2, 0, 255]))).toBe(true);
    expect(await f.store.readChannelRequest(input.id)).toMatchObject({ request: { bundle, text: input.text, status: 'sent' } });
    expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [
      { index: 0, result: { outcome: 'sent', externalMessageId: '987' } }, { index: 1, result: { outcome: 'sent', externalMessageId: '987' } },
      { index: 2, result: { outcome: 'sent', externalMessageIds: ['987', '988'] } }, { index: 3, result: { outcome: 'sent', externalMessageId: '987' } },
    ] });
  } finally { await f.close(); }
}, 60000);

it('둘째 앨범 연결 단절 후 데몬 재시작 시 성공 항목을 건너뛰고 재개한다', async () => {
  const f = await bundleFixture();
  try {
    const photo = await file(f, Buffer.from('photo')); const doc = await file(f, Buffer.from('document'));
    const bundle = { summary: 'summary', albums: [{ photos: [photo] }, { photos: [photo, photo] }], document: doc };
    const input = await insert(f, bundle); f.disconnectOnRequest(3); await f.start();
    await expect.poll(async () => f.store.listChannelItemResults(input.id), { timeout }).toMatchObject({ items: [{ result: { outcome: 'sent' } }, { result: { outcome: 'sent' } }, { result: { outcome: 'unknown' } }] });
    await expect.poll(async () => f.db.rows<{ current_attempt_token: string | null }>(`select current_attempt_token from brain.work_items where target_id='${input.id}'`), { timeout }).toMatchObject([{ current_attempt_token: null }]);
    await f.stop(); await f.start(); f.advance(2000); await done(f, input.id);
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendMediaGroup', 'sendDocument']);
    expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [0, 1, 2, 3].map(index => ({ index, result: { outcome: 'sent' } })) });
  } finally { await f.close(); }
}, 60000);

it.each([4096, 4097])('UTF-16 텍스트 %i 단위 경계를 HTTP와 영구 실패로 검증한다', async length => {
  const f = await bundleFixture();
  try {
    const doc = await file(f, Buffer.from('doc')); const input = await insert(f, { summary: 'x'.repeat(length), albums: [], document: doc });
    await f.start();
    if (length === 4096) { await done(f, input.id); expect(f.requests).toHaveLength(2); }
    else { await failed(f, input.id); expect(f.requests).toHaveLength(0); expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [{ result: { outcome: 'definite_failed', code: 'too_large', retryable: false } }] }); }
  } finally { await f.close(); }
}, 60000);

it.each([0, 1, 2, 10, 11])('앨범 %i장의 메서드 선택과 범위 초과를 검증한다', async count => {
  const f = await bundleFixture();
  try {
    const photo = await file(f, Buffer.from('photo')); const doc = await file(f, Buffer.from('doc'));
    const input = await insert(f, { summary: 'summary', albums: [{ photos: Array(count).fill(photo) }], document: doc }); await f.start();
    if (count === 0 || count === 11) { await failed(f, input.id); expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage']); expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [{ result: { outcome: 'sent' } }, { result: { code: 'too_large', retryable: false } }] }); }
    else { await done(f, input.id); expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage', count === 1 ? 'sendPhoto' : 'sendMediaGroup', 'sendDocument']); }
  } finally { await f.close(); }
}, 60000);

it.each([['photo', 10], ['document', 50]] as const)('%s %iMiB 포함 및 초과는 multipart 성공과 HTTP 없는 too_large다', async (kind, mib) => {
  for (const extra of [0, 1]) {
    const f = await bundleFixture();
    try {
      const large = await file(f, Buffer.alloc(mib * 1024 * 1024 + extra, 65)); const small = await file(f, Buffer.from('small'));
      const input = await insert(f, { summary: 'summary', albums: kind === 'photo' ? [{ photos: [large] }] : [], document: kind === 'document' ? large : small }); await f.start();
      if (!extra) { await done(f, input.id); expect(f.requests.some(r => r.url.endsWith(kind === 'photo' ? '/sendPhoto' : '/sendDocument') && r.bytes.includes(Buffer.alloc(1024, 65)))).toBe(true); }
      else { await failed(f, input.id); expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage']); expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [{ result: { outcome: 'sent' } }, { result: { code: 'too_large', retryable: false } }] }); }
    } finally { await f.close(); }
  }
}, 120000);

it('허용되지 않는 FileStore 위치는 파일 HTTP 없이 거부한다', async () => {
  const f = await bundleFixture();
  try {
    const doc = await file(f, Buffer.from('doc'));
    const bad = { location: { storeKind: 'local' as const, ownership: 'brain' as const, locator: '../outside' }, filename: 'bad' };
    const input = await insert(f, { summary: 'summary', albums: [{ photos: [bad] }], document: doc }); await f.start();
    await failed(f, input.id);
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage']);
    expect(await f.store.listChannelItemResults(input.id)).toMatchObject({ items: [{ result: { outcome: 'sent' } }, { result: { code: 'LOCATION_REFUSED' } }] });
  } finally { await f.close(); }
}, 60000);
