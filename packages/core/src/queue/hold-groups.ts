import type { Clock } from '../ports/clock.js';
import type { WorkStore } from '../ports/store.js';
const invalid = (group: string) => group.trim() === '' || [...group].length > 200;
const usage = { ok: false as const, code: 'USAGE' as const, message: '보류 그룹 이름은 공백뿐일 수 없으며 200자 이하여야 합니다' };
export async function holdWorkGroup({ store, clock }: { store: Pick<WorkStore, 'holdWorkGroup'>; clock: Clock }, { group }: { group: string }) {
  if (invalid(group)) return usage;
  const result = await store.holdWorkGroup({ group, now: clock.now() });
  return result.ok ? { ...result, group } : result;
}
export async function releaseWorkGroup({ store }: { store: Pick<WorkStore, 'releaseWorkGroup'> }, { group }: { group: string }) {
  if (invalid(group)) return usage;
  const result = await store.releaseWorkGroup({ group });
  return result.ok ? { ...result, group } : result;
}
