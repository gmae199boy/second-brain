import { PROCESS_ABI_ENV, decodeAbiEnv, sendChannelRequest } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { telegramSender } from '../adapters/telegram.js';

const env = process.env;
async function run(): Promise<void> {
  if (!decodeAbiEnv(env).ok || env[PROCESS_ABI_ENV.workKind] !== 'channel_send' ||
      env[PROCESS_ABI_ENV.targetKind] !== 'channel_request') {
    console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false }));
    process.exitCode = 2;
    return;
  }
  if (!env['BRAIN_TELEGRAM_BOT_TOKEN'] || !env['BRAIN_TELEGRAM_CHAT_ID']) {
    console.log(JSON.stringify({ abi: 1, type: 'error', code: 'CHANNEL_CONFIG_INVALID', retryable: false }));
    process.exitCode = 2;
    return;
  }
  const store = postgresStore({ databaseUrl: env[PROCESS_ABI_ENV.databaseUrl]! });
  try {
    const read = await store.readChannelRequest(env[PROCESS_ABI_ENV.targetId]!);
    if (!read.ok || read.channel?.kind !== 'telegram' || read.conversation?.externalRef !== env['BRAIN_TELEGRAM_CHAT_ID']) {
      console.log(JSON.stringify({ abi: 1, type: 'error', code: 'CHANNEL_CONFIG_INVALID', retryable: false }));
      process.exitCode = 2;
      return;
    }
    const sent = await sendChannelRequest({ store, sender: telegramSender(env['BRAIN_TELEGRAM_BOT_TOKEN'],
      env['BRAIN_CHANNEL_TEST_ENDPOINT'] ? { endpoint: env['BRAIN_CHANNEL_TEST_ENDPOINT'] } : {}),
      requestId: env[PROCESS_ABI_ENV.targetId]!, workItemId: env[PROCESS_ABI_ENV.workId]!,
      attemptToken: env[PROCESS_ABI_ENV.attemptToken]!, now: () => new Date() });
    if (!sent.ok) {
      console.log(JSON.stringify({ abi: 1, type: 'error', code: sent.code, retryable: false }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ abi: 1, type: 'result', summary: '채널 전송 완료' }));
  } finally {
    await store.close();
  }
}
await run().catch(() => {
  console.log(JSON.stringify({ abi: 1, type: 'error', code: 'CHANNEL_WORKER_FAILED', retryable: false }));
  process.exitCode = 2;
});
