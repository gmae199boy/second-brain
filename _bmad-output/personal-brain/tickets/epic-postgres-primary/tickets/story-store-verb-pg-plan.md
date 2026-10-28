---
title: '세션 Store 완성: 나머지 세션 verb와 계약이 PG에서 통과한다'
type: 'feature'
ticket: '14'
created: '2026-10-28'
status: done
baseline_revision: '518a96412de271d4dff80eb335d5151d7c4b80b2'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/story-tracer-pg-hook-plan.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 11.1은 PG Store에 수집 경로의 verb만 만들었다. `listStaleSessions`·`listIdentityCandidates`·`countUntaggedSessions`·`fillSessionTags`, `listTranscriptFiles`, 세션 계약이 쓰는 `listOpenWorkTargets`가 PG에 없어 session-store(가리기 제외)·transcript-file-store 계약을 PG에서 돌릴 수 없다. 같은 세션 동시 수집도 한 프로세스 안의 두 pool로만 시험했다.

**Approach:** 1의 PG Store 팩토리와 capability 타입을 넓혀 위 verb를 SQLite와 같은 의미로 구현한다. 세션 계약에서 가리기 case를 따로 떼어 PG가 나머지 전부를 돌게 한다. 두 Node 프로세스가 같은 세션을 동시에 수집하는 통합 시험을 더한다.

## Boundaries & Constraints

**Always:**
- 의미의 기준은 SQLite 구현과 공통 계약이다. 정렬은 SQLite의 바이트 순서와 같게 `collate "C"`로 한다. `count(*)`(bigint)는 number로 돌려준다.
- 쓰기(`fillSessionTags`)는 `withWrite` 하나를 지나고, 세션 하나에 대한 쓰기는 수집과 같은 세션 토큰 `pg_advisory_xact_lock` 아래에서 한다. 오류는 기존 `databaseFailure` 분류(`DB_UNAVAILABLE`·`DB_LOCKED`)를 쓰고 `SESSION_NOT_FOUND`는 값으로 돌려준다.
- U+0000 규칙(epic Notes 2026-10-28, 1의 resolve): transcript에서 온 text 칸은 `pgText`로 쓰고 `originalText`로 되읽는다. `fillSessionTags`의 `first_cwd`/`first_cwd_raw`, 반환하는 세션의 `first_cwd`, `listTranscriptFiles`의 `last_harness_message_id`가 대상이다.
- 계약 case 이름과 수는 memory·SQLite에서 지금과 같다(가리기 case는 계속 그 둘에서 돈다).
- 전체 `Store`인 척하는 cast나 미구현 verb를 두지 않는다. PG 팩토리의 타입은 실제로 구현한 verb만 담는다.

**Never:**
- `redactMessage`와 가리기 case, `brain.redacting` 경로(티켓 5), WorkStore의 나머지 9 verb(티켓 3)는 만들지 않는다. `listOpenWorkTargets`만 이 스토리가 만든다.
- CLI·데몬·doctor의 PG 조립을 넓히지 않는다(7·10). `apps/cli`는 고치지 않는다. 
- `packages/postgres/migrations/0001_initial.sql`은 verb가 필요로 하는 경우가 아니면 고치지 않는다(2가 키운다). 고친다면 10 전 개발 DB 재생성 정책을 따른다.
- SQLite 코드·테스트의 동작을 바꾸지 않는다. `plugin/app-ref`·plugin version을 바꾸지 않는다. 문서·커밋에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 오래된 세션 | parser_version이 null·다른 값·같은 값인 세션, 다른 하네스 | null·다른 값만, `harness_session_id` 바이트 순 | 없음 |
| 정체성 후보 | project·first_cwd 없고 `session_identity` 일감 없는 세션 | 그 세션만, id 순 | 없음 |
| 꼬리표 채우기 | 빈 꼬리표 세션 + checkout | `filled: true`, project·worktree·tag_source 한 번 채움, 이미 있는 꼬리표·first_cwd는 그대로 | 없는 세션은 `SESSION_NOT_FOUND` |
| first_cwd에 U+0000 | `fillSessionTags`의 firstCwd가 `a\u0000b` | 되읽은 값이 원문과 같고 text 칸은 U+FFFD | 없음 |
| 트랜스크립트 목록 | 빈 내역 / 여러 경로 | 빈 배열 / 하네스 일치 행만 `path` 바이트 순, 커서 원문 복원 | 없음 |
| 열린 일감 대상 | 완료·미완료 work_items | 미완료이고 kind 일치만 | 없음 |
| DB 꺼짐 | 연결 실패 | 각 verb가 `DB_UNAVAILABLE` 값 | 예외 없음 |
| 두 프로세스 동시 수집 | 같은 세션, 같은 배치, 두 child process가 동시에 시작 | 둘 다 ok, inserted 합 = 배치 수, 메시지·도구 메모 수와 세션 커서가 한 번 수집한 DB와 같음 | 잠금 초과 시 `DB_LOCKED`(시험은 기본 예산에서 둘 다 성공을 기대) |

</intent-contract>

## Code Map

- `packages/core/src/testing/contracts/session-store.ts:37,1186` -- `SessionStoreSubject`, `sessionStoreContract()`. 비가리기 case 4개(`:1188` 오래된 세션, `:1207` 근거·후보, `:1303` 정체성 일감, `:1317` 꼬리표 채우기)를 subject가 `Omit<SessionStore,'redactMessage'> & UserStore & Pick<WorkStore,'listOpenWorkTargets'>`인 새 묶음으로, `:1249` 가리기 case를 가리기 묶음으로 뗀다. `sessionStoreContract()`는 둘과 `sessionIngestContract()`를 합쳐 그대로 둔다(이름·수 불변). `contracts/index.ts`, `testing/index.ts`에서 export.
- `packages/core/test/contracts.test.ts:100` 등 -- `sessionStoreContract()`를 쓰는 meta 시험. 바꾸지 않아도 통과해야 한다.
- `packages/core/src/ports/store.ts:272,631,738,1367` -- `SessionStore`, `WorkStore.listOpenWorkTargets`, `TranscriptFileStore`, `SessionIngestStore`. 포트 자체는 바꾸지 않는다.
- `packages/sqlite/src/sessions.ts:273`(`fillSessionTags`), `:303`·`:316`·`:330` -- 의미 기준. `packages/sqlite/src/work.ts:388`(`listOpenWorkTargets`, 쓰기 잠금 없는 읽기), `packages/sqlite/src/transcript-files.ts:40`(`listTranscriptFiles`). 고치지 않는다.
- `packages/postgres/src/sessions.ts:136` -- `postgresSessionStore`. `ensureCheckout`·세션 행 읽기·`toSession`·세션 토큰 advisory lock 도우미를 재사용해 네 verb를 더한다.
- `packages/postgres/src/transcript-files.ts:37` -- `listTranscriptFiles` 추가(기존 행 변환 재사용).
- `packages/postgres/src/ingest-work.ts` -- 일감 쓰기 도우미. `listOpenWorkTargets`를 둘 곳(또는 새 `work.ts`).
- `packages/postgres/src/store.ts:9` -- `PostgresIngestStore` 타입과 팩토리. 넓힌 타입(예: `PostgresStore`)으로 바꾸고 `index.ts` export를 맞춘다. `packages/second_brain/src/postgres.ts`는 `export *`라 그대로다. `apps/cli`는 `postgresStore`만 쓴다.
- `packages/postgres/src/text.ts` -- `pgText`·`originalText`.
- `packages/postgres/migrations/0001_initial.sql:34,99,360-376` -- sessions·transcript_files, tag evidence trigger(이미 있음).
- `packages/postgres/test/store.test.ts:10,13` -- 계약 실행 목록과 한 프로세스 두 pool 동시 수집 시험. 새 계약 묶음과 transcript 계약을 목록에 더한다.
- `packages/postgres/test/fixture.ts` -- `database()`·`subject()`(`appUrl`은 `brain_app`).
- `packages/sqlite/test/fixtures/drain-worker.mjs`, `packages/sqlite/test/work-store.test.ts:404` -- 두 프로세스 시험의 선례(dist import, spawn, stdout 신호).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/testing/contracts/session-store.ts`, `contracts/index.ts`, `testing/index.ts` -- 비가리기 세션 계약 묶음과 가리기 묶음을 이름 있는 함수·subject 타입으로 떼고 `sessionStoreContract()`가 셋을 합치게 함 -- PG가 가리기 없이 나머지 전부를 돌게
- [x] `packages/postgres/src/sessions.ts` -- `listStaleSessions`·`listIdentityCandidates`·`countUntaggedSessions`·`fillSessionTags` -- E11-4 세션 verb
- [x] `packages/postgres/src/transcript-files.ts` -- `listTranscriptFiles` -- transcript-file-store 계약
- [x] `packages/postgres/src/ingest-work.ts`(또는 새 `work.ts`) -- `listOpenWorkTargets`(쓰기 잠금 없는 읽기) -- 세션 계약의 정체성 일감 case
- [x] `packages/postgres/src/store.ts`, `index.ts` -- 넓힌 capability 타입과 팩토리 조립 -- 1의 경계를 넓힘
- [x] `packages/postgres/test/store.test.ts` -- 새 세션 계약 묶음·`transcriptFileStoreContract()`를 PG 실행 목록에 추가, U+0000 first_cwd·transcript 커서 왕복, `collate "C"` 정렬(대소문자·한글 섞인 경로), DB 꺼짐 값 -- I/O 매트릭스
- [x] `packages/postgres/test/session-concurrency.test.ts`(새), `packages/postgres/test/fixtures/ingest-worker.mjs`(새) -- 두 child process가 stdin 신호로 동시에 같은 세션·같은 배치(메시지 100건 이상, 도구 메모 포함)를 수집하고, 결과를 같은 배치를 한 번 수집한 별도 DB와 비교 -- 계약 밖 동시 수집(S3)

**Acceptance Criteria:**
- Given 테스트 DB, when `pnpm build && pnpm exec vitest run --project postgres`, then PG에서 session-store 계약의 가리기 외 모든 case, `sessionIngestContract`, `userStoreContract`, `transcriptFileStoreContract` 4 case가 통과한다.
- Given 같은 명령, when memory·SQLite 실행을 보면, then 세션 계약 case 이름과 수가 baseline과 같다(가리기 case 포함).
- Given `session-concurrency.test.ts`, when 두 프로세스가 같은 세션을 동시에 수집하면, then 두 결과 모두 ok이고 inserted 합이 배치 메시지 수이며, 세션의 메시지 수·도구 메모 수·`last_harness_message_id`·`cursor_fingerprint`·`parser_version`이 한 번 수집한 DB와 같다.
- Given 전체 저장소, when `pnpm test`, then build·typecheck와 모든 시험이 통과한다.

## Implementation Notes

- 2026-10-28: `context:` 두 파일 전체를 읽고 세션 metadata/redaction 계약 분리, PG 세션 4 verb·transcript 목록·열린 일감 대상·capability 조립, 두 프로세스 수집 시험을 구현했다. SQLite·CLI·baseline SQL·plugin은 변경하지 않았다.
- 타입 충돌(사용자 답변 대기): 새 읽기 verb 5개의 기존 포트 결과는 `DB_UNAVAILABLE`만 허용하지만 계획은 `databaseFailure`의 `DB_LOCKED` 분류를 요구하고 포트 변경도 금지한다. 임의 cast나 포트 변경 없이 분류를 구현한 현재 상태에서는 build·typecheck가 이 5개 반환 타입에서 실패한다. 읽기 오류는 기존 포트대로 유지할지, 포트 결과 타입에 `DB_LOCKED`를 허용할지 질문했다. 결정 전이므로 완료로 표시하지 않는다.
- 검증: `npx --yes pnpm@12 exec vitest run --project postgres --project core --project sqlite`에서 58개 파일·1,565개 테스트 통과. PG의 가리기 외 세션 계약과 transcript 계약 4개, NUL 원문 복원·바이트 정렬·연결 실패 값·세션 잠금·두 프로세스 메시지/도구 메모 각 128건 비교를 포함한다. baseline과 세션 계약 case 이름·수(32개) 및 가리기 case 본문이 같음을 별도 비교했다. `git diff --check` 통과.
- 전체 검증은 미완료: build·typecheck는 위 타입 충돌로 실패했다. 별도 전체 `vitest run`은 108개 파일 중 105개 통과, 2,927개 테스트 중 2,920개 통과·7개 실패다. bootstrap 6개는 클론 build 실패와 그 후속 결과이며 daemon 설정 오류 감시 1개는 시간 초과다. 타입 결정과 build 수정 후 `pnpm test` 재검증이 필요하다.
- 결정(2026-10-28, 오케스트레이터): 읽기 verb 5개(`listStaleSessions`·`listIdentityCandidates`·`countUntaggedSessions`·`listTranscriptFiles`·`listOpenWorkTargets`)는 포트 타입을 바꾸지 않고 모든 DB 실패를 `DB_UNAVAILABLE`로 돌려준다. 근거: `packages/core/src/ports/store.ts`의 `ListOpenWorkTargetsResult` 주석이 "읽기는 writer를 기다리지 않으므로 `DB_UNAVAILABLE`만"이라고 정했고, SQLite 기준 구현도 같다. 계획 Always의 `DB_LOCKED` 분류는 포트가 그 코드를 허용하는 쓰기(`fillSessionTags`)에 적용한다.

- 재개 완료(2026-10-28, 사용자 결정 반영): 읽기 verb 5개의 catch에서 `describe(error)` 메시지와 `DB_UNAVAILABLE` 값을 반환하게 했다. `fillSessionTags`는 기존 `withWrite`·세션 토큰 advisory lock을 통해 `DB_LOCKED` 분류를 유지한다. 포트 수정이나 오류 타입 cast는 없다. 위의 “답변 대기”·“검증 미완료” 기록은 이전 실행 상태이며 이번 재개로 해소했다.
- 오류 분류 회귀 검증: `store.test.ts`에 sessions·transcript_files·work_items를 별도 트랜잭션의 ACCESS EXCLUSIVE 잠금으로 막는 3개 시험을 추가했다. 읽기 5개 모두 잠금 초과를 `DB_UNAVAILABLE`로 반환하며, 기존 `fillSessionTags` 잠금 시험은 `DB_LOCKED`와 세션 무변경을 확인한다. 연결 거부 시험도 유지한다.
- 최종 검증: `npx --yes pnpm@12 build`와 `npx --yes pnpm@12 typecheck`를 각각 통과한 뒤 `npx --yes pnpm@12 test`를 실행했다. build·typecheck와 108개 파일·2,930개 테스트 모두 통과했다(vitest 68.08초). `git diff --check`도 통과했다. 두 프로세스 메시지/도구 메모 각 128건 수집·단일 수집 DB 비교, PG의 가리기 외 세션 계약·transcript 계약, memory·SQLite의 기존 가리기 포함 계약이 모두 실행됐다.
- 이전 실패 7개 판정: bootstrap의 `hook.test.ts`·`npx.test.ts`는 작업 트리(미추적 파일 포함)를 복사한 git snapshot을 clone하고 실제 build한다. 앞선 타입 오류 때문에 clone build에서 멈춘 6개는 타입 수정 후 전체 시험에서 모두 통과했다. daemon 설정 오류 감시 시험은 SQLite 경로이며 해당 제품 코드·시험·포트를 이번 변경에서 수정하지 않았다. 같은 시험을 `npx --yes pnpm@12 exec vitest run --project cli test/daemon-run.test.ts -t 'reports a config made unreadable mid-run once and stops cleanly'`로 별도 3회 실행해 모두 통과했고, 최종 전체 시험에서도 통과했다. 이전 시간 초과는 이번 PG 변경과 무관한 일시적 flaky로 판단하며 정확한 시간 초과 원인은 재현되지 않았다. CLI 범위 확장 없이 마쳤다.
- 남은 사항: 이 구현 범위의 미완료는 없다. daemon 시간 초과의 정확한 원인은 미확정이며 재발하면 별도 조사가 필요하다. ticket 상태의 최종 완료 판정은 오케스트레이터에 남기고 `tickets.py mark`는 실행하지 않았다.
- 오케스트레이터 검증(2026-10-28): baseline 이후 diff를 직접 읽었다. 계획 Verification의 `npx --yes pnpm@12 exec vitest run --project postgres session-concurrency`(1개 통과), `… --project postgres --project core --project sqlite`(1,568개 통과)가 통과했다. 전체 `npx --yes pnpm@12 test`는 첫 실행에서 `packages/postgres/test/text.test.ts:14`(11.1의 기존 시험, `world()`의 `lockTimeoutMs: 40` 아래 `ensureSelfUser`) 1개가 실패했고 단독 재실행과 두 번째 전체 실행(108개 파일·2,930개 시험)은 모두 통과했다. 부하에 따라 40ms 잠금 예산을 넘는 flaky로 본다. I/O 매트릭스 8행은 PG 계약 실행·`store.test.ts` 추가 시험·`session-concurrency.test.ts`가 모두 덮고 실제로 돌았다.

## Plan Change Log

## Review Triage Log

### 2026-10-28 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings:
  - (없음) quick 렌즈가 수용 기준 미충족·규칙 위반·버그를 찾지 못했다.

### 2026-10-28 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings:
  - (없음) 새 quick 리뷰 세션이 baseline 이후 diff와 주변 코드를 검사했으며 확정된 수용 기준 미충족·규칙 위반·버그가 없었다. patch 0, defer 0, reject 0.

## Design Notes

- 가리기 case만 빼는 이유: `redactMessage`는 `brain.redacting` GUC·raw 짝 칸 정리와 함께 티켓 5가 만든다. 계약을 이름 있는 묶음으로 나누면 5는 가리기 묶음을 PG 실행 목록에 더하기만 하면 된다.
- `listOpenWorkTargets`는 WorkStore에 속하지만 세션 계약의 정체성 일감 case가 쓰고 표(`work_items`)는 1이 이미 만들었다. 티켓 3은 나머지 9 verb를 만든다.
- 두 프로세스 시험 예: 부모가 DB·소유자·세션을 만들고 child 둘을 띄운 뒤 둘이 `ready`를 찍으면 stdin에 `go`를 보낸다. child는 `postgresStore({ databaseUrl })`로 배치를 수집하고 결과 JSON을 stdout에 쓴다. 배치는 시험이 만들어 JSON으로 넘기거나 child가 같은 생성 함수로 만든다(Date 왕복 주의).

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project postgres session-concurrency` -- expected: 두 프로세스 동시 수집 시험 통과
- `pnpm build && pnpm exec vitest run --project postgres --project core --project sqlite` -- expected: 계약 실행 전부 통과
- `pnpm test` -- expected: build·typecheck·전체 시험 통과(PG는 global-setup이 Docker로 띄움, OrbStack 켜짐)

**Manual checks (if no CLI):**
- 셸에 pnpm이 없으면 `npx --yes pnpm@12 …` 또는 corepack pnpm 12로 같은 명령을 돌린다(1의 기록).

## Auto Run Result

- 상태: `built`. 티켓·계획을 `done`으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 완료 판정은 오케스트레이터가 한다. 사람이 저장소 밖에서 할 일은 없다.
- 요약: PG Store에 `listStaleSessions`·`listIdentityCandidates`·`countUntaggedSessions`·`fillSessionTags`·`listTranscriptFiles`·`listOpenWorkTargets`를 SQLite와 같은 의미로 구현하고, 세션 계약을 비가리기 묶음(`sessionMetadataContract`)과 가리기 묶음(`sessionRedactionContract`)으로 나눠 PG가 가리기 외 세션 계약·transcript 계약을 모두 돌게 했다. 두 Node 프로세스 동시 수집 통합 시험을 더했다.
- 바뀐 파일:
  - `packages/core/src/testing/contracts/session-store.ts` — 비가리기·가리기 묶음과 subject 타입 분리, `sessionStoreContract()`는 원래 순서·이름·수(32)로 합성.
  - `packages/core/src/testing/contracts/index.ts`, `packages/core/src/testing/index.ts` — 새 묶음·타입 export.
  - `packages/postgres/src/sessions.ts` — 세션 verb 4개. `fillSessionTags`는 세션 토큰 advisory lock 아래 `withWrite`, `first_cwd`는 `pgText`/`originalText`.
  - `packages/postgres/src/transcript-files.ts` — `listTranscriptFiles`(`collate "C"`, 커서 원문 복원).
  - `packages/postgres/src/ingest-work.ts` — `listOpenWorkTargets`(잠금 없는 읽기).
  - `packages/postgres/src/store.ts`, `packages/postgres/src/index.ts` — 넓힌 `PostgresStore` 타입과 팩토리 조립(`PostgresIngestStore`는 유지).
  - `packages/postgres/test/store.test.ts` — PG 계약 실행 목록 확장, NUL 왕복, 바이트 정렬, 완료 일감 제외, DB 꺼짐 값, 세션 잠금 `DB_LOCKED`, 읽기 잠금 실패의 `DB_UNAVAILABLE`.
  - `packages/postgres/test/session-concurrency.test.ts`, `packages/postgres/test/fixtures/ingest-worker.mjs` — 두 프로세스 동시 수집 시험(메시지·도구 메모 128건, 한 번 수집한 DB와 비교).
- 검토 결과: quick 렌즈 1개, 지적 0건. patch 0, defer 0, reject 0.
- 재검토 권고: `false`(patch한 지적 없음).
- 검증: `npx --yes pnpm@12 exec vitest run --project postgres session-concurrency` 통과(1개). `… --project postgres --project core --project sqlite` 1,568개 통과. 전체 `npx --yes pnpm@12 test`는 첫 실행에서 기존 `packages/postgres/test/text.test.ts:14` 1개 실패, 단독 재실행과 두 번째 전체 실행(108개 파일·2,930개 시험)은 모두 통과.
- 같은 세션 동시 수집 시험의 실행 명령: `pnpm build && pnpm exec vitest run --project postgres session-concurrency`(셸에 pnpm이 없으면 `npx --yes pnpm@12 …`).
- 남은 위험: 11.1의 `text.test.ts`가 `world()`에서 `lockTimeoutMs: 40`으로 `ensureSelfUser`까지 돌려, 전체 병렬 실행의 부하에 따라 가끔 잠금 예산을 넘는다(이번 변경이 PG 시험을 늘려 빈도가 오를 수 있다). 읽기 verb는 포트대로 잠금 대기 실패도 `DB_UNAVAILABLE`로 돌려준다. `redactMessage`(티켓 5)와 WorkStore 나머지 9 verb(티켓 3)는 아직 PG에 없다. 기존 `.env` 비원자 쓰기 이월(11.1)은 그대로다.
- 후속 실행(2026-10-28): 기존 `built` 계획을 후속 리뷰 경로로 검사했다. 오케스트레이터 소유 상태를 유지하고 기존 deferred-work ledger 항목을 수정하지 않았다. 이번 실행의 변경 파일은 이 계획뿐이다.
- 후속 리뷰: 새 quick 세션 `01a18205-68b1-7de0-933d-71c9765ce0fe`가 baseline 이후 구현·계약 diff와 주변 코드를 읽었다. 발견 0건, patch high 0·medium 0·low 0, defer 0, reject 0이며 `followup_review_recommended: false`다.
- 후속 검증: 계획에 남은 오케스트레이터 검증 기록(동시 수집 1개, PG·Core·SQLite 1,568개, 전체 108개 파일·2,930개 통과)을 확인했다. 이번 실행은 제품 코드·시험을 변경하지 않아 build·시험을 반복하지 않았다. `git diff --check`를 통과했다. 남은 위험은 위에 기록된 기존 시험의 짧은 잠금 예산이며 새 위험은 발견하지 못했다.
