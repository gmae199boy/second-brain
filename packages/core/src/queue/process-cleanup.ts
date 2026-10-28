import type { Clock, Timer } from '../ports/clock.js';
import type { ProcessHandle, ProcessInspector } from '../ports/process.js';
export interface GroupIdentity { pgid: number | null; osBootAt: Date | null; osStartedAt: Date | null }
const sameSecond = (a: Date, b: Date): boolean => Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
/** Shared identity rules for recovery and live cleanup. Never signal a reused group. */
export async function inspectGroup(inspector: ProcessInspector, identity: GroupIdentity): Promise<'ours' | 'died' | 'unknown'> {
  if (identity.pgid === null) return 'died';
  const boot = await inspector.bootTime();
  if (boot.state === 'found' && identity.osBootAt !== null && !sameSecond(boot.value, identity.osBootAt)) return 'died';
  const group = await inspector.groupMembers(identity.pgid);
  if (group.state === 'none') return 'died';
  if (group.state === 'unknown' || boot.state !== 'found' || identity.osBootAt === null) return 'unknown';
  const leader = group.value.find(member => member.pid === identity.pgid);
  if (leader === undefined) return 'ours';
  if (identity.osStartedAt === null) return 'unknown';
  return sameSecond(leader.startedAt, identity.osStartedAt) ? 'ours' : 'died';
}
export async function cleanProcessGroup(options: {
  inspector: ProcessInspector; identity: GroupIdentity; clock: Clock; timer: Timer;
  graceMs: number; confirmMs: number; handle?: ProcessHandle;
}): Promise<'died' | 'unknown'> {
  const { inspector, identity, clock, timer } = options;
  const state = await inspectGroup(inspector, identity);
  if (state === 'died') { if (options.handle) await options.handle.exited; return 'died'; }
  if (identity.pgid === null || (state === 'unknown' && (!options.handle || options.handle.leaderExited))) return 'unknown';
  const waiting = new AbortController();
  const send = async (signal: 'SIGTERM' | 'SIGKILL') => inspector.signalGroup(identity.pgid!, signal);
  if (await send('SIGTERM') === 'failed') return 'unknown';
  const graceEnd = clock.now().getTime() + options.graceMs;
  while (clock.now().getTime() < graceEnd) {
    const current = await inspectGroup(inspector, identity);
    if (current === 'died') { if (options.handle) await options.handle.exited; return 'died'; }
    if (current === 'unknown' && (!options.handle || options.handle.leaderExited)) return 'unknown';
    await timer.sleep(Math.max(0, Math.min(50, graceEnd - clock.now().getTime())), waiting.signal);
  }
  const remaining = await inspectGroup(inspector, identity);
  if (remaining !== 'died') {
    if (remaining === 'unknown' && (!options.handle || options.handle.leaderExited)) return 'unknown';
    if (await send('SIGKILL') === 'failed') return 'unknown';
  }
  if (options.handle) await options.handle.exited;
  const confirmEnd = clock.now().getTime() + options.confirmMs;
  do {
    // Only an empty group confirms cleanup; errors and unreadable output remain uncertain.
    const members = await inspector.groupMembers(identity.pgid);
    if (members.state === 'none') return 'died';
    if (clock.now().getTime() >= confirmEnd) break;
    await timer.sleep(Math.max(0, Math.min(50, confirmEnd - clock.now().getTime())), waiting.signal);
  } while (true);
  return 'unknown';
}
