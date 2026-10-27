---
title: '마이그레이션 0009와 예약 틱: 시각이 된 일감이 한 번만 들어간다'
type: 'feature'
ticket: '5'
created: '2026-10-27'
status: done
baseline_revision: '5f65f5604f567a0d0e350a73bd4e1e7043016926'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 데몬(9.1·9.4)은 drain과 감시만 돌고, "그 시각이 되면 일감을 넣는" 자리가 없다. 다음 조각의 사용자 스케줄러가 얹힐 예약 테이블도, 시각이 된 예약을 `work_items`에 정확히 한 번 넣는 틱도 없다(E9-4, Done when 5).

**Approach:** SQLite 마이그레이션 0009(schema version 9)로 `schedules` 테이블을 만들고, Core에 저장소 능력(`ScheduleStore`)과 틱 use case(`brain.schedules.tick()`)를, 데몬 회차에 틱 호출을 더한다. 예약 하나의 발화는 한 트랜잭션(일감 넣기 + `last_run_at`·`next_run_at` 갱신, `next_run_at` compare-and-set)이고, 다음 시각은 발화 시점 + 간격이라 놓친 회차는 하나로 합쳐진다. 검증용 Core 일감 종류 `schedule_probe`를 더한다.

## Boundaries & Constraints

**Always:**
- **테이블**(`packages/sqlite/migrations/0009_schedules.sql`, 머리 주석에 이유): `schedules(id text primary key, kind text not null, target_kind text not null, target_id text not null, interval_seconds integer, next_run_at text, last_run_at text, created_at text not null) strict`. 검사: 시각 칸 셋은 `work_items`와 같은 ISO glob(null 허용 칸은 `is null or …`), `interval_seconds is null or interval_seconds > 0`, `interval_seconds is null or next_run_at is not null`(반복은 끝나지 않는다). `next_run_at is null`은 "끝난 한 번짜리"다. 부분 인덱스 `schedules_due_idx on schedules (next_run_at) where next_run_at is not null`. 멱등 키는 `id`(UUIDv7)뿐 — `(kind, target)` 중복은 `work_items`의 미완료 키가 합친다.
- `SQLITE_SCHEMA_VERSION = 9`. 버전 8을 단언하는 기존 시험(`schema-0006.test.ts`, `schema-0005.test.ts`의 최고 번호 등)과 `schema.test.ts`의 `EXPECTED_TABLES`(`schedules` 추가)를 고친다. 0009 전용 시험 파일은 다른 `schema-000N.test.ts` 관례를 따른다.
- **도메인·포트**(Core): `domain/schedule.ts`의 `Schedule`(id, kind, targetKind, targetId, intervalSeconds: number|null, nextRunAt: Date|null, lastRunAt: Date|null, createdAt). `ports/store.ts`에 `ScheduleStore`를 더하고 `Store`에 합친다(Postgres는 `HealthStore`만이라 영향 없음):
  - `addSchedule(input)` — 행 하나 만들기(이 조각에서는 시험과 다음 조각만 씀; 명령은 없음).
  - `listDueSchedules({ now, limit })` — 읽기(쓰기 잠금 없음), `next_run_at <= now`인 행을 `next_run_at, id` 순으로.
  - `fireSchedule({ scheduleId, expectedNextRunAt, nextRunAt, work: AddWorkInput, now })` — 한 `withWrite` 트랜잭션: 행의 `next_run_at`이 여전히 `expectedNextRunAt`일 때만 `ensureWork`(9.1 이전부터 있는 find-or-create, `work.ts`)로 일감을 넣고 `last_run_at = now`, `next_run_at = nextRunAt`. 결과 `{ ok: true, fired: true, created } | { ok: true, fired: false }`(다른 발화가 먼저 옮김) `| { ok: false, code: 'DB_UNAVAILABLE' | 'DB_LOCKED', message }`. 예외·제약 위반은 되돌리고 값으로 답한다.
- **규칙은 Core에.** `queue/schedule-tick.ts`의 `tickSchedules({ store, clock, idGen })`: `now`를 한 번 읽고 `listDueSchedules({ now, limit: SCHEDULE_TICK_LIMIT })`(=100, 남은 것은 다음 틱), 예약마다 `nextRunAt = intervalSeconds === null ? null : now + intervalSeconds초`, 일감 `{ id: idGen.next(), kind, targetKind, targetId, createdAt: now, nextAttemptAt: now }`로 `fireSchedule`. 첫 `ok: false`에서 멈추고 그 코드로 답한다. 결과 `{ ok: true, fired, enqueued } | { ok: false, code, message, fired, enqueued }`. 이미 미완료 일감이 있으면(`created: false`) 새 행 없이 예약만 앞으로 간다. `Brain`에 `schedules: { tick(): Promise<ScheduleTickResult> }`. Core에 타이머·프로세스 코드 없음(FR-23).
- **검증용 종류**: `queue/schedule-probe-work.ts`의 `SCHEDULE_PROBE_KIND = 'schedule_probe'`, 처리기는 아무것도 하지 않고 `{ ok: true }`. `createBrain`의 `coreHandlers`에 등록, `index.ts`에서 export. 문서 주석: 설치본에서 틱→drain을 확인하는 종류(9.8), 부수 효과 없음.
- **메모리 가짜**(`testing/fakes/store.ts`)와 계약(`testing/contracts/schedule-store.ts`, `index.ts` export): 핵심 행렬(시각 안 됨·됨, 한 번짜리 끝남, CAS 진 발화는 아무것도 안 바꿈, 미완료 일감 있으면 `created: false`이고 예약은 전진). `packages/core/test/contracts.test.ts`(메모리)와 `packages/sqlite/test/`(SQLite) 둘 다 돌린다.
- **데몬 회차**(`apps/cli/src/daemon/run.ts` `drainOnce`): 스키마 확인과 `createBrain` 뒤, `brain.queue.drain` 앞에 `brain.schedules.tick()` — 같은 회차의 drain이 넣은 일감을 처리한다. 틱 실패는 drain을 막지 않는다. 틱 상태는 drain 문제(`said`)·감시 상태와 별도 상태로, 바뀔 때만 한 줄(한국어, 코드 포함)을 쓰고 성공하면 지운다. 발화가 있었던 회차는 한 줄(`예약 N건 발화, 새 일감 M건`처럼 절마다 한글). 틱 해상도는 회차 간격(최대 `DAEMON_DRAIN_PAUSE_MS`)이고 쉬는 시간을 바꾸지 않는다.
- **문서**: README `## 데몬`에 예약 틱 문단(테이블, 회차마다 틱, 놓친 회차 하나로, 한 번짜리 끝남, DB 실패는 되돌리고 다음 틱, 등록 명령 없음·다음 조각, `schedule_probe`). 로그 기록 목록에 틱 줄. 아키텍처 Table Contract에 `schedules` 행은 오케스트레이터(계획 작성자)가 쓴다 — 구현 세션은 건드리지 않는다.
- 시험은 임시 home·임시 `CLAUDE_CONFIG_DIR`만 쓰고(`environment()` 관례), 절대 홈 경로를 쓰지 않는다. 데몬 모듈은 stdout/stderr에 직접 쓰지 않는다.

**Never:**
- 예약 등록·목록·삭제 명령이나 설정, 새 spool 종류(DB 실패는 트랜잭션 되돌림으로만), 기회적 drain·`queue drain`·SessionStart에 틱 넣기, Postgres 마이그레이션(epic 7), `work_items` 스키마·청구 쿼리·`DRAIN_*`/`DAEMON_*` 상수 변경, 시각이 된 예약을 회차가 아닌 별도 타이머로 깨우기, `stop/start`(9.6)·로그 회전(9.9), 새 의존성.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 시각 됨 | 반복 60초, `next_run_at` = T, 시계 T+1s | `schedule_probe` 일감 하나, 같은 회차 drain이 완료; `last_run_at`=T+1s, `next_run_at`=T+61s | — |
| 시각 안 됨 | 시계 < `next_run_at` | 아무것도 안 넣음 | — |
| 세 주기 건너뜀 | 데몬 꺼진 동안 T+185s 지남, 기동 | 일감 하나뿐, `next_run_at`=기동 시각+60s | — |
| 한 번짜리 | `interval_seconds` null, 시각 됨 | 일감 하나, `next_run_at` null; 이후 틱은 다시 넣지 않음 | — |
| 미완료 일감 있음 | 같은 `(kind, target)`의 열린 일감 | 새 행 없음(`created: false`), 예약은 전진 | — |
| 경쟁 발화 | 목록 뒤 다른 발화가 `next_run_at`을 옮김 | `fired: false`, 일감·예약 그대로 | — |
| 일감 넣기 실패 | 틱 트랜잭션 안 insert가 거절됨 | 일감·`last_run_at`·`next_run_at` 모두 그대로, 로그 한 번, drain은 계속 | 다음 틱에 다시; DB가 돌아오면 한 번 들어감 |
| 예약 갱신 실패 | 일감 insert 뒤 schedules update가 거절됨 | insert도 되돌려짐(일감 없음), 예약 그대로 | 같음 |
| 스키마 불일치 | 버전 ≠ 9 | 틱도 drain도 안 함(9.1 그대로) | — |

</intent-contract>

## Code Map

- `packages/sqlite/migrations/0008_attachment_rules.sql` -- 머리 주석 관례; `0002_files_and_work.sql:40-84` -- `work_items` 시각 glob 검사·부분 인덱스 모범.
- `packages/sqlite/src/migrate.ts:20` -- `SQLITE_SCHEMA_VERSION`; 폴더 최고 번호가 상수와 같아야 한다(290).
- `packages/sqlite/src/work.ts` -- `ensureWork(held, input)`(export, 트랜잭션 안 find-or-create), `instant()`·`toWorkItem` 변환, `withWrite` 사용과 `DB_UNAVAILABLE` 값 반환 관례. 새 `packages/sqlite/src/schedules.ts`(`sqliteScheduleStore(connect)`)가 같은 모양; `store.ts:83-88`에 펼쳐 넣는다. `driver.ts`의 `SqliteSchema`에 테이블 타입.
- `packages/sqlite/src/write.ts:52` -- `withWrite(connection, work)` = `BEGIN IMMEDIATE`…commit/rollback, `WriteResult`.
- `packages/sqlite/test/schema.test.ts:24` `EXPECTED_TABLES`, `schema-0006.test.ts:462-463`·`schema-0005.test.ts:379` 버전 8 단언, `work-store.test.ts` -- 계약을 SQLite로 돌리는 모범.
- `packages/core/src/ports/store.ts:631`(`WorkStore`), `:762`(`Store` 합) -- 새 능력 자리. `domain/work-item.ts` -- 도메인 모양 관례. `domain/index.ts`·`src/index.ts` -- export.
- `packages/core/src/brain.ts:224-277` -- `createBrain`, `coreHandlers`에 `schedule_probe`; `Brain` 인터페이스(약 214)에 `schedules`; `queue: {`(388) 옆에 `schedules: { tick }`.
- `packages/core/src/queue/drain.ts:72-80` -- `WorkHandler`·`WorkHandlerResult`. `capture/session-identity-work.ts` -- 종류 상수·처리기 파일 모양.
- `packages/core/src/testing/fakes/store.ts`(1405줄, `workItems` 상태 183) -- 메모리 구현 자리; `testing/contracts/work-store.ts`·`index.ts`·`fixtures.ts` -- 계약 모양; `packages/core/test/contracts.test.ts` -- 메모리 가짜에 계약을 거는 곳.
- `packages/core/test/brain-drain.test.ts:411`, `blob-delete.test.ts:235`, `document-extract.test.ts:180` -- 가짜 스키마 버전 8; `schemaVersion`과 맞춰야 하면 고친다.
- `apps/cli/src/daemon/run.ts` -- `drainOnce`(스키마 확인→`createBrain`→drain), `said` 상태 관례, `counts`/`worked`(바꾸지 않음). 틱은 `createBrain` 바로 뒤.
- `apps/cli/test/daemon-run.test.ts` -- `homeFor({ migrated })`(149), `startDaemon`(128), `start()`(169), `waitFor`, `installed()`·process 틀(518~); `clock` 주입으로 fake clock.
- `packages/core/src/doctor/doctor.ts:221` -- `schema-version` 점검(저장 버전 = 빌드 버전이면 ok); 상수만 올리면 따라온다.
- `README.md:532` -- `## 데몬`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0009_schedules.sql`, `packages/sqlite/src/migrate.ts`, `packages/sqlite/src/driver.ts` -- 테이블·검사·인덱스, 버전 9, 타입 -- 저장 자리
- [x] `packages/core/src/domain/schedule.ts`, `packages/core/src/ports/store.ts`, export 파일 -- `Schedule`, `ScheduleStore`(세 verb와 입력·결과 타입), `Store`에 합침 -- 포트
- [x] `packages/core/src/queue/schedule-tick.ts`, `packages/core/src/queue/schedule-probe-work.ts`, `packages/core/src/brain.ts`, `packages/core/src/index.ts` -- `tickSchedules`·`SCHEDULE_TICK_LIMIT`, `SCHEDULE_PROBE_KIND`와 처리기, `brain.schedules.tick()` -- 규칙
- [x] `packages/core/src/testing/fakes/store.ts`, `packages/core/src/testing/contracts/schedule-store.ts`(+`index.ts`), `packages/core/test/contracts.test.ts` -- 메모리 구현과 계약 -- 어댑터 둘이 같은 규칙
- [x] `packages/core/test/schedule-tick.test.ts` -- 고정 시계로 행렬의 시각 됨·안 됨·세 주기·한 번짜리·미완료 일감·첫 실패에서 멈춤, `brain.schedules.tick()` 뒤 `brain.queue.drain`이 `schedule_probe`를 완료 -- Core 증거
- [x] `packages/sqlite/src/schedules.ts`, `packages/sqlite/src/store.ts` -- `sqliteScheduleStore` -- SQLite 어댑터
- [x] `packages/sqlite/test/schedule-store.test.ts`(+`schema-0009.test.ts` 또는 같은 파일) -- 계약을 SQLite로; 검사 제약 거절(간격 0, 반복인데 `next_run_at` null, 잘못된 시각); 시험용 trigger로 insert 실패·update 실패 각각에서 일감과 예약이 그대로임, trigger를 지운 뒤 한 번 들어감; 버전 8을 단언하던 시험·`EXPECTED_TABLES` 갱신 -- 트랜잭션 증거
- [x] `apps/cli/src/daemon/run.ts` -- 회차의 틱 호출, 틱 상태 한 번 기록, 발화 줄 -- 데몬 연결
- [x] `apps/cli/test/daemon-run.test.ts` -- in-process(조절 가능한 fake clock, 짧은 `drainPauseMs`): 시계를 예약 시각 너머로 옮기면 `schedule_probe` 하나가 들어가 완료; 세 주기 지난 예약으로 기동하면 하나뿐이고 `next_run_at` = 발화 시각 + 간격; 한 번짜리는 여러 회차 뒤에도 하나; trigger로 틱 트랜잭션을 실패시키면 일감·예약 불변·로그 한 번·데몬 계속, trigger를 지운 뒤 다음 회차에 정확히 하나. 프로세스(`dist/bin.js`): 설치된 home에 세 주기 지난 반복 예약을 SQL로 넣고 데몬을 띄우면 완료된 `schedule_probe` 행이 정확히 하나이고, `brain doctor run --json`의 `schema-version`이 ok·`9` -- 사용자 표면 증거
- [x] `README.md` -- `## 데몬`의 예약 틱 문단과 로그 목록 -- 사용자 문서

**Acceptance Criteria:**
- Given 설치된 임시 home에 간격 N초로 세 주기 전에 시각이 된 예약 하나, when `brain daemon run`을 띄우면, then 그 예약의 `schedule_probe` 일감은 정확히 하나 들어가 완료되고 예약의 `next_run_at`은 발화 시각 + N초다.
- Given 조절 가능한 시계로 뜬 데몬과 아직 시각이 안 된 예약, when 시계를 예약 시각 너머로 옮기면, then 다음 회차에 일감 하나가 들어가고 같은 데몬의 drain이 처리한다.
- Given 틱 트랜잭션 안의 쓰기가 거절되는 DB, when 회차가 여러 번 돌면, then 일감도 `last_run_at`·`next_run_at`도 바뀌지 않고 로그에 한 번만 남으며, 거절이 풀린 다음 회차에 일감이 정확히 하나 들어간다.
- Given 한 번짜리 예약, when 발화 뒤 시계가 계속 가도, then 그 예약의 일감은 다시 들어가지 않는다.
- Given 이 빌드, when `SQLITE_SCHEMA_VERSION`과 설치본의 `brain doctor run`을 보면, then 9이고 `schema-version`은 ok다.
- Given 이 변경 전의 시험, when 전체 시험(Docker가 없으면 `postgres` 제외)을 돌리면, then 그대로 통과한다.

## Implementation Notes

- Added schema 0009, `ScheduleStore`, Core tick/probe, memory and SQLite adapters, and daemon tick-before-drain integration. Firing uses `withWrite` plus the expected-next-run CAS and shared `ensureWork`.
- Tick failure state survives skipped ticks and drain failures independently; successful ticks clear it. Tests cover a schema mismatch between failed ticks and a fresh failure after recovery.
- Updated the CLI unavailable-store implementation and its test double for the new store capability. Existing latest-schema assertions also required updates in SQLite users/chunk-locator and CLI setup tests.
- Architecture Table Contract remains owned by the plan author and was not edited in implementation.

## Plan Change Log

## Review Triage Log

- Quick review: no findings. All I/O matrix scenarios are covered by passing Core, shared contract, SQLite rollback, and daemon integration/process tests.
- 위 행은 구현 세션(codex)이 스스로 돌린 자체 점검 기록이다(계획의 상태·리뷰 칸도 그 세션이 바꿨고 오케스트레이터가 되돌렸다). 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-27 — Review pass
- verdicts: 17 findings — high 0, medium 2, low 9, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) 첫 발화 실패에서 틱이 멈춰, 계속 실패하는 예약 하나가 그 뒤의 예약을 영영 막는다 — 맞다. 다만 이 조각에서 예약 행은 Store verb(시험)와 직접 SQL로만 생기고, 행마다 실패하는 경우는 손상된 행뿐이다. 계속 가게 바꾸면 DB 잠금 때 예약마다 busy timeout을 기다려 틱 하나가 100배 길어진다(계획이 고른 절충). 등록 명령(다음 조각)이 입력을 검증해야 한다.
  - `[low]` `[patch]` (blind) `rowSchedule`이 엄격한 `parseInstant` 대신 `new Date`로 읽어 GLOB는 통과하는 없는 날짜(`2026-02-30`)가 3월 2일로 바뀌고 CAS가 영영 맞지 않는다 — node로 재현(`2026-03-02T00:00:00.000Z`)했다. `work.ts:595`처럼 `parseInstant`로 읽고 실패면 던져 verb의 catch가 `DB_UNAVAILABLE`로 답하게 고쳤다. SQLite 시험 추가.
  - `[low]` `[reject]` (blind) 간격 상한이 없어 아주 큰 간격은 다음 시각이 표기 범위를 넘어 매번 발화가 실패한다 — 맞다(1e13초면 Invalid Date). 이 조각에 등록 경로가 없고, 막으려면 새 검사·분기가 든다. 등록 조각이 입력에서 막는다.
  - `[medium]` `[patch]` (blind) 틱 뒤 abort를 보지 않아, 틱 중 SIGTERM이 와도 drain 한 회차(최대 10초)를 새로 시작한다 — 9.1이 설정·스키마 읽기에서 고친 것과 같은 종류. 틱 뒤 `signal.aborted`면 drain 없이 돌아가게 했고(틱 로그 상태는 유지), 결정적 회귀 시험을 더했다. 틱 자체의 abort 확인은 예약마다 짧은 트랜잭션이라 두지 않았다.
  - `[false]` `[reject]` (blind) 틱이 던지면 `DRAIN_THREW`로 빠져 drain을 건너뛴다 — 틱의 Store verb는 모두 try/catch로 값을 돌려주고(큰 간격의 Invalid Date도 `instant()`가 try 안에서 던져 `DB_UNAVAILABLE`), 틱이 던지는 실제 경로를 보이지 못했다. 버그로 던지면 크게 실패하는 것이 맞다.
  - `[low]` `[patch]` (blind) README가 "DB 실패는 모두 되돌린다"고 하지만 앞서 발화한 예약은 커밋된 채 남는다 — 문장을 예약 단위 되돌림과 앞선 발화 유지로 고쳤다.
  - `[low]` `[patch]` (blind) 메모리 가짜가 같은 시각을 `localeCompare`로 정렬해 SQLite의 이진 `order by id`와 다를 수 있다 — 코드 단위 비교로 바꿨고 대소문자가 섞인 계약 사례(`z,B,a`)가 둘 다에서 돈다.
  - `[low]` `[reject]` (blind) CAS를 연결 둘로 겨루는 시험이 없다 — 낡은 `expectedNextRunAt`로 부르는 순차 시험이 같은 비교를 짚고, 연결 사이 직렬화는 기존 `withWrite`(`BEGIN IMMEDIATE`)의 성질이다. 동시 실행 시험은 비결정적이다.
  - `[low]` `[reject]` (edge) 표기 범위를 넘는 간격이 매 틱 되돌려지고 뒤 예약을 굶긴다 — blind의 간격 상한·첫 실패 멈춤 두 행과 같은 이유.
  - `[low]` `[patch]` (edge) GLOB는 통과하지만 정규화되는 시각이 CAS와 영영 어긋난다 — blind `rowSchedule` 행과 같은 패치.
  - `[medium]` `[patch]` (verification-gap) 모든 시험이 `schedule_probe`/`probe`라 틱이 종류·대상을 박아 넣어도 통과한다 — Core 틱 시험에 다른 `kind`·`targetKind`·`targetId`의 예약이 그 값 그대로 일감이 되는 사례를 더했다.
  - `[low]` `[patch]` (verification-gap) 순서 시험이 같은 시각끼리만이라 `id` 순으로만 정렬해도 통과한다 — 더 이른 시각의 큰 id(`z`)가 `limit: 1`에서 이기는 계약 사례를 더했다(메모리·SQLite).
  - `[false]` `[reject]` (intent) 미완료 일감이 있으면 새 행 없이 예약만 전진해 "예약마다 새 일감 하나" 읽기와 다르다 — `work_items`의 미완료 키 유일성(AD-21, Table Contract)이 같은 일의 두 번째 열린 행을 막으므로 다른 읽기는 구현할 수 없다. "한 번만 들어간다"와 맞다.
  - `[false]` `[reject]` (intent) 되돌림이 틱 전체가 아니라 예약 단위다 — 의도의 "같은 트랜잭션"은 한 예약의 일감과 그 시각들이고, 실패한 예약의 일감·시각은 그대로다. 틱 전체 원자성은 의도에 없다.
  - `[false]` `[reject]` (intent) 다음 시각이 처리기 실행 시각이 아니라 틱 시각이다 — 의도가 다음 시각을 일감 넣기와 같은 트랜잭션에서 갱신하라고 하므로 그 시점에 알 수 있는 실행 시점은 발화 시각뿐이다.
  - `[false]` `[reject]` (intent) 끄고·시간 지나고·다시 켜는 순서 대신 기동 전에 이미 지난 예약으로 시험한다 — 데몬은 예약 상태를 메모리에 두지 않고 DB만 읽으므로 두 경우의 시작 상태가 같다.
  - `[false]` `[reject]` (intent) DB 실패를 DB 전체 장애가 아니라 trigger 거절로 시험한다 — 전체 장애는 연결·`BEGIN` 단계에서 어떤 쓰기도 하기 전에 값으로 끝나고(기존 "닿지 않는 DB" 데몬 시험), trigger는 쓰기 뒤 실패라 더 엄격하다.

### 2026-10-27 — Follow-up thorough review
- verdicts: 19 findings — high 0, medium 2, low 12, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind 1) A malformed timestamp rejects the whole due batch — `result.rows.map(rowSchedule)` fails before any firing. Only manually corrupted SQL rows reach this state; isolating rows needs new recovery policy and branches. Retain the explicit failure rather than silently skip corrupted reservations; this is unlikely in everyday use with no registration command.
  - `[low]` `[reject]` (blind 2) Unbounded positive intervals can create unrepresentable next instants and block later schedules — carried: same interval-bound claim as the previous blind review, with unchanged tick arithmetic and SQLite validation. Existing verdict retained: no user registration surface; adding input policy is more than a direct correction.
  - `[low]` `[reject]` (blind 3) Abort during a tick does not stop its later firings — verified that cancellation is checked after the bounded tick, before drain, and the tick has no signal parameter. Each firing is a short transaction, at most 100 per tick; cancellation inside a bounded operation is unlikely to matter in ordinary use and would add a new public parameter and branches. The prior drain-after-abort defect remains fixed.
  - `[low]` `[reject]` (blind 4) Negative due-query limits differ between memory and SQLite — verified `slice(0, limit)` versus SQLite LIMIT. The sole production caller is `tickSchedules` with the constant 100; there is no negative-limit path. Enforcing a new range would add guards for input no current caller supplies.
  - `[low]` `[patch]` (blind 5) Schedule firing lacks real SQLite writer-lock recovery coverage — existing schedule tests use triggers, while shared withWrite handles BEGIN IMMEDIATE contention. Added a deterministic held-lock test proving DB_LOCKED, unchanged state and successful retry through this adapter.
  - `[low]` `[patch]` (blind 6) SQLite partial-commit behavior lacks a two-reservation rollback test — Core mocks the second failure; SQLite rollback tests have one reservation. Added a targeted second-reservation failure and recovery test proving the first commit survives and each queues only once.
  - `[medium]` `[patch]` (blind 7) Recurrence after completed work is unverified — current tests stop before the next recurrence or reuse open work; they cannot detect suppression after completion. Added a second tick/drain at the next due instant with a distinct completed work row and updated schedule timestamps.
  - `[low]` `[patch]` (blind 8) Tick-limit test does not prove continuation — it changes listDueSchedules to fail directly after the first 100. Added the second successful tick and assert only the remaining reservation fires before exercising the read failure.
  - `[low]` `[patch]` (blind 9) Immediate schema-8 upgrade lacks direct preserved-data coverage — migrations from 7 do preserve data and traverse 8, but no case asserts from: 8 and only 0009 applied. Added that case and an idempotent rerun without changing migration behavior.
  - `[low]` `[reject]` (blind 10) Failure logs omit schedule identity and suppress distinct failures with the same code — verified tickProblem.key is tick.code and ScheduleTickResult omits identity. Current registration is internal and failures are reported by code as intended; adding result fields and diagnostic identity is more than a direct correction, with negligible current operational harm.
  - `[low]` `[reject]` (edge 1) Large intervals generate noncanonical years and block later schedules — carried: same unchanged interval-bound defect and prior low/reject verdict as blind 2; no repeated patch or deferral.
  - `[low]` `[patch]` (edge 2) Memory accepts finite timestamps outside four-digit years that SQLite rejects — verified memory checks only finite getTime while SQLite uses formatInstant. Replaced the existing timestamp predicates with the shared codec and added adapter-contract rejection/unchanged-state cases; no new public surface.
  - `[low]` `[reject]` (edge 3) Negative listDueSchedules limit yields different adapter results — same verified discrepancy and sole fixed-100 production caller as blind 4. Range guards would add complexity for currently unreachable input.
  - `[medium]` `[patch]` (verification-gap 1) SQLite target reconstruction is unverified for targetId distinct from schedule ID — pre-verified evidence: all SQLite/daemon fixtures use equal IDs, while the distinct-target Core case uses memory. Added a shared contract round trip asserting distinct identity and target values, run against memory and SQLite.
  - `[false]` `[reject]` (intent 1) Existing-work reuse differs from a new row for each reservation — carried: the open-work uniqueness contract requires reuse; the intent guarantees one firing, not duplicate open work. Same unchanged ensureWork path and prior verdict.
  - `[false]` `[reject]` (intent 2) Per-reservation rollback differs from tick-wide atomicity — carried: the intent binds a reservation's work and timestamps in one transaction, not the whole batch. Same withWrite boundary and prior verdict.
  - `[false]` `[reject]` (intent 3) Next-run time uses tick time instead of handler execution time — carried: the queue insertion transaction must set the next time before a handler runs, so firing time is the applicable execution instant. Same clock read and prior verdict.
  - `[false]` `[reject]` (intent 4) Already-overdue startup tests omit a literal stop/time-jump/restart lifecycle — carried: schedules live only in SQLite; the initial DB state is equivalent and both in-process and installed-process tests exercise startup. Same prior verdict.
  - `[false]` `[reject]` (intent 5) Trigger failure differs from whole-DB unavailability — carried: triggers exercise rollback after writes, while unavailable connections fail before writes; daemon already retries opening each round. Same rollback/recovery evidence and prior verdict.

## Design Notes

- 발화를 예약마다 한 트랜잭션으로, `next_run_at` CAS로 하는 이유: 한 예약의 실패가 다른 예약을 되돌리지 않고, 목록(읽기)과 발화(쓰기) 사이에 다른 틱이 같은 예약을 옮겼으면 아무것도 쓰지 않는다 — 데몬은 하나지만 다음 조각의 명령이 같은 verb를 부를 수 있다.
- 다음 시각을 Core가 정하는 이유: "발화 시점 + 간격, 놓친 회차는 하나로"는 제품 규칙이고, 어댑터가 둘(epic 7의 Postgres)이 되어도 한 곳에 있어야 한다. 저장소는 받은 값을 CAS 안에서 쓸 뿐이다.
- 틱을 drain 안이 아니라 데몬 회차에 두는 이유: 틱은 데몬의 일(E9-4)이고, 기회적 drain(명령 끝 2초)이 틱을 돌면 데몬이 꺼진 동안 예약이 명령마다 흩어져 발화한다. 같은 회차 drain 앞에 두어 넣은 일감이 바로 처리된다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project core --project sqlite --project cli` -- expected: 새 시험 포함 통과
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- expected: 전부 통과(`postgres`는 Docker가 없으면 global setup에서 멈추므로 제외하고 그 사실을 기록)
- `git diff --check` -- expected: 출력 없음

**Implementation verification (2026-10-27):**
- `pnpm build` — passed.
- `pnpm typecheck` — passed.
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` — 94 files, 2698 tests passed; no skipped tests, 75.42 seconds.
- Focused new Core/SQLite scheduling tests — 9 passed. Daemon integration/process suite — 33 passed, including failure recovery and schema-9 doctor evidence.
- `git diff --check` — passed.
- Postgres was excluded: `docker info` could not connect to the Docker daemon. No Postgres schema or adapter changes were made.

## Auto Run Result

Status: built. Follow-up thorough review completed; the orchestrator owns ticket completion. No `tickets.py mark` was run, no ticket was marked done, and no existing deferred-work ledger entry was modified, reopened or rewritten.

**Implemented behavior.** Migration 0009 adds schedules and raises the SQLite schema version to 9. Core computes due firings, coalesces missed intervals, ends one-shots, and enqueues work while advancing each reservation atomically through SQLite compare-and-set. The daemon ticks before drain, preserves retryable reservations on failure and reports tick errors separately. The side-effect-free `schedule_probe` verifies the complete path.

**Files changed in this follow-up.**
- `packages/core/src/testing/contracts/schedule-store.ts` — distinct persisted identity/target round trip and canonical timestamp rejection with unchanged-state assertions for both adapters.
- `packages/core/src/testing/fakes/store.ts` — use the shared instant codec for schedule timestamp validation, matching SQLite's four-digit-year contract.
- `packages/core/test/schedule-tick.test.ts` — prove a second recurrence after work completion and continuation beyond the 100-reservation batch.
- `packages/sqlite/test/schedule-store.test.ts` — real writer-lock recovery, per-reservation partial commits and rollback, and schema-8-to-9 preserved-data/idempotence evidence.
- This plan — complete 19-finding triage and updated verification/result; prior review rows preserved.

**Previously implemented files in the reviewed change.**
- `packages/sqlite/migrations/0009_schedules.sql` — table, constraints and due index.
- `packages/sqlite/src/migrate.ts` — schema version 9; `driver.ts` — schedule row type; `schedules.ts` — atomic schedule adapter; `store.ts` — adapter composition.
- `packages/core/src/domain/schedule.ts` — domain model; `domain/index.ts`, `ports/index.ts`, `index.ts` — exports; `ports/store.ts` — schedule capability; `brain.ts` — composition and public tick; `queue/schedule-tick.ts` — firing policy; `queue/schedule-probe-work.ts` — probe handler.
- `packages/core/src/testing/contracts/index.ts`, `testing/index.ts` — contract exports; `packages/core/test/contracts.test.ts` — memory contract registration.
- `apps/cli/src/daemon/run.ts` — tick before drain, independent tick logging and post-tick cancellation; `apps/cli/src/doctor/store.ts` — unavailable-store capability.
- `apps/cli/test/daemon-run.test.ts` — clock, rollback/recovery, cancellation and installed-process scheduling/doctor evidence; `dispatch.test.ts` — store test double; `setup.test.ts` — schema-version assertions.
- `packages/sqlite/test/schema.test.ts`, `schema-files.test.ts`, `schema-0004.test.ts`, `schema-0005.test.ts`, `schema-0006.test.ts`, `schema-0007.test.ts`, `schema-0008.test.ts`, `users.test.ts`, `chunk-locator.test.ts` — latest-schema/migration assertions.
- `README.md` — scheduling behavior and logs; `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` — schedules Table Contract row.

**Review.** Four fresh CLI reviewer sessions ran blind-hunter, edge-case-hunter, verification-gap and intent-alignment. All 19 findings are logged individually above. Seven patch entries were applied: high 0, medium 2, low 5. No findings were deferred. Twelve were rejected: malformed manually edited rows require a separate recovery policy; interval-bound findings retain the prior decision (two rows); cancellation inside a bounded tick needs new API/branches; negative-limit findings have no production caller (two rows); schedule-specific error identity needs result/log surface changes; five carried intent readings are refuted by open-work uniqueness, per-reservation atomicity, firing-time semantics, equivalent persisted startup state and trigger rollback evidence respectively. No existing ledger entries were touched.

**Follow-up review recommendation: false.** This is a follow-up pass and patched no high findings (two medium and five low). The medium changes add verification of existing behavior; the only behavior correction aligns memory timestamp rejection with the existing SQLite codec. No specific unverified high risk remains.

**Verification after patches (2026-10-27).**
- Implementation session `01a17ba3-9127-7b91-b136-abe4fc852208`: 24 selected scheduling tests passed.
- `pnpm build && pnpm typecheck` — passed.
- `pnpm vitest run --project core --project sqlite --project cli` — 82 files, 2,398 tests passed (68.82 seconds).
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` — 94 files, 2,713 tests passed (70.65 seconds).
- `git diff --check` — passed after removing an extra trailing blank line in this plan.
- PostgreSQL excluded: `docker info` could not connect to the Docker daemon. This change contains no PostgreSQL adapter or schema modifications.

**Residual risks.** A corrupt SQL row or unrepresentable repeat interval can prevent later schedules from firing; these existing reviewed limitations retain their prior disposition. There is no user registration command in this ticket. Scheduling resolution follows daemon rounds, and cancellation waits for a bounded tick to finish. Completion remains for the orchestrator's independent verification.
