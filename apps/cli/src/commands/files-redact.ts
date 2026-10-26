import { checkFilesRedact, type FilesRedactInput } from 'second_brain';
import type { CommandContextBase, CommandSpec } from '../dispatch.js';

function inputOf(context: CommandContextBase): FilesRedactInput {
  return {
    file: context.args[0] ?? '',
    ...(context.options.yes === true ? { confirm: true } : {}),
  };
}

export const filesRedactCommand: CommandSpec = {
  ns: 'files', verb: 'redact', nsDescription: '저장된 첨부 파일을 관리합니다',
  usedFor: '첨부 파일의 원본 사본·추출 텍스트·검색용 이름을 되돌릴 수 없게 가립니다',
  required: ['file'], arguments: ['<file>'],
  // One example, and the argument is `<file>` in it: the two spellings it takes
  // — the UUIDv7 and the `sha256:` content hash — are what `USAGE` says.
  examples: ['brain files redact <file> --yes --json'],
  output: '파일 id와 내용 해시, 함께 쓰는 메시지 수, 이미 가렸는지, 지운 추출 세대·조각·검색용 이름·메타데이터 수, 넣은 블롭 삭제 일감 수, 해소한 실패 수를 반환합니다',
  risk: 'destructive', hook: false, dryRun: false, writes: true,
  // As `messages redact`: the masking must not be followed by this run's own
  // write, and the blob the queue then deletes is the next drain's.
  drain: false,
  options: [
    { flags: '--yes', description: '되돌릴 수 없는 가리기에 동의합니다' },
  ],
  // The format only. The confirmation gate needs the number of messages that
  // share the file, which only the database can say, so it lives in the verb
  // (`files/redact.ts`).
  preflight(context) {
    const failure = checkFilesRedact(inputOf(context));
    return failure === undefined ? undefined : { ok: false, ...failure };
  },
  async run(context) {
    const result = await context.brain.files.redact(inputOf(context));
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        file_id: result.fileId,
        content_hash: result.contentHash,
        messages: result.messages,
        already_redacted: result.alreadyRedacted,
        extractions_removed: result.extractionsRemoved,
        chunks_removed: result.chunksRemoved,
        names_removed: result.namesRemoved,
        metadata_removed: result.metadataRemoved,
        blob_deletes_queued: result.blobDeletesQueued,
        failures_resolved: result.failuresResolved,
      },
      text: [
        result.alreadyRedacted
          ? `이미 가린 파일입니다. 메시지 ${String(result.messages)}개가 함께 쓰며, 블롭 삭제 일감 ${String(result.blobDeletesQueued)}건을 넣었습니다.`
          : `메시지 ${String(result.messages)}개가 함께 쓰는 파일을 가렸습니다. 추출 세대 ${String(result.extractionsRemoved)}건과 조각 ${String(result.chunksRemoved)}건, 검색용 이름 ${String(result.namesRemoved)}건, 메타데이터 ${String(result.metadataRemoved)}건을 지우고 블롭 삭제 일감 ${String(result.blobDeletesQueued)}건을 넣었습니다.`,
        // The bytes are not deleted in the transaction (AD-7), so the sentence
        // has to say when they will be: a person who stops here would think
        // Brain's copy was already off the disk.
        ...(result.blobDeletesQueued > 0
          ? ['Brain이 가진 사본은 다음 `brain queue drain`이 디스크에서 지웁니다.']
          : []),
      ],
    };
  },
};
