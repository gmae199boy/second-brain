import { expect, it, vi } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';

const daemon = vi.hoisted(() => vi.fn(async (_options: unknown) => ({ok:true as const})));
vi.mock('../src/daemon/run.js', () => ({runDaemon:daemon}));

it('passes the injected Drive factory through standalone dispatch to daemon',async()=>{
  const driveFactory=vi.fn();
  const code=await dispatch(commands,['daemon','run'],{clock:{now:()=>new Date('2026-01-01Z')},env:{},driveFactory,stdout:()=>{},stderr:()=>{}});
  expect(code).toBe(0);
  expect(daemon).toHaveBeenCalledWith(expect.objectContaining({driveFactory}));
});
