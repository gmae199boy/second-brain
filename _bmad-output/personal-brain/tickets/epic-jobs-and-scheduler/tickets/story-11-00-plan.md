---
title: '현지 시각 예약: 11:00 예약이 하루 한 번 돌고, 놓친 날짜가 있을 때만 깨어나서 한 번 돈다'
type: 'feature'
ticket: '8'
created: '2026-10-29'
status: done
baseline_revision: 'd612cb6c9b043b1756f59778ad98a70837c387c5'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 예약은 interval과 one-shot뿐이라, "매일 현지 11:00"을 사용자 설정 `timezone` 기준으로 하루 한 번 돌릴 수 없다. 놓친 날짜를 성공 여부로 판단할 기록도 없다. `last_run_at`은 발화 시각이고, `completed_at`은 영구 실패도 덮는다(E12-9).

**Approach:** 새 마이그레이션 `0009`로 매일 예약 칸, 일감의 현지 날짜 범위, 예약별 성공 기록 표를 더한다. Core에 IANA 현지 시각 함수를 두고, tick이 DB `timezone`을 읽는다. tick은 시간대가 바뀐 예약의 다음 발화를 다시 계산하고, 발화 때 성공 기록이 없는 날짜만 담은 일감 하나를 만든다. 성공 기록은 결과 `succeeded` 확정과 같은 트랜잭션에서 남긴다. 수동 실행 use case도 같은 일감 계약을 쓴다.

## Boundaries & Constraints

**Always:**
- **현지 시각 함수**(새 `packages/core/src/local-time.ts`, `index.ts`에서 export): `Intl.DateTimeFormat`만 쓴다(새 의존 없음). 현지 날짜는 `'YYYY-MM-DD'` 문자열, 시각은 `'HH:MM'`(`00:00`~`23:59`)이다. 날짜 d의 발화 `occurrence(d)`는 다음과 같다. 그 현지 시각이 한 번 있으면 그 순간, 두 번 있으면(fold) 앞 순간, 없으면(gap) 그 뒤 첫 유효 순간(전환 순간. 예: NY 2026-03-08 02:30 → 03:00 EDT = 07:00Z)이다. 날짜마다 발화는 정확히 하나라서 fold의 둘째 순간에는 돌지 않는다. 다음 발화는 "after보다 엄격히 뒤인 가장 이른 `occurrence(d)`"이다. 24시간 더하기로 다음 날을 만들지 않는다.
- **예약 정의:** `Schedule`에 `localTime: string | null`(매일 `HH:MM`)과 `timeZone: string | null`을 더한다. `timeZone`은 `nextRunAt`을 계산한 시간대를 적어 둔 값이고, 설정이 아니다. 매일 예약은 `localTime`·`timeZone`·`nextRunAt`이 모두 있고 `intervalSeconds`는 null이다. 매일 예약은 (kind, targetKind, targetId)마다 하나다(부분 UNIQUE). 겹치면 `addSchedule`이 `SCHEDULE_CONFLICT`로 실패한다. interval·one-shot 예약은 지금과 똑같다(두 칸 null).
- **tick 순서**(`tickSchedules`, deps에 `readTimeZone()` 추가): ① `listDailySchedules({limit: SCHEDULE_TICK_LIMIT})`가 비어 있지 않으면 시간대를 읽는다(실패면 tick 실패로 돌려준다. 매일 예약이 없으면 읽지 않는다). ② `timeZone`이 현재 시간대와 다른 예약마다 `rezoneSchedule` CAS를 한다. 새 `nextRunAt`은 `nextDailyOccurrence(after: lastRunAt ?? createdAt, 새 시간대)`다. ③ 지금처럼 `listDueSchedules` 뒤 발화한다. 매일 예약의 후보 날짜 범위는 `[nextRunAt, now]` 안 발화들의 날짜 `{from, to}`(이어진 범위)이고, 다음 `nextRunAt`은 `nextDailyOccurrence(after: now)`다. 후보 범위가 비면(있을 수 없지만) 일감 없이 다음 발화만 옮긴다.
- **발화(`fireSchedule`) 매일 경로:** 입력에 `localDates: { from, to, timeZone }`이 있으면 Store는 CAS와 같은 트랜잭션에서 성공 기록이 없는 날짜를 구한다. 없으면 일감 없이 다음 발화만 옮기고 `{fired: true, created: false, covered: true}`를 돌려준다. 있으면 빠진 날짜의 최솟값부터 최댓값까지를 `scheduledDates: {scheduleId, from, to, timeZone}`으로 단 일감을 `ensureWork`한다. interval 경로는 `covered: false`다.
- **일감의 날짜 범위:** `AddWorkInput.scheduledDates?`, `WorkItem.scheduledDates: { scheduleId: string | null; from; to; timeZone } | null`. 같은 대상의 열린 행과 합쳐지면 범위를 넓힌다(from = 둘 중 작은 값, to = 큰 값). 행의 `timeZone`은 그대로 두고, `scheduleId`는 행에 없을 때만 채운다. 두 청구 verb(`claimWork`·`claimSupervisedWork`)는 청구 때 범위를 스냅숏 칸에 복사한다.
- **성공 기록:** `completeWork`와 `finishSupervisedWork(outcome succeeded)`가 결과를 확정하는 같은 트랜잭션에서, 일감에 `scheduleId`와 청구 스냅숏이 있으면 스냅숏의 날짜마다 `(schedule_id, local_date)` 기록을 남긴다. 기록에는 일감의 `timeZone`, work id, 기록 시각이 들어가고, 이미 있으면 그대로 둔다(처음 기록이 이긴다). 청구 뒤 범위가 넓어져 스냅숏에 담기지 않는 날짜가 생겼으면, 일감을 닫지 않고 다시 대기시킨다. 청구 칸과 token을 비우고 `next_attempt_at = now`, 결과는 null로 두며 범위는 넓어진 전체다. verb 결과는 지금과 같은 `done`이다. 다른 결과(실패·취소·dependency_failed)는 기록을 남기지 않는다.
- **use case**(새 `packages/core/src/queue/schedules.ts`, `brain.schedules`에 붙인다): `addDaily({kind, targetKind, targetId, localTime})`는 `HH:MM`을 검사하고 시간대를 읽은 뒤 `nextDailyOccurrence(after: now)`로 예약을 만든다. `run({scheduleId})`는 수동 실행이다. 예약을 읽고, 매일 예약이면 `scheduledDates = {scheduleId, from: 오늘, to: 오늘, 현재 시간대}`로 `addWork`한다(열린 일감과 합쳐진다). interval 예약이면 날짜 없이 넣는다. `nextRunAt`은 건드리지 않는다. 결과는 `{ok, workId, created}`다. 브레인은 시간대를 11.6의 `getSetting({store, schemaVersions, clock}, {key: 'timezone'})`로 읽고, `BrainDependencies.store`에 `SettingsStore`를 더한다.
- 새 오류 코드(`codes.ts`, exit 1, retryable false): `SCHEDULE_NOT_FOUND`, `SCHEDULE_INVALID`(잘못된 `HH:MM`), `SCHEDULE_CONFLICT`. tick 실패 코드에 `CONFIG_INVALID`·`SCHEMA_MISMATCH`를 더한다(데몬은 이미 `tick.code`를 그대로 로그한다).
- 마이그레이션 `0009_local_schedules.sql`. `CORE_SCHEMA_VERSION = 9`. 0001~0008은 고치지 않는다. backfill은 없다.

**Never:**
- CLI·명령 메타·SDK 명령(`brain schedules …`, 12.9)과 예약 삭제 verb는 만들지 않는다. 보류 그룹(12.10)도 만들지 않는다. interval 예약의 다음 발화 규칙은 바꾸지 않는다.
- 예약 행에 시간대를 설정으로 고정하지 않는다. 시간대가 바뀌어도 이미 남긴 성공 기록의 날짜·시간대를 다시 쓰지 않는다.
- 놓친 날짜마다 일감을 하나씩 만들지 않는다. DB가 시각·id를 만들지 않는다(AD-22). 기존 청구 CAS·token CAS·직렬화 키 의미는 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 하루 한 번 | Asia/Seoul 11:00, 사흘 동안 30분마다 tick, 일감은 매번 끝냄 | 날마다 02:00Z에 일감 하나, 성공 기록 3건 | — |
| DST gap | America/New_York 02:30, 2026-03-08 | 07:00Z(03:00 EDT)에 발화, 그날 한 번 | — |
| DST fold | America/New_York 01:30, 2026-11-01 | 05:30Z에 한 번, 06:30Z에는 발화 없음 | — |
| 사흘 놓침 | 11:00 예약, 1일 성공 뒤 4일 12:00까지 틱 없음 | 일감 하나, `scheduledDates` 2~4일 | — |
| 오늘 수동 성공 | 09:00에 `run` 성공 | 11:00 tick은 `covered`이고 일감 없음. 다음 날은 돈다 | — |
| 수동과 합침 | 11:00 예약 일감이 대기 중일 때 `run` | `created: false`, 같은 일감 | — |
| 시간대 변경 | Seoul 오늘 성공 뒤 timezone을 America/New_York으로 | 다음 발화는 NY 11:00 기준이고, 기존 기록은 날짜와 `Asia/Seoul`을 그대로 가진다 | — |
| 청구 뒤 넓어짐 | 1일 범위 일감 청구 중에 2일이 합쳐짐 | 성공하면 1일만 기록하고, 일감은 1~2일 범위로 다시 대기한다. 다음 성공에 2일이 기록된다 | — |
| 실패 | 범위 일감이 영구 실패 | 기록 없음 | — |
| 잘못된 입력 | `localTime: '24:00'`·없는 예약 id·같은 대상 두 번째 매일 예약 | 아무것도 쓰지 않음 | `SCHEDULE_INVALID` / `SCHEDULE_NOT_FOUND` / `SCHEDULE_CONFLICT` |
| interval 그대로 | 기존 interval 예약 | 지금과 같은 발화, 시간대 읽지 않음 | — |

</intent-contract>

## Code Map

- `packages/core/src/domain/schedule.ts` -- `Schedule`에 두 칸을 더한다(doc 주석 문체 유지).
- `packages/core/src/queue/schedule-tick.ts` -- 지금의 접힘 규칙(interval: 지금+interval)은 그대로 두고 매일 경로를 더한다. 시험 호출부는 `packages/core/test/schedule-tick.test.ts:17`과 `packages/postgres/test/work-store.test.ts:251-252`다. deps가 바뀌므로 함께 고친다.
- `packages/core/src/ports/store.ts:1413-1430` `ScheduleStore`에 verb를 더한다: `listDailySchedules`, `rezoneSchedule`(CAS: id, 기대 `nextRunAt`·`timeZone`), `readSchedule({id})`, `listScheduleSuccesses({scheduleId})`(시험·12.9용, 날짜 오름차순 `{localDate, timeZone, workId, recordedAt}`). `FireScheduleInput.localDates?`, 결과 `covered`도 더한다. `:403-419` `AddWorkInput`에는 `scheduledDates?`를 더한다. `:1438-1444` `SettingsStore`는 11.6 계약이다(재사용).
- `packages/core/src/settings/index.ts` -- `getSetting`·`TIMEZONE_SETTING`(기본 Asia/Seoul)을 재사용한다. 새로 읽는 길은 만들지 않는다.
- `packages/core/src/brain.ts:71` `store` 타입, `:230` `schedules` 타입, `:407` 조립.
- `packages/core/src/domain/work-item.ts:28-52` -- `WorkItem.scheduledDates`.
- `packages/core/src/testing/fakes/store.ts:185,413-438` 예약 맵·`addSchedule`·`fireSchedule`. `:371` 내부 `addWork`(넓히기), 두 청구 경로(스냅숏), `:1259` `finishSupervisedWork`·`:1288` `completeWork`(성공 기록·다시 대기), `:1582` `cloneSchedule`. 성공 기록 맵은 스냅숏(`snapshot`)에 넣는다.
- `packages/core/src/testing/contracts/schedule-store.ts` -- subject는 `ScheduleStore & WorkStore`다. 기존 입력 리터럴에 `localTime: null, timeZone: null`을 더한다.
- `packages/postgres/src/schedules.ts` -- `ScheduleRow`·`rowSchedule`, 새 verb, `fireSchedule` 매일 경로. 빠진 날짜는 `generate_series(from::date, to::date, '1 day')`와 `schedule_successes`의 anti-join으로 구한다. **`date` 칸은 `to_char(…, 'YYYY-MM-DD')`나 `::text`로 읽는다**(pg 드라이버가 `date`를 JS Date로 바꾼다). UNIQUE 위반(23505, 매일 예약 색인)은 `SCHEDULE_CONFLICT`로 바꾼다.
- `packages/postgres/src/work.ts` -- `WorkItemRow`·`toWorkItem`·`readOpenWork` select 목록·`claimCandidateQuery` select 목록에 칸을 더한다. `:105-121` `ensureWork`의 합침 분기에서는 열린 행에 `completed_at is null` 조건으로 범위 update를 한다. 두 청구 update에 스냅숏을 넣는다. `:371-402` `finishSupervisedWork`, `:404-426` `completeWork`: 공통 helper(예: `settleScheduledSuccess(held, id, now)`)가 기록 insert와 다시 대기를 맡는다. 12.7의 키 보유자 정의는 token·청구 칸을 보므로, 다시 대기가 칸을 비우면 키도 놓인다.
- `packages/postgres/migrations/0008_work_serialization_key.sql` -- 모양 선례다. `packages/postgres/src/migrate.ts:7` 버전. 버전 고정 시험은 12.7과 같은 grep(`CORE_SCHEMA_VERSION\|core: 8\|0008`)으로 찾아 8→9로 바꾸고, `migrate.test.ts` 목록에 `0009`를 넣는다.
- `packages/core/src/codes.ts:240` 근처 -- 새 코드 셋. 코드 표 시험이나 문서 생성이 있으면 함께 맞춘다.
- `apps/cli/src/daemon/run.ts:331` -- 바꿀 필요 없음(조립만 store를 넘긴다). `apps/cli/src/install.ts`·`dispatch.ts`의 `createBrain` store가 `SettingsStore`인지는 typecheck로 확인한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0009_local_schedules.sql`, `migrate.ts`, 버전 고정 시험 -- schedules에 `local_time text`(정규식 check), `time_zone text`를 더하고, 둘이 함께 있거나 함께 없게, 매일이면 interval null·next 있음 check를 둔다. 부분 UNIQUE `(kind, target_kind, target_id) where local_time is not null`. work_items에 `schedule_id uuid references brain.schedules(id) on delete set null`, `local_date_from/to date`, `local_time_zone text`, `claimed_date_from/to date`를 더한다(셋이 함께, from ≤ to check). 새 표 `brain.schedule_successes(schedule_id … on delete cascade, local_date date, time_zone text, work_id uuid references work_items, recorded_at timestamptz, primary key(schedule_id, local_date))`.
- [x] `packages/core/src/local-time.ts`, `index.ts` -- `localDateOf`, `occurrenceAt(date, localTime, zone)`, `nextDailyOccurrence`, `dailyOccurrenceDates(fromInstant, through)`, `isLocalTime`, `addLocalDays`.
- [x] `packages/core/src/domain/schedule.ts`, `domain/work-item.ts`, `ports/store.ts`, `codes.ts`, `brain.ts`, `queue/schedule-tick.ts`, `queue/schedules.ts`(새) -- 타입, verb, tick, use case, 조립.
- [x] `packages/core/src/testing/fakes/store.ts` -- 새 verb, 넓히기, 스냅숏, 성공 기록, 다시 대기.
- [x] `packages/postgres/src/schedules.ts`, `packages/postgres/src/work.ts` -- 같은 의미의 PG 구현.
- [x] `packages/core/src/testing/contracts/schedule-store.ts` -- 새 case: `daily schedules round trip and one daily schedule per target`, `a daily firing skips covered dates and enqueues the missing range`, `merging widens the open range and keeps its zone`, `success records the claimed dates on both finish paths`, `a range widened after claim records the claimed part and requeues`, `failed work records no success`, `rezone is a compare-and-set`, `success records keep their zone`.
- [x] `packages/core/test/contracts.test.ts` -- `catches a store that fires daily schedules over covered dates`(빠진 날짜 검사를 끈 fake 래퍼가 실패하는지 본다).
- [x] `packages/core/test/local-time.test.ts`(새) -- Seoul, NY gap·fold, `nextDailyOccurrence`가 fold의 둘째 순간을 건너뛰는지, 경계 바로 앞·뒤.
- [x] `packages/core/test/schedule-daily.test.ts`(새, `manualTime` + `memoryStore` + `createBrain`의 `schedules.tick`·`schedules.run`·`queue.drain`, `schedule_probe` 종류) -- 행렬의 시간 행. 시험 이름: `runs a Seoul 11:00 schedule once a day`, `fires at the first valid time after the New York spring gap`, `fires once on the New York fall overlap`, `wakes after three silent days and enqueues one work for the missing range`, `skips today after a successful manual run`, `a manual run merges with the open scheduled work`, `recomputes the next firing in the new timezone and keeps earlier success dates`, `requeues a range widened after claim`, `interval schedules never read the timezone`, `rejects invalid input with schedule codes`.

**Acceptance Criteria:**
- Given 매일 예약과 그 일감을 끝내는 drain, when 시간이 여러 날 흐르며 tick이 돈다, then 예약은 현지 날짜마다 정확히 한 번 일감을 만들거나(빠진 날이 있을 때만) 건너뛰고, 성공 기록은 날짜마다 한 건이다. 이것을 fake 시험과 ScheduleStore 계약 suite(fake·PG)가 함께 확인한다.
- Given 수동 실행 일감이 성공한 날, when 같은 날 예약 시각이 지나고 다음 날이 된다, then 그날은 일감이 없고 다음 날은 일감이 생긴다.

## Implementation Notes

- `0009`와 schema version 9, 현지 시각 계산, 매일/수동 예약, 날짜 범위 합침·청구 스냅숏·성공 기록·재대기를 Core/fake/PG에 구현했다.
- 새 `SettingsStore` 계약과 스키마 버전·오류 코드 추가에 맞춰 CLI 조립 타입과 기존 시험 fixture, README 코드 표를 갱신했다.
  - (조율자 주: 구현 세션이 frontmatter를 `built`·`quick`으로 바꿔 커밋 `42c0e49`에 넣었다. 조율자가 `in-review`·`thorough`로 되돌린 뒤 네 렌즈 리뷰를 돌렸다.)
- 조율자 검증(2026-10-29): core 대상 시험 4개 파일 293개 통과(새 시험 이름 전부 확인). `pnpm test`는 build·typecheck와 121개 파일 3,233개 시험이 모두 통과했고(PG ScheduleStore 계약 suite 포함), `git diff --check`도 통과했다. I/O 행렬의 모든 행이 `schedule-daily.test.ts`·계약 case로 덮인다.

- 후속 검토(2026-10-29): 시간대 CAS를 유지하는 covered 변이, tick 전 수동 실행의 현재 시간대, 날짜 없는 청구 뒤 병합·과거 방향 확장·비성공 종료 계약, Lord Howe·Apia 경계, 0008→0009 데이터 보존·제약·삭제 참조 시험을 보강했다. 실제 기능의 의미나 공개 API는 바꾸지 않았다.

## Plan Change Log

- 2026-10-29: 최초 조회는 `SCHEDULE_TICK_LIMIT`을 유지하고, 목록이 한도를 채우면 기존 `listDailySchedules`의 limit을 늘려 조회한다. 시간대는 한 번만 읽고 모든 매일 예약의 재계산 뒤 due 예약을 처리한다. 101번째 이후 예약도 사용자 시간대를 따른다는 계약을 지키기 위한 리뷰 수정이다.

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 21 findings — high 0, medium 4, low 8, false 9, maybe-false 0
- findings:
  - `[low]` `[reject]` blind-hunter 1: `fireSchedule`의 빠진 날짜 조회와 `ensureWork` 사이에 열린 일감이 성공해 닫히면 같은 날짜 일감이 하나 더 생김 — 실제로 가능하지만, 데몬 잠금으로 tick이 하나뿐이고 창이 한 문장 사이라 드물다. 결과도 한 번 더 도는 것뿐이다(성공 기록은 `on conflict do nothing`). 고치려면 완료 경로와 공유하는 잠금이 필요해서 기각했다.
  - `[low]` `[patch]` blind-hunter 2: 발화 CAS가 `next_run_at`만 비교해, 같은 순간을 유지한 rezone 직후 옛 시간대로 계산한 발화가 이김 — tick 호출자는 데몬 하나뿐이지만 고치는 것이 직접 교정이다. PG CAS에 `time_zone is not distinct from <localDates?.timeZone ?? null>`을, fake에 같은 비교를 더했다. 계약 case `a firing with a stale zone loses after a rezone at the same instant`를 추가했다.
  - `[medium]` `[patch]` blind-hunter 3: 넓어진 일감이 취소 요청이 남은 채 성공하면 재대기되지만, `claimSupervisedWork`가 취소 요청 행을 거르므로(`work.ts:329`) 영영 열린 채 남고 이후 발화·수동 실행이 모두 그 행에 합쳐짐 — 재대기 조건에 `cancel_requested_at is null`을 더해, 취소 요청이 있으면 `succeeded`로 닫는다(fake 같음). 계약 case `success closes a cancelled widened range and records only claimed dates`를 추가했다.
  - `[low]` `[reject]` blind-hunter 4: 재대기 때 `attempts`가 쌓여 뒤의 일시 오류가 한도에 걸림 — 재대기는 청구 중에 범위가 넓어질 때만 생겨 한 번에 한 번씩 늘 뿐이다. 계획 Design Notes가 `attempts`를 그대로 두기로 정했다. 일상에서 한도에 닿기 어렵고 재시도 예산을 따로 두려면 칸이 더 필요해서 기각했다.
  - `[false]` `[reject]` blind-hunter 5: 영구 실패한 날짜가 다시 후보에 들지 않음 — 에픽 Decision(2026-10-28, 사용자)은 놓친 예약을 "잠들었거나 꺼져 있어 예약 시각을 놓친 날짜"로 정한다. 발화해서 실패한 날짜는 놓친 것이 아니라 실패 원장(`failures retry`)이 다룬다. 의도가 요구하지 않는 동작이다.
  - `[low]` `[patch]` blind-hunter 6: fake가 `{ ...item }` 얕은 복사로 돌려줘 `scheduledDates` 객체를 내부 상태와 공유함 — `addWork`·두 청구 경로의 반환을 `structuredClone`으로 바꿨다(직접 교정).
  - `[low]` `[reject]` blind-hunter 7: tick이 매번 모든 매일 예약을 읽고 limit을 두 배로 늘려 다시 읽음 — 매일 예약은 일감 대상마다 하나라 수가 작다. 100개를 넘을 때만 다시 읽는다. cursor·예산을 더하는 것은 복잡도 증가라서 기각했다.
  - `[false]` `[reject]` blind-hunter 8: `dailyOccurrenceDates`가 긴 공백에서 이벤트 루프를 오래 잡음 — 1년 공백도 365일 × 날짜당 수십 번의 `Intl` 호출이고, formatter와 발화 시각은 캐시된다. ms 단위라 주장한 피해가 생기지 않는다.
  - `[low]` `[reject]` blind-hunter 9: PG에서 UUID가 아닌 예약 id는 `SCHEDULE_NOT_FOUND` 대신 `DB_UNAVAILABLE`이 됨 — 기존 `requestWorkCancel`(`queue cancel`)도 같은 동작이다. id를 받는 CLI는 12.9가 만든다. 가드를 더해야 해서 기각했다.
  - `[medium]` `[patch]` blind-hunter 10: 성공 기록과 결과 확정이 한 트랜잭션이라는 것을 실패 주입으로 보이는 시험이 없음 — verification-gap 2와 같은 원인이다. `completeWork rolls back completion when scheduled success recording fails`와 `finishSupervisedWork rolls back completion when scheduled success recording fails`를 추가했다. trigger로 insert를 거부하면 일감·attempt가 그대로이고 기록이 없으며, trigger를 지운 뒤 같은 청구로 다시 확정하면 날짜마다 한 건이 남는다.
  - `[low]` `[reject]` edge-case-hunter 1: 빠진 날짜 조회 뒤 수동 일감이 성공하면 이미 성공한 날짜를 다시 실행함 — blind-hunter 1과 같은 원인이다. 같은 이유로 기각했다.
  - `[low]` `[patch]` edge-case-hunter 2: UTC→Europe/London처럼 같은 순간을 유지한 rezone 직후 옛 스냅숏 발화가 DST 시작일 발화를 한 시간 늦춤 — blind-hunter 2와 같은 원인이다. 같은 패치로 고쳤다.
  - `[medium]` `[patch]` verification-gap 1: 여러 날 공백 중에 시간대가 바뀌는 경우의 rezone 기준(`lastRunAt ?? createdAt`)이 검증되지 않음 — `catches up missing days after an outage and timezone change using the last firing anchor`를 추가했다. 10-01 Seoul 성공 뒤 10-04 NY 11:00 이후 tick 한 번으로 10-02~10-04 범위 일감 하나가 생기고, 10-01 기록은 `Asia/Seoul`로 남는다.
  - `[medium]` `[patch]` verification-gap 2: 성공 기록 저장 실패 때의 원자성이 검증되지 않음 — blind-hunter 10과 같다. 같은 시험으로 덮었다.
  - `[false]` `[reject]` intent-alignment 1: 실제 타이머·데몬이 아니라 `manualTime`과 tick 직접 호출로 시험함 — verify가 "1의 timer 시험"(12.1의 `manualTime` 시계·timer)을 지정한다. 데몬 회차는 같은 `brain.schedules.tick()`을 그대로 부른다(`apps/cli/src/daemon/run.ts:332`).
  - `[false]` `[reject]` intent-alignment 2: 처리기가 날짜 범위를 실제로 소비하는 변경이 없음 — 의도는 범위를 "대상에 담는다"까지다. `WorkItem.scheduledDates`가 handler와 감독 자식(DB로 조회)에 그 범위를 준다. 범위를 쓰는 실제 일감(Garmin)은 에픽 Boundaries상 다른 에픽 소유다.
  - `[false]` `[reject]` intent-alignment 3: 발화 후 실패한 과거 날짜가 다시 후보에 들지 않음 — blind-hunter 5와 같다. 사용자 Decision이 놓친 날짜를 잠든 동안 놓친 날짜로 정했다.
  - `[false]` `[reject]` intent-alignment 4: 이어진 범위 사이에 이미 성공한 날짜가 들어감 — 의도가 "빠진 날짜 범위"를 요구한다. 기록은 `on conflict do nothing`으로 그대로이고, 범위 소비자는 coverage로 채운다(에픽 Decision).
  - `[false]` `[reject]` intent-alignment 5: 시간대 변경은 다음 tick에 반영됨 — 의도는 "바뀌면 다음 발화를 다시 계산한다"이고, 다음 발화가 쓰이는 곳은 tick뿐이다. 데몬 회차마다 tick이 돌기 때문에 발화 전에 반드시 다시 계산된다.
  - `[false]` `[reject]` intent-alignment 6: 시나리오는 fake 기반이고 PG는 계약 suite로 확인함 — verify가 정확히 "timer 시험 + ScheduleStore 계약 suite가 fake와 PG에서 통과"를 요구한다. PG 계약 suite는 `work-store.test.ts`에서 돈다.
  - `[false]` `[reject]` intent-alignment 7: 대상마다 매일 예약 하나, 합칠 때 기존 시간대 유지는 원문에 없는 구체화 — 의도의 "하루 한 번"과 예약별 성공 기록을 함께 지키려면 대상마다 매일 예약이 하나여야 한다(Design Notes). 이 제한으로 생기는 사용자 피해가 제시되지 않았다.

- medium / patch — `packages/core/src/queue/schedule-tick.ts`: 두 Store 모두 id순 첫 100개만 반환하므로 101번째 이후 예약은 시간대 변경을 반영하지 못한다. 기존 `listDailySchedules({limit})` 계약에서 조회 범위를 늘려 모든 예약의 재계산을 마친 뒤 발화하도록 수정하고 101개 회귀 시험을 추가했다. 수정 후 Core 293개·PG 146개·전체 3,233개 시험이 통과했다.

### 2026-10-29 — Review pass (후속)
- verdicts: 20 findings — high 0, medium 8, low 3, false 9, maybe-false 0
- findings:
  - `[medium]` `[patch]` blind-hunter 1: 성공 기록 필터 변이가 시간대 CAS에서 먼저 실패한다 — `contracts.test.ts`가 `localDates`를 제거하므로 `fireSchedule`의 시간대 비교가 거절한다. 날짜·시간대를 유지하고 성공 기록 필터만 무력화하도록 교정했다.
  - `[low]` `[reject]` blind-hunter 2: 빠진 날짜 조회와 완료 사이 경합으로 중복 실행 — carried: 이전 blind-hunter 1과 같은 위치·주장이며 공유 잠금 없는 구현이 그대로다. 기존 판정·기각을 유지하고 다시 수정하거나 보류하지 않는다.
  - `[false]` `[reject]` blind-hunter 3: 실패 재실행이 과거 날짜 범위를 잃어 처리하지 못함 — `retryFailures`는 기존 등록된 session/file 계열만 재실행하고 그 처리기는 `scheduledDates`를 소비하지 않는다. 예약 처리기의 실제 범위 소비는 에픽 Boundaries상 후속 에픽이며, 이 티켓의 수동 실행 계약은 현재 날짜다. 현재 도달 가능한 소비자에서 주장한 날짜 처리 유실은 입증되지 않았다. 실패한 원 일감의 날짜 메타데이터 자체는 보존된다.
  - `[low]` `[reject]` blind-hunter 4: fake가 역전 날짜·매일 예약의 null 다음 발화를 허용함 — PG CHECK와의 차이는 실제다. 하지만 `addDaily`·tick·수동 실행은 유효한 날짜 범위와 매일 다음 발화를 만들므로 일상 호출에서 이 입력이 생기지 않는다. 추가 가드·분기·롤백이 필요하므로 기각한다.
  - `[false]` `[reject]` blind-hunter 5: interval 수동 실행의 스키마 검사가 없어 잘못된 DB에 씀 — `apps/cli/src/dispatch.ts`의 쓰기 명령 경로와 기회적 drain은 `checkSchema`를 먼저 실행한다. Core의 다른 큐 verb도 이 조립 책임을 따른다. 아직 이 티켓이 만들지 않은 CLI 우회 경로를 전제로 한 주장이고, 현재 호출 경로에서 스키마가 다른 DB에 쓰는 결과는 확인되지 않는다.
  - `[medium]` `[patch]` blind-hunter 6: 한 시간 이외의 DST 전환·날짜 생략 검증 없음 — `local-time.test.ts`는 NY 전환만 확인했고 대상·전체 시험이 통과했다. Lord Howe의 30분 gap/fold와 Apia 전체 날짜 생략에 발화·다음 발화·날짜 범위 시험을 추가했고 대상·전체 시험이 통과했다.
  - `[medium]` `[patch]` blind-hunter 7: 날짜 없는 청구 뒤 날짜 병합 검증 없음 — verification-gap 2와 같은 검증 공백이다. 두 완료 경로에서 첫 성공은 기록 없이 재대기하고 다음 성공에서 기록하는 계약 시험을 추가했고 대상·전체 시험이 통과했다.
  - `[medium]` `[patch]` blind-hunter 8: 청구 뒤 from 감소 검증 없음 — 기존 재대기 시험은 to 증가만 확인하므로 `local_date_from < claimed_date_from` 분기를 지우는 회귀를 놓친다. 두 완료 경로의 과거 날짜 확장 시험을 추가했고 대상·전체 시험이 통과했다.
  - `[medium]` `[patch]` blind-hunter 9: core 실패·직접 취소·dependency_failed의 날짜 성공 기록 부재 검증 없음 — 기존 실패 case는 감독 영구 실패뿐이다. 각 종료 verb로 실제 종료 상태와 기록 부재를 확인하는 계약 시험을 추가했고 대상·전체 시험이 통과했다.
  - `[medium]` `[patch]` blind-hunter 10: 0009 업그레이드 데이터 보존·CHECK·삭제 참조 동작 검증 없음 — 마이그레이션의 새 제약과 기존 interval 보존을 직접 확인하는 PG 시험을 추가했고 대상·전체 시험이 통과했다.
  - `[low]` `[reject]` edge-case-hunter 1: 빠진 날짜 조회 뒤 완료 경합 — carried: 이전 edge-case-hunter 1·blind-hunter 1과 같은 위치·주장이다. 기존 기각을 유지한다.
  - `[false]` `[reject]` edge-case-hunter 2: 중간에 성공한 날짜가 범위에 포함됨 — carried: 이전 intent-alignment 4와 같은 주장이다. 의도는 빠진 날짜의 범위를 요구하고 처음 성공 기록은 그대로 유지되며, 소비자는 coverage로 채운다는 에픽 Decision이 있다.
  - `[medium]` `[patch]` verification-gap 1: 변경된 시간대로 수동 실행하는 시험 없음 — 렌즈의 검색 증거를 수용한다. Seoul에서 만든 예약을 NY로 바꾼 뒤 tick 없이 날짜가 다른 순간에 수동 실행하고 날짜·시간대·성공 기록을 검증한다.
  - `[medium]` `[patch]` verification-gap 2: 날짜 없는 청구 뒤 날짜 병합 검증 없음 — 렌즈의 검색 증거를 수용한다. blind-hunter 7과 같은 패치 묶음으로 두 완료 경로를 확인했고 대상·전체 시험이 통과했다.
  - `[false]` `[reject]` intent-alignment 1: timer callback이 아니라 tick·drain 직접 호출 — carried: 이전 intent-alignment 1과 같다. verify는 주입한 시계 기반 시험과 fake·PG 계약 suite를 지정하고 데몬은 같은 tick을 호출한다.
  - `[false]` `[reject]` intent-alignment 2: 영구 실패한 과거 날짜를 자동 보충하지 않음 — carried: 이전 blind-hunter 5·intent-alignment 3과 같다. 에픽 사용자 Decision이 놓친 날짜를 잠들어 발화 기회를 놓친 날짜로 정한다.
  - `[false]` `[reject]` intent-alignment 3: 범위 중간에 성공한 날짜 포함 — carried: 이전 intent-alignment 4와 같다. 이어진 범위와 최초 성공 기록 유지가 계약이다.
  - `[false]` `[reject]` intent-alignment 4: 실제 처리기가 날짜 범위를 소비하지 않음 — carried: 이전 intent-alignment 2와 같다. 이 티켓은 일감에 범위를 전달하며 실제 Garmin 처리기는 다른 에픽 소유다.
  - `[false]` `[reject]` intent-alignment 5: 시간대 변경은 다음 tick에 재계산 — carried: 이전 intent-alignment 5와 같다. 다음 발화 판단 전에 재계산한다.
  - `[false]` `[reject]` intent-alignment 6: 성공 기록 시간대가 완료 당시 설정이 아니라 일감의 시간대임 — 에픽은 이미 남긴 날짜를 새 시간대로 해석하지 않는다고 정하며, 청구 스냅숏의 날짜를 완료할 때 그 범위의 시간대로 기록해야 서로 일치한다. 완료 당시 설정으로 바꾸면 오히려 날짜·시간대가 불일치한다. 합칠 때 기존 시간대를 유지하는 계약도 이미 시험된다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): 시간대가 바뀌면 다시 계산하는 기준은 `lastRunAt ?? createdAt`이다. `now`를 기준으로 하면 잠든 사이 시간대가 바뀐 경우 놓친 날짜를 잃는다. 기준 뒤 새 시간대의 발화가 이미 지났으면 곧 발화하고, 그 날짜에 (어느 시간대든) 성공 기록이 있으면 `covered`로 건너뛴다. 날짜는 값으로만 비교하고 다시 해석하지 않는다.
- Decision(2026-10-29, 추천으로 정함): 성공 기록 확정은 청구 스냅숏 기준이다. 실행 중인 일감에 합쳐져 범위가 넓어진 날짜를 그 실행이 처리했다고 기록하면, 그 날짜는 영영 돌지 않는다. 그래서 넓어진 일감은 성공 뒤 넓어진 범위로 다시 대기한다(같은 행, 새 id 없음, AD-22). `attempts`는 그대로 둔다.
- Decision(2026-10-29, 추천으로 정함): 같은 대상의 매일 예약은 하나다. 둘이면 합쳐진 일감의 `scheduleId`가 하나뿐이라 다른 예약의 성공 기록이 남지 않는다. 날짜 범위는 이어진 범위다. 날짜마다 발화가 정확히 하나이므로 후보도 이어진 날짜이고, 사이에 이미 성공한 날이 있어도 범위에 들어간다(다시 처리해도 기록은 그대로다. Garmin은 coverage로 채운다).

```text
tick: daily=listDaily; zone=daily? readTimeZone : —
  for s in daily where s.timeZone≠zone: rezone(s, next=occ>(s.lastRunAt??s.createdAt, zone))
  for s in listDue: daily? fire(s, localDates=dates[s.nextRunAt..now], next=occ>(now)) : 기존
```

## Verification

**Commands:**
- `pnpm exec vitest run --project core test/local-time.test.ts test/schedule-daily.test.ts test/schedule-tick.test.ts test/contracts.test.ts` -- expected: fake 시험·계약·변이 시험 통과.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts` -- expected: PG ScheduleStore 계약 suite와 0009 통과. PG 사전 조건: OrbStack이 켜져 있다(global setup이 `second-brain-test-postgres-1`을 띄운다).
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.
- `git diff --check` -- expected: 출력 없음.

**Executed (2026-10-29):**
- `pnpm exec vitest run --project core test/local-time.test.ts test/schedule-daily.test.ts test/schedule-tick.test.ts test/contracts.test.ts`: 4 files, 293 passed.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts`: 2 files, 146 passed.
- `pnpm test`: build, typecheck, 121 files, 3,233 passed.
- `git diff --check`: clean.
- Quick review: 1 finding, fixed with regression coverage; no deferred findings. Matrix rows are covered by the executed daily integration and shared Store contract tests.

## Auto Run Result

Status: built

- 구현 요약: 기존 현지 매일 예약 구현을 네 렌즈로 후속 검토했다. 성공 날짜 필터 변이가 시간대 CAS에서 먼저 실패하던 시험을 교정했고, 새 검증 공백 7개 묶음을 보강했다. 기능 구현·공개 API의 의미를 바꾸지 않았다.
- 바뀐 파일:
  - `packages/core/test/contracts.test.ts` — 날짜·시간대를 유지한 성공 기록 필터 변이와 잘못 생성된 covered 날짜 일감 확인.
  - `packages/core/src/testing/contracts/schedule-store.ts` — 날짜 없는 청구 뒤 병합, 과거 방향 범위 확장, core 실패·취소·의존 실패의 성공 기록 부재를 fake·PG에서 검증.
  - `packages/core/test/schedule-daily.test.ts` — tick 전 시간대 변경 후 수동 실행의 날짜·시간대·성공 기록 확인.
  - `packages/core/test/local-time.test.ts` — Lord Howe 30분 gap/fold와 Apia 날짜 생략의 발화·다음 발화·범위 경계 확인.
  - `packages/postgres/test/migrate.test.ts` — 0008→0009 interval·완료 one-shot 보존, 날짜 CHECK, 삭제 SET NULL·CASCADE 검증.
  - 이 계획 — 후속 리뷰 판정·검증·인계 결과 기록.
- 리뷰 판정: 20건(high 0, medium 8, low 3, false 9, maybe-false 0). medium 패치 7개 묶음 적용(날짜 없는 청구 병합 2건은 같은 묶음). high 패치 0개. 보류 추가 0개. 기존 deferred-work ledger 항목은 수정·재개·재작성하지 않았다.
- 기각 근거:
  - blind-hunter 2·edge-case-hunter 1 — 기존 판정 유지. 드문 완료·발화 경합에 공유 잠금이 필요하다.
  - blind-hunter 3 — 현재 실패 재실행 등록 소비자는 예약 날짜를 소비하지 않으며, 실패한 원 일감의 메타데이터는 보존된다. 실제 범위 소비자는 후속 에픽이다.
  - blind-hunter 4 — 검증된 use case가 만드는 입력에서는 발생하지 않는 fake의 잘못된 직접 입력 차이다. 방어 분기 추가가 필요하다.
  - blind-hunter 5 — 실제 CLI 쓰기·기회적 drain 호출자는 스키마를 먼저 검사한다.
  - edge-case-hunter 2·intent-alignment 3 — 이어진 날짜 범위와 기존 성공 기록 유지가 계약이다.
  - intent-alignment 1·2·4·5 — 기존 판정 유지. 주입한 시계 시험, 발화 기회를 놓친 날짜 보충, 일감에 범위 전달, 다음 tick에서 발화 전 시간대 재계산이 의도와 일치한다.
  - intent-alignment 6 — 청구 날짜와 일치하는 범위 시간대로 성공 기록을 남기며, 완료 당시 설정으로 날짜를 재해석하지 않는다.
- 후속 리뷰 권고: `false`. 이번 실행은 후속 pass이며 high 패치가 없다. 날짜 재대기와 완료 경로의 추가 시험도 모두 통과했다.
- 검증:
  - 변경 전 `pnpm test`: build·typecheck 및 121개 파일 3,242개 시험 통과.
  - 변경 후 계획의 Core 대상 명령: 4개 파일 303개 시험 통과.
  - 변경 후 계획의 PG 대상 명령: 2개 파일 154개 시험 통과.
  - 변경 후 `pnpm test`: build·typecheck 및 121개 파일 3,251개 시험 통과.
  - `git diff --check d612cb6c9b043b1756f59778ad98a70837c387c5`: 통과.
- 남은 위험: 이전에 기각한 드문 완료·발화 경합과 재대기의 attempts 누적은 그대로다. 실제 설치 DB 적용·플러그인 배포는 에픽 후속 티켓 소관이다. 새 사람의 결정은 필요하지 않다.
- 인계: `built`로 HALT한다. 티켓·계획을 `done`으로 표시하지 않았고 `tickets.py mark`는 실행하지 않았다. 완료 판정은 오케스트레이터의 자체 검증에 맡긴다.
