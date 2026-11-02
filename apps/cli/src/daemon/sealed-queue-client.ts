import { runQueueList } from '../commands/queue-list.js';
import { protectedQueueClient, type ProtectedQueueTransport } from './protected-queue.js';

/** 보호 transport의 OS 신원 확인은 호출자 책임이다. Store나 환경은 받지 않는다. */
export function sealedQueueList(options: Record<string, unknown>, transport?: ProtectedQueueTransport) {
  return runQueueList({ options, queue: protectedQueueClient(transport) });
}
