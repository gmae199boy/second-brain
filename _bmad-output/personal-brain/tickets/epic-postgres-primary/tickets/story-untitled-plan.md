---
title: '일감·예약·실패: 두 프로세스가 동시에 청구해도 한 번만 처리된다'
type: 'feature'
ticket: '3'
created: '2026-10-28'
status: done
baseline_revision: '19fe598f3bc1ea4c57d5cac18cbbdd460d0aea96'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** PG Store는 WorkStore 10 verb 중 `listOpenWorkTargets` 하나만 있고 ScheduleStore는 없다. 그래서 work-store·schedule-store 계약이 PG에서 돌지 않고, 두 drain이 같은 일감을 청구하거나 두 틱이 같은 예약을 두 번 발화하지 않는다는 보장이 PG에 없다. 경로별 연결 설정(hook의 짧은 한도)도 CLI 호출부에 숫자로 흩어져 있다.

**Approach:** `packages/postgres`에 WorkStore 10 verb(청구는 `FOR UPDATE SKIP LOCKED`)와 ScheduleStore 3 verb(발화는 예약 행 compare-and-set 뒤 일감 find-or-create, 한 트랜잭션)를 구현해 `postgresStore`에 합친다. 경로별 `lock_timeout`·`statement_timeout`·`application_name`·UTC를 `connect.ts`의 한 함수가 정한다. 두 계약을 PG에서 돌리고, 계약 밖 시험으로 두 프로세스 동시 drain, 예약 동시 발화, `lock_timeout` 초과의 `DB_LOCKED`를 확인한다.

## Boundaries & Constraints

**Always:**
- 의미의 기준은 SQLite 구현(`packages/sqlite/src/work.ts`, `schedules.ts`)과 Core port 주석이다. 결과 값·`created`·`lost`·순서·오류 코드가 같아야 한다.
- 쓰기는 기존 `withWrite`(한 트랜잭션, 실패는 `databaseFailure`: `55P03`·`40P01` → `DB_LOCKED`, 나머지 → `DB_UNAVAILABLE`)로 한다. 연결 실패·`brain` schema 없음은 모든 새 verb에서 `DB_UNAVAILABLE` 값이다(throw하지 않는다).
- port 결과 타입이 `DB_UNAVAILABLE`만 허용하는 읽기(`hasDueWork`·`listOpenWorkTargets`·`listFailures`)는 모든 오류를 `DB_UNAVAILABLE`로 낸다(기존 `listTranscriptFiles` 선례). `listDueSchedules`는 `databaseFailure`를 쓴다.
- 모든 입력 시각은 쓰기 전에 Core `formatInstant`로 검사하고, 범위 밖 시각은 아무것도 쓰지 않고 실패 값으로 돌려준다. 읽은 시각은 `Date`로 되돌린다(ms 정밀도 왕복).
- `claimWork`의 순서는 `(attempts, id)`이고 조건은 SQLite `claimCandidateQuery`와 같다(미완료, `next_attempt_at <= now`, 청구 없음 또는 만료, kind 목록 안). `hasDueWork`도 같은 조건 함수를 쓴다. 만료 시각은 `workKindPolicy(kind).claimForMs`로 JS에서 계산한다.
- 경로 프로필이 없을 때(`path` 생략)의 `createPool` 기본값과 명시 숫자 옵션의 우선은 지금과 같다.
- 시험 DB는 `test/fixture.ts`의 `database()`/`subject()`를 쓴다. 자격 증명은 자식 프로세스에 stdin으로 넘긴다(인자 금지).

**Never:**
- 임대 갱신·작업 의존성·현지 시각 예약·감독자(epic 12), 저장본 가리기(티켓 5), 데몬·명령의 PG 전환(티켓 7)을 하지 않는다. `apps/cli`는 `dispatch.ts`의 hook `postgresStore` 호출을 경로 프로필로 바꾸는 것 말고 고치지 않는다.
- `packages/postgres/migrations/0001_initial.sql`, `packages/sqlite/**`, `plugin/app-ref`·plugin version을 바꾸지 않는다.
- 청구를 "먼저 읽고 나중에 쓰기"(잠금 없는 select 뒤 update)나 advisory lock 하나로 직렬화하는 방식으로 만들지 않는다.
- 문서·커밋·시험 출력 인용에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 동시 drain | 일감 40개, 두 Node 프로세스가 `drainQueue`를 동시에 시작 | 처리 기록 40줄·서로 다른 id 40개, 모든 행 `completed_at` 있음·`claimed_by` null·`attempts = 1` | 두 worker 모두 exit 0, `stopped: 'empty'` |
| 잠긴 행 건너뛰기 | 유일한 due 행을 다른 트랜잭션이 `for update`로 잡음 | `claimWork`가 기다리지 않고 `item: null` | 없음 |
| 예약 동시 발화 | 같은 due 예약을 두 store의 `tickSchedules`가 동시에 발화(둘 다 행 잠금에서 대기한 뒤 풀림) | 한쪽 `fired 1·enqueued 1`, 다른 쪽 `fired 0`, 그 target의 일감 1개, `next_run_at` 한 번만 전진 | 없음 |
| 잠금 초과(일감) | 다른 트랜잭션이 일감 행을 잡은 채 `lockTimeoutMs: 40`으로 `completeWork` | `DB_LOCKED`, 행 불변. 풀린 뒤 다시 부르면 `done` 한 번 | 값으로 반환 |
| 잠금 초과(예약) | 예약 행을 잡은 채 `fireSchedule` | `DB_LOCKED`, 예약·일감 불변. 풀린 뒤 `fired: true, created: true`, 다시 부르면 `fired: false` | 값으로 반환 |
| 발화 원자성 | 소유자 연결이 `work_items` INSERT를 거부하는 trigger를 둠 | `fireSchedule`이 `DB_UNAVAILABLE`, 예약 불변·일감 없음. trigger를 지우면 한 번 발화 | 롤백 |
| schema 없음 | `drop schema brain cascade` 뒤 새 verb 호출 | `claimWork`·`addWork`·`fireSchedule`·`listDueSchedules`·`listFailures` 모두 `DB_UNAVAILABLE` 값 | throw 없음 |
| 경로 프로필 | `path: 'turn' \| 'command' \| 'drain'` | `lock_timeout`·`statement_timeout`·`application_name`·`TimeZone=UTC`가 Design Notes 표대로 실제 세션에 보임 | 없음 |

</intent-contract>

## Code Map

- `packages/postgres/src/ingest-work.ts` -- 지금 `ensureWork`(void, `on conflict … do nothing`)와 `listOpenWorkTargets`만 있다. 새 `work.ts`로 옮겨 전체 WorkStore로 키우고 이 파일은 지운다. `sessions.ts:28`(import)·`:243`(세션 생성 트랜잭션 안의 identity 일감)이 `ensureWork`를 쓴다. 반환값을 `{ created, row }`로 바꿔도 그 호출은 결과를 쓰지 않는다.
- `packages/postgres/src/store.ts` -- `postgresStore` 조립과 `PostgresStore` 타입(`Pick<WorkStore,'listOpenWorkTargets'>` → `WorkStore & ScheduleStore`). `postgresOpenWorkStore` 대신 새 work·schedule store를 펼친다.
- `packages/postgres/src/connect.ts` -- `createPool`이 이미 `-c lock_timeout -c statement_timeout -c timezone=UTC`와 `application_name`을 건다. 여기에 경로 프로필을 더한다. `databaseFailure`·`describe`·`PgConnect` 재사용.
- `packages/postgres/src/write.ts` -- `withWrite(connection, work, key?)`. 그대로 쓴다.
- `packages/postgres/src/transcript-files.ts:38` -- 읽기 오류를 `DB_UNAVAILABLE`로 내는 선례, `order by … collate "C"` 선례.
- `packages/sqlite/src/work.ts`(전체), `packages/sqlite/src/schedules.ts` -- 의미 기준(읽기만). `finish` 헬퍼(변경 행 수 → `done`/`lost`), `recordFailure`(closeWork 먼저, 남의 청구면 실패 행도 안 씀, `first_occurred_at` 불변·`occurrences + 1`·`resolved_at = null`), `releaseWork`(`greatest(0, attempts - 1)`), `listFailures`(`occurred_at desc, id desc`, 선택 필터, limit 없음 허용).
- `packages/core/src/ports/store.ts:404-660`(WorkStore 타입·주석), `:1348-1364`(ScheduleStore). `packages/core/src/domain/work-item.ts`의 `workKindPolicy`.
- `packages/core/src/testing/contracts/work-store.ts`(17 case, UUID id 사용 — 그대로), `schedule-store.ts`(4 case, id가 `'a'`·`'b'`·`'work-a'`·`'reservation-17'` 같은 비 UUID라 PG `uuid` 열에 들어가지 않음 → 고친다). memory 실행 `packages/core/test/contracts.test.ts:1473`, SQLite 실행 `packages/sqlite/test/schedule-store.test.ts:27`도 그대로 통과해야 한다.
- `packages/core/src/queue/drain.ts:217` `drainQueue`, `packages/core/src/queue/schedule-tick.ts:10` `tickSchedules` -- 계약 밖 시험이 부르는 실제 Core 경로.
- `packages/core/src/busy-timeout.ts` -- `BUSY_TIMEOUT_MS`(`turn` 3000, `command`·`drain` 10000)와 `BusyTimeoutPath`. 이름은 바꾸지 않는다.
- `apps/cli/src/dispatch.ts:575-576` -- hook 경로의 `postgresStore({... connectTimeoutMs/lockTimeoutMs/queryTimeoutMs/applicationName })`를 `path: 'turn'`으로 바꾼다(값은 같아야 함).
- 시험 선례: `packages/postgres/test/session-concurrency.test.ts`+`fixtures/ingest-worker.mjs`(stdin 자격 증명, `ready`/`go` 장벽, dist import), `packages/sqlite/test/work-store.test.ts:411`과 `fixtures/drain-worker.mjs`(두 프로세스 drain, 로그 파일), `packages/sqlite/test/schedule-store.test.ts:28-66`(롤백·`DB_LOCKED` 시험), `packages/postgres/test/store.test.ts`(blocker `pg.Client`, `lockTimeoutMs: 40, queryTimeoutMs: 1000`), `packages/postgres/test/connect.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/src/connect.ts` -- `CreatePoolOptions`에 `path?: BusyTimeoutPath`를 더하고, 경로 → 연결 설정 표를 이 파일 한 곳에 둔다(Design Notes). 명시한 숫자·이름 옵션이 프로필보다 우선 -- E11-4 연결 함수 한 곳
- [x] `packages/postgres/src/work.ts`(새) -- `ensureWork`(→ `{ created, row }`)와 `postgresWorkStore` 10 verb. `ingest-work.ts`를 지우고 `sessions.ts` import를 옮긴다 -- E11-4
- [x] `packages/postgres/src/schedules.ts`(새) -- `postgresScheduleStore` 3 verb -- E11-4
- [x] `packages/postgres/src/store.ts` -- 두 store를 조립하고 `PostgresStore` 타입을 넓힌다 -- 계약 실행
- [x] `apps/cli/src/dispatch.ts` -- hook `postgresStore` 호출을 `path: 'turn'`으로 바꾼다(동작 동일) -- 경로별 설정이 한 곳
- [x] `packages/core/src/testing/contracts/schedule-store.ts` -- 예약·일감 id를 소문자 정규 UUID 상수로 바꾼다. 같은 시각의 id 순서 case는 큰 id를 먼저 넣고 작은 id가 먼저 나오는지 보는 꼴로 뜻을 지킨다. 나머지 단언은 그대로 -- 계약이 PG에서 돌 수 있게
- [x] `packages/postgres/test/work-store.test.ts`(새) -- `workStoreContract()`·`scheduleStoreContract()`를 `subject`로 돌리고, I/O 매트릭스의 계약 밖 행을 아래 이름으로 시험한다 -- 검증 기준
- [x] `packages/postgres/test/fixtures/drain-worker.mjs`(새) -- stdin으로 URL을 받아 `postgresStore({ databaseUrl, path: 'drain' })`로 `drainQueue`를 돌리는 worker. `ready` 뒤 `go`를 기다리고, handler는 id를 로그에 덧붙이고 잠깐 쉰다 -- 동시 drain
- [x] `packages/postgres/test/connect.test.ts` -- 경로별 pool 옵션 표 시험과, 실제 DB 세션의 `current_setting` 확인 시험을 더한다 -- 경로 프로필

**시험 이름(`packages/postgres/test/work-store.test.ts`):**
- `describe('work-store contract')`, `describe('schedule-store contract')` -- 계약 case 이름 그대로
- `hands every item to exactly one of two draining processes`
- `claimWork skips a row another transaction holds instead of waiting`
- `fires a schedule once when two ticks race for it`
- `returns DB_LOCKED when a work write outlasts lock_timeout, then completes once`
- `returns DB_LOCKED when a firing outlasts lock_timeout, then fires once`
- `rolls back a firing whose work insert is refused, then fires once`
- `answers DB_UNAVAILABLE from queue and schedule verbs when the brain schema is missing`
- `connect.test.ts`: `applies the %s path profile to a live session`

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/work-store.test.ts packages/postgres/test/connect.test.ts`, then work-store 계약 17 case·schedule-store 계약 4 case와 위 이름의 계약 밖 시험이 모두 통과한다.
- Given 같은 실행, when 두 프로세스 동시 drain 시험이 끝나면, then 처리 기록의 id가 일감 수와 같고 중복이 없으며 모든 일감이 `attempts = 1`로 닫혀 있다.
- Given 같은 실행, when 예약 동시 발화 시험이 끝나면, then 그 예약의 일감은 하나이고 두 틱의 `fired` 합이 1이다.
- Given 같은 실행, when 잠금 초과 시험이 끝나면, then 행을 잡힌 쓰기는 `DB_LOCKED` 값으로 돌아오고 행은 바뀌지 않았으며, 잠금이 풀린 뒤 같은 호출은 한 번만 효과를 낸다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 memory·SQLite·PG 계약을 포함한 모든 시험이 통과한다.

## Implementation Notes

- PostgreSQL WorkStore 10 verb와 ScheduleStore 3 verb를 `withWrite`로 구현했다. 청구는 `FOR UPDATE SKIP LOCKED`, 발화는 예약 CAS 뒤 일감 생성을 사용한다.
- 경로별 연결 설정을 `connect.ts`에 모으고 hook 호출을 `path: 'turn'`으로 바꿨다. 공통 schedule 계약 id를 UUID로 바꾸고 계약·동시성·잠금·롤백·schema 누락 시험을 추가했다.
- 리뷰에서 발견한 find-or-create 조회 사이의 완료 경합을 재시도로 보완했다. 결정적 회귀 시험은 수정 전 실패, 수정 후 통과했다. 미완료·이연 항목은 없다.

## Plan Change Log

## Review Triage Log

- 참고: 아래 첫 항목은 구현 세션이 스스로 돌린 quick 검토(이 워크플로의 렌즈 밖) 기록이다.
- `medium` / `patch` — `packages/postgres/src/work.ts`: `ON CONFLICT DO NOTHING` 후 열린 행 조회 사이에 다른 drain이 그 행을 완료하면 조회가 비고 정상 DB에 `DB_UNAVAILABLE`을 반환한다. READ COMMITTED의 문장별 snapshot과 `completed_at is null` 필터로 경합을 확인했다. 충돌 행이 사라지면 insert/read를 재시도하도록 수정했다. 별도 연결과 query-result 장벽을 쓰는 회귀 시험으로 수정 전 실패·수정 후 통과를 확인했다.

### 2026-10-28 — Review pass
- verdicts: 17 findings — high 0, medium 5, low 7, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind-hunter 1) `ensureWork`의 재시도 루프에 상한이 없다 — 반복하려면 매 회차 사이에 다른 트랜잭션이 같은 key의 열린 행을 새로 만들고 청구·완료까지 커밋해야 한다. 회차마다 다른 쪽의 진전이 있어야 하므로 일상 사용에서 만날 일이 없고, 상한·실패 분기를 더하는 것은 직접 수정이 아니다.
  - `[false]` `[reject]` (blind-hunter 2) `addWork`·`claimWork`의 `toWorkItem`이 try 밖이라 범위 밖 시각 행에서 예외가 샌다 — 이 표의 시각은 adapter만 쓰고, 모든 쓰기가 `formatInstant`(0000~9999년)를 거친다. 그런 행을 만드는 프로그램 경로가 없다. SQLite 구현도 같은 구조다.
  - `[medium]` `[patch]` (blind-hunter 3) `retryWork`·`recordFailure`가 실패 문장을 그대로 `text`에 넣어 U+0000이 있으면 22021로 `DB_UNAVAILABLE`이 된다 — `failureText`(`packages/core/src/domain/failure.ts:139`)는 NUL을 지우지 않고, spool된 실패는 영영 재생되지 못한다. `last_error`와 `failures.message`를 `pgText(...).text`(U+0000 → U+FFFD)로 저장하도록 고쳤고, 시험 `stores NUL failure sentences with replacement characters when retrying and recording`이 통과한다.
  - `[medium]` `[patch]` (blind-hunter 4) 두 프로세스 drain 시험은 한 worker가 40개를 다 처리해도 통과한다 — 각 worker의 `drainQueue` 보고서에 `claimed > 0`을 단언하도록 고쳤다.
  - `[low]` `[reject]` (blind-hunter 5) 열린 행 없이 두 연결이 같은 key로 동시에 `addWork`하는 시험이 없다 — 결함 주장이 아니라 시험 추가 요구다. 코드는 PG의 `ON CONFLICT … DO NOTHING`(진행 중 삽입을 기다린 뒤 충돌로 처리) 뒤 열린 행을 읽고, 동시 발화 시험이 같은 `ensureWork` 경로를 지난다. 새 시험 행렬은 직접 수정이 아니다.
  - `[medium]` `[patch]` (blind-hunter 6) `recordFailure({ closeWork })`의 원자성 시험이 없다 — verification-gap 2와 같은 원인. 아래 행에서 고쳤다.
  - `[low]` `[reject]` (blind-hunter 7) WorkStore의 범위 밖 시각 거부 시험이 없다 — 모든 쓰기 verb가 트랜잭션 안에서 `instant()`로 검사하고 실패를 값으로 낸다. SQLite와 같은 구조이고, 시험 행렬 추가는 직접 수정이 아니다.
  - `[low]` `[reject]` (blind-hunter 8) 청구 만료 → 재청구 → 옛 worker의 늦은 종료를 한 줄로 잇는 시험이 없다 — 계약이 만료 뒤 재청구(`a live claim hides the item, an expired one does not`)와 남의 청구로 끝내기의 `lost`(`finishing with somebody else's claim is lost`)를 각각 확인하고, 모든 종료 verb가 `claimed_by` CAS다. 연결 시험은 새 행렬이다.
  - `[low]` `[reject]` (blind-hunter 9) schedule 계약을 UUID로 바꾸면서 `'B'`·`'a'`의 대소문자 구분 정렬 판별이 사라졌다 — PG `uuid` 열은 입력을 소문자로 정규화하므로 공유 계약에서 그 판별을 지킬 수 없고, Core는 소문자 UUID만 만든다. 대소문자 섞인 id가 들어올 경로가 없어 피해를 짚을 곳이 없다. SQLite 전용 시험 추가는 이 티켓이 고치지 않는 `packages/sqlite`다.
  - `[false]` `[reject]` (edge-case-hunter 1) `toWorkItem` 예외 — blind-hunter 2와 같은 주장, 같은 반증.
  - `[low]` `[reject]` (edge-case-hunter 2) find-or-create 재시도 무한 반복 — blind-hunter 1과 같은 주장, 같은 판정.
  - `[medium]` `[patch]` (verification-gap 1, pre-verified) 정상 `retryWork`가 실제로 다음 시도를 미루는지 PG에서 확인하지 않는다 — 시험 `postpones retried work until its next attempt instant`를 더했다(직전 시각에 `due: false`·`item: null`, 그 시각에 청구됨).
  - `[medium]` `[patch]` (verification-gap 2, pre-verified) 실패 행 INSERT가 거부될 때 일감 닫기도 되돌려지는지 확인하지 않는다 — 시험 `rolls back closing work when its failure insert is refused, then records once`를 더했다(trigger로 거부 → `DB_UNAVAILABLE`, 일감 행 불변, 실패 행 없음 → trigger 제거 뒤 한 번 기록, 다시 부르면 `lost`).
  - `[false]` `[reject]` (intent-alignment 1) CLI 명령·데몬 진입점이 PG를 쓰지 않고 `command`·`drain` 경로가 실제 진입점에 연결되지 않았다 — 티켓 verify는 Store 수준 계약과 동시 drain·발화·잠금 초과 시험을 요구하고, 런타임 PG 조립은 epic Decision(스토리 계획)이 티켓 7에 둔다. hook 진입점은 이미 `path: 'turn'`을 쓴다.
  - `[false]` `[reject]` (intent-alignment 2) 예약 동시 발화 시험이 OS 프로세스 둘이 아니라 한 프로세스의 두 pool이다 — 의도는 "두 틱"이고, 두 pool은 서로 다른 DB backend 두 개로 실제 행 잠금 경합을 만든다(`pg_stat_activity`에서 둘 다 `Lock` 대기를 확인). 프로세스 경계를 요구하는 것은 drain 쪽뿐이고 그쪽은 자식 프로세스 둘이다.
  - `[low]` `[reject]` (intent-alignment 3) 바뀐 schedule 계약은 UUID 입력에 대한 통과이고 대소문자 정렬 판별이 빠졌다 — blind-hunter 9와 같은 원인, 같은 판정.
  - `[false]` `[reject]` (intent-alignment 4) "한 번 처리"가 프로세스 중단·청구 만료 뒤 재청구·외부 효과까지 포괄하지 않는다 — 티켓이 임대 갱신을 epic 12로 명시해 뺐고, verify가 요구하는 관측(동시 drain에서 일감마다 한 번)은 시험이 단언한다.

### 2026-10-28 — Review pass
- 후속 검토: 기존 `built` 구현 전체를 네 렌즈로 다시 검토했다. 상태 필드는 오케스트레이터 소유이므로 유지했다. 기존 원장 항목은 수정하지 않았다.
- verdicts: 19 findings — high 0, medium 4, low 9, false 6, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind-hunter 1) NUL 치환 뒤 실패 문장이 8,192바이트 상한을 넘는다 — Core `failureText` 뒤 U+0000 한 바이트가 U+FFFD 세 바이트로 늘어난다. `encodedFailure`에서 기존 `truncateUtf8`와 `FAILURE_MESSAGE_MAX_BYTES`를 적용했다. retry·실패 기록·일감 종료의 두 열이 같은 값이며 상한·마스킹·코드 포인트 경계를 지키는 회귀 시험을 추가했다.
  - `[low]` `[reject]` (blind-hunter 2) Core가 허용하는 연도 `0000`은 PG timestamptz 입력에서 거부된다 — `formatInstant`는 네 자리 연도 0000을 허용하고 adapter는 그대로 보낸다. 실제 경계 차이는 있지만 일감·예약의 운영 시각으로 만날 가능성이 낮고, BC 표현과 읽기 변환까지 추가해야 하므로 직접 수정 범위를 넘는 low 항목으로 거절했다.
  - `[low]` `[reject]` (blind-hunter 3) 빈 큐의 동일 키 동시 삽입 시험이 없다 — carried: 이전 blind-hunter 5와 같은 위치·주장이다. 기존 판정대로 별도 시험 행렬을 추가하지 않았다.
  - `[low]` `[reject]` (blind-hunter 4) 동일 실패 키의 동시 upsert 시험이 없다 — `recordFailure`는 UNIQUE 키의 단일 `INSERT ON CONFLICT DO UPDATE`에서 횟수를 증가시키고 최초 시각을 보존한다. 순차 계약은 그 결과를 검증한다. 새 병렬 시험 행렬 요구이며, 실제 잘못된 결과나 일상적인 회귀 위험을 보여 주지 않아 거절했다.
  - `[low]` `[reject]` (blind-hunter 5) WorkStore 잘못된 시각 입력의 무변경 시험이 없다 — carried: 이전 blind-hunter 7과 같은 주장이다. `instant` 검사와 `withWrite` 롤백은 그대로이며 기존 low 거절 판정을 유지했다.
  - `[low]` `[patch]` (blind-hunter 6) SKIP LOCKED 시험이 잠기지 않은 다음 후보 청구를 확인하지 않는다 — 기존 유일 후보의 null 단언을 유지하고 두 번째 due 행을 추가해 그 id의 청구와 첫 행의 무변경을 확인했다.
  - `[medium]` `[patch]` (blind-hunter 7) ready/go와 5ms 대기는 두 worker의 실제 청구를 보장하지 못한다 — 빠른 프로세스가 전부 완료하면 올바른 구현도 `claimed > 0`에서 실패할 수 있다. 첫 handler에서 `entered`를 보내고 양쪽 진입 뒤에만 `continue`를 받는 장벽으로 바꿨다. 고유 id·전체 집합·완료·attempts 단언을 유지했다.
  - `[low]` `[patch]` (blind-hunter 8) 부모의 15초 종료가 worker의 30초 예산보다 짧다 — 부모 watchdog을 예산+10초, 시험 timeout을 예산+20초로 맞추고 실패·정리 경로에서 자식을 종료하도록 했다.
  - `[medium]` `[patch]` (blind-hunter 9) 부모는 고정 미래 시각, worker는 시스템 달력 시각을 쓴다 — fixture 시각 이전의 달력에서는 모든 일감이 미래가 된다. 기준 시각을 자격 증명과 함께 stdin으로 넘기고 `performance.now()` 경과 시간을 더하는 시계로 바꿨다.
  - `[low]` `[reject]` (blind-hunter 10) 새 verb의 연결 거부·종료 시험이 없다 — 각 쓰기는 `withWrite`의 오류 값 변환을 공유하고 읽기는 자체 catch를 둔다. schema 누락 시험은 13 verb를 모두 실행한다. 기존 연결 시험 외에 새 verb별 장애 행렬을 요구한 항목이며 실제 예외 유출을 입증하지 않아 거절했다.
  - `[low]` `[reject]` (edge-case-hunter 1) find-or-create 반복에 상한이 없다 — carried: 기존 blind-hunter 1·edge-case-hunter 2와 같은 위치·주장이다. 매번 다른 생산자와 완료자의 진전이 있어야 하는 경합이라는 기존 근거와 거절 판정을 유지했다.
  - `[false]` `[reject]` (edge-case-hunter 2) 범위 밖 저장 시각을 변환하면서 addWork·claimWork가 예외를 던진다 — carried: 기존 blind-hunter 2·edge-case-hunter 1과 같은 주장이다. 모든 adapter 쓰기는 `formatInstant`를 통과하고, 해당 행을 만드는 프로그램 경로가 없다는 반증을 유지했다.
  - `[medium]` `[patch]` (verification-gap 1, pre-verified) 동일 occurredAt에서 실패 id 내림차순과 limit의 판별력이 없다 — PG 시험에 같은 시각·서로 다른 실패 키를 작은 id부터 기록하고 전체 순서와 limit 1의 큰 id를 확인하는 시험 하나를 추가했다.
  - `[false]` `[reject]` (intent-alignment 1) 예약 발화 시험은 OS 프로세스 둘을 쓰지 않는다 — carried: 이전 intent-alignment 2와 같은 주장이다. 티켓의 예약 기준은 두 틱이며, 서로 다른 DB backend 두 개의 실제 잠금 경합을 시험한다.
  - `[false]` `[reject]` (intent-alignment 2) 잠금 초과 시험이 모든 쓰기 verb를 개별 실행하지 않는다 — 티켓 verify는 잠금 초과 쓰기의 `DB_LOCKED`를 요구한다. 일감과 예약의 실제 행 잠금 시험이 공통 `withWrite`·`databaseFailure` 경로를 검증하며, 모든 verb별 잠금 행렬을 요구하지 않는다.
  - `[low]` `[reject]` (intent-alignment 3) UUID 계약 입력에서 대소문자 문자열 정렬 판별이 사라진다 — carried: 이전 blind-hunter 9·intent-alignment 3과 같은 주장이다. PG uuid 정규화와 Core의 소문자 UUID 생성이라는 기존 근거를 유지했다.
  - `[false]` `[reject]` (intent-alignment 4) 실제 CLI·daemon의 command·drain PG 전환과 spool replay가 없다 — carried: 이전 intent-alignment 1과 같은 주장이다. 에픽은 런타임 PG 조립을 티켓 7에 두고 이 티켓은 Store 계약·두 프로세스 drain을 검증한다.
  - `[false]` `[reject]` (intent-alignment 5) 장애·외부 효과까지 일반적인 exactly-once를 보장하지 않는다 — carried: 이전 intent-alignment 4와 같은 주장이다. 티켓은 정상 동시 drain 관측을 요구하고 임대 갱신을 epic 12로 명시해 제외한다.
  - `[false]` `[reject]` (intent-alignment 6) NUL 치환은 티켓에 없는 저장 의미 변경이다 — 에픽의 PG text/NUL 결정과 기존 검토가 실패 문장 저장을 다룬다. 실패 문장은 원문 transcript가 아닌 마스킹된 로그이며 치환 자체는 기존 패치다. 이번 검토는 바이트 상한 위반만 위 blind-hunter 1로 고쳤다.

## Design Notes

**경로 프로필(`connect.ts` 한 곳):** `BUSY_TIMEOUT_MS[path]`를 `B`라 할 때 `connectTimeoutMs = B`, `lockTimeoutMs = B`, `queryTimeoutMs = B + 1000`(→ 기존 계산으로 `statement_timeout = B + 1000`, client deadline `B + 2000`), `application_name`은 `turn` → `second-brain-hook`, `command` → `second-brain-command`, `drain` → `second-brain-drain`. `timezone=UTC`는 모든 경로에 그대로. `path`가 없으면 지금의 기본값(5000, `second-brain`). `turn`은 지금 dispatch가 넘기는 값과 정확히 같다.

**청구(한 트랜잭션):**
```sql
select … from brain.work_items
 where completed_at is null and next_attempt_at <= $now
   and (claim_expires_at is null or claim_expires_at <= $now)
   and kind = any($kinds::text[])
 order by attempts, id limit 1
 for update skip locked;
-- 있으면: update … set attempts = attempts + 1, claimed_at, claim_expires_at, claimed_by where id = $id
```
`hasDueWork`는 같은 조건 함수를 잠금 절 없이 쓴다. 빈 kind 목록은 DB에 묻지 않고 `due: false`/`item: null`. 잠긴 행을 건너뛰어 `null`이 되는 것은 port가 말하는 "다른 쪽이 먼저 가져감"이다.

**find-or-create:** `addWork`는 `insert … on conflict (kind, target_kind, target_id) where completed_at is null do nothing returning *` → 행이 오면 `created: true`, 아니면 열린 행을 읽어 `created: false`. 같은 id를 다시 제안해도 arbiter 충돌이 먼저라 아무것도 만들지 않는다. `recordFailure`는 `on conflict (target_kind, target_id, stage, fingerprint) do update … returning id, (xmax = 0) as created`로 한 문장에서 `created`를 얻는다(closeWork가 있으면 그 CAS를 먼저 하고 0행이면 `lost`, 실패 행도 쓰지 않음).

**발화(한 트랜잭션, 순서가 중요):** 먼저 `update brain.schedules set last_run_at = $now, next_run_at = $next where id = $id and next_run_at = $expected returning id`로 예약 행을 잠그며 CAS한다. 0행이면 `fired: false`. 1행이면 `ensureWork`로 `created`를 얻는다. READ COMMITTED에서 두 번째 발화는 행 잠금을 기다린 뒤 바뀐 `next_run_at`으로 WHERE를 다시 보고 0행이 된다. 일감을 먼저 넣고 예약을 나중에 고치면 두 틱이 서로 다른 일감 id로 경합하므로 그렇게 하지 않는다.

**동시 발화 시험의 겹침 만들기:** 소유자 연결이 `begin; select … from brain.schedules where id = $1 for update`로 행을 잡고, 두 store(각자 pool·`sequenceIdGen` 시작값 다름)의 `tickSchedules`를 함께 시작한 뒤 `pg_stat_activity`에서 두 backend가 `wait_event_type = 'Lock'`이 될 때까지 기다렸다가 rollback한다. drain 시험은 일감 40개, worker 둘을 `ready` 뒤 동시에 `go`.

## Verification

**Commands:**
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/work-store.test.ts packages/postgres/test/connect.test.ts` -- expected: 새 계약·계약 밖 시험 전부 통과
- `npx --yes pnpm@12 exec vitest run --project core --project sqlite` -- expected: 바뀐 schedule 계약이 memory·SQLite에서 통과
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과(PG는 global-setup이 Docker로 띄움, OrbStack 켜짐)

**Actual results (2026-10-28):**
- `npx --yes pnpm@12 test`: build·typecheck 성공, 110 files / 2,980 tests 통과.
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/work-store.test.ts packages/postgres/test/connect.test.ts`: 2 files / 40 tests 통과. WorkStore 계약 17 case, ScheduleStore 계약 4 case와 모든 I/O 매트릭스 행의 시험이 실행되어 통과했다.
- `npx --yes pnpm@12 exec vitest run --project core --project sqlite`: 50 files / 1,465 tests 통과.
- `git diff --check`와 `git diff --cached --check`: 통과.
- `quick` 리뷰 1건을 수정하고 최종 전체 검증을 다시 통과했다. 이연 항목 없음.

## Auto Run Result

- 인계 상태: `built`. 기존 plan의 `status: 'built'`를 그대로 유지했고, 티켓을 `done`으로 바꾸거나 `tickets.py mark`를 실행하지 않았다. 완료 판정은 오케스트레이터가 맡는다.
- 후속 검토에서 PG WorkStore·ScheduleStore 구현 전체를 네 렌즈로 확인했다. 기존 WorkStore 10 verb·ScheduleStore 3 verb, `FOR UPDATE SKIP LOCKED`, 예약 CAS, 경로별 연결 설정과 `DB_LOCKED` 분류는 유지된다.
- 이번 수정 파일:
  - `packages/postgres/src/work.ts` — 실패 문장의 NUL 치환 뒤 기존 Core UTF-8 절단 함수로 8,192바이트 상한을 적용한다. retry·실패 기록·일감 종료의 저장 문장은 같은 방식으로 처리한다.
  - `packages/postgres/test/fixtures/drain-worker.mjs` — 첫 handler 참여 장벽과 fixture 기준 시각+단조 경과 시계를 사용한다. 설정·자격 증명은 stdin으로 받는다.
  - `packages/postgres/test/work-store.test.ts` — 문장 상한·마스킹·코드 포인트, 동일 시각 실패 정렬·limit, 잠긴 첫 행 뒤 다음 후보 청구를 검증한다. drain 부모는 두 handler 진입을 기다린 뒤 풀며 예산·watchdog·시험 timeout·자식 정리를 맞춘다.
  - 이 plan — 기존 기록을 보존하고 후속 판정·실행 결과를 추가했다. 시작 전에 제거되어 있던 이전 Auto Run Result는 복원하지 않고 이번 인계 결과를 기록했다.
- 검토 판정: 19건 중 medium 4·low 9·false 6, high·maybe-false 0. patch 6항목(medium 4·low 2)을 적용했다. 거절 13건(low 7·false 6)은 위 후속 Review Triage Log의 각 행에 반증 또는 거절 이유를 기록했다. 새로운 deferred 항목은 없고 기존 원장과 `deferred: []`는 그대로다.
- 후속 검토 권고: `false`. 이번 실행은 기존 `built` plan의 후속 pass이며 high patch가 없다. 추가 검토가 필요한 구체적인 미검증 high 위험은 발견하지 않았다.
- 검증 결과:
  - 수정 전 `npx --yes pnpm@12 test`: build·typecheck 성공, 110 files / 2,983 tests 통과.
  - 구현 세션의 수정 파일 집중 시험: 34 tests 통과.
  - 수정 뒤 `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/work-store.test.ts packages/postgres/test/connect.test.ts`: build 성공, 2 files / 45 tests 통과.
  - 수정 뒤 `npx --yes pnpm@12 exec vitest run --project core --project sqlite`: 50 files / 1,465 tests 통과.
  - 수정 뒤 `npx --yes pnpm@12 test`: build·typecheck 성공, 110 files / 2,985 tests 통과.
  - 동시 drain: `hands every item to exactly one of two draining processes`. 예약 CAS: `fires a schedule once when two ticks race for it`. 잠금 초과: `returns DB_LOCKED when a work write outlasts lock_timeout, then completes once`와 `returns DB_LOCKED when a firing outlasts lock_timeout, then fires once`. 두 Store 계약과 함께 위 PG 명령으로 실행했다.
  - 새 경계·정렬 시험: `caps encoded failure sentences equally in work and failure rows at code point boundaries`, `lists failures at equal instants by descending id and applies the limit`.
- 남은 한계: Core의 연도 0000 입력은 PG에서 거부된다(low 거절 근거는 위 로그). 이전 실행에서 이름이 보존되지 않은 간헐 실패는 이번 수정 전·후 전체 실행에서 재현되지 않았다. 참여 장벽과 시계 의존성을 수정했지만 당시 실패와 같은 원인이었다고 단정할 수 없다. 실제 command·daemon PG 전환은 에픽의 후속 티켓 범위다.
- 기존 구현 세션 `01a1822c-3545-7851-b7b0-feab7b0f0901`을 재개해 소스·시험을 수정했다. 검토·문서 외 소스는 조정자가 직접 편집하지 않았다. push하지 않는다.
