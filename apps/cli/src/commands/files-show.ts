import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const filesShowCommand: CommandSpec = {
  ns: 'files', verb: 'show', nsDescription: '저장된 첨부 파일을 관리합니다', usedFor: '문서 출처의 현재 추출 위치와 문맥을 읽습니다',
  required: [], arguments: ['[fileId]'], examples: ['brain files show <file-id> --chunk-locator <json> --json', 'brain files show --source-file-id <source-id> --json'], output: '현재 추출 텍스트 또는 source 색인 상태·원본 접근·링크', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [ { flags: '--source-file-id <id>', description: '외부 source 파일 ID' }, { flags: '--chunk-locator <json>', description: '정규형 문서 조각 위치' }, { flags: '--extraction-id <id>', description: '검색 결과의 추출 세대' }, { flags: '--before <n>', description: '앞 문맥 조각 수' }, { flags: '--after <n>', description: '뒤 문맥 조각 수' }, { flags: '--offset <n>', description: '가린 텍스트 이어 읽기 위치' }, { flags: '--fingerprint <hash>', description: '이어 읽기 본문 지문' } ],
  async run(context) {
    const o = context.options;
    const result = await context.brain.files.show({ ...(context.args[0] ? {file_id:context.args[0]} : {}), ...(typeof o.sourceFileId === 'string' ? {source_file_id:o.sourceFileId} : {}), ...(typeof o.chunkLocator === 'string' ? {chunk_locator:o.chunkLocator} : {}), ...(typeof o.extractionId === 'string' ? { extraction_id: o.extractionId } : {}), ...(o.before === undefined ? {} : { before: Number(o.before) }), ...(o.after === undefined ? {} : { after: Number(o.after) }), ...(o.offset === undefined ? {} : { offset: Number(o.offset) }), ...(typeof o.fingerprint === 'string' ? { fingerprint: o.fingerprint } : {}) });
    if (!result.ok) return { ...result, ...('status' in result ? { message: `${result.message} (${result.status}${'source_unreachable' in result && result.source_unreachable ? ', source_unreachable' : ''})`, data: { status: result.status, ...('source_unreachable' in result ? { source_unreachable: result.source_unreachable } : {}) } } : {}) };
    return { ...result, text: recallText([...(result.meta.generation_changed ? ['추출 세대가 바뀌었습니다.'] : []), ...(result.meta.source_unreachable ? ['원본에 접근할 수 없습니다.'] : []), ...('source_file' in result.meta ? [`출처 ${JSON.stringify(result.meta.source_file)}`] : []), ...('source_file' in result.meta && result.meta.source_file?.stale ? ['보존된 본문은 현재 원격 버전보다 오래되었습니다.'] : []), ...result.data.map(r => `위치 ${r.chunk_locator}\n본문 ${r.body}`)], result.meta) };
  },
};
