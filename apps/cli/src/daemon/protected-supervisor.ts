import { runSupervisor, protectedDataFromBrain, handleProtectedRequest, type Brain, type ProtectedDataPort, type ExtensionStore, type SupervisorOptions } from 'second_brain';
import { sealedGarminLaunches, type SealedGarminPorts } from './sealed-garmin.js';
import { sealedProcessLauncher, type SealedNativeLauncher } from './sealed-launcher.js';
import { sealedNativeBridge, type createNativeBridgeAdapter } from './sealed-native-bridge.js';
import type { ProtectedMutationStore } from './protected-mutations.js';
import { protectedCommandStore } from './protected-command-store.js';
import { handleQueueFrame } from './protected-queue.js';

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
    run: () => runProtectedSupervisor({ ...options, store: commandStore }, {
      native: bridge.launcher, inspector: bridge.inspector, garmin: { ...ports.garmin, bootstrap: bridge.bootstrap },
      ...(ordinary ? { ordinaryWorkerHost: ordinary } : {}),
      ...(ports.ordinaryKinds ? { ordinaryKinds: ports.ordinaryKinds } : {}),
    }),
  };
}

/** 설치 registry의 hash와 port만 사용한다. */
export function createInstalledProtectedService<T extends ProtectedServiceStore>(
  options: ProtectedServiceOptions<T>, ports: ProtectedServicePorts<T> & { bridgeHash: string },
) {return createProtectedService(options,ports,sealedNativeBridge(ports.bridgeHash));}
