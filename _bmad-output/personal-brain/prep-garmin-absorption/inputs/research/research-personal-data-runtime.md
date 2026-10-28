---
title: '개인 데이터 런타임: 코드 조사'
type: codebase
repository: '~/github/second-brain'
commit: '22390f56cdb1e939d74209f152c6b7d2a51a9f96'
comparison_repository: '~/github/garmin'
comparison_commit: '7fb33dd1661ad25cd73e14ed63abe0a87151f62e'
branch: main
status: complete
validation: normal
claims: {verified: 17}
created: '2026-10-27'
updated: '2026-10-27'
---

# 개인 데이터 런타임: 코드 조사

이 문서는 두 저장소의 고정 커밋에서 확인한 구현 사실을 기록한다. 제품 통합에 대한 판단과 제안은 별도 `integration-assessment.md`에 둔다. 독자는 통합을 결정할 사용자와 이후 변경을 설계할 개발자다.

## Questions

1. second-brain의 데몬·예약·작업 처리기는 작업을 어떻게 획득·실행·재시도·종료하며, 어떤 테스트가 이를 다루는가?
2. second-brain의 개인 데이터 저장·파일 수집·조회·복제 구조는 무엇이며, 검색·Drive·임베딩은 어디까지 구현되었는가?
3. Garmin의 수집·정규화·분석·저장·알림·예약은 어떻게 연결되고, 어떤 보호 장치와 테스트가 있는가?

질문별 분석자는 새로운 컨텍스트에서 코드와 테스트만 읽었다. 제품 통합 의도와 기존 기획 문서는 전달하지 않았다. 부모 에이전트가 조사 질문·코드 위치·결과 종합을 담당하고, 주요 주장에는 별도 검증을 수행한다.

실행 검증 범위: 이 조사는 코드 정적 분석이다. 패키지를 설치하거나 운영 DB·토큰·예약·데몬을 변경하지 않는다. 테스트 파일에서 확인한 보장과 이번 조사에서 실제 실행한 테스트를 구분한다.

## 1. 데몬·예약·작업 실행

### 실행 흐름과 확장 지점

데몬은 매 회차 DB·스키마를 확인하고 예약을 발화한 뒤 `brain.queue.drain`을 기다린다. drain은 spool 재주입, transcript 스캔, identity/파일 관련 일감 준비, 작업 처리를 같은 예산 안에서 진행한다. 작업 처리기는 `claim → await handler → 완료/재시도 기록` 순서를 반복한다. 한 drain 안에서는 직렬이며, 서로 다른 drain 프로세스는 원자적 claim으로 작업을 나눈다. `apps/cli/src/daemon/run.ts:162-214 (runDaemon) @ 22390f5`; `packages/core/src/brain.ts:436-495 (drain) @ 22390f5`; `packages/core/src/queue/drain.ts:237-305 (drainQueue) @ 22390f5`; `packages/sqlite/src/work.ts:202-251 (claimWork) @ 22390f5`.

데몬 기본 drain 예산은 10초다. 이는 다음 작업 획득을 시작할지 판단하는 제한이며, 이미 시작한 처리기의 timeout이 아니다. 원래 분석 주장의 “drain의 10초 제한”은 별도 검증에서 범위가 부정확하다고 지적되어 “데몬 기본 예산”으로 수정했다. `apps/cli/src/daemon/run.ts:57 (DAEMON_DRAIN_BUDGET_MS) @ 22390f5`; `packages/core/src/queue/drain.ts:224-258 (drainQueue) @ 22390f5`.

Core 처리기는 schedule probe, session identity, session ingest, document extract, blob delete다. `createBrain`의 `{ ...coreHandlers, ...workHandlers }`는 호출자 처리기에 우선권을 주며, drain별 `input.handlers`가 최종적으로 덮어쓴다. Core 처리기를 바꾸지 못한다는 인근 주석과 실제 구현이 다르다. 알 수 없는 kind는 획득 대상에서 제외한다. `packages/core/src/brain.ts:264-281 (createBrain) @ 22390f5`; `packages/core/src/brain.ts:392-400 (createBrain) @ 22390f5`; `packages/core/src/queue/drain.ts:224-249 (drainQueue) @ 22390f5`.

### 임대·실패·종료

작업 기본 임대는 600,000ms이고 kind별 override map은 비어 있다. 만료된 claim은 다른 drain이 재획득할 수 있다. 완료·재시도·해제는 `claimed_by`가 맞아야 반영되며, 다른 소유자가 가져간 뒤에는 lost가 된다. 만료 자체가 원래 소유자의 완료를 즉시 거부하는 것은 아니다. 조사한 queue/work 경로에서는 임대 갱신 구현을 찾지 못했다. `packages/core/src/domain/work-item.ts:111-132 (DEFAULT_WORK_POLICY) @ 22390f5`; `packages/sqlite/src/work.ts:76-92 (claimCandidateQuery) @ 22390f5`; `packages/sqlite/src/work.ts:254-296 (completeWork) @ 22390f5`.

DB가 쓰기를 거부하면 claim을 해제하고 drain을 멈춘다. 명시적 영구 오류는 곧바로 실패 기록, 명시적 일시 오류는 retryAfter 또는 기본 15분, 분류되지 않은 오류는 1초부터 최대 1시간까지 지수 backoff를 쓴다. 기본 최대 시도는 10회다. 처리기 예외는 HANDLER_THREW로 변환된다. `packages/core/src/queue/drain.ts:134-159 (classifyWorkFailure) @ 22390f5`; `packages/core/src/queue/drain.ts:338-353 (attempt) @ 22390f5`; `packages/core/src/domain/work-item.ts:95-114 (retryDelayMs) @ 22390f5`.

SIGTERM/SIGINT는 데몬 controller를 abort하지만, 실행 중인 drain에는 signal을 전달하지 않는다. 현재 drain 종료를 기다리며 heartbeat는 별도 interval로 갱신된다. 다만 동기 코드가 이벤트 루프를 막으면 heartbeat도 지연된다. `apps/cli/src/commands/daemon-run.ts:50-81 (daemonRunCommand) @ 22390f5`; `apps/cli/src/daemon/run.ts:258-284 (drainOnce) @ 22390f5`; `apps/cli/src/daemon/heartbeat.ts:45-62 (startHeartbeat) @ 22390f5`.

작업 claim의 write transaction은 처리기 실행 전에 끝난다. 별도 `withWrite`는 BEGIN IMMEDIATE부터 callback을 await하는 동안까지 연결과 transaction을 유지한다. SQLite 드라이버는 DatabaseSync를 사용하므로 busy 대기는 프로세스 진행을 막을 수 있다. `packages/sqlite/src/write.ts:52-92 (withWrite) @ 22390f5`; `packages/sqlite/src/driver.ts:41-64 (adaptDatabase) @ 22390f5`.

### 예약과 테스트 근거

예약은 interval 방식이다. tick은 현재 시각을 한 번 읽고 최대 100개를 발화하며, 반복 예약의 다음 시각은 실제 발화 시각 + 간격이다. 밀린 여러 회차는 한 회차로 합친다. enqueue와 next_run_at 갱신은 `fireSchedule`의 transaction 안에서 함께 수행한다. 같은 kind/target의 열린 일감은 중복 생성하지 않는다. 이 경로에는 시간대별 매일 HH:MM 계산이 없다. `packages/core/src/queue/schedule-tick.ts:5-29 (tickSchedules) @ 22390f5`; `packages/sqlite/src/schedules.ts:44-69 (fireSchedule) @ 22390f5`; `packages/sqlite/src/work.ts:96-121 (ensureWork) @ 22390f5`.

분석자는 queue-drain, schedule-tick, sqlite work-store, daemon-run 테스트의 assertion을 읽었다. 재시도, 예산, 열린 일감 중복 방지, 프로세스간 claim, 진행 중 handler와 abort, heartbeat, SIGTERM 정리를 다룬다. 이는 테스트가 존재하고 어떤 조건을 검사하는지에 대한 확인이며 이번 실행에서 통과했다는 뜻은 아니다. 테스트 세부 위치는 `digests/runtime.md`에 기록했다.

## 2. 개인 데이터 저장·파일·조회

### 실제 공개 기능

공개 Brain은 messages/files redact, doctor, sessions ingest, failures list/retry, queue drain, schedules tick, close를 제공한다. 공개 인터페이스와 전체 CLI 등록 목록에는 recall/search, 독립 파일 수집, 측정값 입력, 복제 명령이 없다. 이는 하위 Store에 읽기 기능이 전혀 없다는 뜻은 아니다. `packages/core/src/brain.ts:126-220 (Brain) @ 22390f5`; `apps/cli/src/commands/index.ts:36-56 (commands) @ 22390f5`.

SQLite Store는 세션·첨부·추출·사용자·작업·예약·transcript 저장을 조합한다. 메시지는 session/harness message id로 중복을 막고, 하위 `readSession`으로 시간순 메시지와 도구 기록을 읽는다. `packages/sqlite/src/store.ts:66-90 (sqliteStore) @ 22390f5`; `packages/sqlite/src/sessions.ts:379-415 (ingest) @ 22390f5`; `packages/sqlite/src/sessions.ts:542-589 (readSession) @ 22390f5`.

### 파일 수집과 출처

현재 파일 유입은 transcript에서 파싱된 메시지 첨부를 중심으로 동작한다. inline bytes 또는 크기/줄 수가 맞는 원본 파일 fallback을 읽고, blob 저장을 DB 쓰기 전에 수행한다. 파일은 내용 해시로 식별하며, 첨부에는 메시지·순서·원본 참조·표시명이 남는다. 별도 파일 import 공개 진입점은 없다. `packages/core/src/sessions/ingest.ts:402-465 (ingestSession) @ 22390f5`; `packages/sqlite/migrations/0002_files_and_work.sql:189-203 (message_attachments) @ 22390f5`.

files/file_locations/extractions/document_chunks는 파일의 내용, 위치, 소유권, 추출 세대를 관계로 보존한다. schema의 store_kind에는 drive가 허용되지만, 생산 코드 검색에서는 Google Drive API client를 찾지 못했다. “Drive 값이 있다”와 “Drive 동기화가 구현됐다”는 별개다. `packages/sqlite/migrations/0002_files_and_work.sql:102-158 (file_locations) @ 22390f5`; `packages/sqlite/migrations/0002_files_and_work.sql:221-263 (document_extractions) @ 22390f5`.

현재 CLI 하네스는 Claude Code 하나, 문서 추출기는 UTF-8 textExtractor 하나다. Markdown은 텍스트로 다룬다. PDF/DOCX/이미지 해석기는 이 등록 목록에 없다. `apps/cli/src/harnesses.ts:31-39 (harnesses) @ 22390f5`; `packages/core/src/files/extractors.ts:68-85 (DOCUMENT_EXTRACTORS) @ 22390f5`.

### 검색 기반과 실제 검색 경로의 차이

세션 chunk·log·도구 target과 문서 chunk·파일명에는 trigram FTS5 schema와 유지 trigger가 있다. 그러나 생산 코드에서 찾은 MATCH 실행은 임시 index를 쓰는 health probe이며, 공개 recall API와 세션 chunks 생성기는 검색 범위에서 찾지 못했다. 문서 document_chunks의 실제 작성기는 존재한다. 따라서 “chunk 생성이 모두 없다”는 표현은 틀리다. `packages/sqlite/migrations/0001_initial.sql:384-441 (chunks_fts) @ 22390f5`; `packages/sqlite/migrations/0002_files_and_work.sql:449-487 (document_chunks_fts) @ 22390f5`; `packages/sqlite/src/store.ts:279-299 (trigramProbe) @ 22390f5`; `packages/sqlite/src/extractions.ts:279-300 (appendExtractionChunks) @ 22390f5`.

ModelStudio는 빈 placeholder다. postgresStore는 HealthStore & SchemaStore와 close만 제공하며 대화·첨부 Store 또는 실행 중 복제기는 확인되지 않았다. 측정값/시계열 공개 API와 전용 테이블도 조사한 생산 코드·마이그레이션에서 찾지 못했다. log_entries는 progress/decision/rule/preference 종류의 텍스트 기록이다. `packages/modelstudio/src/index.ts:1-4 (module) @ 22390f5`; `packages/postgres/src/store.ts:49-131 (postgresStore) @ 22390f5`; `packages/sqlite/migrations/0001_initial.sql:147-166 (log_entries) @ 22390f5`.

SQLite schema version은 9다. 설치 migration은 WAL 설정 후 migration별 write transaction에서 저장 버전을 다시 확인하고 SQL과 버전 기록을 함께 반영한다. `packages/sqlite/src/migrate.ts:20 (SQLITE_SCHEMA_VERSION) @ 22390f5`; `packages/sqlite/src/migrate.ts:131-198 (runSqliteMigrations) @ 22390f5`.

## 3. Garmin 비교 조사

별도 저장소의 커밋과 citation 검증을 혼동하지 않도록 Garmin 사실은 [garmin-runtime.md](garmin-runtime.md)에 분리했다. 원본 분석과 테스트 탐색 기록은 `digests/garmin.md`에 있다.

## Where the answers meet

`createBrain`은 개인 데이터 수집 처리기와 예약/대기열의 결합 지점이다. caller workHandlers와 per-drain handlers의 확장 경로가 있고, drain은 이 처리기 map에 등록된 kind만 claim한다. `packages/core/src/brain.ts:264-281 (createBrain) @ 22390f5`; `packages/core/src/brain.ts:392-400 (createBrain) @ 22390f5`; `packages/core/src/queue/drain.ts:224-249 (drainQueue) @ 22390f5`.

## Open questions

15파일/질문 한도 밖으로 남긴 영역은 parser 내부, filesystem containment, 문서 추출 transaction 세부, Postgres migration/setup 전체다. 다음 사실 질문은 “파일 원본이 수정·삭제될 때 추출 세대와 출처 연결은 어떻게 바뀌는가?”와 “설정 변경·업그레이드 중 실행 작업의 수명은 어떻게 처리되는가?”다. 본 조사에서 미확인인 이 영역을 구현된 기능으로 계산하지 않는다.

생산 코드 부재 판단은 지정 커밋의 packages/apps와 공개 registry 검색 범위에 한정한다. 설치된 별도 버전·외부 서비스·미커밋 코드의 상태를 나타내지 않는다.

## Prior documents

다음 문서의 존재만 확인했으며, 구현 여부를 입증하는 근거로 사용하지 않았다: second-brain의 architecture-brain-v1-slice-1 및 epic-daemon/attachments/log-and-context 연구 문서, Garmin의 architecture-garmin-2026-10-15.
