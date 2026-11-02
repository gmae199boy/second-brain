import { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { createBrain } from 'second_brain';
import { postgresProtectedMutationStore, postgresQueueHostFence, postgresStore } from 'second_brain/postgres';
import { brainDependencies } from '../assembly.js';
import { readConfig } from '../config/codec.js';
import { systemClock, systemTimer } from '../runtime/clock.js';
import { uuidV7IdGen } from '../runtime/id-gen.js';
import { createInstalledProtectedService } from './protected-supervisor.js';

/** 이 조립은 검증된 launcher의 ACK 및 단일 사용 capability 이후에만 호출된다. */
export async function runSealedSupervisor(configuration: string, authority: unknown, fixture: boolean): Promise<void> {
  if (!fixture) throw new Error('protected deployment unverified');
  const value: unknown = JSON.parse(configuration);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration');
  const config = value as Record<string, unknown>;
  const fields = ['bridgeHash','databaseUrl','endpointHash','fixtureEndpoint','fixtureHost','home','hostHash','mode','schemaVersion'];
  if (Object.keys(config).sort().join(',') !== fields.sort().join(',') || config['mode'] !== 'service') throw new Error('configuration');
  for (const field of ['bridgeHash','endpointHash','hostHash']) if (typeof config[field] !== 'string' || !/^[0-9a-f]{40}$/u.test(config[field])) throw new Error('configuration');
  for (const field of ['fixtureEndpoint','fixtureHost','home']) if (typeof config[field] !== 'string' || !isAbsolute(config[field]) || config[field].includes('\0')) throw new Error('configuration');
  if (typeof config['databaseUrl'] !== 'string' || config['databaseUrl'].length > 2048 || !Number.isSafeInteger(config['schemaVersion']) || (config['schemaVersion'] as number) <= 0) throw new Error('configuration');
  const url = new URL(config['databaseUrl']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'brain_protected_supervisor') throw new Error('configuration');
  const databaseUrl = config['databaseUrl'], home = config['home'] as string;
  const store = postgresStore({databaseUrl}), fence = postgresQueueHostFence({databaseUrl}), mutations = postgresProtectedMutationStore({databaseUrl});
  const controller = new AbortController();
  const channel = new Socket({fd:5,readable:true,writable:true});
  channel.once('end',()=>controller.abort());channel.once('error',()=>controller.abort());channel.once('close',()=>controller.abort());
  try {
    const configResult = await readConfig(home);
    const schemaVersions = {core: config['schemaVersion'] as number};
    const service = createInstalledProtectedService({store,clock:systemClock,timer:systemTimer,idGen:uuidV7IdGen(),signal:controller.signal,schemaVersions,pollMs:100,
      onReadiness(ready) {if (ready) {const body=Buffer.from('service-ready'), header=Buffer.alloc(4);header.writeUInt32BE(body.length);channel.write(Buffer.concat([header,body]));}}
    }, {bridgeHash:config['bridgeHash'] as string,queueInstallation:{hostHash:config['hostHash'] as string,endpointHash:config['endpointHash'] as string,fence,fixtureHost:config['fixtureHost'] as string,fixtureEndpoint:config['fixtureEndpoint'] as string,fixtureDatabaseUrl:databaseUrl},mutations,
      garmin:{verifyInstalledWorker:async()=>false,snapshot:async()=>{throw new Error('closed');},admit:async()=>({ok:false,code:'EXTENSION_CONFIG_INVALID'}),release:async()=>({ok:true,released:false})},
      status:async()=>({available:true,requiresAction:false}),
      makeBrain:commandStore=>createBrain(brainDependencies({home,env:{},config:configResult,store:commandStore,clock:systemClock,idGen:uuidV7IdGen(),workHandlers:{},schemaVersions}))
    },authority);
    await service.run();
  } finally {controller.abort();channel.destroy();await Promise.allSettled([store.close(),fence.close(),mutations.close()]);}
}
