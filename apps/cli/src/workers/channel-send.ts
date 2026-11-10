import { PROCESS_ABI_ENV, decodeAbiEnv, sendChannelRequest } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { localFileStore } from '../runtime/file-store.js';
import { telegramSender } from '../adapters/telegram.js';

const env = process.env;
async function run(): Promise<void> {
  if (!decodeAbiEnv(env).ok || env[PROCESS_ABI_ENV.workKind] !== 'channel_send' ||
      env[PROCESS_ABI_ENV.targetKind] !== 'channel_request') {
    console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false }));
    process.exitCode = 2;
    return;
  }
  const store = postgresStore({ databaseUrl: env[PROCESS_ABI_ENV.databaseUrl]! });
  try {
    const barrier = async (stage: string) => {
      if (env['BRAIN_CHANNEL_TEST_ENDPOINT'] && env['BRAIN_CHANNEL_TEST_BARRIER'] === stage)
        await fetch(`${env['BRAIN_CHANNEL_TEST_ENDPOINT']}/test-barrier/${stage}`, { method: 'POST' });
    };
    const read = await store.readChannelRequest(env[PROCESS_ABI_ENV.targetId]!);
    if (!read.ok) throw Error('채널 요청 조회 실패');
    const credential = read.channel ? await store.channelControl!.credentials(read.channel.id) : null;
    if (credential && !credential.ok) throw Error('채널 자격 증명 조회 실패');
    // A channel credential is authoritative. Only pre-existing legacy channels use
    // global DB/.env config, and their conversation must still match that config.
    const token = credential?.ok ? credential.token : null;
    const legacy = !token && !read.channel?.botRef.startsWith('messenger:') &&
      read.conversation?.externalRef === env['BRAIN_TELEGRAM_CHAT_ID'];
    const resolvedToken = token ?? (legacy ? env['BRAIN_TELEGRAM_BOT_TOKEN'] : undefined);
    const sender = read.channel?.kind === 'telegram' && resolvedToken
      ? telegramSender(resolvedToken, env['BRAIN_CHANNEL_TEST_ENDPOINT'] ? { endpoint: env['BRAIN_CHANNEL_TEST_ENDPOINT'] } : {})
      : { async sendMessage() { return { ok: false as const, outcome: 'definite_failed' as const, code: 'CHANNEL_CONFIG_INVALID', retryable: false }; } };
    const sent = await sendChannelRequest({ store, sender,
      ...(env['BRAIN_CHANNEL_FILES_PATH'] ? { files: localFileStore({ root: env['BRAIN_CHANNEL_FILES_PATH'] }) } : {}),
      requestId: env[PROCESS_ABI_ENV.targetId]!, workItemId: env[PROCESS_ABI_ENV.workId]!,
      attemptToken: env[PROCESS_ABI_ENV.attemptToken]!, now: () => new Date(), beforeFinish: () => barrier('before-finish') });
    await barrier('after-finish');
    if (!sent.ok) {
      console.log(JSON.stringify({ abi: 1, type: 'error', code: /^[A-Z][A-Z0-9_]{0,63}$/.test(sent.code) ? sent.code : `CHANNEL_${sent.code.toUpperCase()}`, retryable: sent.retryable ?? true }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ abi: 1, type: 'result', summary: '채널 전송 완료' }));
  } finally {
    await store.close();
  }
}
await run().catch(() => {
  console.log(JSON.stringify({ abi: 1, type: 'error', code: 'CHANNEL_WORKER_FAILED', retryable: true }));
  process.exitCode = 2;
});
