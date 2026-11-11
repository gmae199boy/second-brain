import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, normalizeTimeZone } from '../settings/index.js';
import { resolveSelfUser } from '../users/self.js';
import type { Store } from '../ports/store.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Clock } from '../ports/clock.js';
import type { ChannelControlStore } from './control.js';
const uuid = (id: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const ref = (value: string | undefined) => !!value && (uuid(value) || /^[a-z][a-z0-9_-]{0,63}$/.test(value));
const topic = (value: string | undefined) => !!value && /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(value) && value.length <= 200;
const invalid = () => ({ ok: false as const, code: 'INVALID_ARGUMENT', message: '채널 입력 형식이 올바르지 않습니다' });
const unavailable = () => ({ ok: false as const, code: 'CONFIG_INVALID', message: '채널 관리 저장소를 사용할 수 없습니다' });
export function channelManagement(store: Store, clock: Clock, ids: IdGen) {
  return {
    inventory: () => store.channelControl?.inventory() ?? Promise.resolve(unavailable()),
    async configureMessenger(input: { kind: string; token: string; messengerId?: string; name?: string }) {
      if ((input.name !== undefined && (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.name) || uuid(input.name))) || input.kind !== 'telegram' || !input.token || !TELEGRAM_BOT_TOKEN.normalize(input.token).ok || (input.messengerId !== undefined && !uuid(input.messengerId))) return invalid();
      return store.channelControl?.configureMessenger({ ...input, messengerId: input.messengerId ?? ids.next() }) ?? unavailable();
    },
    async configureChannel(input: { messengerId: string; chatId: string; channelId?: string; threadId?: string; name?: string }) {
      if ((input.name !== undefined && (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.name) || uuid(input.name))) || !ref(input.messengerId) || !input.chatId || !TELEGRAM_CHAT_ID.normalize(input.chatId).ok ||
        (input.channelId !== undefined && !uuid(input.channelId)) || (input.threadId !== undefined && !/^[1-9][0-9]*$/.test(input.threadId))) return invalid();
      if (!store.channelControl) return unavailable();
      const self = await resolveSelfUser(store); if (!self.ok) return self;
      return store.channelControl.configureChannel({ ...input, channelId: input.channelId ?? ids.next(), userId: self.userId });
    },
    async route(input: Parameters<ChannelControlStore['route']>[0]) {
      if (!['set','list','remove'].includes(input.action) || (input.action !== 'list' && !topic(input.topic)) || (input.action === 'set' && (!ref(input.messengerId) || !ref(input.channelId)))) return invalid();
      return store.channelControl?.route(input) ?? unavailable();
    },
    async subscribe(input: Parameters<ChannelControlStore['subscribe']>[0]) {
      if (!['set','list','remove'].includes(input.action) || (input.action !== 'list' && !topic(input.event)) ||
        (input.action === 'set' && (!ref(input.messengerId) || !ref(input.channelId))) ||
        (input.action !== 'set' && (input.at !== undefined || input.timeZone !== undefined)) ||
        (input.at !== undefined && input.at !== 'immediate' && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.at))) return invalid();
      const zone = input.timeZone === undefined ? undefined : normalizeTimeZone(input.timeZone);
      if (zone && (!zone.ok || (input.at ?? 'immediate') === 'immediate')) return invalid();
      return store.channelControl?.subscribe({ ...input, ...(zone?.ok ? { timeZone: zone.value } : {}) }) ?? unavailable();
    },
    async send(input: { topic?: string; messengerId?: string; channelId?: string; text: string; at?: string; key?: string }) {
      if ((input.topic !== undefined ? (!topic(input.topic) || input.messengerId !== undefined || input.channelId !== undefined) : (!ref(input.messengerId) || !ref(input.channelId))) || !input.text || input.text.length > 4000 || (input.key !== undefined && (!input.key || input.key.length > 512))) return invalid();
      const sendAt = input.at === undefined ? undefined : new Date(input.at);
      if (sendAt && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.at!) || !Number.isFinite(sendAt.getTime()))) return invalid();
      return store.channelControl?.send({ id: ids.next(), topic: input.topic, messengerId: input.messengerId, channelId: input.channelId, text: input.text, key: input.key ?? ids.next(), now: clock.now(), sendAt }) ?? unavailable();
    },
    async sendPending(input: { topic?: string; event?: string; id?: string; date?: string }) {
      if ((input.event !== undefined ? (!topic(input.event) || input.topic !== undefined) : !topic(input.topic)) || (input.id && !uuid(input.id)) || (input.id && input.date) ||
        (input.date && (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0,10) !== input.date))) return invalid();
      return store.channelControl?.sendPending({ ...input, now: clock.now() }) ?? unavailable();
    },
  };
}
