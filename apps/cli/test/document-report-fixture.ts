import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createBrain, drainQueue, documentExtractHandler, enqueueDocumentExtractions, importFileHandler, FILE_IMPORT_KIND, DOCUMENT_EXTRACT_KIND } from 'second_brain';
import { memorySpool, sequenceIdGen } from 'second_brain/testing';
import { postgresStore, provisionExtension, EXPECTED_SCHEMA_VERSIONS } from 'second_brain/postgres';
import { extHome } from './ext-fixture.js';
import { localFileStore } from '../src/runtime/file-store.js';
import { importStaging } from '../src/runtime/import-staging.js';
import { brainDependencies } from '../src/assembly.js';
import { readConfig } from '../src/config/codec.js';

/** A disposable extension producer, its file import/extract pipeline and CLI home. */
export async function documentReportFixture() {
  const f = await extHome();
  const store = postgresStore({databaseUrl:f.db.appUrl});
  const admin = new pg.Client({connectionString:f.db.url});
  let ext: pg.Client | undefined;
  const name = 'testext', password = randomBytes(24).toString('hex');
  const ids = sequenceIdGen({timestampMs:Date.now()}), clock={now:()=>new Date()}, spool=memorySpool();
  const files=localFileStore({root:join(f.home,'files')}), staging=importStaging(f.home);
  const close = async () => { try { await ext?.end(); } finally { try { await store.close(); } finally { try { await admin.end(); } finally { await f.cleanup(); } } } };
  try {
    await admin.connect(); await provisionExtension(f.db.url,name,password);
    const extUrl=new URL(f.db.url); extUrl.username=`brain_ext_${name}`; extUrl.password=password;
    ext=new pg.Client({connectionString:extUrl.toString()}); await ext.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,`${name}.import`]);
    const work=ids.next(), token=ids.next(), now=clock.now();
    const added = await store.addWork({id:work,kind:`${name}.import`,targetKind:'import',targetId:'fixture',createdAt:now,nextAttemptAt:now});
    if (!added.ok) throw Error(added.message);
    const claim = await store.claimSupervisedWork({now,claimedBy:'fixture',kinds:[`${name}.import`],attemptToken:token});
    if (!claim.ok || !claim.item) throw Error('fixture producer claim failed');
    const dir=join(f.home,'extensions',name,'staging'); await mkdir(dir,{recursive:true});
    async function request(key:string, kind:string, content:Buffer, reportDate='2026-01-02') {
      const request=ids.next(); await writeFile(join(dir,key),content);
      await ext!.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,$2,$3,'fixture','fixture',$3,$4,$5,'text/markdown',$6,$7,$8,$9::jsonb)`,[request,name,key,createHash('sha256').update(content).digest('hex'),content.length,clock.now(),work,token,JSON.stringify({kind,report_date:reportDate})]);
      const handoff = await store.imports.handoffImport({requestId:request,workId:ids.next(),now:clock.now()});
      if (!handoff.ok || !handoff.created) throw Error('fixture import handoff failed'); return request;
    }
    async function importAndExtract() {
      const imported=await drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[FILE_IMPORT_KIND]:importFileHandler(store.imports,staging,files,clock,ids,store,store)}});
      await enqueueDocumentExtractions({store,clock,idGen:ids},{deadline:Date.now()+5000});
      const extracted=await drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[DOCUMENT_EXTRACT_KIND]:documentExtractHandler({store,files,clock,idGen:ids})}});
      return {imported,extracted};
    }
    const config=await readConfig(f.home);
    const sdk=createBrain(brainDependencies({home:f.home,env:f.env,config,store,clock,idGen:ids,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{}}));
    return { f, store, admin, name, ids, clock, spool, files, sdk, request, importAndExtract, close };
  } catch (error) { await close(); throw error; }
}
