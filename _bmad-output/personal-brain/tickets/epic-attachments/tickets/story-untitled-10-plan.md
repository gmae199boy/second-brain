---
title: '다시 추출 경로'
type: 'feature'
ticket: '10'
created: '2026-10-26'
status: done
baseline_revision: '0ab62b1b085916905751f24c991a2defc58d0a13'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `brain failures list`와 `brain failures retry`가 `--target-kind`를 조용히 무시한다.
    evidence: |-
      두 명령이 `context.options['target-kind']`를 읽지만 dispatcher는 commander의 `command.opts()`를 넘기고, commander는 플래그 이름을 `targetKind`로 바꾼다(`setup-run.ts`는 바르게 camelCase로 읽음). 구현 에이전트가 `brain failures list --target-kind file --json`이 `session` 행도 돌려주는 것을 확인했다. 기존 시험은 픽스처마다 거른 종류의 실패만 있어 잡지 못한다. 이 스토리 전부터 있던 결함이고, 고침은 두 파일의 키를 `targetKind`로 바꾸고 섞인 픽스처 시험을 더하는 것이다.
    location: >-
      apps/cli/src/commands/failures-list.ts:71, apps/cli/src/commands/failures-retry.ts:56
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 8이 `failures retry`의 대상 종류 `file`과 `document_extract` 일감을 만들었지만, (1) 추출기 버전(`DOCUMENT_EXTRACTOR_VERSION`)이 올라도 이미 성공한 파일을 다시 읽는 길이 없고, (2) `failures retry`가 가린 파일·원본에 닿을 수 없는 파일의 실패에도 일감을 넣어 handler가 아무 일 없이 닫고 실패는 영영 남으며, 건너뛴 사실이 어디에도 보이지 않는다.

**Approach:** 새 명령 없이(`files reindex` 만들지 않음) drain의 넣기 단계가 현재 세대가 옛 버전 `ok`인 파일을 한 번 다시 넣고, `failures retry`와 drain 모두 가린·원본 불가 파일은 건너뛰고 그 수를 결과에 싣는다(원본 불가가 있으면 경고 `FILE_SOURCE_UNREACHABLE`).

## Boundaries & Constraints

**Always:**
- 새 Store 읽기 `ExtractionStore.listFilesWithStaleExtraction({ extractorVersion, limit })` → `{ ok: true; fileIds: readonly string[]; redacted: number; sourceUnreachable: number } | { ok: false; code: 'DB_UNAVAILABLE'; message }`. 잠금 없는 읽기. "뒤처진 파일" = `current_extraction_id`가 가리키는 세대가 `status = 'ok'`이고 `extractor_version <> extractorVersion`이며, 그 파일에 `extractor_version = extractorVersion`인 세대가 **하나도 없음**(상태 무관 — 다시 읽기가 실패해도 매 drain 다시 넣지 않음; 그 뒤는 `failures retry`의 몫). `fileIds` = 그 가운데 `home_location_id` 있음·`redacted_at` null·`source_unreachable_at` null, id 순 `limit`개. `redacted` = 뒤처졌고 가린 파일 수, `sourceUnreachable` = 뒤처졌고 가리지 않았고 원본 불가인 파일 수(둘 다 `limit`과 무관한 전체 수).
- 구현: SQLite(`packages/sqlite/src/extractions.ts`), fake(`packages/core/src/testing/fakes/store.ts`, 가리기 없음 → `redacted`는 늘 0), 손 Store 둘(`apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts`는 `unavailable`), 계약(`packages/core/src/testing/contracts/extraction-store.ts`)에 사례 추가.
- drain 넣기: `enqueueDocumentExtractions`가 새 파일 다음에 같은 마감·`listOpenWorkTargets`·`addWork` 규칙으로 뒤처진 파일도 넣고 `{ redacted, sourceUnreachable }`를 돌려준다(읽기 실패·마감 전 미실행이면 0). 버전은 옵션(`extractorVersion`, 기본 `DOCUMENT_EXTRACTOR_VERSION`).
- `BrainDrainReport`에 `reextractRedacted`·`reextractUnreachable`(unwritable로 일찍 끝나면 0). CLI `queue drain` data에 `reextract_redacted`·`reextract_unreachable`, 한 줄 문장에 `건`이 붙은 절 둘, `reextract_unreachable > 0`이면 `warnings`에 `FILE_SOURCE_UNREACHABLE`. `output` 설명 문구 갱신.
- `retryFailures`: 대상 종류 `file`이고 고른 kind가 `DOCUMENT_EXTRACT_KIND`인 실패마다 `readFileExtractionState`로 상태를 읽어 `redactedAt`이면 `redacted += 1`, 아니고 `sourceUnreachableAt`이면 `sourceUnreachable += 1`로 세고 일감을 넣지 않는다. `FILE_NOT_FOUND`는 지금처럼 넣는다(handler가 닫음), `DB_UNAVAILABLE`은 그 code로 실패. 의존성에 `Pick<ExtractionStore, 'readFileExtractionState'>`. `FailuresRetryData`에 `redacted`·`sourceUnreachable`. CLI `failures retry` data에 `redacted`·`source_unreachable`, 0보다 크면 각각 한국어 한 줄, `source_unreachable > 0`이면 `warnings`에 `FILE_SOURCE_UNREACHABLE`. `output` 설명 갱신.
- 새 문구는 한국어(출력 언어 시험). README의 drain·`failures retry` 설명에 한두 문장.

**Never:** 마이그레이션, Postgres, 새 CLI 명령(`files reindex`)·옵션, `codes.ts` 표 변경(`FILE_SOURCE_UNREACHABLE`은 이미 있음), handler(`documentExtractHandler`)의 동작 변경, `unsupported`·`too_large`·`failed` 현재 세대의 다시 넣기(성공 파일만), 파일 가리기(12), `source_unreachable_at` 해제.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| 버전 상승 | 현재 세대 `ok`·`doc/0`, 빌드 `doc/1`, drain | 일감 1개, 새 attempt `ok`·`doc/1`, 포인터 새 세대, 옛 세대 정리 | — |
| 두 번째 drain | 위 다음 | 새 일감·attempt 없음 | — |
| 정상 파일 | 현재 세대가 이미 빌드 버전 | 넣지 않음 | — |
| 다시 읽기 실패 | 옛 `ok` + 빌드 버전 `failed` 세대 | 넣지 않음, 옛 포인터·조각 그대로 | 실패 행은 `failures retry`로 |
| 원본 불가 | 뒤처진 `ok` + `source_unreachable_at` | 넣지 않음, `reextract_unreachable` 1, 경고 `FILE_SOURCE_UNREACHABLE`, 옛 조각·포인터 그대로 | — |
| 가린 파일(SQLite) | 뒤처진 `ok` + `redacted_at` | 넣지 않음, `reextract_redacted` 1 | — |
| 성공 아닌 세대 | 현재 포인터 없음, `unsupported`·`doc/0`만 | 넣지 않음, 세지 않음 | — |
| retry 일시 실패 | `file` 실패, 파일 정상 | 일감 1, drain 뒤 attempt +1, 성공 시 포인터 새 세대·실패 해소 | — |
| retry 원본 불가 | `file` 실패 + `source_unreachable_at` | 일감 없음, `source_unreachable` 1, 경고, 새 attempt 없음 | — |
| retry 가린 파일 | `file` 실패 + `redacted_at` | 일감 없음, `redacted` 1 | — |
| retry DB 실패 | 상태 읽기 `DB_UNAVAILABLE` | — | 그 code로 실패 |

</intent-contract>

## Code Map

- `packages/core/src/files/extract-work.ts` -- `enqueueDocumentExtractions`(확장; 마감 확인·`held` 집합·`addWork` 실패 시 멈춤을 그대로 재사용), `DOCUMENT_EXTRACT_KIND`. handler는 바꾸지 않는다.
- `packages/core/src/files/extractors.ts` -- `DOCUMENT_EXTRACTOR_VERSION`(주석의 "later story" 문장을 사실대로 고침).
- `packages/core/src/brain.ts:159` `BrainDrainReport`(`rereadMissing`이 같은 종류의 칸 본보기), `:400` `drain()`(`:443` 넣기 호출, `:408` unwritable 조기 반환), `:352` retry 조립(`store` 전체를 넘김).
- `packages/core/src/failures/retry.ts` -- `retryFailures`, `FailuresRetryData`·`FailuresRetryDependencies`.
- `packages/core/src/ports/store.ts:954-1090` -- `FileExtractionState`, `ListFilesAwaitingExtractionResult`(결과 타입 본보기), `ExtractionStore`(새 메서드 자리, 문서 주석 문체).
- `packages/sqlite/src/extractions.ts:463` `listFilesAwaitingExtraction` -- 잠금 없는 읽기 본보기(connect·try/catch·`describe`).
- `packages/core/src/testing/fakes/store.ts:875` -- fake 본보기(`fileRows`, `extractions`, `sourceUnreachableAt`, `currentExtractionId` 보관 방식 확인).
- `apps/cli/src/commands/queue-drain.ts`, `apps/cli/src/commands/failures-retry.ts` -- data 칸·`text`·`output`; 성공 결과에 `warnings?: readonly WarningCode[]`(`apps/cli/src/dispatch.ts:155`).
- `apps/cli/src/doctor/store.ts:66`, `apps/cli/test/dispatch.test.ts:1331` -- 손 Store.
- 시험 본보기: `packages/core/test/document-extract.test.ts`(createBrain + fake, `brain.queue.drain({ handlers })`로 `documentExtractHandler({..., extractorVersion: 'doc/0'})` 주입해 옛 버전 세대 만들기), `packages/sqlite/test/document-extract.test.ts`·`packages/sqlite/test/extraction-store.test.ts`(`withWrite({ redact: true })`로 `redacted_at` 채우기), `apps/cli/test/sessions-ingest.test.ts`(txt @파일 수집 → drain, 8의 AC), `apps/cli/test/capture-scan.test.ts:864`(`DatabaseSync`로 행 직접 쓰기; 가리기 trigger는 `brain_redact_allowed()` 함수를 요구하므로 CLI에서 `redacted_at`이 필요하면 `database.function('brain_redact_allowed', () => 1)` 등록).
- `packages/core/test/failures.test.ts`, `apps/cli/test/*failures*` -- 기존 retry 기대값(새 칸 0 추가에 맞춰 고침).
- `README.md` -- drain·`failures retry` 절, 출력 칸 대조 시험이 있으면 함께.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `packages/sqlite/src/extractions.ts`, `packages/core/src/testing/fakes/store.ts`, `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts`, `packages/core/src/testing/contracts/extraction-store.ts` -- `listFilesWithStaleExtraction`과 계약 사례(옛 버전 `ok`만 나옴, 빌드 버전 세대가 하나라도 있으면 빠짐, 성공 아닌 현재 세대·포인터 없음은 안 나옴, 원본 불가는 `fileIds`에서 빠지고 `sourceUnreachable`로 셈) -- 넣기·보고의 입력.
- [x] `packages/core/src/files/extract-work.ts`, `packages/core/src/files/extractors.ts` -- 뒤처진 파일 넣기와 건너뛴 수 반환.
- [x] `packages/core/src/brain.ts`, `packages/core/src/failures/retry.ts`, export 파일 -- 보고 칸, retry 건너뛰기.
- [x] `apps/cli/src/commands/queue-drain.ts`, `apps/cli/src/commands/failures-retry.ts` -- data 칸·문장·경고·`output`.
- [x] `packages/core/test/document-extract.test.ts`(또는 새 `reextract.test.ts`), `packages/core/test/failures.test.ts` -- I/O 표의 fake로 되는 줄 전부(retry 일시 실패는 감싼 FileStore로 10회 뒤 실패 행을 만들거나 실패 행을 직접 기록).
- [x] `packages/sqlite/test/document-extract.test.ts` -- SQLite에서 가린 파일·원본 불가 건너뛰기와 수, 버전 상승 뒤 새 세대 조각이 FTS로 찾힘.
- [x] `apps/cli/test/` 해당 파일 -- 아래 AC, 기존 엔벨로프 기대값 갱신.
- [x] `README.md` -- 버전 상승 다시 넣기와 건너뛰기 한두 문장.

**Acceptance Criteria:**
- Given 설치한 임시 home에서 txt @파일을 수집해 `ok` 세대가 생긴 뒤 DB에서 그 세대의 `extractor_version`을 옛 값으로 만든 상태, when `brain queue drain --json`을 두 번, then 첫 실행 뒤 그 파일의 `attempt`가 하나 올라 포인터가 빌드 버전 `ok` 세대를 가리키고, 두 번째 실행 뒤 `attempt`·세대 수가 그대로다.
- Given 같은 상태에서 그 파일의 `source_unreachable_at`을 채움, when `brain queue drain --json`, then 새 attempt가 없고 옛 포인터·조각이 그대로이며 엔벨로프 `data.reextract_unreachable`이 1, `warnings`에 `FILE_SOURCE_UNREACHABLE`.
- Given 그 파일에 미해결 `document_extract` 실패 행이 있고 파일이 원본 불가(또는 가림), when `brain failures retry --json`, then `data.added`가 0, `data.source_unreachable`(또는 `data.redacted`)이 1, 원본 불가면 `warnings`에 `FILE_SOURCE_UNREACHABLE`, 그 뒤 drain에도 새 attempt가 없다.
- Given 저장소 전체, when `pnpm build`·`pnpm typecheck`, then 새 Store 메서드를 모든 구현이 갖춰 통과한다.

## Implementation Notes

- 닫힌 세대의 `extractor_version`은 바꿀 수 없으므로(trigger `document_extractions_immutable_update`) CLI 시험의 `stampExtractorVersion`은 옛 빌드가 남겼을 모양을 직접 만든다: 옛 버전 `ok` 행을 attempt+1로 넣고 조각·포인터를 옮긴 뒤 대체된 행을 지운다. `files_immutable_update`가 `brain_redact_allowed()`를 부르므로 그 연결에 `0`을 돌려주는 함수를 등록한다.
- CLI 시험 transcript 줄에 `cwd`를 넣어 `session_identity` 실패가 생기지 않게 했다(그래야 거르지 않은 `failures retry`의 `added`가 0).
- SQLite 구현은 한 SQL 조각(`behindPredicate`)을 id 목록과 집계 두 문장이 함께 써서, 넣은 파일과 센 파일이 어긋나지 않는다.
- 넣기 단계는 새 파일을 먼저, 뒤처진 파일을 다음에 넣는다(예산이 모자라면 텍스트가 하나도 없는 파일이 우선). 뒤처진 목록 읽기가 실패해도 새 파일은 넣고 수는 0이다.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 3 findings — high 0, medium 0, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` (quick) drain의 `reextract_redacted`는 실제 가리기(0002 주석대로 `files.redact`가 현재 세대를 지우며 포인터를 비움) 뒤에는 늘 0이다(`packages/sqlite/src/extractions.ts` `behindPredicate`) — 맞다. 다만 가린 파일은 넣지 않는다는 건너뛰기 자체는 그대로 지켜지고, 해는 늘 `0건`인 칸 하나다. 가리기는 아직 없고(12), 고치려면 칸을 없애거나(공개 출력 변경) "뒤처짐"의 뜻을 바꿔야 해서 직접 고침이 아니다. 12가 가리기 모양을 정할 때 이 칸의 쓸모를 정하도록 남은 위험에 적었다. `failures retry`의 `redacted`는 `redacted_at`을 직접 읽어 영향이 없다.
  - `[low]` `[reject]` (quick) SQLite의 가린 파일 시험이 `redacted_at`만 채우고 포인터·조각을 남겨, 실제 가리기가 만들지 않는 상태를 쓴다(`packages/sqlite/test/document-extract.test.ts`) — 위와 같은 뿌리. 시험은 이 어댑터의 질의(가린 파일을 목록에서 빼고 셈)를 정확히 확인하고, 실제 가리기 상태는 12가 정한다. 12가 가리기 뒤 다시 추출 경로를 검증한다(티켓 12 verify).
  - `[low]` `[patch]` (quick) `ENQUEUE_LIMIT` 주석이 읽기 한 번 500건만 말하지만 이제 두 읽기에 걸려 한 실행이 1,000건까지 읽고 넣으려 한다(`packages/core/src/files/extract-work.ts`) — 구현 에이전트가 주석을 "읽기마다의 상한, 한 실행 최대 천 건, 실행을 짧게 하는 것은 마감"으로 고쳤다(코드 변경 없음).

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) "그 추출기의 버전"은 빌드 전체의 상수 하나(`DOCUMENT_EXTRACTOR_VERSION`, AD-24의 `doc/1+pdfjs-…` 꼴)로 읽는다. 추출기별 버전은 지금 없다.
- Decision(같은 날) 다시 넣는 대상은 현재 세대가 `ok`인 파일뿐이다(티켓 "성공 파일"). `unsupported` 이미지를 EXIF 추출기가 다시 읽게 하는 길은 그 스토리(epic 4의 1)가 정한다.
- Decision(같은 날) "빌드 버전 세대가 하나도 없음"을 조건에 넣어, 다시 읽기가 영구 실패해도 drain마다 다시 넣지 않는다. 일시 실패는 일감 재시도(AD-21), 그 뒤는 `failures retry`.
- Decision(같은 날) 건너뛴 수는 `limit`과 무관한 전체 수이고, 원본 불가는 상태가 남는 한 매 drain 보인다(AD-24 "결과에 경고를 붙인다").

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 새 시험 포함 모두 통과(Docker가 있으면 `pnpm test`).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- **요약:** 새 명령 없이 다시 추출 경로를 마쳤다. 새 Store 읽기 `listFilesWithStaleExtraction`(현재 세대가 다른 버전의 `ok`이고 빌드 버전 세대가 하나도 없는 파일, 가린·원본 불가 파일은 목록에서 빼고 전체 수로 셈)을 SQLite·fake·손 Store에 더하고, drain 넣기 단계가 새 파일 다음에 뒤처진 파일을 한 번 넣는다(다시 읽기가 실패해도 매 drain 다시 넣지 않음). `brain queue drain`은 `reextract_redacted`·`reextract_unreachable`과 원본 불가가 있으면 경고 `FILE_SOURCE_UNREACHABLE`을 낸다. `failures retry`는 파일 추출 실패마다 상태를 한 번 읽어 가린·원본 불가 파일은 일감 없이 `redacted`·`source_unreachable`로 세고 같은 경고를 낸다. handler는 바꾸지 않았다.
- **바뀐 파일:**
  - `packages/core/src/ports/store.ts`, `packages/core/src/ports/index.ts`, `packages/core/src/index.ts` — 새 Store 메서드·결과 타입·export.
  - `packages/sqlite/src/extractions.ts` — 공용 SQL 조각으로 id 목록과 건너뛴 수 집계.
  - `packages/core/src/testing/fakes/store.ts`, `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` — fake·손 Store.
  - `packages/core/src/testing/contracts/extraction-store.ts` — 뒤처진 목록 계약 사례.
  - `packages/core/src/files/extract-work.ts` — 뒤처진 파일 넣기, 건너뛴 수 반환, `extractorVersion` 옵션, `ENQUEUE_LIMIT` 주석.
  - `packages/core/src/files/extractors.ts` — 버전 상수 주석을 실제 동작대로.
  - `packages/core/src/brain.ts` — `BrainDrainReport`의 `reextractRedacted`·`reextractUnreachable`.
  - `packages/core/src/failures/retry.ts` — 파일 상태 읽기와 건너뛰기, `redacted`·`sourceUnreachable`.
  - `apps/cli/src/commands/queue-drain.ts`, `apps/cli/src/commands/failures-retry.ts` — 엔벨로프 칸·문장·경고·`output`.
  - `README.md` — drain과 `failures retry` 절에 한 문단씩.
  - 시험: `packages/core/test/{document-extract,failures,brain-drain}.test.ts`, `packages/sqlite/test/document-extract.test.ts`, `apps/cli/test/{sessions-ingest,queue-drain}.test.ts`.
- **리뷰(quick, 1회):** 3건 모두 low — 패치 1(`ENQUEUE_LIMIT` 주석), 기각 2(drain의 `reextract_redacted`가 12의 실제 가리기 뒤 늘 0이 되는 점과 그 상태를 흉내 낸 SQLite 시험: 건너뛰기는 지켜지고 해는 늘 0인 칸뿐이며, 고치려면 공개 출력을 바꾸거나 "뒤처짐"을 다시 정의해야 함 — 12로 넘김). 미룸 1(리뷰 밖, 구현 중 발견한 기존 결함: `failures list`·`retry`의 `--target-kind` 무시, medium).
- **후속 리뷰 권고:** false — 패치한 항목은 low 1(high 0, medium 0).
- **검증:** 패치 전후 각각 `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 81개 파일 2,511개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 열한 줄이 모두 실행된 시험에 덮인다('retry 일시 실패'는 8의 기존 시험 `packages/core/test/document-extract.test.ts`가 attempt 증가·포인터 교체·실패 해소를 확인).
- **남은 위험:** 12가 가리기에서 현재 세대를 지우면 drain의 `reextract_redacted`는 늘 0이 된다 — 12가 이 칸을 남길지 정해야 한다. `listFilesWithStaleExtraction`은 모든 drain(기회적 2초 포함)에서 돌고 `document_extractions(file_id, extractor_version)`에 맞는 색인이 없어 파일이 아주 많으면 훑기가 된다(마이그레이션 금지라 색인 없음). `source_unreachable_at`을 푸는 길이 없어 원본 불가 뒤처진 파일은 매 drain 경고를 낸다(AD-24대로). `unsupported` 이미지는 다시 넣지 않으므로 EXIF 추출기(epic 4의 1)는 자기 길이 필요하다. Postgres 시험은 Docker가 없어 돌리지 않았다(Postgres는 `ExtractionStore`를 구현하지 않음).
