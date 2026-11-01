// 합성 격리 PG만 사용하는 별도 프로세스 fixture다. 운영 설치 진입점이 아니다.
import { createBrain } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { createProtectedService } from '../../dist/daemon/protected-supervisor.js';
import { serveQueueFrames } from '../../dist/daemon/queue-frame-stream.js';
import { brainDependencies } from '../../dist/assembly.js';
import { readConfig } from '../../dist/config/codec.js';
import { uuidV7IdGen } from '../../dist/runtime/id-gen.js';
import { once } from 'node:events';
const home=process.env['BRAIN_QUEUE_FIXTURE_HOME'];
const databaseUrl=process.env['BRAIN_QUEUE_FIXTURE_DB'];
if(!home || !databaseUrl)process.exit(2);
const store=postgresStore({databaseUrl});
try {
  const config=await readConfig(home);const clock={now:()=>new Date('2026-01-01T00:00:00.000Z')};
  const assembly={home,env:process.env,config,store,clock,idGen:uuidV7IdGen(),workHandlers:{},schemaVersions:{core:1}};
  const service=createProtectedService({store},{garmin:{},mutations:{},status:async()=>({available:true,requiresAction:false}),makeBrain:commandStore=>createBrain(brainDependencies({...assembly,store:commandStore}))},{revoker:{}});
  await serveQueueFrames(process.stdin,async frame=>{if(!process.stdout.write(frame))await once(process.stdout,'drain');},service);
} catch {process.exitCode=1;} finally {await store.close();}
