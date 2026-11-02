import { runSupervisor, protectedDataFromBrain, handleProtectedRequest, type Brain, type ProtectedDataPort, type ExtensionStore, type SupervisorOptions } from 'second_brain';
import { sealedGarminLaunches, type SealedGarminPorts } from './sealed-garmin.js';
import { sealedProcessLauncher, type SealedNativeLauncher } from './sealed-launcher.js';
import { sealedNativeBridge, type createNativeBridgeAdapter } from './sealed-native-bridge.js';
import type { ProtectedMutationStore } from './protected-mutations.js';
import { protectedCommandStore } from './protected-command-store.js';
import { handleQueueFrame } from './protected-queue.js';
import { serveProtectedQueueHost, type QueueHostFence, type QueueHostRunner } from './protected-queue-host.js';
import { createInstalledQueueEndpointRunner, createQueueEndpointRunner, type QueueEndpointRunner } from './queue-endpoint-runner.js';
import { createInstalledQueueHostRunner, createQueueHostRunner } from './queue-host-runner.js';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

/** 보호 서비스의 신뢰된 설치 코드만 이 포트를 조립한다. */
export interface ProtectedSupervisorPorts {
  native: SealedNativeLauncher;
  inspector: SupervisorOptions['inspector'];
  garmin: SealedGarminPorts;
  ordinaryWorkerHost?: NonNullable<SupervisorOptions['sealedService']>['ordinaryWorkerHost'];
  ordinaryKinds?: readonly string[];
}

/** 기존 단일 Core 감독자가 모든 claim과 identity commit을 소유한다. */
export async function runProtectedSupervisor(
  options: Omit<SupervisorOptions, 'launcher' | 'inspector' | 'launches' | 'protectedLaunches' | 'loadProtectedLaunches' | 'sealedService'>,
  ports: ProtectedSupervisorPorts,
): Promise<void> {
  const garmin = sealedGarminLaunches(ports.garmin);
  await runSupervisor({
    ...options,
    launcher: sealedProcessLauncher(ports.native),
    inspector: ports.inspector,
    launches: {},
    sealedService: {
      // collect에는 아직 별도의 비입력 bootstrap 계약이 없다.
      launches: { 'garmin.auth': garmin['garmin.auth']! },
      protectedKinds: ['garmin.auth', 'garmin.collect'],
      ...(ports.ordinaryWorkerHost ? { ordinaryWorkerHost: ports.ordinaryWorkerHost } : {}),
      ...(ports.ordinaryKinds ? { ordinaryKinds: ports.ordinaryKinds } : {}),
    },
  });
}

type ProtectedServiceStore = SupervisorOptions['store'] & ExtensionStore;
type ProtectedServiceOptions<T extends ProtectedServiceStore> = Omit<SupervisorOptions, 'launcher' | 'inspector' | 'launches' | 'protectedLaunches' | 'loadProtectedLaunches' | 'sealedService' | 'store'> & { store: T };
type ProtectedServicePorts<T extends ProtectedServiceStore> = Omit<ProtectedSupervisorPorts, 'native' | 'inspector' | 'garmin'> & {
  garmin: Omit<SealedGarminPorts, 'bootstrap'>; mutations: ProtectedMutationStore;
  makeBrain(store: T): Brain; status: ProtectedDataPort['status'];
  queueHost?: {fence: QueueHostFence; runner: QueueHostRunner};
  queueEndpoint?: QueueEndpointRunner;
};
/** 같은 store와 bridge를 Core 감독자와 명명된 사용자 API가 공유한다. */
export function createProtectedService<T extends ProtectedServiceStore>(
  options: ProtectedServiceOptions<T>, ports: ProtectedServicePorts<T>, bridge: ReturnType<typeof createNativeBridgeAdapter>,
) {
  const commandStore=protectedCommandStore(options.store,ports.mutations,bridge.revoker);
  const brain=ports.makeBrain(commandStore);
  const api=protectedDataFromBrain(brain,ports.status);
  const ordinary=ports.ordinaryWorkerHost && {
    kinds: () => ports.ordinaryWorkerHost!.kinds(),
    async start(item: Parameters<NonNullable<ProtectedSupervisorPorts['ordinaryWorkerHost']>['start']>[0],token: string) {
      const result=await ports.ordinaryWorkerHost!.start(item,token);if(!result.ok)return result;
      const pid=result.handle.pid;bridge.registerOrdinary(pid);
      const handle=new Proxy(result.handle,{get(target,key,receiver) {
        if(key==='closeOutput')return () => {bridge.releaseOrdinary(pid);target.closeOutput();};
        return Reflect.get(target,key,receiver);
      }});
      return {ok:true as const,handle};
    },
  };
  return {
    store: commandStore,
    request: (value: unknown) => handleProtectedRequest(value,api),
    requestQueueFrame: (frame: string) => handleQueueFrame(frame,brain.queue),
    requestQueueViaHost: (frame: string) => ports.queueHost ? serveProtectedQueueHost(ports.queueHost.fence,ports.queueHost.runner,frame) : Promise.resolve(undefined),
    async run() {
      const controller=new AbortController();const abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
      let ready=false;
      try {
        const core=runProtectedSupervisor({ ...options, signal:controller.signal, store: commandStore, async onReadiness(value) {
          ready=false;await options.onReadiness?.(value);ready=value && !controller.signal.aborted;
        } }, {
          native: bridge.launcher, inspector: bridge.inspector, garmin: { ...ports.garmin, bootstrap: bridge.bootstrap },
          ...(ordinary ? { ordinaryWorkerHost: ordinary } : {}),
          ...(ports.ordinaryKinds ? { ordinaryKinds: ports.ordinaryKinds } : {}),
        }).finally(abort);
        if(!ports.queueEndpoint){await core;return;}
        const endpoint=ports.queueEndpoint.run({async requestQueueFrame(frame) {
          const response=ready && !controller.signal.aborted && ports.queueHost ? await serveProtectedQueueHost(ports.queueHost.fence,ports.queueHost.runner,frame) : undefined;
          return response ?? JSON.stringify({ok:false,code:'SERVICE_UNAVAILABLE',message:'보호 서비스를 사용할 수 없습니다'});
        }},controller.signal).finally(abort);
        const results=await Promise.allSettled([core,endpoint]);
        const failure=results.find((result): result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
      } finally {options.signal.removeEventListener('abort',abort);controller.abort();}
    },
  };
}

/** 설치 registry의 hash와 port만 사용한다. */
export function createInstalledProtectedService<T extends ProtectedServiceStore>(
  options: ProtectedServiceOptions<T>, ports: ProtectedServicePorts<T> & { bridgeHash: string; queueInstallation?: {hostHash: string; endpointHash: string; fence: QueueHostFence; fixtureHost?: string; fixtureEndpoint?: string; fixtureDatabaseUrl?: string} }, authority?: unknown,
) {
  let native: {consumeSupervisor(value:unknown):boolean;deploymentReady():boolean;supervisorFixture():boolean};
  try {native=createRequire(import.meta.url)('./peer.node') as typeof native;}
  catch {throw new Error('protected supervisor closure unverified');}
  if(!ports.queueInstallation||!native.deploymentReady()||!native.consumeSupervisor(authority))throw new Error('protected supervisor closure unverified');
  const bridge=sealedNativeBridge(ports.bridgeHash);let service: ReturnType<typeof createProtectedService<T>>;
  const fixture=native.supervisorFixture(),installation=ports.queueInstallation;
  if(!fixture && (installation.fixtureHost||installation.fixtureEndpoint||installation.fixtureDatabaseUrl))throw new Error('protected supervisor closure unverified');
  const fixtureSpawn=(path:string,endpoint:boolean)=>{
    if(!installation.fixtureDatabaseUrl)throw new Error('fixture credential missing');
    const child=spawn(path,[],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:[endpoint?'ignore':'pipe','pipe','pipe','pipe','pipe','ignore','ignore','ignore','pipe']});
    const credential=(child.stdio as unknown as Writable[])[8]!;credential.on('error',()=>{});credential.end(installation.fixtureDatabaseUrl);return child;
  };
  const runner=fixture && installation.fixtureHost
    ? createQueueHostRunner(async()=>fixtureSpawn(installation.fixtureHost!,false),{requestQueueFrame:frame=>service.requestQueueFrame(frame)})
    : createInstalledQueueHostRunner(installation.hostHash,{requestQueueFrame:frame=>service.requestQueueFrame(frame)});
  const endpoint=fixture && installation.fixtureEndpoint
    ? createQueueEndpointRunner(async()=>fixtureSpawn(installation.fixtureEndpoint!,true))
    : createInstalledQueueEndpointRunner(installation.endpointHash);
  service=createProtectedService(options,{...ports,queueHost:{fence:installation.fence,runner},queueEndpoint:endpoint},bridge);
  return service;
}
