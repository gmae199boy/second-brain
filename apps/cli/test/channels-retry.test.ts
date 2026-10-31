import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { channelFixture } from './channel-fixture.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

const timeout = 15000;
type Fixture = Awaited<ReturnType<typeof channelFixture>>;
async function attempts(f: Fixture) {
  return f.db.rows<{ outcome: string | null; error_code: string | null; attempt_token: string }>('select outcome,error_code,attempt_token from brain.channel_attempt_results order by created_at,attempt_token');
}
async function failed(f: Fixture, count: number) {
  await expect.poll(async () => (await attempts(f)).filter(a => a.outcome !== null).length, { timeout }).toBe(count);
  await expect.poll(async () => (await f.db.rows<{ current_attempt_token: string | null }>("select current_attempt_token from brain.work_items where kind='channel_send'"))[0]?.current_attempt_token, { timeout }).toBeNull();
}
async function checkProducer(f: Fixture, before: Awaited<ReturnType<Fixture['producer']>>) { expect(await f.producer()).toEqual(before); }

it.each([
  ['disconnect', 'unknown', 'network_unknown'],
  ['broken', 'unknown', 'invalid_response'],
  ['bad-ok', 'unknown', 'invalid_response'],
  ['500', 'definite_failed', 'http_5xx'],
  ['429', 'definite_failed', 'http_429'],
] as const)('%s 이후 같은 요청을 새 시도로 재발신한다', async (mode, outcome, code) => {
  const f = await channelFixture(mode);
  try {
    const before = await f.producer(); await f.store.createChannelRequest(f.input); await f.start();
    await failed(f, 1);
    expect((await attempts(f))[0]).toMatchObject({ outcome, error_code: code });
    expect(f.requests).toHaveLength(1); await checkProducer(f, before);
    f.setMode('success');
    if (mode === '429') { f.advance(6999); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1); f.advance(1); }
    else f.advance(1000);
    await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } });
    expect(f.requests).toHaveLength(2); expect(f.requests[0]!.body).toBe(f.requests[1]!.body);
    const history = await attempts(f); expect(history).toHaveLength(2); expect(history[1]!.outcome).toBe('sent'); expect(history[0]!.attempt_token).not.toBe(history[1]!.attempt_token);
    expect(await f.db.rows('select request_id from brain.channel_gates')).toHaveLength(1); await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

it('연결 전 거부를 기록하고 같은 요청을 재발신한다', async () => {
  const f = await channelFixture();
  try {
    const before = await f.producer(); await f.offline(); await f.store.createChannelRequest(f.input); await f.start(); await failed(f, 1);
    expect((await attempts(f))[0]).toMatchObject({ outcome: 'definite_failed', error_code: 'network_before_send' });
    await checkProducer(f, before); await f.online(); f.advance(1000);
    await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } });
    expect(f.requests).toHaveLength(1); expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1); await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

it.each(['400', 'config', 'too_large'] as const)('%s 영구 실패는 한 번으로 닫히고 doctor에 요청이 보인다', async mode => {
  const f = await channelFixture(mode === '400' ? '400' : 'success');
  try {
    const before = await f.producer(); await f.store.createChannelRequest(mode === 'too_large' ? { ...f.input, text: 'x'.repeat(4097) } : f.input); await f.start(mode !== 'config');
    await failed(f, 1); expect(await f.db.rows("select attempts,outcome from brain.work_items where kind='channel_send'")).toMatchObject([{ attempts: 1, outcome: 'failed' }]);
    const failures = await f.db.rows<{ target_id: string }>("select target_id from brain.failures where target_kind='channel_request'"); expect(failures).toMatchObject([{ target_id: f.input.id }]);
    const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id);
    f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 150)); expect(await attempts(f)).toHaveLength(1); expect(f.requests).toHaveLength(mode === '400' ? 1 : 0); await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

it('일시 실패 열 번은 failures와 doctor에 요청을 남긴다', async () => {
  const f = await channelFixture('500');
  try {
    const before = await f.producer(); await f.store.createChannelRequest(f.input); await f.start();
    for (let n = 1; n <= 10; n++) { await failed(f, n); await checkProducer(f, before); if (n < 10) f.advance(2 ** (n - 1) * 1000); }
    expect(f.requests).toHaveLength(10); expect(await f.db.rows("select attempts,outcome from brain.work_items where kind='channel_send'")).toMatchObject([{ attempts: 10, outcome: 'failed' }]);
    expect(await f.db.rows("select target_id from brain.failures where target_kind='channel_request'")).toMatchObject([{ target_id: f.input.id }]);
    const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id);
    f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 150)); expect(f.requests).toHaveLength(10);
  } finally { await f.close(); }
}, 60000);

it.each(['receipt', 'before-finish', 'after-finish'] as const)('%s 경계에서 실제 worker 종료 후 안전하게 수렴한다', async stage => {
  const f = await channelFixture(stage === 'receipt' ? 'hold' : 'success');
  try {
    const before = await f.producer(); await f.store.createChannelRequest(f.input);
    await f.start(true, stage === 'receipt' ? undefined : stage);
    if (stage === 'receipt') await expect.poll(() => f.requests.length, { timeout }).toBe(1);
    else await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
    const current = await f.db.rows<{ pid: number; token: string; work_item_id: string }>("select pid,token,work_item_id from brain.work_attempts where outcome is null and pid is not null");
    expect(current).toHaveLength(1);
    if (stage === 'after-finish') expect((await attempts(f))[0]?.outcome).toBe('sent');
    process.kill(current[0]!.pid, 'SIGKILL');
    await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>(`select outcome from brain.work_attempts where token='${current[0]!.token}'`))[0]?.outcome, { timeout }).toBe(stage === 'after-finish' ? 'succeeded' : 'died');
    expect(await f.store.finishChannelAttempt({ requestId: f.input.id, workItemId: current[0]!.work_item_id, attemptToken: current[0]!.token, now: new Date(), externalMessageId: 'stale' })).toEqual({ ok: true, outcome: 'lost' });
    await checkProducer(f, before); f.setMode('success'); f.advance(1000);
    await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } });
    await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>("select outcome from brain.work_items where kind='channel_send'"))[0]?.outcome, { timeout }).toBe('succeeded');
    expect(f.requests).toHaveLength(stage === 'after-finish' ? 1 : 2);
    if (stage !== 'after-finish') { expect(f.requests[0]!.body).toBe(f.requests[1]!.body); expect((await attempts(f)).map(a => a.outcome)).toEqual(['unknown', 'sent']); }
    expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1); await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

async function prepareAttempt(f: Fixture, count: number) {
  await f.store.createChannelRequest(f.input);
  const handoff = await f.store.handoffChannelRequest({ requestId: f.input.id, workId: f.ids.next(), now: f.now() });
  if (!handoff.ok || !handoff.workItemId) throw Error('채널 인계 실패');
  for (let n = 1; n < count; n++) {
    const token = f.ids.next(); const now = f.now();
    await f.store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'old', attemptToken: token });
    await f.store.finishSupervisedWork({ id: handoff.workItemId, attemptToken: token, now, outcome: 'failed', nextAttemptAt: now });
  }
  return handoff.workItemId;
}

it.each([1, 10])('실행 중 %i번째 시도에서 저장 결과를 우선한다', async count => {
  for (const mode of ['sent', 'permanent', 'unresolved'] as const) {
    const f = await channelFixture(mode === 'unresolved' ? 'hold' : mode === 'permanent' ? '400' : 'success');
    try {
      const before = await f.producer(); await prepareAttempt(f, count);
      await f.start(true, mode === 'unresolved' ? undefined : 'after-finish');
      if (mode === 'unresolved') await expect.poll(() => f.requests.length, { timeout }).toBe(1);
      else await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
      const [running] = await f.db.rows<{ pid: number; token: string; work_item_id: string }>("select pid,token,work_item_id from brain.work_attempts where outcome is null and pid is not null");
      if (!running) throw Error('실행 중 worker가 없습니다');
      process.kill(running.pid, 'SIGKILL');
      await expect.poll(async () => (await f.db.rows<{ current_attempt_token: string | null }>("select current_attempt_token from brain.work_items where kind='channel_send'"))[0]?.current_attempt_token, { timeout }).toBeNull();
      const rows = await f.db.rows<{ outcome: string; finished_at: Date | null }>(`select outcome,finished_at from brain.channel_attempt_results where attempt_token='${running.token}'`);
      expect(rows[0]?.outcome).toBe(mode === 'sent' ? 'sent' : mode === 'permanent' ? 'definite_failed' : 'unknown'); expect(rows[0]?.finished_at).not.toBeNull();
      await checkProducer(f, before); f.setMode('success');
      if (mode === 'unresolved' && count === 1) { f.advance(1000); await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>("select outcome from brain.work_items where kind='channel_send'"))[0]?.outcome, { timeout }).toBe('succeeded'); }
      else await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>("select outcome from brain.work_items where kind='channel_send'"))[0]?.outcome, { timeout }).toBe(mode === 'sent' ? 'succeeded' : 'failed');
      f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 120));
      expect(f.requests).toHaveLength(mode === 'unresolved' && count === 1 ? 2 : 1);
      const failures = await f.db.rows<{ target_id: string; code: string }>("select target_id,code from brain.failures where target_kind='channel_request'");
      expect(failures).toHaveLength(mode === 'permanent' || (mode === 'unresolved' && count === 10) ? 1 : 0);
      if (failures.length) { expect(failures[0]).toMatchObject({ target_id: f.input.id, code: mode === 'permanent' ? 'CHANNEL_HTTP_4XX' : 'INTERRUPTED' }); const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id); }
      expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1); await checkProducer(f, before);
    } finally { await f.close(); }
  }
}, 60000);

it.each([1, 10])('감독자 재시작이 %i번째 실제 worker의 저장 결과를 우선한다', async count => {
  for (const mode of ['sent', 'permanent', 'unresolved'] as const) {
    const f = await channelFixture(mode === 'unresolved' ? 'hold' : mode === 'permanent' ? '400' : 'success');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const before = await f.producer(); const work = await prepareAttempt(f, count); const token = f.ids.next();
      const claim = await f.store.claimSupervisedWork({ now: f.now(), kinds: ['channel_send'], claimedBy: '이전 감독자', attemptToken: token });
      if (!claim.ok || !claim.item) throw Error('이전 시도 청구 실패');
      child = spawn(process.execPath, [fileURLToPath(new URL('../dist/workers/channel-send.js', import.meta.url))], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...withoutHarnessFolders(process.env), BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: f.db.appUrl, BRAIN_WORK_ID: work,
        BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: 'channel_send', BRAIN_TARGET_KIND: 'channel_request', BRAIN_TARGET_ID: f.input.id,
        BRAIN_RUN_GENERATION: String(count), BRAIN_TELEGRAM_BOT_TOKEN: 'test-token', BRAIN_TELEGRAM_CHAT_ID: 'test-chat',
        BRAIN_CHANNEL_TEST_ENDPOINT: f.endpoint, ...(mode === 'unresolved' ? {} : { BRAIN_CHANNEL_TEST_BARRIER: 'after-finish' }),
      } });
      if (!child.pid) throw Error('worker 시작 실패');
      const exit = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', () => resolve()); });
      await f.store.recordSupervisedProcess({ id: work, attemptToken: token, pid: child.pid, pgid: child.pid, osBootAt: null, osStartedAt: null });
      if (mode === 'unresolved') await expect.poll(() => f.requests.length, { timeout }).toBe(1);
      else await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
      child.kill('SIGKILL'); await exit; child = undefined;
      f.setMode('success'); await f.start();
      await expect.poll(async () => (await f.db.rows<{ current_attempt_token: string | null }>(`select current_attempt_token from brain.work_items where id='${work}'`))[0]?.current_attempt_token, { timeout }).toBeNull();
      const rows = await f.db.rows<{ outcome: string; finished_at: Date | null }>(`select outcome,finished_at from brain.channel_attempt_results where attempt_token='${token}'`);
      expect(rows[0]?.outcome).toBe(mode === 'sent' ? 'sent' : mode === 'permanent' ? 'definite_failed' : 'unknown'); expect(rows[0]?.finished_at).not.toBeNull();
      if (mode === 'unresolved' && count === 1) { f.advance(1000); await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome, { timeout }).toBe('succeeded'); }
      else await expect.poll(async () => (await f.db.rows<{ outcome: string | null }>(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome, { timeout }).toBe(mode === 'sent' ? 'succeeded' : 'failed');
      f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 120));
      expect(f.requests).toHaveLength(mode === 'unresolved' && count === 1 ? 2 : 1);
      const failures = await f.db.rows<{ target_id: string; code: string }>("select target_id,code from brain.failures where target_kind='channel_request'");
      expect(failures).toHaveLength(mode === 'permanent' || (mode === 'unresolved' && count === 10) ? 1 : 0);
      if (failures.length) { expect(failures[0]).toMatchObject({ target_id: f.input.id, code: mode === 'permanent' ? 'CHANNEL_HTTP_4XX' : 'INTERRUPTED' }); const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id); }
      expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1); await checkProducer(f, before);
    } finally { if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill('SIGKILL'); await stopped; } await f.close(); }
  }
}, 60000);

it.each(['permanent', 'rate_limit', 'tenth_unknown'] as const)('정상 종료·재기동은 %s의 저장 계약을 보존한다', async scenario => {
  const f = await channelFixture(scenario === 'permanent' ? '400' : scenario === 'rate_limit' ? '429' : 'hold');
  try {
    const before = await f.producer(); await prepareAttempt(f, scenario === 'tenth_unknown' ? 10 : 1);
    await f.start(true, scenario === 'tenth_unknown' ? undefined : 'after-finish');
    if (scenario === 'tenth_unknown') await expect.poll(() => f.requests.length, { timeout }).toBe(1);
    else await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
    await f.stop(); await checkProducer(f, before);
    const history = await f.db.rows<{ outcome: string; finished_at: Date | null }>('select outcome,finished_at from brain.channel_attempt_results');
    expect(history[0]?.outcome).toBe(scenario === 'permanent' ? 'definite_failed' : scenario === 'rate_limit' ? 'definite_failed' : 'unknown');
    expect(history[0]?.finished_at).not.toBeNull();
    const beforeRestart = await f.db.rows<{ attempts: number; outcome: string | null; next_attempt_at: Date }>("select attempts,outcome,next_attempt_at from brain.work_items where kind='channel_send'");
    expect(beforeRestart).toMatchObject([{ attempts: scenario === 'tenth_unknown' ? 10 : 1, outcome: scenario === 'rate_limit' ? null : 'failed' }]);
    f.setMode('success'); await f.start();
    if (scenario === 'rate_limit') {
      const remaining = beforeRestart[0]!.next_attempt_at.getTime() - f.now().getTime();
      expect(remaining).toBeGreaterThan(1); f.advance(remaining - 1); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1);
      f.advance(1); await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } }); expect(f.requests).toHaveLength(2);
    } else {
      f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1);
      const failures = await f.db.rows<{ target_id: string; code: string }>("select target_id,code from brain.failures where target_kind='channel_request'");
      expect(failures).toMatchObject([{ target_id: f.input.id, code: scenario === 'permanent' ? 'CHANNEL_HTTP_4XX' : 'INTERRUPTED' }]);
      const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id);
    }
    await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

it.each(['permanent', 'rate_limit', 'tenth_unknown'] as const)('보류와 해제는 %s의 저장 계약을 보존한다', async scenario => {
  const f = await channelFixture(scenario === 'permanent' ? '400' : scenario === 'rate_limit' ? '429' : 'hold');
  try {
    const before = await f.producer(); const work = await prepareAttempt(f, scenario === 'tenth_unknown' ? 10 : 1);
    await f.db.query(`update brain.work_items set hold_group='channel-test' where id='${work}'`);
    await f.start(true, scenario === 'tenth_unknown' ? undefined : 'after-finish');
    if (scenario === 'tenth_unknown') await expect.poll(() => f.requests.length, { timeout }).toBe(1);
    else await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
    await f.store.holdWorkGroup({ group: 'channel-test', now: f.now() });
    await expect.poll(async () => (await f.db.rows<{ current_attempt_token: string | null }>(`select current_attempt_token from brain.work_items where id='${work}'`))[0]?.current_attempt_token, { timeout }).toBeNull();
    const history = await f.db.rows<{ outcome: string; finished_at: Date | null }>('select outcome,finished_at from brain.channel_attempt_results');
    expect(history[0]?.outcome).toBe(scenario === 'tenth_unknown' ? 'unknown' : 'definite_failed'); expect(history[0]?.finished_at).not.toBeNull();
    const [item] = await f.db.rows<{ attempts: number; outcome: string | null; next_attempt_at: Date }>(`select attempts,outcome,next_attempt_at from brain.work_items where id='${work}'`);
    expect(item).toMatchObject({ attempts: scenario === 'tenth_unknown' ? 10 : 1, outcome: scenario === 'rate_limit' ? null : 'failed' });
    f.setMode('success'); await f.store.releaseWorkGroup({ group: 'channel-test' });
    if (scenario === 'rate_limit') {
      const remaining = item!.next_attempt_at.getTime() - f.now().getTime(); expect(remaining).toBeGreaterThan(1);
      f.advance(remaining - 1); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1);
      f.advance(1); await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } }); expect(f.requests).toHaveLength(2);
    } else {
      f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1);
      const failures = await f.db.rows<{ target_id: string; code: string }>("select target_id,code from brain.failures where target_kind='channel_request'");
      expect(failures).toMatchObject([{ target_id: f.input.id, code: scenario === 'permanent' ? 'CHANNEL_HTTP_4XX' : 'INTERRUPTED' }]);
      const doctor = await runPgCommand(['doctor', 'run', '--json'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home }); expect(doctor.stdout).toContain(f.input.id);
    }
    await checkProducer(f, before);
  } finally { await f.close(); }
}, 30000);

it('마지막 허용 시도에서 전체 항목 저장 직후 worker 종료를 추가 HTTP 없이 성공으로 정산한다', async () => {
  const f = await channelFixture();
  try {
    const saved = await f.files.put(Buffer.from('document')); if (!saved.ok) throw Error(saved.message);
    const doc = { location: saved.location, filename: 'report.txt' };
    const bundle = { summary: 'summary', albums: [], document: doc };
    await f.store.createChannelRequest({ ...f.input, bundle });
    const handoff = await f.store.handoffChannelRequest({ requestId: f.input.id, workId: f.ids.next(), now: f.now() });
    if (!handoff.ok || !handoff.workItemId) throw Error('인계 실패');
    for (let n = 1; n < 10; n++) { const token = f.ids.next(), now = f.now(); await f.store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'old', attemptToken: token }); await f.store.finishSupervisedWork({ id: handoff.workItemId, attemptToken: token, now, outcome: 'failed', nextAttemptAt: now }); }
    await f.start(true, 'before-finish'); await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
    const [running] = await f.db.rows<{ pid: number; token: string }>("select pid,token from brain.work_attempts where outcome is null and pid is not null");
    if (!running) throw Error('worker가 없습니다');
    expect(await f.store.listChannelItemResults(f.input.id)).toMatchObject({ items: [{ result: { outcome: 'sent' } }, { result: { outcome: 'sent', externalMessageId: '987' } }] });
    process.kill(running.pid, 'SIGKILL');
    await expect.poll(async () => f.db.rows<{ outcome: string }>(`select outcome from brain.work_items where id='${handoff.workItemId}'`), { timeout }).toMatchObject([{ outcome: 'succeeded' }]);
    expect(await f.store.readChannelRequest(f.input.id)).toMatchObject({ request: { status: 'sent', externalMessageId: '987' } });
    expect(await f.db.rows(`select outcome,external_message_id from brain.channel_attempt_results where attempt_token='${running.token}'`)).toMatchObject([{ outcome: 'sent', external_message_id: '987' }]);
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendMessage', 'sendDocument']);
    expect(await f.db.rows(`select id from brain.failures where target_id='${f.input.id}'`)).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);

it.each(['too_large', 'http_429'] as const)('항목 %s 저장 직후 worker 종료 시 실패 정책을 보존한다', async code => {
  const f = await channelFixture(code === 'http_429' ? '429' : 'success');
  try {
    const saved = await f.files.put(Buffer.from('document')); if (!saved.ok) throw Error(saved.message);
    const bundle = { summary: code === 'too_large' ? 'x'.repeat(4097) : 'summary', albums: [], document: { location: saved.location, filename: 'report.txt' } };
    await f.store.createChannelRequest({ ...f.input, bundle });
    await f.start(true, 'before-finish'); await expect.poll(() => f.barriers.length, { timeout }).toBe(1);
    const [running] = await f.db.rows<{ pid: number; token: string }>('select pid,token from brain.work_attempts where outcome is null and pid is not null');
    if (!running) throw Error('worker가 없습니다');
    expect(await f.store.listChannelItemResults(f.input.id)).toMatchObject({ items: [{ result: { outcome: 'definite_failed', code } }] });
    process.kill(running.pid, 'SIGKILL');
    await expect.poll(async () => (await f.db.rows<{ current_attempt_token: string | null }>("select current_attempt_token from brain.work_items where kind='channel_send'"))[0]?.current_attempt_token, { timeout }).toBeNull();
    expect(await f.db.rows(`select outcome,error_code,retryable,retry_after_ms from brain.channel_attempt_results where attempt_token='${running.token}'`)).toMatchObject([{ outcome: 'definite_failed', error_code: code, retryable: code === 'http_429', retry_after_ms: code === 'http_429' ? '7000' : null }]);
    const [work] = await f.db.rows<{ outcome: string | null; next_attempt_at: Date }>("select outcome,next_attempt_at from brain.work_items where kind='channel_send'");
    if (code === 'too_large') {
      expect(work?.outcome).toBe('failed'); f.advance(3_600_000); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(0);
    } else {
      expect(work?.outcome).toBeNull(); const remaining = work!.next_attempt_at.getTime() - f.now().getTime(); expect(remaining).toBeGreaterThanOrEqual(7000);
      f.setMode('success'); f.advance(remaining - 1); await new Promise(resolve => setTimeout(resolve, 200)); expect(f.requests).toHaveLength(1);
      f.advance(1); await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout }).toMatchObject({ request: { status: 'sent' } }); expect(f.requests).toHaveLength(3);
    }
  } finally { await f.close(); }
}, 30000);
