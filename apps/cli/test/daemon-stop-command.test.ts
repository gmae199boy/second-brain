import { afterEach, expect, it, vi } from 'vitest';
import { daemonStopCommand } from '../src/commands/daemon-stop.js';
import * as control from '../src/daemon/control.js';
import * as launchd from '../src/daemon/launchd.js';
import { tempHomes } from './temp-home.js';

const temporary = tempHomes();
afterEach(async () => { vi.restoreAllMocks(); await temporary.cleanup(); });

it('preserves the stop failure hint, owner PID, terminal guidance, code and exit', async () => {
  const home = await temporary.create('brain-stop-command-');
  const hint = 'pid 4242: launchd 밖에서 띄운 데몬은 그 터미널에서 멈추세요';
  const error = new control.DaemonControlError('DAEMON_CONTROL_FAILED', '데몬이 멈추지 않았습니다', hint,
    { unloaded: false, alive: true, owner_pid: 4242 });
  const stop = vi.spyOn(control, 'stopDaemon').mockRejectedValue(error);
  vi.spyOn(launchd, 'systemLaunchctl').mockReturnValue({
    uid: 501, isLoaded: vi.fn(), bootout: vi.fn(), bootstrap: vi.fn(), kill: vi.fn(),
  });
  if (daemonStopCommand.standalone !== true) throw new Error('daemon stop must be standalone');
  const result = await daemonStopCommand.run({
    env: { SECOND_BRAIN_HOME: home }, clock: { now: () => new Date() },
    options: {}, args: [], stdin: async () => '', recordHookArrival: async () => {},
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ home }));
  expect(result).toEqual({ ok: false, code: error.code, message: error.message, hint, exit: 1 });
  expect(result).toMatchObject({ hint: expect.stringContaining('pid 4242') });
  expect(result).toMatchObject({ hint: expect.stringContaining('그 터미널에서 멈추세요') });
});
