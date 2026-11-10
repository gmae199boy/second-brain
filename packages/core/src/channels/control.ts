import type { ChannelBundle } from './store.js';
export type ChannelControlFailure = { ok: false; code: string; message: string };
export type ChannelRoute = { topic: string; messengerId: string; channelId: string };
/** Private storage capability; credential reads never form public CLI responses. */
export interface ChannelControlStore {
  inventory(): Promise<{ ok: true; messengers: { messengerId: string; name: string | null; kind: string; configured: boolean }[]; channels: { messengerId: string; channelId: string; name: string | null }[] } | ChannelControlFailure>;
  configureMessenger(input: { messengerId: string; kind: string; token: string; name?: string }): Promise<{ ok: true; messengerId: string } | ChannelControlFailure>;
  configureChannel(input: { channelId: string; messengerId: string; userId: string; chatId: string; threadId?: string; name?: string }): Promise<{ ok: true; messengerId: string; channelId: string } | ChannelControlFailure>;
  credentials(messengerId: string): Promise<{ ok: true; token: string | null } | ChannelControlFailure>;
  route(input: { action: 'set' | 'list' | 'remove'; topic?: string; messengerId?: string; channelId?: string }): Promise<{ ok: true; routes: ChannelRoute[] } | ChannelControlFailure>;
  send(input: { id: string; topic?: string; messengerId?: string; channelId?: string; key: string; text: string; now: Date; sendAt?: Date; bundle?: ChannelBundle }): Promise<{ ok: true; id: string } | ChannelControlFailure>;
  sendPending(input: { topic: string; id?: string; date?: string; now: Date }): Promise<{ ok: true; count: number } | ChannelControlFailure>;
  health(): Promise<{ ok: true; channels: number; configured: number; routes: number; unrouted: number; scheduled: number } | ChannelControlFailure>;
}
