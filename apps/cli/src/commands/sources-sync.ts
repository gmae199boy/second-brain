import type {CommandSpec} from '../dispatch.js';
export const sourcesSyncCommand:CommandSpec={
  ns:'sources',verb:'sync',nsDescription:'외부 source를 동기화합니다',usedFor:'연결된 source의 파일을 동기화합니다',required:['sourceId'],arguments:['<sourceId>'],examples:['brain sources sync <source-id> --json'],output:'source와 동기화 일감 ID 및 생성 여부',risk:'write',writes:true,hook:false,dryRun:false,drain:false,
  async run(context){const result=await context.brain.sources.sync({sourceId:context.args[0]??''});if(!result.ok)return result;return {ok:true,data:{source_id:result.sourceId,work_id:result.workId,created:result.created},text:['source 동기화를 마쳤습니다.']};},
};
