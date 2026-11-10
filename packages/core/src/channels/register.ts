import { sha256Hex } from '../domain/sha256.js';
import { getSetting, type SettingsDependencies } from '../settings/index.js';
import { resolveSelfUser } from '../users/self.js';
import type { ChannelStore } from './store.js';

/** 자기 사용자·대상의 안정된 ID로 재시도와 동시 등록을 멱등 처리한다. */
function registrationId(parts: readonly string[]): string {
  const hash = sha256Hex(JSON.stringify(['brain.channels.add.v1', ...parts]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** 등록만 수행한다. 발신 요청이나 일감을 만들지 않는다. */
export async function registerTelegramChannel(deps: SettingsDependencies & { store: SettingsDependencies['store'] & Pick<ChannelStore, 'ensureChannel' | 'ensureChannelConversation'> }) {
  const chat = await getSetting(deps, { key: 'telegram.chat_id' });
  if (!chat.ok) return chat;
  if (!chat.value) return { ok: false as const, code: 'CONFIG_INVALID' as const, message: '먼저 brain config set telegram.chat_id <id>로 대상을 설정하세요' };
  const self = await resolveSelfUser(deps.store);
  if (!self.ok) return self;
  // [ASSUMPTION] 단일 Telegram 봇 설정을 비밀이 없는 고정 참조로 등록한다.
  const channel = await deps.store.ensureChannel({ id: registrationId(['telegram']), kind: 'telegram', botRef: 'telegram' });
  if (!channel.ok) return channel;
  const conversation = await deps.store.ensureChannelConversation({
    id: registrationId(['telegram', self.userId, chat.value]), userId: self.userId,
    channelId: channel.channel.id, externalRef: chat.value, threadRef: null,
  });
  return conversation.ok ? { ok: true as const, conversationId: conversation.conversation.id } : conversation;
}
