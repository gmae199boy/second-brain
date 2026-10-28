# Epic 11 코드 조사 — PostgreSQL 단일 주 저장소

조사일: 2026-10-28. 기준 HEAD: `d126bc9`. 정적 코드 조사이며 Docker·네트워크·설치·테스트 실행은 하지 않았다. 아래 건수는 코드의 선언/계약 case를 센 값이며 통과 실측이 아니다. 이 보고서만 작성했다.

결정 재논의는 제외한다. 공식 PostgreSQL 18/OrbStack, 빈 DB + transcript 재수집, SQLite 삭제, PG 0001 재작성은 확정이다. 근거: `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md:14`, `:44`, `:66`; 아래에서 **spine**은 `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`를 뜻한다. 인용 `spine:행`은 이 파일의 행이다.

## 1. 현재 PostgreSQL 코드와 AD-31 차이

| 파일 | 현재 구현 | 이번 에픽의 차이 |
|---|---|---|
| `packages/postgres/src/connect.ts:34` | pg Pool 생성 공통 함수, 연결/질의 기본 5초, max 1, idle error listener, import 때 연결 없음 | AD-7의 호출 경로별 lock_timeout, statement_timeout, application_name, UTC 세션 설정이 없다. 세션 advisory lock과 SKIP LOCKED 청구도 Store에 아직 없다(spine:167). |
| `packages/postgres/src/store.ts:49` | `HealthStore & SchemaStore`만 반환. `checkHealth`, `readSchemaVersion`, `close` 3개 고유 verb | SQLite가 제공하는 업무 verb 46개 전부 미구현(3절). health는 서버 버전·vector 설치 여부, schema는 public singleton 조회뿐이다(`:57`, `:103`). |
| `packages/postgres/src/migrate.ts:12` | 기대 버전 1, 패키지 migrations 폴더만 읽음 | owner/확장 입력과 checksum 기록/검증이 없다. |
| `packages/postgres/src/migrate.ts:122` | 파일마다 BEGIN → `pg_advisory_xact_lock(4919270911)` → 버전 재조회 → SQL → singleton UPSERT → COMMIT | 파일별 트랜잭션과 advisory lock은 재사용 가능. 이미 적용된 파일을 version 비교만으로 생략해 파일 내용 변경은 감지 못 한다. |
| `packages/postgres/src/migrate.ts:178` | `public.schema_version` 유무 검사, 없으면 0; `:198` 파일 정렬·같은 번호 중복 거부·최고 번호 확인 | 연속 번호의 중간 누락 검사는 없다. `brain.schema_migrations(owner,version,name,checksum,applied_at)`와 owner별 연속 번호로 바꿔야 한다(spine:475). |
| `packages/postgres/src/setup.ts:78` | vector 설치(불가능하면 capability 실패로 남기고 설치 자체는 진행) | pgvector 금지와 충돌. `ensureVectorExtension`/export/호출 테스트 정리. |
| `packages/postgres/src/setup.ts:136` | 기본 chunk config 한 행을 JSONB 값 비교로 멱등 seed | document_chunk config 및 새 schema 이름과 맞춰야 한다. 지금은 설치 외부 API이며 Store port가 아니다. |

현재 PG SQL은 332줄, 일반 테이블 15개, GIN 3개, trigger 4개, plpgsql 함수 3개다. `pg_trgm`은 이미 설치하지만 GIN이 `body/text/target` 원칼럼에 걸려 AD-15의 **lower(expression)** 기준과 다르다(`packages/postgres/migrations/0001_initial.sql:11`, `:216`). `brain` schema/role 경계 없이 unqualified 표를 만든다(`:14`); `messages.seq`, chunk의 seq 범위, 로그의 anchor_seq/joined_upto_seq, `sessions.user_id text`는 후속 SQLite 계약과 어긋난 초기 설계다(`:38`, `:68`, `:95`, `:137`). 메시지/도구 메모 UPDATE·DELETE 및 TRUNCATE 방어와 message-id GUC 기반 redaction 함수는 이미 있다(`:227`, `:252`, `:260`, `:286`). 그러나 첨부·파일·추출·일감·예약·settings와 redaction 정리 일감은 없다. 0001을 그대로 확장 마이그레이션으로 이어가는 접근 대신 재작성하라는 spine:484를 따른다.

PG 테스트는 `packages/postgres/test/store.test.ts:45` health 계약, `:67` schema 계약(빈 DB·마이그레이션 후·연결 불가 변형 포함), `test/migrate.test.ts:287` 초기 테이블/키, `:326` 동시 실행, `:367` MIGRATION_FAILED 구분, `:429` TRUNCATE 거부, `:478` redaction, `:999` GIN 3개를 검사한다. `test/setup.test.ts:89` vector 설치와 `:124` config seed, `:159` JSONB 키 순서 비교를 검사한다. 업무 Store 계약 runner는 아직 없다.

테스트 인프라:

- `compose.test.yaml:3` vector init SQL, `:11` `pgvector/pgvector:pg18`, `:15` host 54329, `:18` tmpfs `/var/lib/postgresql`, `:23` healthcheck. 제품 영속성 tracer에 이 Compose를 쓰면 안 된다. spine:640·:685는 테스트도 공식 postgres:18로 정했다.
- `tooling/test-db/src/index.ts:79` 매 테스트용 random database 생성/삭제, `:80` 기본 `installVector=true`, `:93` CREATE EXTENSION vector. 이 옵션 제거/대체와 role/schema를 갖춘 테스트 fixture가 필요하다.
- `tooling/test-db/src/global-setup.ts:86`: env URL이 있으면 Docker 호출 없음; 없으면 docker info → compose ps → 없을 때 up --wait. 자신이 띄운 경우만 down(`:128`). 실패는 테스트 전에 안내 한 번으로 중단하고 반쯤 만든 컨테이너는 보존(`:111`). 이 소유권 규칙은 유지할 가치가 있다.
- `_bmad-output/personal-brain/plan-test-db-auto-start.md:30`의 과거 frozen 범위는 이미지·포트·tmpfs 변경 금지였지만, 이 에픽의 새 spine은 공식 이미지를 명시한다. 과거 16개 실패/1546개 성공 기록(`:22`, `:87`)은 현재 case 수가 아니다. 이 문서를 조용히 현재 설계로 해석하지 말고 이번 변경의 상위 근거를 스토리에 명시한다.

pgvector에 실제 의존하는 전체 지점(일반적인 embedding vector 타입은 별개): `compose.test.yaml:3`; `tooling/test-db/src/index.ts:25`, `:80`, `:93`; `tooling/test-db/src/global-setup.ts:47`; `tooling/test-db/test/global-setup.test.ts:130`, `:149`; `packages/postgres/src/setup.ts:15`, `:78`, `:175`; `packages/postgres/src/index.ts`의 해당 재export; `packages/postgres/src/store.ts:62`, `:88`, `:140`; `packages/postgres/test/setup.test.ts:89`, `:101`; `packages/postgres/test/store.test.ts:20`; `apps/cli/src/install/docker.ts:37`; `packages/core/src/testing/fakes/store.ts:80`; `packages/core/test/doctor.test.ts:83`, `:101`, `:402`; Store probe 설명 `packages/core/src/ports/store.ts:31`; README의 adapter 설명/테스트 전제 `README.md:916`, `:989`. SQL의 'vector 미설치도 동작' 설명과 테스트 fixture(`packages/postgres/migrations/0001_initial.sql:8`, `test/migrate.test.ts:79`, `test/setup.test.ts:23`)도 문구 갱신 대상이다. `packages/core/src/domain/embedding.ts:16` 등 수학적 vector 자체는 pgvector 의존이 아니며 삭제 근거가 없다.

## 2. SQLite 전용 경로: 교체/삭제 목록과 오류·spool

런타임은 `second_brain` 재export를 거쳐 SQLite를 쓴다. 직접 `@second-brain/sqlite` import만 찾으면 CLI를 놓친다. 번들 `packages/second_brain/src/index.ts:3`, dependency `packages/second_brain/package.json:31`, 별도 PG 진입점 `packages/second_brain/src/postgres.ts:2`, 경계 허용 목록 `packages/second_brain/test/boundaries.test.ts:52`를 함께 바꿔야 한다.

| 경로 | 현재 결합/교체점 |
|---|---|
| `apps/cli/src/dispatch.ts:345` | CreateStore가 SqliteStoreOptions이고 기본 factory가 sqliteStore(`:435`). `:572` config.storePath + busyTimeout으로 연다. 쓰기 전 SQLite 버전 검사(`:603`), 별도 기회적 drain 연결(`:739`)도 함께 교체. |
| `apps/cli/src/assembly.ts:79` | Core에 전달하는 기대 schema version이 SQLITE_SCHEMA_VERSION. 빌드 기록 생성기도 SQLite 버전을 import하고 build.json에 쓴다(`apps/cli/scripts/write-build-info.mjs:5`, `:44`). 둘 다 PG owner별 버전 모델로 교체해야 한다. |
| `apps/cli/src/daemon/run.ts:163` | 매 회차 config → SQLite Store → schema guard → tick/drain → close. `:264`, `:268`의 옵션/버전 교체. 실패마다 새 연결을 시도하는 구조는 이미 있다. |
| `apps/cli/src/install/store.ts:118` | SQLite header 검사·0600 파일 생성·0700 폴더·wal/shm chmod → migrations. `:151` runSqliteMigrations; `:221` self-user; `:297` 설치 doctor도 SQLite. 빈 PG 전환에서는 옛 project collision 합치기(`:5`, `:101`) 경로도 불필요. |
| `apps/cli/src/install/flow.ts:403` | DB 파일 위치·충돌 확인(`:451`)·마이그레이션(`:486`)·self(`:518`)·config 저장(`:539`)·doctor(`:561`)·완료 기록(`:639`)이 파일 모델이다. `--store-path` 플래그 파서(`:1032` 이하)·결과의 store.path(`:651`)도 바뀐다. |
| `tooling/bootstrap/src/bootstrap.ts:420` | ref 준비 → pnpm install/build(`:467`) → 설치기 실행(`:431`) → 완료 기록 검증(`:445`). bootstrap이 직접 DB를 열거나 migrations를 실행하지는 않는다. 같은 설치기에 PG 전환을 넣어 갱신 경로가 공유하게 한다. `plugin/bootstrap.js`와 `tooling/bootstrap/bin/second-brain.js` 생성 복사본도 동기화 대상. |

`packages/sqlite/src/connect.ts:108`의 openSqlite는 런타임 `?mode=rw`로 미존재 파일을 생성하지 않고 실패를 DB_UNAVAILABLE 값으로 반환한다. foreign_keys/recursive_triggers와 JS closure `brain_redact_allowed()`를 등록한다(`:128`). `src/write.ts:49` withWrite가 한 connection을 잡아 BEGIN IMMEDIATE, busy → DB_LOCKED, commit/rollback, redact marker 정리를 소유한다. SQLite adapter의 sessions/attachments/extractions/users/work/schedules/transcript-files/migrate 전부 이 helper를 쓰며 Store health도 수동 BEGIN IMMEDIATE를 쓴다(`src/store.ts:222`). Core에 남은 BEGIN IMMEDIATE 설명(`packages/core/src/ports/store.ts:639`, `:1255`)과 `packages/core/src/busy-timeout.ts` 명명도 새 lock_timeout 구현과 맞춰야 한다(spine:167).

저장본 가리기: `packages/sqlite/src/write.ts:75` secure_delete ON, finally OFF(`:89`), `src/sessions.ts:145` 본문·redactions·파생물 정리 쓰기 후 `:181` wal_checkpoint(TRUNCATE) best effort, `src/attachments.ts:222` 파일 가리기 후 `:328` 같은 checkpoint다. PG는 이 PRAGMA를 이식하지 않는다. spine:224의 트랜잭션 로컬 GUC와 plpgsql, 정리 일감 → 트랜잭션 밖 VACUUM FULL/CHECKPOINT, 미완료 doctor warn 및 제한된 MAINTAIN/pg_checkpoint 권한 경로가 필요하다. 현 PG SQL redaction은 메시지만 치환/기록하며 이 후속 정리는 없다(`packages/postgres/migrations/0001_initial.sql:321`).

FTS5는 5개: chunks_fts/log_entries_fts/tool_notes_fts(`packages/sqlite/migrations/0001_initial.sql:384`, `:406`, `:429`), document_chunks_fts/file_names_fts(`0002_files_and_work.sql:449`, `:470`). external-content + search_rowid이며 secure-delete 설정과 동기화 trigger 14개를 쓴다(3절). 제품 코드의 MATCH는 health의 임시 FTS5 탐침(`packages/sqlite/src/store.ts:280`)뿐이다. 현재 사용자 검색 Store verb는 없다(3절의 전체 verb 목록). 실제 FTS 질의/블록 소거 검사는 `packages/sqlite/test/schema.test.ts:169`, `:552`, `test/schema-files.test.ts:148`, `:1087`, `test/schema-0006.test.ts:119`, `test/redact.test.ts:59`, `test/extraction-store.test.ts:184`, `test/document-extract.test.ts:173`에 있다. PG의 lower(col) GIN 및 쓰기/가리기 검증으로 의미를 옮기고 SQLite FTS 내부 블록 검사는 삭제한다. 검색 API 전체를 여기서 새로 만드는 것은 epic 경계 밖이다(spine:276, 에픽:48).

doctor의 DB 파일/WAL 상태는 CLI 파일 검사라기보다 adapter probes다: `packages/sqlite/src/store.ts:115` 파일 위치, `:213` 임시 테이블 rollback으로 writable 검사(잠금이면 warn), `:263` WAL mode, `:280` FTS5 trigram, `:302` 이후 FK 검사. Core `packages/core/src/doctor/doctor.ts:152`는 Store probes를 결과로 조합하므로 PG의 연결·쓰기·pg_trgm·owner별 schema와 runtime OrbStack/컨테이너 check를 넣을 수 있다. CLI `apps/cli/src/doctor/checks.ts:152` spool 및 node/shim/plugin/daemon 등의 머신 체크는 유지한다.

오류 분기와 앞으로의 매핑:

- `packages/core/src/schema.ts:29`: schema read 실패 → DB_UNAVAILABLE; null/다른 version → SCHEMA_MISMATCH. 현재 PG도 연결 거부·닫힌 연결 query 실패는 DB_UNAVAILABLE(`packages/postgres/src/store.ts:95`, `:125`). 없는 `schema_version`(42P01)은 null이라 **현재는 SCHEMA_MISMATCH**가 된다(`:119`); AD-10은 runtime에 database/schema/role 자체가 없으면 DB_UNAVAILABLE라고 하므로 `brain` 부재와 version 불일치를 구분해야 한다(spine:205).
- 쓰기 전 guard 실패에 spool handler가 있으면 handler로 우회하고 없으면 오류; DB_UNAVAILABLE exit 2, SCHEMA_MISMATCH exit 1(`apps/cli/src/dispatch.ts:599`). hook의 세션 수집은 schema 이후 실제 Store 실패도 `DB_UNAVAILABLE | DB_LOCKED`일 때 spool(`packages/core/src/sessions/ingest.ts:299`, `:540`, `:567`, `:650`), 수동 재수집은 spoolOnUnwritable 옵션으로 구분(`:72`).
- 그러므로 PG open/pool/query 중 연결 거부·접속 종료는 **모든 업무 verb에서도** DB_UNAVAILABLE 값으로 내려와야 기존 spool이 동작한다. 현재 health catch만으로는 충분하지 않다. lock_timeout은 DB_LOCKED로, 버전 불일치는 SCHEMA_MISMATCH로 잇는 adapter 오류 분류를 새로 검증해야 한다. statement_timeout/중도 연결 단절의 commit 결과 불명은 멱등 재시도 계약의 중요한 실패 시나리오다(AD-7/9, spine:167, :190).
- redaction은 실패 시 rollback하고 spool하지 않는 계약이므로 일반 hook fallback과 분리한다(spine:227). migration은 연결 전 실패 DB_UNAVAILABLE, 연결 후 SQL 거부 MIGRATION_FAILED(`packages/postgres/src/migrate.ts:98`, `:151`); 현재는 연결 후 끊김도 MIGRATION_FAILED가 될 수 있다는 한계가 있다.

전체 `node:sqlite` 실제 import 파일 목록은 부록 A에 생성했다. adapter 밖에도 CLI 통합 fixture와 bootstrap hook 테스트가 직접 DB를 읽는다. 단순 `packages/sqlite` 폴더 삭제만으로는 요구사항을 만족하지 못한다.

## 3. Store port·공유 계약·SQLite 0001–0009 기준선

`packages/core/src/ports/store.ts:762` Store 합성 + 별도 SchemaStore. 고유 메서드 총 **49개**, PG 현재 3개/미구현 46개다(close 중복 선언은 한 번 계산).

| capability (선언 위치) | verb |
|---|---|
| HealthStore `:83` | checkHealth, close |
| SchemaStore `:786` | readSchemaVersion, close |
| SessionStore `:272` (9) | listStaleSessions, listIdentityCandidates, countUntaggedSessions, redactMessage, fillSessionTags, ensureSession, findSession, ingest, readSession |
| UserStore `:396` (2) | ensureSelfUser, readSelfUser |
| WorkStore `:631` (10) | addWork, hasDueWork, claimWork, completeWork, retryWork, releaseWork, recordFailure, listOpenWorkTargets, listFailures, resolveFailures |
| TranscriptFileStore `:738` (2) | listTranscriptFiles, recordTranscriptFile |
| AttachmentStore `:975` (11) | listMissingFileNames, writeFileNames, listFileNames, linkAttachments, listMessageAttachments, readFileLocation, listFileLocations, markFileLocationDeleted, readFileSharing, listRedactedContentHashes, redactFile |
| ExtractionStore `:1269` (9) | beginExtraction, appendExtractionChunks, finishExtraction, setFileSourceUnreachable, readFileExtractionState, listFilesAwaitingExtraction, listFilesWithStaleExtraction, listExtractions, listExtractionChunks |
| ScheduleStore `:1348` (3) | addSchedule, listDueSchedules, fireSchedule |

공유 계약 case 수는 `contractCase(...)` 선언 수다(각 case 내부 반복/assertion 수와 다름). 아래 계약 소스 경로의 공통 prefix는 `packages/core/src/testing/contracts/`다.

| suite 소스:첫 case | case 수 | memory 실행 | SQLite 실행 | PG 실행 |
|---|---:|---|---|---|
| `store.ts:17` | 3 | core/test/contracts.test.ts:84 | sqlite/test/store.test.ts:101 | postgres/test/store.test.ts:45 |
| `schema-store.ts:21` | 3 | core/test/contracts.test.ts:132 (memorySchemaStore) | sqlite/test/store.test.ts:110 | postgres/test/store.test.ts:67 |
| `session-store.ts:52` | 32 | core/test/contracts.test.ts:100 | sqlite/test/session-store.test.ts:61 | 없음 |
| `user-store.ts:24` | 3 | core/test/contracts.test.ts:108 | sqlite/test/users.test.ts:67 | 없음 |
| `work-store.ts:37` | 17 | core/test/contracts.test.ts:116 | sqlite/test/work-store.test.ts:67 | 없음 |
| `transcript-file-store.ts:28` | 4 | core/test/contracts.test.ts:124 | sqlite/test/transcript-file-store.test.ts:51 | 없음 |
| `attachment-store.ts:10` | 4 | core/test/contracts.test.ts:1407 | sqlite/test/session-store.test.ts:741 | 없음 |
| `extraction-store.ts:192` | 9 | core/test/contracts.test.ts:1411 | sqlite/test/extraction-store.test.ts:161 | 없음 |
| `file-redaction.ts:216` | 4 | core/test/contracts.test.ts:1415 | sqlite/test/session-store.test.ts:745 | 없음 |
| `schedule-store.ts:9` | 4 | core/test/contracts.test.ts:1473 | sqlite/test/schedule-store.test.ts:27 | 없음 |

위 Store/Schema 계약은 **83 case**, PG 업무 미연결 **77 case**다. 표의 실행 파일은 모두 `packages/` 아래다. 별도 FileStore port(바이트 I/O)는 DB Store가 아니며 `file-store.ts:7` 2 case를 memoryFileStore(`packages/core/test/contracts.test.ts:1406`)와 localFileStore(`apps/cli/test/file-store.test.ts:18`)가 실행한다. SQLite/PG adapter는 FileStore 구현이 아니다. 세션 동시성·다른 프로세스 청구·SQL 직접 UPDATE 거부 같은 adapter 전용 테스트는 이 83 case 바깥이므로 공통 계약 통과만으로 AD-7을 증명하지 못한다(`packages/sqlite/test/work-store.test.ts:374`, `test/store.test.ts:18`).

### 기준선의 실제 범위와 건수

최종 일반 테이블 **25개**(FTS 내부 shadow table 제외), FTS virtual table **5개**, 고유 trigger 이름 **42개**(FTS 동기화 14 + 규칙 28), 최종 명명 index **8개**(UNIQUE 5 + 일반 3)다. `document_extractions_open_idx`는 0004 재작성으로 사라지고 running_idx로 바뀌므로 옛 명명 index 이름 9개를 그대로 최종 건수로 세면 틀린다(`packages/sqlite/migrations/0004_capture_columns.sql:277`, `:316`).

- 초기 15개: workspaces/projects/worktrees/sessions/messages/tool_notes/log_entries/log_entry_edits/index_configs/chunks/redactions/context_injections/failures/transcript_files/schema_version(`packages/sqlite/migrations/0001_initial.sql:42`–`:300`).
- 0002에서 추가 8개: work_items/files/file_locations/message_attachments/document_extractions/document_chunks/file_names/file_metadata(`packages/sqlite/migrations/0002_files_and_work.sql:40`, `:102`, `:144`, `:189`, `:221`, `:256`, `:273`, `:293`). index_configs 재작성은 추가 테이블이 아니다(`:529`).
- 0003 users 추가 + sessions.user_id FK로 재작성, self 한 명 partial UNIQUE(`0003_users.sql:26`, `:36`, `:91`).
- 0004 git_branch/is_subagent_report, source_unreachable_at, chunk_locator + page 일치·null 예외 trigger, pattern_version redactions, extraction attempt/failed_stage와 running 유일성, failures 일반 target, due index 변경(`0004_capture_columns.sql:68`, `:106`, `:139`, `:198`, `:277`, `:353`, `:409`).
- 0005 projects.identity_key, work/failure target 계약 보정, tool_notes.call_id partial UNIQUE와 불변성, redactions.tool_note_id와 불변 trigger 2개, failed_stage 강제 trigger 2개(`0005_identity_and_records.sql:96`, `:140`, `:172`, `:221`, `:263`, `:314`, `:326`).
- 0006 메시지 seq 제거, 로그 anchor/joined 시각으로 변경, chunks from_at/to_at 및 UNIQUE 변경, messages(session_id,occurred_at) index; FTS search_rowid 보존은 SQLite 업그레이드 사정이므로 PG의 새 데이터 설계 요구와 구분(`0006_drop_message_seq.sql:98`, `:185`, `:210`, `:250`).
- 0007 tag_source/first_cwd + evidence insert/update trigger 2개(`0007_session_tag_source.sql:3`, `:8`).
- 0008 attachments update/delete 규칙, extraction update 규칙, chunk delete 규칙, redacted 파일의 names/metadata 재생성 방지 4개: trigger 총 8개(`0008_attachment_rules.sql:7`, `:21`, `:27`, `:45`, `:58`, `:65`, `:72`, `:79`).
- 0009 schedules + next_run_at partial index, 반복 예약의 null next_run_at 금지 CHECK(`0009_schedules.sql:3`, `:18`).

ID 자체 UNIQUE(FTS용 search_rowid PK와 별도인 5개)를 제외한 업무 키는 테이블 UNIQUE **17개** + 명명 UNIQUE index **5개**다: workspace.name; project.remote_identity/identity_key; worktree(project,path); session(harness,harness_session_id); message(session,harness_message_id); note(session,harness_message_id,ordinal); chunk(session,index_config,from_at,to_at); failure(target_kind,target_id,stage,fingerprint); transcript(harness,path); file.content_hash; location(file,store_kind,locator); attachment(message,ordinal); extraction(file,attempt); document_chunk(extraction,ordinal); file_name(file,name_source,text); metadata(file,key). 근거는 위 최종 CREATE TABLE 위치 및 `0001_initial.sql:132`, `:281`, `0005_identity_and_records.sql:221`, `:263`, `0006_drop_message_seq.sql:98`, `:210`이다.

명명 UNIQUE 5개는 work_items_open_key_idx(`0002_files_and_work.sql:78`), users_self_idx(`0003_users.sql:36`), document_extractions_running_idx(`0004_capture_columns.sql:316`), tool_notes_call_id_idx(`0005_identity_and_records.sql:316`), index_configs_key_idx(`0002_files_and_work.sql:553`, NULL 대체값 비교)다. 일반 3개는 work_items_due_idx(attempts,id,next_attempt_at, 미완료만), messages_session_occurred_idx, schedules_due_idx(`0004_capture_columns.sql:409`, `0006_drop_message_seq.sql:250`, `0009_schedules.sql:18`). PG의 NULLS NOT DISTINCT는 이미 index_config에 쓰므로 의미 비교 기준으로 삼을 수 있다(`packages/postgres/migrations/0001_initial.sql:132`).

규칙 trigger 28개는 message/note/redactions update·delete 6개; files immutable 2 + home/extraction pointer 검증 4; location immutable 2; locator 필수 2; failed_stage 2; tag evidence 2; 0008의 8개다(위 SQL 위치). PG baseline에는 plpgsql 및 TRUNCATE 방어도 필요하며 SQLite trigger 문법을 1:1 복제하는 것이 acceptance는 아니다(spine:547). 새 baseline에서는 singleton을 schema_migrations로 교체하고 settings를 추가하므로 **현재와 동등한 일반 표는 26개**가 예상된다. 미래 Garmin/health/analysis/channel 표를 미리 발명할 근거는 없다(spine:576–:581).

## 4. chunk_locator: 저장·읽기와 text/jsonb 선택의 영향

SQLite는 TEXT 컬럼 + JSON 유효/object/압축 표기/type 5종/page 사본 일치 CHECK다(`packages/sqlite/migrations/0004_capture_columns.sql:139`). 구형 행의 null만 허용하고 새 insert의 null은 trigger가 거부(`:156`); 세부 필수 필드/키 순서는 DB CHECK만으로 전부 검사하지 않는다. Core는 pdf/docx/text만 지원하고 time/sheet를 거부(`packages/core/src/domain/chunk-locator.ts:12`, `:26`).

Core encode는 입력 키를 검증하고 null/undefined 생략, type 첫 키와 종류별 literal 순서로 JSON.stringify, -0을 0으로 만든다(`packages/core/src/domain/chunk-locator.ts:108`, `:143`, `:195`, `:203`, `:211`). decode는 JSON.parse → encode → **result.text === 원문 text**까지 비교하므로 다른 키 순서/공백은 실패다(`:243`). 추출 저장은 document_chunks에 문자열을 넣고(`packages/sqlite/src/extractions.ts:297`), 읽기는 decode 후 page 일치 확인(`:663`)이다. AD-24는 이 Core 정규형과 page 사본의 null 포함 일치, 단일 current generation을 고정했다(spine:398).

| 선택 | 보존/비교/테스트에 생기는 실제 차이 |
|---|---|
| text | Core가 만든 바이트 표기·키 순서·공백 없음 그대로 저장/왕복한다. 기존 decode와 SQL 직접 readback의 문자열 동등 테스트 유지 가능. PG에서 JSON 구조 CHECK를 따로 만들고, Core codec의 세부 유효성 검증을 유지해야 한다. 현재 업무 UNIQUE 키에는 locator가 없으므로 locator의 JSON 의미 동등성 index가 당장 필요한 근거는 없다(3절). |
| jsonb | JSON 값을 저장하므로 원문 표기/키 순서를 원본처럼 보존하는 계약으로 사용할 수 없다. 이미 PG `chunk_params`는 키 순서와 무관한 값 비교를 의도한다(`packages/postgres/src/setup.ts:125`, `test/setup.test.ts:159`). locator를 jsonb로 받는다면 adapter는 DB 값 객체를 Core encode에 넣어 정규 문자열을 다시 만들어야 하며 `jsonb::text`를 decode에 그대로 넘길 수 있다고 가정하면 안 된다. 저장 바이트 정규형 보존에서 경계 출력 정규형 재생성으로 의미가 바뀌므로 AD-24 해석을 명시해야 한다. |

현재 테스트는 **DB에서 읽은 TEXT와 encoded.text 완전 일치**(`packages/sqlite/test/chunk-locator.test.ts:124`, `:140`), DB가 받았어도 Core가 거부하는 형태(`:156`, `:163`), Core 키/숫자/범위 검증(`packages/core/test/chunk-locator.test.ts`)을 나눈다. PG 선택 검증에는 pdf bbox/소수/-0, key permutation, null 생략, text/docx, page mismatch/null, 재시작 readback을 넣는다. jsonb의 의미 동등성은 정규형 텍스트 동등성과 별개 assertion으로 검증한다. **기존 byte 계약 보존에는 text의 변경량이 작다는 조사 판단**이며 선택을 확정하지 않는다. PG 실제 왕복은 이번 조사에서 실행하지 않았다.

## 5. Settings와 timezone

현재 `apps/cli/src/config/codec.ts:29` KNOWN_KEYS는 schema_version/timezone/store.path/files.path/mirror.path/update.auto 6개다. `[store] url_env`는 아직 구현되지 않았다. `BrainConfig.timezone`은 필수 string(`:83`), read 시 기본 Asia/Seoul 및 Intl 시간대 유효성 검사(`:190`), setup read의 기존값 보존/잘못된 값 reset(`:387`), writer가 TOML top-level timezone을 쓴다(`:565`). `.env`는 writer가 기존 값을 parse/rewrite하지만(`:554`) 현재 runtime DB URL을 읽어 resolve하는 경로가 없다.

**현재 timezone의 실제 소비는 설정 codec과 설치 flow 보존(`apps/cli/src/install/flow.ts:750`)뿐**이다. Core/CLI assembly에 시간대를 넘기는 소비자는 아직 없고, 시작 날짜 맥락/현지 날짜 검색의 사용은 spine의 미래 계약이다(`packages/core/src/brain.ts:100`, `apps/cli/src/assembly.ts:76`, spine:255, :257). 시간대를 DB로 옮긴다는 이유로 epic 12/17의 스케줄러/검색을 여기서 구현하지 않는다.

접점:

1. baseline `brain.settings(key,value,updated_at)`와 Runtime 설정 codec의 DB read/write, 알려진 키별 타입·기본값·검증 및 `<ext>.*` 선언 자리(spine:317, :577). Store에는 SettingsStore가 아직 없다(3절); SDK가 config get/set을 제공하려면 port/메모리 fake/공유 계약도 추가해야 한다. value의 SQL 타입과 설정 정의 등록 API는 현 코드가 정하지 않았다.
2. 기계 config는 store.path → store.url_env, timezone 제거; `.env`의 BRAIN_DATABASE_URL resolve와 secret 출력 차단, setup 재실행 시 DB timezone 우선 읽기/쓰기. 파일·미러·update.auto는 기계 값으로 유지한다(spine:315–:320). fresh DB 원칙은 기존 설정값을 무조건 버리라는 뜻은 아니므로 기존 TOML timezone 최초 seed 정책은 PO 확인거리다.
3. `apps/cli/src/commands/index.ts:36`에는 config namespace가 없다. get/set CommandSpec, used_for/required/examples/output/risk/hook/dryRun 메타 및 guide schema 노출, `packages/core/src/brain.ts:126` 이후 SDK surface와 `packages/second_brain/src/index.ts` export 연결이 필요하다. 명령 메타 계약은 spine:631.
4. `epic-drive/epic-drive.md:35` E8-7은 '사용자 선택 DB, 머신 값 TOML, 비밀 .env', 첫 키 drive.keep_local_days, 키마다 정해진 저장소에 get/set, 플러그인 슬래시 래퍼는 epic 3을 기대했다. 보관 기간은 기본 30일, 0은 검증 직후(`:28`); 0009 다음 번호라는 옛 표현은 PG baseline 재단 결정으로 대체된다. timezone '나중에 정함'은 이미 전환 확정으로 바뀌었다(`:76`). 설정 키 지원과 Drive 삭제 기능 구현은 구분해야 한다.

## 6. 컨테이너 수명·setup/doctor/daemon 접점

현재 실제 setup은 SQLite이고 `apps/cli/src/install.ts:32`의 import/system deps가 install/store helper를 연결한다. `apps/cli/src/install/docker.ts`는 별도 helper이며 실제 flow에서 import하지 않는다(해당 파일 import 검색 결과 없음). 따라서 파일이 있다는 사실만으로 제품용 PG 설치가 구현됐다고 볼 수 없다.

남은 helper는 CommandRunner 주입(`apps/cli/src/install/docker.ts:12`), docker info/present 검사(`:77`, `:91`), 컨테이너 inspect, named volume과 loopback publish를 가진 docker run(`:163`), start(`:193`), readiness poll(`:211`)이다. 그러나 이미지 pgvector(`:37`), volume 이름 second-brain-pgdata(`:43`), Docker Desktop brew cask 설치(`:71`), docker run 경로는 새 spine의 OrbStack 선행조건·공식 postgres·제품 Compose와 다르다. 이 helper의 runner/오류 처리 패턴은 재사용하되 실제 lifecycle 명령은 Compose로 교체한다.

- setup: 환경 점검 단계에 OrbStack 설치/실행 식별 + Docker Compose 가용성, `<home>/postgres/compose.yaml`과 secret env 작성 → up -d --wait → 관리 연결로 role/schema/migrations → 사용자·timezone → shim/LaunchAgent/restart → doctor → 완료 기록을 넣는다(spine:328–:331). DB/runtime role 생성은 setup만 하며 `brain_app`이 owner가 되어 불변 trigger/권한을 우회하지 않도록 역할을 나눈다(spine:468, :472).
- doctor: `apps/cli/src/doctor/checks.ts` Runtime check list + `packages/postgres/src/store.ts:57` health 조합. OrbStack 꺼짐을 generic DB 접속 실패와 구분하고 dependent check는 skip 이유를 적는다(spine:335). pg_trgm 직접 탐침·쓰기/owner별 schema·정리 pending warn은 vector probe를 대체한다. 조회 명령에서 컨테이너를 시작하면 안 된다(spine:517). 현재 Core doctor는 DB부터 확인하고 Runtime check는 뒤에 돈다(`packages/core/src/doctor/doctor.ts:152`, `:173`); OrbStack 선행 실패에 따라 DB를 skip하려면 단순 check append 이상으로 순서/의존성을 바꿔야 한다.
- daemon: `apps/cli/src/daemon/run.ts:163`의 연결/schema 실패 결과(`:270`)를 recovery state로 연결하고, AD-27의 compose up을 **backoff**로 실행한다. 지금은 고정 10초 pause(`:68`, `:198`)이며 watch batch가 깨운다. 일반 drain wake가 recovery backoff를 무시해 compose 폭주하지 않게 별도 next retry 시각/상태가 필요하다는 구현상 위험이 있다. SIGTERM 취소·동일 오류 로그 중복 억제(`:180`)는 유지한다. 성공 후 재연결·schema guard·spool drain까지 관찰해야 한다.
- uninstall: `apps/cli/src/commands/setup-uninstall.ts`에 compose down(볼륨 유지)을 연결하고, 데이터 삭제 별도 확인을 보존한다(spine:347, :518). 기존 SQLite 파일 삭제 문구/목록도 점검 대상이다.

실행 helper 재사용 후보는 `apps/cli/src/daemon/launchd.ts:49` systemLaunchctl: execFile + args 배열 + env + 10초 timeout + SIGKILL + 값 오류 반환/가짜 adapter(`:55`), `apps/cli/src/doctor/checks.ts:561` promisified execFile(버전/git 조회 timeout), `tooling/bootstrap/src/bootstrap.ts:1302` spawn runner, `tooling/test-db/src/global-setup.ts:62` 주입 runner다. dev 테스트의 sync spawn(`:166`)을 상주 데몬에 그대로 쓰면 이벤트 루프를 막으므로 비동기 실행 패턴이 더 적합하다.

**불확실한 실행 환경**: repo에는 OrbStack을 특정해 검사하는 구현이 아직 없다. docker info 성공은 Docker Desktop/다른 context도 성공하므로 OrbStack 선행조건의 증거가 되지 않는다(`apps/cli/src/install/docker.ts:91`). 무엇을 probe할지와 OrbStack context를 어떻게 판별할지는 구현 스파이크로 검증해야 하며, 이번 조사에서 OS/Docker를 호출하지 않았다. named volume/포트는 spine:515의 ASSUMPTION을 채택하되 충돌 시 안내를 설계해야 한다.

## 7. Collision map과 slicing input

다음은 발행된 스토리가 아닌 PO용 후보다. 각 크기는 현재 코드량 기반 추정이며 새 구현 LOC 확정 견적이 아니다. 한 에픽 동안 baseline 0001을 함께 완성하되 이미 테스트/배포된 뒤 checksum을 조용히 바꾸는 절차는 금지해야 한다(AD-31의 파일 기록 요구, spine:481).

| 순서/후보 | 관찰 가능한 결과 | 주요 소유 파일·패키지 | 크기·공유 lane |
|---|---|---|---|
| T1 tracer: hook으로 잡은 세션이 컨테이너 재생성 후 남음 | 임시 home의 제품 Compose, fresh PG, transcript import/실제 hook 수집, 같은 volume에서 컨테이너 재생성 뒤 ID·시각·본문 동일 | postgres connect/migrate/setup/store + baseline; core Store/contract; CLI config/dispatch/assembly/install; tooling/test-db; 새 제품 Compose fixture; plugin hook 경유 검증 | 가장 넓은 lane. sessions 원본 866 LOC, users 137, transcript-files 190 중 수집에 필요한 경로; 필요 work/attachment verb도 포함. 세션 9개 중 redaction 제외 8 + user 2 + transcript 2가 대략 수집 축. 현재 Store는 전체 필수 타입이므로 '세션만 구현하고 완전 Store라고 cast' 금지. 필요한 port 좁히기 또는 필요한 전체 verb 구현을 계획에서 명시. |
| T2 일감·예약의 PG 동시성 | 두 프로세스 청구 중복 없음, lease/실패 재시도/발화 CAS 및 spool replay 계약 | postgres work/schedules/write helpers; core ports/contracts/queue; CLI daemon/run 및 fixture | work 621 + schedules 72 LOC 참고, 13 verbs. 세션 advisory lock helper와 baseline/Store factory는 T1 뒤 같은 DB lane. 임대 갱신·의존성·현지 예약은 epic 12. |
| T3 첨부·추출·이름/전문색인 동등성 | 파일 metadata·attempt 세대·늦은 완료 방어와 첨부/추출 계약, lower GIN 5종 | postgres attachments/extractions/baseline; core locator/contracts; CLI extraction/attachment 통합 test fixture | attachments 365 + extractions 694 LOC, 20 verbs(파일 redact 포함). T2 claim 활용. locator text/jsonb 결정은 이 후보 착수 전, SQL 최종화 전에 필요. |
| T4 저장본 가리기·정리 권한 | 원문 보호·GUC 누수 없음·파일/메시지 정리, pending doctor warn → 유지보수 성공 후 해제 | postgres redaction SQL/functions/write + maintenance adapter; core redaction/queue/doctor; CLI assembly/doctor | 2 redact verbs는 T1/T3 업무 구현과 분리 책임을 두되 동일 SQL/factory lane에서 순서대로. 28 규칙 trigger + PG TRUNCATE/권한 경계가 검증 대상. 정리 일감/상태/권한/직접 SQL 공격 테스트는 새 코드라 현재 LOC만으로 작게 잡으면 안 됨. |
| T5 사용자 설정과 config get/set | timezone/keep_local_days 검증·영속 readback, SDK/CLI 메타 | core settings port/use case/fake/contracts/brain; postgres settings + baseline; CLI config/commands/index/dispatch/install/assembly | 새 settings 표 1, port와 get/set 2 verbs 규모 + codec 파일 600줄대 교체 접점. CLI config·설치 lane은 T1과 겹침; Drive 기능은 제외. |
| T6 OrbStack 진단·daemon recovery 완성 | OrbStack 미설치/중단 안내, refused PG→spool, daemon backoff→compose up→drain, 컨테이너만 제거해도 설정·파일 행 유지 | CLI install/docker(or replacement)/flow/store, doctor/checks, daemon/run/control, uninstall; postgres health | install flow 1100줄대·daemon run 370줄대·doctor checks 600줄대 영향. T1에 최소 lifecycle을 포함하고 여기서는 실패/복구 매트릭스를 닫음. 설치/daemon/doctor lane은 병렬 편집 금지. |
| T7 전환 마감·SQLite 삭제·플러그인 배포 | runtime·test fixture node:sqlite 제거, 모든 Store 계약 PG 연결, 설치본 hook 검증 | packages/sqlite 전체, second_brain exports/package, CLI runtime/tests, bootstrap generated copies, vitest/build/package lock/README, plugin/app-ref + manifest | SQLite src 약 4.3k LOC + SQL 2,324줄 삭제 대상; 남은 fixture 교체가 더 큰 위험. app-ref는 이전 구현 commit을 가리키고 manifest version 동시 bump(AGENTS 정책, spine:333). 모든 앞 후보 완료 후 한 release lane. |

**주문형 순서**: tracer의 acceptance를 첫 스토리의 목표로 두고, prerequisite인 baseline/runner·제품 lifecycle·최소 port를 그 안의 선행 작업으로 드러낸다. Store의 현재 거대한 교집합 때문에 tracer를 '메서드 세 개'로 잘게 잘라 독립 출시 가능한 것으로 표현하면 실제 수집을 증명하지 못한다(`packages/core/src/ports/store.ts:762`, `apps/cli/src/dispatch.ts:345`). 전체 46 업무 verbs 이식을 먼저 한 대형 스토리로 숨기지 말고, T1에서 필요한 capability와 통합 순서를 정해야 한다.

공유 충돌: (a) `postgres/migrations/0001_initial.sql`, migrate/store/index는 T1→T2→T3→T4→T5 한 DB lane; (b) CLI config/dispatch/assembly/install은 T1→T5→T6 한 runtime lane; (c) daemon/run·doctor/checks는 T2/T4/T6 의존 순서; (d) plugin/bootstrap 생성물/app-ref/version은 T7 마지막 lane. 계약 suite별 PG 테스트 파일은 개별 추가 가능하지만 shared factory와 baseline 쓰기는 순서화해야 한다.

규모 근거: 현 PG src 681줄(connect74+migrate226+setup190+store175+index16), baseline332줄. SQLite adapter src는 connect196/driver90/write93/migrate298/store340, 업무 sessions866/attachments365/extractions694/users137/work621/schedules72/transcript-files190/project-keys289/index41이다. SQL 0001–0009 합계 **2,324줄**, CREATE TABLE 문 35회(재작성 포함), CREATE TRIGGER 문 51회(재작성 포함)로, 순방향 SQLite SQL을 그대로 PG 파일 9개로 옮기는 크기가 아니다. 최종 26표·최소 동등 키/규칙·GIN5와 새 migration ledger/role·settings·maintenance 경로로 재단하는 일이다(3절 SQL 인용).

**가장 위험하고 아직 검증되지 않은 부분**은 PG 동시성/권한/실패 매핑을 묶은 redaction·추출·청구 경계다. 전역 단일 writer였던 SQLite가 PG 세션/행 잠금으로 바뀌므로 같은 행에 대한 ingest/redact/extract/claim 경합과 연결 종료 직후 commit 결과 불명을 기존 happy-path 계약만으로 잡지 못한다(`packages/sqlite/src/write.ts:31`, spine:167, :224, :398). 특히 runtime role의 GUC 설정만 믿고 일반 직접 UPDATE가 허용되는지, 유지보수 권한을 광범위하게 주지 않고 정리를 끝낼 수 있는지는 직접 SQL/별도 role/동시 process 통합 검증이 필요하다. 이 조사에서는 실행하지 않았으므로 구현 가능성을 증명한 것으로 읽으면 안 된다.

### PO에게 열어 둘 것

- `chunk_locator`: 저장 바이트 정규형 보존(text)인가, adapter 경계에서 Core 재정규화(jsonb)인가. AD-24와 현 테스트 차이를 명시하고 결정(4절, spine:784).
- 기존 TOML timezone을 fresh PG 최초 setup에서 seed할지, 재확인할지. 이미 PG 설정이 있으면 어느 값을 기본 UI에 보여 줄지(spine:317, 기존 `apps/cli/src/install/flow.ts:750`). DB 전환 자체와 기존 brain.db 데이터 이전은 재결정 대상이 아니다.
- config get/set의 첫 배포에서 timezone 외 drive.keep_local_days도 검증/노출할지, E8-7 계약 틀만 두고 Drive 때 등록할지(`epic-drive/epic-drive.md:35`).
- spine:515의 volume 이름/포트 ASSUMPTION 확정 및 실제 Mac 설치본/실제 hook 검증 시점·담당. OrbStack 설치는 사용자 선행조건이라는 결정은 이미 확정이다.
- tracer와 완전 Store 교집합 사이를 좁은 capability로 먼저 연결할지, T1 구현 범위를 넓힐지의 스토리 경계. baseline checksum을 고정하고 나머지 후속 SQL로 갈 전환 시점도 함께 정해야 한다(spine:481, `packages/core/src/ports/store.ts:762`).

## 부록 A. node:sqlite 및 SQLite package 직접 의존의 전수 목록

다음 목록은 추측이 아니라 현재 tracked source/fixture의 import/export/dependency 정적 검색 결과다. 각 행의 경로는 저장소 상대 경로다.

- `packages/second_brain/package.json:31` — `"@second-brain/sqlite": "workspace:*"`
- `packages/second_brain/src/index.ts:3` — `export * from '@second-brain/sqlite';`
- `packages/second_brain/test/boundaries.test.ts:52` — `'@second-brain/sqlite',`
- `packages/sqlite/package.json:2` — `"name": "@second-brain/sqlite",`
- `packages/sqlite/src/connect.ts:1` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/src/driver.ts:1` — `import type { DatabaseSync, SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/chunk-locator.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/document-extract.test.ts:4` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/extraction-store.test.ts:4` — `import type { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/fixtures/lock-holder.mjs:10` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/fixtures/schema-lock-holder.mjs:10` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/migrate.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/schedule-store.test.ts:4` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/schema-0004.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/schema-0005.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/schema-0006.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/schema-0007.test.ts:4` — `import { DatabaseSync } from 'node:sqlite';`
- `packages/sqlite/test/schema-files.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/schema.test.ts:4` — `import type { SQLInputValue } from 'node:sqlite';`
- `packages/sqlite/test/store.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/capture-scan.test.ts:16` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/daemon-run.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/daemon-status.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/daemon-stop-start.test.ts:7` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/dispatch.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/doctor-run.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/files-redact.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/fixtures/lock-holder.mjs:11` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/install-store.test.ts:4` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/install.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/messages-redact.test.ts:9` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/output-codecs.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/queue-drain.test.ts:5` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/sessions-ingest.test.ts:17` — `import { DatabaseSync } from 'node:sqlite';`
- `apps/cli/test/setup.test.ts:13` — `import { DatabaseSync } from 'node:sqlite';`
- `tooling/bootstrap/test/hook.test.ts:16` — `import { DatabaseSync } from 'node:sqlite';`
