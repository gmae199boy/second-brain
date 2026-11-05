// 단일 고정 확인 요청. 영수증이 존재하면 조회만 하며 자동 재생성하지 않는다.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, open, readFile } from 'node:fs/promises';

const app = join(homedir(), '.second_brain/app');
const home = process.env.SECOND_BRAIN_HOME || join(homedir(), '.second_brain');
const receiptPath = join(home, 'run', 'channels-mac-probe.json');
const load = path => import(pathToFileURL(join(app, path)).href);
const { readConfig, resolveStoreUrl, resolveTelegramConfig } = await load('apps/cli/dist/config/codec.js');
const { resolveSelfUser } = await load('packages/core/dist/index.js');
const { postgresStore } = await load('packages/postgres/dist/index.js');
const { uuidV7IdGen } = await load('apps/cli/dist/runtime/id-gen.js');
let store;
try {
  const config = await readConfig(home);
  if (!config.ok) throw Error('설정 파일을 읽을 수 없습니다');
  const url = await resolveStoreUrl(home, config.config.storeUrlEnv, {});
  if (!url) throw Error('DB 연결 설정이 없습니다');
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw Error('영수증을 읽을 수 없습니다'); }
  store = postgresStore({databaseUrl:url});
  if (receipt) {
    if (receipt.version !== 1 || !['request','channel','conversation','work','producerResult'].every(k => typeof receipt[k] === 'string' && /^[0-9a-f-]{36}$/.test(receipt[k]))) throw Error('영수증 형식이 올바르지 않습니다');
    const found = await store.readChannelRequest(receipt.request);
    if (!found.ok || !found.request) throw Error('기록된 요청이 없습니다. 재생성하지 않습니다');
    if (found.request.producer !== 'channels-mac-probe' || found.request.producerResultId !== receipt.producerResult || found.request.conversationId !== receipt.conversation || found.channel?.id !== receipt.channel) throw Error('영수증과 요청 소유 정보가 다릅니다');
    const status = await store.readChannelStatus(receipt.request);
    if (!status.ok || !status.request) throw Error('상태를 읽을 수 없습니다');
    let latest = found.request;
    if (status.request.delivery === 'sent') {
      const reread = await store.readChannelRequest(receipt.request);
      if (!reread.ok || !reread.request || reread.request.status !== 'sent') throw Error('완료된 요청을 다시 읽을 수 없습니다');
      latest = reread.request;
    }
    console.log(JSON.stringify({receipt,actualWorkId:latest.workItemId,status:status.request,messageId:latest.externalMessageId},null,2));
  } else {
    const telegram = await resolveTelegramConfig(home, {});
    if (!telegram) { console.log('Telegram 두 키가 없어 요청을 생성하지 않았습니다.'); process.exitCode=2; }
    else {
      const self = await resolveSelfUser(store); if (!self.ok) throw Error(self.code);
      const id = uuidV7IdGen(); receipt={version:1,request:id.next(),channel:id.next(),conversation:id.next(),work:id.next(),producerResult:id.next()};
      await mkdir(join(home,'run'),{recursive:true,mode:0o700});
      const f=await open(receiptPath,'wx',0o600);
      try { await f.writeFile(JSON.stringify(receipt,null,2)+'\n'); await f.sync(); } finally { await f.close(); }
      const check = result => { if (!result.ok) throw Error('요청 저장 또는 인계 실패. 영수증을 보존하고 조사하세요'); return result; };
      check(await store.ensureChannel({id:receipt.channel,kind:'telegram',botRef:'channels-mac-probe'}));
      check(await store.ensureChannelConversation({id:receipt.conversation,userId:self.userId,channelId:receipt.channel,externalRef:telegram.chatId,threadRef:null}));
      const created=check(await store.createChannelRequest({id:receipt.request,conversationId:receipt.conversation,producer:'channels-mac-probe',producerResultId:receipt.producerResult,purpose:'notice',revision:null,text:'Personal Brain 채널 연결 확인 메시지입니다.',createdAt:new Date()}));
      if (!created.created || created.request.id !== receipt.request) throw Error('요청 소유권 충돌');
      const handoff=check(await store.handoffChannelRequest({requestId:receipt.request,workId:receipt.work,now:new Date()}));
      console.log(JSON.stringify({receipt,actualWorkId:handoff.workItemId,notice:'요청을 인계했습니다. 같은 명령으로 상태를 조회하세요.'},null,2));
    }
  }
} catch { console.error('확인 도구가 중단됐습니다. 영수증과 설치 상태를 보존하고 조사하세요.'); process.exitCode=1; }
finally { if (store) await store.close(); }
