// 명시적 실행만 허용한다. 영수증과 단일 소유 요청 외의 참조가 있으면 롤백한다.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const app=join(homedir(),'.second_brain/app'), home=process.env.SECOND_BRAIN_HOME || join(homedir(),'.second_brain');
const load=p=>import(pathToFileURL(join(app,p)).href);
const {readConfig,resolveStoreUrl}=await load('apps/cli/dist/config/codec.js');
const require=createRequire(join(app,'apps/cli/package.json')); const {Client}=require('pg');
let client;
try {
  if (process.argv.slice(2).join(' ') !== '--delete-owned-probe') throw Error('명시 플래그 필요');
  const receipt=JSON.parse(await readFile(join(home,'run/channels-mac-probe.json'),'utf8'));
  if(receipt.version!==1 || !['request','channel','conversation','work','producerResult'].every(k=>typeof receipt[k]==='string' && /^[0-9a-f-]{36}$/.test(receipt[k]))) throw Error('invalid receipt');
  const config=await readConfig(home); if(!config.ok) throw Error('invalid config');
  const runtime=await resolveStoreUrl(home,config.config.storeUrlEnv,{}), password=await resolveStoreUrl(home,'BRAIN_POSTGRES_PASSWORD',{});
  if(!runtime || !password) throw Error('missing admin credentials');
  const url=new URL(runtime); url.username='postgres'; url.password=password; url.searchParams.delete('user'); url.searchParams.delete('password');
  client=new Client({connectionString:url.toString()}); await client.connect(); await client.query('begin isolation level serializable');
  const row=(await client.query(`select r.id,r.producer,r.producer_result_id,r.conversation_id,c.channel_id,c.user_id,ch.kind,ch.bot_ref from brain.channel_requests r join brain.channel_conversations c on c.id=r.conversation_id join brain.channels ch on ch.id=c.channel_id where r.id=$1 for update of r,c`,[receipt.request])).rows[0];
  const self=(await client.query('select id from brain.users where is_self=1')).rows[0];
  if(!row || !self || row.user_id!==self.id || row.producer!=='channels-mac-probe' || row.producer_result_id!==receipt.producerResult || row.conversation_id!==receipt.conversation || row.channel_id!==receipt.channel || row.kind!=='telegram' || row.bot_ref!=='channels-mac-probe') throw Error('ownership mismatch');
  const work=(await client.query("select id,completed_at,current_attempt_token from brain.work_items where target_kind='channel_request' and target_id=$1 for update",[receipt.request])).rows;
  if(work.some(w=>!w.completed_at || w.current_attempt_token)) throw Error('work active');
  const other=(await client.query(`select (select count(*) from brain.channel_requests where conversation_id=$1 and id<>$2)+(select count(*) from brain.channel_legacy_notifications where conversation_id=$1)+(select count(*) from brain.channel_legacy_deliveries where conversation_id=$1)+(select count(*) from brain.channel_conversations where channel_id=$3 and id<>$1) as n`,[receipt.conversation,receipt.request,receipt.channel])).rows[0];
  if(Number(other.n)!==0) throw Error('other references');
  const ids=work.map(w=>w.id);
  await client.query('delete from brain.channel_item_results where request_id=$1',[receipt.request]);
  await client.query('delete from brain.channel_attempt_results where request_id=$1',[receipt.request]);
  await client.query('delete from brain.channel_gates where request_id=$1',[receipt.request]);
  await client.query("delete from brain.failures where target_kind='channel_request' and target_id=$1",[receipt.request]);
  await client.query('delete from brain.channel_requests where id=$1',[receipt.request]);
  await client.query('delete from brain.work_attempts where work_item_id=any($1::uuid[])',[ids]);
  await client.query('delete from brain.work_items where id=any($1::uuid[])',[ids]);
  await client.query('delete from brain.channel_conversations where id=$1',[receipt.conversation]);
  await client.query('delete from brain.channels where id=$1',[receipt.channel]);
  await client.query('commit'); console.log('확인용 요청을 정리했습니다. 중복 발신 방지를 위해 영수증은 보존합니다.');
} catch { if(client) await client.query('rollback').catch(()=>{}); console.error('정리를 수행하지 않았습니다. 소유권, 참조, 완료된 일감 및 관리자 설정을 확인하세요.'); process.exitCode=1; }
finally { if(client) await client.end().catch(()=>{}); }
