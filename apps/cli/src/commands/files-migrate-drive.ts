import type { CommandSpec } from '../dispatch.js';

export const filesMigrateDriveCommand: CommandSpec = {
  ns: 'files', verb: 'migrate-drive', nsDescription: '저장된 첨부 파일을 관리합니다',
  usedFor: '요청한 첨부 한 건의 Drive 이전을 예약합니다',
  required: ['file-id'], arguments: ['<file-id>'],
  examples: ['brain files migrate-drive <file-id> --json'],
  output: '대기 또는 기이전 상태와 필요한 작업 ID', risk: 'write', hook: false, dryRun: false, writes: true, drain: false,
  async run(context) {
    const result=await context.brain.files.migrateDrive({fileId:context.args[0] ?? ''});
    if(!result.ok)return result;
    return {ok:true,data:result.state==='queued'?{state:result.state,work_id:result.workId}:{state:result.state},text:[result.state==='queued'?'Drive 이전을 예약했습니다.':'이미 Drive로 이전한 첨부입니다.']};
  },
};
