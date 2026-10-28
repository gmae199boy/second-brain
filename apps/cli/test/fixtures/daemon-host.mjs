import { runDaemon } from '../../dist/daemon/run.js';
import { systemClock } from '../../dist/runtime/clock.js';
import { uuidV7IdGen } from '../../dist/runtime/id-gen.js';
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const supervisor = JSON.parse(process.env.FAKE_SUPERVISOR_OPTIONS ?? '{}');
await runDaemon({ home: process.env.SECOND_BRAIN_HOME, env: process.env, clock: systemClock, idGen: uuidV7IdGen(),
  signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor });
