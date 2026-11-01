/* 격리 DB와 합성 서비스로 실제 Core 및 제품 adapter를 조합한다. */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { runSupervisor } from '../../../../packages/core/dist/index.js';
import { postgresStore } from '../../../../packages/postgres/dist/index.js';
import { sealedGarminLaunches } from '../../../../apps/cli/dist/daemon/sealed-garmin.js';
import { sealedProcessLauncher } from '../../../../apps/cli/dist/daemon/sealed-launcher.js';
import { createNativeBridgeAdapter } from '../../../../apps/cli/dist/daemon/sealed-native-bridge.js';
import { systemClock, systemTimer } from '../../../../apps/cli/dist/runtime/clock.js';

const [bridge, port, fixtureWorker, signalCase] = process.argv.slice(2);
if (!bridge || !/^\d+$/.test(port ?? '') || !fixtureWorker) process.exit(2);
const work = '00000000-0000-4000-8000-000000000151';
const store = postgresStore({ databaseUrl: `postgres://brain_protected_supervisor@127.0.0.1:${port}/postgres` });
const controller = new AbortController();
const bridgeAdapter = createNativeBridgeAdapter(async () => spawn(bridge, [], {
  cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore','pipe','pipe','pipe'],
}));
const verify = promisify(execFile);
const launches = sealedGarminLaunches({
  async verifyInstalledWorker() {
    try { await verify('/usr/bin/codesign', ['--verify','--strict',fixtureWorker], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 }); return true; }
    catch { return false; }
  },
  async snapshot() { return JSON.stringify({ version: 1, extension: 'garmin', values: { 'garmin.tokenstore': 'fixture', 'garmin.timezone': 'UTC' } }); },
  async admit(item, token) {
    return store.reserveExtensionAdmission({ extension: 'garmin', workId: item.id, attemptToken: token, generation: item.attempts, target: 'fixture', timeZone: 'UTC' });
  },
  async release(item, token) { return store.releaseExtensionAdmission({ extension: 'garmin', workId: item.id, attemptToken: token }); },
  bootstrap: bridgeAdapter.bootstrap,
});
const issues = [];
const running = runSupervisor({ store, schemaVersions: { core: 29 }, launcher: sealedProcessLauncher(bridgeAdapter.launcher), inspector: bridgeAdapter.inspector,
  clock: systemClock, timer: systemTimer, idGen: { next: randomUUID }, signal: controller.signal, launches: {},
  sealedService: { launches: { 'garmin.auth': launches['garmin.auth'] }, protectedKinds: ['garmin.auth','garmin.collect'] },
  pollMs: 50, cancelPollMs: 100, renewEveryMs: 500, groupConfirmMs: 1000, cancelGraceMs: 200,
  log(message) { issues.push(message); },
});
let success = false, lastState = null;
try {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const result = await store.getWork(work);
    if (!result.ok) { issues.push(`fixture 조회 오류 ${result.code}`); break; }
    if (result.entry) lastState = { attempts: result.entry.item.attempts, outcome: result.entry.item.outcome, current: Boolean(result.entry.item.currentAttemptToken), lastOutcome: result.entry.latestAttempt?.outcome, lastCode: result.entry.latestAttempt?.errorCode };
    if (signalCase === '1' && result.entry?.latestAttempt?.lastProgressAt) { success = true; break; }
    if (result.entry?.item.completedAt) { success = signalCase !== '1' && result.entry.item.outcome === 'succeeded'; break; }
    await new Promise(resolve => setTimeout(resolve,100));
  }
} finally {
  controller.abort(); await running; await store.close();
}
if (!success) { process.stderr.write(`Core/native fixture 실패: ${issues.join(' | ')} 상태=${JSON.stringify(lastState)}\n`); process.exitCode = 1; }
