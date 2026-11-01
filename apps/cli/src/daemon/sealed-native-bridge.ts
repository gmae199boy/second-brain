import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import { promisify } from 'node:util';
import type { Duplex } from 'node:stream';
import type { ProcessInspector, ProcessLauncher, ProcessSpec, ProtectedLaunch } from 'second_brain';
import { systemProcessInspector } from '../runtime/process-inspector.js';
import type { SealedNativeLauncher } from './sealed-launcher.js';
import type { ProtectedAttemptRevoker } from './protected-mutations.js';

export const SEALED_NATIVE_BRIDGE = '/Library/Application Support/SecondBrain/libexec/garmin-supervisor-bridge';
const execute = promisify(execFile);
type Handle = Extract<Awaited<ReturnType<ProcessLauncher['start']>>, { ok: true }>['handle'];
type Exit = Awaited<Handle['exited']>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidBytes(value: string): Buffer {
  if (!uuidPattern.test(value) || value === '00000000-0000-0000-0000-000000000000') throw new Error('invalid identity');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}
function uuidText(bytes: Buffer): string {
  const value = bytes.toString('hex');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

/** 봉인 registry가 고정 cdhash를 공급한다. 경로와 명령은 사용자 설정에서 읽지 않는다. */
async function verifyInstalledBridge(expectedHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(expectedHash)) return false;
  try {
    const path = SEALED_NATIVE_BRIDGE;
    if (await realpath(path) !== path) return false;
    for (let part = path; ; part = dirname(part)) {
      const info = await lstat(part);
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (part === path ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) return false;
      const listing = await execute('/bin/ls', ['-lde', part], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 4096 });
      const lines = listing.stdout.trimEnd().split('\n');
      if (lines.length !== 1 || lines[0]!.slice(0,11).includes('+')) return false;
      if (part === '/') break;
    }
    await execute('/usr/bin/codesign', ['--verify', '--strict', path], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 4096 });
    const display = await execute('/usr/bin/codesign', ['-d', '--verbose=4', path], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 8192 });
    return /^CDHash=([0-9a-f]{40})$/m.exec(display.stderr)?.[1] === expectedHash;
  } catch { return false; }
}

/** 최대 프레임과 단일 응답을 강제한다. 입력 자격은 이 채널에 싣지 않는다. */
class Control {
  private buffer = Buffer.alloc(0);
  private pending: { resolve(value: Buffer): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(private readonly socket: Duplex) {
    socket.on('data', (data: Buffer) => {
      if (this.failed) return;
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 516) return this.close();
      if (this.buffer.length < 4) return;
      const size = this.buffer.readUInt32BE(0);
      if (!size || size > 512) return this.close();
      if (this.buffer.length < size + 4) return;
      if (this.buffer.length !== size + 4 || !this.pending) return this.close();
      const pending = this.pending; this.pending = undefined;
      clearTimeout(pending.timer); const frame = this.buffer.subarray(4); this.buffer = Buffer.alloc(0); pending.resolve(frame);
    });
    socket.on('error', () => this.close()); socket.on('close', () => this.close());
  }
  request(frame: Buffer, expected: number, timeoutMs = 8000): Promise<Buffer> {
    const operation = this.serial.then(() => new Promise<Buffer>((done, reject) => {
      if (this.failed || this.pending || !frame.length || frame.length > 1243) return reject(new Error('closed'));
      const timer = setTimeout(() => this.close(), timeoutMs);
      this.pending = { resolve: value => value[0] === expected ? done(value) : (this.close(), reject(new Error('invalid reply'))), reject, timer };
      const header = Buffer.alloc(4); header.writeUInt32BE(frame.length);
      this.socket.write(Buffer.concat([header,frame]), error => { if (error) this.close(); });
    }));
    this.serial = operation.catch(() => {}); return operation;
  }
  close(): void {
    if (this.failed) return; this.failed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('closed')); this.pending = undefined; }
    this.socket.destroy();
  }
}
function parseExit(status: number): Exit {
  const signal = status & 0x7f;
  if (signal === 0) return { code: (status >>> 8) & 0xff, signal: null };
  if (signal === 0x7f) return { code: null, signal: null, unknown: true };
  const name = Object.entries(osConstants.signals).find(([, value]) => value === signal)?.[0];
  return name ? { code: null, signal: name } : { code: null, signal: null, unknown: true };
}
type BridgeProcess = ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> };
type SpawnBridge = () => Promise<BridgeProcess>;

/** 이 adapter는 보호 서비스 내부에서만 조립한다. spawn 함수는 고정 설치물 또는 격리 fixture를 연다. */
export function createNativeBridgeAdapter(spawnBridge: SpawnBridge, osInspector: ProcessInspector = systemProcessInspector): { launcher: SealedNativeLauncher; bootstrap: NonNullable<ProtectedLaunch['bootstrap']>; inspector: ProcessInspector; revoker: ProtectedAttemptRevoker; registerOrdinary(pid: number): boolean; releaseOrdinary(pid: number): void } {
  const live = new WeakMap<Handle, { control: Control; work: string; token: string }>();
  const activePids = new Map<number, { control: Control; start: bigint }>();
  const activeAttempts = new Map<string, { run: number; lease: string; epoch: number; revoke(): Promise<boolean> }>();
  // 보호 PID를 재사용한 경우 일반 신호 경로로 추측하지 않는다.
  const protectedPids = new Set<number>();
  const ordinaryPids = new Set<number>();
  const launcher: SealedNativeLauncher = {
    async startGarmin(spec: ProcessSpec) {
      let child: BridgeProcess | undefined; let control: Control | undefined;
      try {
        const work = spec.env['BRAIN_WORK_ID'] ?? '', token = spec.env['BRAIN_ATTEMPT_TOKEN'] ?? '';
        const run = Number(spec.env['BRAIN_RUN_GENERATION']);
        const targetKind=spec.env['BRAIN_TARGET_KIND'], targetId=spec.env['BRAIN_TARGET_ID'] ?? '';
        if (spec.env['BRAIN_WORK_KIND'] !== 'garmin.auth' || !((targetKind === 'extension' && targetId === 'garmin') || (targetKind === 'account' && uuidPattern.test(targetId) && targetId !== '00000000-0000-0000-0000-000000000000'))
          || !Number.isSafeInteger(run) || run <= 0) throw new Error('invalid work');
        const snapshot: unknown = JSON.parse(spec.env['BRAIN_SETTINGS_SNAPSHOT'] ?? '');
        const values = (snapshot as { values?: Record<string, unknown> } | null)?.values;
        const zone = values?.['garmin.timezone'], target = values?.['garmin.tokenstore'];
        if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).sort().join(',') !== 'extension,values,version'
          || (snapshot as { version?: unknown }).version !== 1 || (snapshot as { extension?: unknown }).extension !== 'garmin'
          || !values || Object.keys(values).sort().join(',') !== 'garmin.timezone,garmin.tokenstore'
          || typeof zone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,128}$/.test(zone)
          || typeof target !== 'string' || !target || target.includes('\0') || Buffer.byteLength(target) > 1024) throw new Error('invalid snapshot');
        const epoch = randomBytes(6).readUIntBE(0,6) + 1;
        const zoneBytes = Buffer.from(zone, 'utf8'), targetBytes = Buffer.from(target, 'utf8'), idBytes=Buffer.from(targetId,'ascii'), frame = Buffer.alloc(55 + zoneBytes.length + targetBytes.length + idBytes.length);
        frame[0] = 1; uuidBytes(work).copy(frame,1); uuidBytes(token).copy(frame,17);
        frame.writeBigUInt64BE(BigInt(run),33); frame.writeBigUInt64BE(BigInt(epoch),41);frame.writeUInt16BE(zoneBytes.length,49);frame.writeUInt16BE(targetBytes.length,51);frame[53]=targetKind==='extension'?1:2;frame[54]=idBytes.length;zoneBytes.copy(frame,55);targetBytes.copy(frame,55 + zoneBytes.length);idBytes.copy(frame,55+zoneBytes.length+targetBytes.length);
        child = await spawnBridge();
        child.once('error', () => control?.close());
        child.once('exit', () => control?.close());
        const socket = child.stdio[3]; if (!socket || !('write' in socket)) throw new Error('control unavailable');
        control = new Control(socket as Duplex);
        const first = await control.request(frame,0x81,20000);
        if (first.length !== 29) throw new Error('invalid start');
        const pid = first.readUInt32BE(1), start = first.readBigUInt64BE(5), lease = uuidText(first.subarray(13,29));
        if (!pid || !start || !uuidPattern.test(lease) || lease === '00000000-0000-0000-0000-000000000000') throw new Error('invalid process');
        const fixedChild = child, fixedControl = control;
        let done = false, exitedFlag = false, finish!: (value: Exit) => void, finishObserved!: (value: Exit) => void;
        let observedValue: Exit | undefined, reapPromise: Promise<boolean> | undefined;
        let revokePromise: Promise<boolean> | undefined;
        const exited = new Promise<Exit>(resolveExit => { finish = resolveExit; });
        const leaderObserved = new Promise<Exit>(resolveExit => { finishObserved = resolveExit; });
        const observeOnce = (value: Exit) => { if (!observedValue) { observedValue=value;exitedFlag=!value.unknown;finishObserved(value); } };
        const finishOnce = (value: Exit) => { if (!done) { done = true; exitedFlag = !value.unknown; finish(value); } };
        const unknown = () => {const value: Exit={code:null,signal:null,unknown:true};observeOnce(value);finishOnce(value);};
        fixedChild.once('exit', unknown);
        fixedChild.once('error', unknown);
        if (fixedChild.exitCode !== null || fixedChild.signalCode !== null) unknown();
        fixedChild.stdout.setEncoding('utf8'); fixedChild.stderr.setEncoding('utf8');
        const handle: Handle = {
          pid, protectedIdentity: { launchLease: lease, connectionEpoch: epoch, startTimeUs: start.toString() },
          stdout: fixedChild.stdout as AsyncIterable<string>, stderr: fixedChild.stderr as AsyncIterable<string>, exited, leaderObserved,
          get leaderExited() { return exitedFlag; },
          closeOutput() { if (activePids.get(pid)?.control === fixedControl) activePids.delete(pid); activeAttempts.delete(`${work}:${token}`); fixedControl.close(); fixedChild.stdout.destroy(); fixedChild.stderr.destroy(); },
          signalGroup() { throw new Error('보호 그룹 신호는 인증된 inspector가 보낸다'); },
          revokeInput() {
            revokePromise ??= fixedControl.request(Buffer.from([6]),0x86,8000).then(reply => reply.length === 2 && reply[1] === 1).catch(() => false);
            return revokePromise;
          },
          reapLeader() {
            reapPromise ??= (async () => {
              // [ASSUMPTION] leader 관찰이 도착하지 않으면 10초 뒤 불명으로 보존한다.
              let timer: NodeJS.Timeout | undefined;
              const timeout=new Promise<null>(resolveTimeout=>{timer=setTimeout(()=>resolveTimeout(null),10_000);});
              const observed=await Promise.race([leaderObserved,timeout]);if(timer)clearTimeout(timer);
              if(!observed || observed.unknown)return false;
              try {const reply=await fixedControl.request(Buffer.from([8]),0x88,8000);if(reply.length!==2 || reply[1]!==1)return false;finishOnce(observed);return true;}
              catch {unknown();return false;}
            })();return reapPromise;
          },
        };
        if (activePids.has(pid) || ordinaryPids.has(pid)) throw new Error('duplicate process');
        const key = `${work}:${token}`;
        if (activeAttempts.has(key)) throw new Error('duplicate attempt');
        activePids.set(pid, {control:fixedControl,start});protectedPids.add(pid);live.set(handle, { control: fixedControl, work, token });
        activeAttempts.set(key, { run, lease, epoch, revoke: () => handle.revokeInput!() });
        void (async () => {
          while (!done) {
            try {
              const reply = await fixedControl.request(Buffer.from([3]),0x83);
              if (reply.length !== 6 || reply[1]! > 3) throw new Error('invalid status');
              if (reply[1] === 2) { unknown(); break; }
              if (reply[1] === 3) observeOnce(parseExit(reply.readUInt32BE(2)));
              if (reply[1] === 1) { const value=parseExit(reply.readUInt32BE(2));observeOnce(value);finishOnce(value);break; }
              await new Promise(resolveWait => setTimeout(resolveWait,150));
            } catch { unknown(); break; }
          }
        })();
        return { ok: true as const, handle };
      } catch {
        control?.close(); child?.stdout.destroy(); child?.stderr.destroy(); child?.kill();
        return { ok: false as const, message: '보호 실행 경계를 확인할 수 없습니다' };
      }
    },
  };
  const bootstrap: NonNullable<ProtectedLaunch['bootstrap']> = {
    async authorize(handle, _identity, item, token, signal) {
      const entry = live.get(handle);
      if (!entry || entry.work !== item.id || entry.token !== token || signal.aborted) return false;
      const abort = () => entry.control.close(); signal.addEventListener('abort',abort,{ once: true });
      try { const reply = await entry.control.request(Buffer.from([2]),0x82,20000); return !signal.aborted && reply.length === 2 && reply[1] === 1; }
      catch { return false; } finally { signal.removeEventListener('abort',abort); }
    },
  };
  const inspector: ProcessInspector = {
    bootTime: () => osInspector.bootTime(),
    async startedAt(pid) {const active=activePids.get(pid);if(!active)return ordinaryPids.has(pid)?osInspector.startedAt(pid):{state:'unknown'};const millis=Number(active.start/1000n);return Number.isSafeInteger(millis) && Number.isFinite(new Date(millis).getTime())?{state:'found',value:new Date(millis)}:{state:'unknown'};},
    async groupMembers(pgid) {
      const active=activePids.get(pgid);if(!active)return ordinaryPids.has(pgid)?osInspector.groupMembers(pgid):{state:'unknown'};
      try {const reply=await active.control.request(Buffer.from([7]),0x87);if(reply.length<2 || reply[1]===255 || reply[1]!>24 || reply.length!==2+reply[1]!*12)return {state:'unknown'};
        const members=[];for(let i=0;i<reply[1]!;i++){const pid=reply.readUInt32BE(2+i*12),millis=Number(reply.readBigUInt64BE(6+i*12)/1000n);if(!pid || !Number.isSafeInteger(millis) || !Number.isFinite(new Date(millis).getTime()))return {state:'unknown'};members.push({pid,pgid,startedAt:new Date(millis)});}
        return members.length?{state:'found',value:members}:{state:'none'};
      } catch {return {state:'unknown'};}
    },
    async signalGroup(pgid, signal) {
      const active = activePids.get(pgid);
      if (!active) return ordinaryPids.has(pgid) ? osInspector.signalGroup(pgid, signal) : 'failed';
      try {
        const reply = await active.control.request(Buffer.from([5, signal === 'SIGTERM' ? 15 : 9]),0x85);
        return reply.length === 2 && reply[1] === 1 ? 'sent' : 'failed';
      } catch { return 'failed'; }
    },
  };
  const revoker: ProtectedAttemptRevoker = {
    async revoke(attempt) {
      const liveAttempt = activeAttempts.get(`${attempt.work}:${attempt.token}`);
      if (!liveAttempt || liveAttempt.run !== attempt.run || liveAttempt.lease !== attempt.lease || liveAttempt.epoch !== attempt.epoch) return false;
      return liveAttempt.revoke();
    },
  };
  return { launcher, bootstrap, inspector, revoker,
    registerOrdinary(pid) {if(!Number.isSafeInteger(pid) || pid<=0 || protectedPids.has(pid) || activePids.has(pid))return false;ordinaryPids.add(pid);return true;},
    releaseOrdinary(pid) {ordinaryPids.delete(pid);},
  };
}

/** 검증된 설치 registry의 hash가 있을 때만 고정 경로를 실행한다. */
export function sealedNativeBridge(expectedHash: string): ReturnType<typeof createNativeBridgeAdapter> {
  return createNativeBridgeAdapter(async () => {
    if (!(await verifyInstalledBridge(expectedHash))) throw new Error('unverified');
    const child = spawn(resolve(SEALED_NATIVE_BRIDGE), [], { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore','pipe','pipe','pipe'] });
    return child as BridgeProcess;
  });
}
