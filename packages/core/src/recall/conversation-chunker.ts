import type { ChunkParams } from '../domain/index-config.js';

export interface ConversationMessage { id: string; occurredAt: Date; body: string }
export interface ConversationChunk { fromAt: Date; toAt: Date; body: string; part: number }

/** [ASSUMPTION] 일반 본문은 줄바꿈으로 결합하고 구분자도 길이에 센다. 목표에 도달한 시각 묶음 뒤에 닫으며 겹침만으로 새 조각을 만들지 않는다. */
export function chunkConversation(messages: readonly ConversationMessage[], params: ChunkParams): ConversationChunk[] {
  const { targetChars, overlapMessages, splitMessagesOverChars } = params;
  if (!Number.isSafeInteger(targetChars) || targetChars <= 0 || !Number.isSafeInteger(overlapMessages) || overlapMessages < 0 ||
      !Number.isSafeInteger(splitMessagesOverChars) || splitMessagesOverChars <= 0) throw new TypeError('잘못된 조각 설정');
  const sorted = [...messages].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups: ConversationMessage[][] = [];
  for (const message of sorted) {
    const last = groups.at(-1);
    if (last && last[0]!.occurredAt.getTime() === message.occurredAt.getTime()) last.push(message);
    else groups.push([message]);
  }
  const chunks: ConversationChunk[] = [];
  let pending: ConversationMessage[] = [];
  let fresh = false;
  const emit = () => {
    if (!fresh || !pending.length) return;
    chunks.push({ fromAt: pending[0]!.occurredAt, toAt: pending.at(-1)!.occurredAt, body: pending.map(m => m.body).join('\n'), part: 0 });
    fresh = false;
  };
  const overlap = (rows: ConversationMessage[]) => {
    if (overlapMessages === 0 || rows.length === 0) return [];
    const start = Math.max(0, rows.length - overlapMessages);
    const time = rows[start]!.occurredAt.getTime();
    return rows.filter(m => m.occurredAt.getTime() >= time);
  };
  for (const group of groups) {
    if (group.some(m => Array.from(m.body).length > splitMessagesOverChars)) {
      for (const message of group) {
        const chars = Array.from(message.body);
        if (chars.length <= splitMessagesOverChars) { pending.push(message); fresh = true; continue; }
        emit();
        const context = overlap(pending);
        for (let i = 0; i < chars.length; i += splitMessagesOverChars) {
          const prefix = i === 0 ? context : [];
          chunks.push({ fromAt: prefix[0]?.occurredAt ?? message.occurredAt, toAt: message.occurredAt,
            body: [...prefix.map(m => m.body), chars.slice(i, i + splitMessagesOverChars).join('')].join('\n'), part: 0 });
        }
        // 긴 본문 자체를 한 원래 메시지로 보존하되 겹침만으로 다시 내보내지 않는다.
        pending = overlap([...context, message]); fresh = false;
      }
    } else {
      pending.push(...group); fresh = true;
    }
    if (Array.from(pending.map(m => m.body).join('\n')).length >= targetChars) {
      emit(); pending = overlap(pending);
    }
  }
  emit();
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    const key = `${chunk.fromAt.toISOString()}/${chunk.toAt.toISOString()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = new Map<string, number>();
  for (const chunk of chunks) {
    const key = `${chunk.fromAt.toISOString()}/${chunk.toAt.toISOString()}`;
    if (counts.get(key)! > 1) { const part = (parts.get(key) ?? 0) + 1; parts.set(key, part); chunk.part = part; }
  }
  return chunks;
}
