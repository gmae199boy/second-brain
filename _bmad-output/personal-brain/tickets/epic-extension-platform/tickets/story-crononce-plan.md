---
title: 'cron·once 예약과 회차 회계(schedule_occurrences)'
type: 'feature'
ticket: '3'
created: '2026-11-05'
status: 'built'
baseline_revision: '5510d151eed1bb87d4f92b91306ac5bdaff4633f'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: ['oversized']
deferred:
  - summary: >-
      예약 회차가 실행 중 계속 도착해 성공 뒤 같은 일감이 재개되면 attempts가 초기화되지 않아 누적되고, 이후 첫 일시 실패도 재시도 한도에 걸릴 수 있다.
    evidence: |-
      packages/postgres/src/work.ts의 성공 정산은 pending 회차가 남으면 일감을 재개하지만 attempts를 그대로 둔다. 기준 5510d15의 settleScheduledSuccess도 날짜 범위 재개에서 같은 동작이었다(기존 동작). 실행 시간이 예약 주기보다 긴 확장에서 10회 이상 재개 후 일시 실패를 주면 확정된다. 재시도 예산 정책 변경은 별도 판단.
    location: >-
      packages/postgres/src/work.ts:891
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 예약은 매일 현지 HH:MM·초 간격만 표현하고, 성공 회계가 `work_items`의 날짜 범위와 `schedule_successes`(일 단위)라서 매주 금요일 예약·한 번 실행·놓친 회차 정책을 표현할 수 없고 합쳐진 일감에서 회차 성공이 틀어진다(AD-39, research Q1). 같은 일감의 다른 시각 예약도 `(kind,target_kind,target_id)` 부분 UNIQUE 때문에 불가능하고, manifest에서 빠진 옛 기본 예약은 정리되지 않는다(20.6 deferred).

**Approach:** 예약 trigger를 `cron`(5필드+IANA 시간대)·`once`(run_at)로 바꾸고 회차 표 `schedule_occurrences`를 회계 원본으로 둔다. 다음 발화는 core port `CronCalculator` 뒤 Runtime adapter(croner 11, `mode:'5-part'`)가 계산한다. 발화는 next_run_at CAS·회차 생성·일감 연결을 한 쓰기 트랜잭션에서 확정하고, attempt 청구 때 붙은 회차만 `claimed`로 묶어 성공 시 그 집합만 `done`으로 확정한다. 기존 daily·`schedule_successes`·일감 날짜 범위는 새 forward migration 0033에서 cron·회차로 옮긴 뒤 제거한다.

## Boundaries & Constraints

**Always:**
- core(`packages/core`)는 외부 의존 0을 유지한다. croner는 Runtime(`apps/cli`)에만 의존성으로 추가하고 `pnpm-lock.yaml`을 갱신한다(Stack: croner 11.0.0).
- 서머타임 규칙은 현행과 같다: 없는 현지 시각은 전환 instant, 겹친 시각은 첫 instant(`packages/core/src/local-time.ts` `occurrenceAt`). 같은 현지 시각이 두 번 발화하지 않는다.
- 발화 CAS는 `next_run_at` 기대값과 `groupAvailable`(확장 pause/hold) 조건을 유지한다. pause된 확장 예약은 발화하지 않고, 재개 뒤 놓친 회차 정책을 따른다.
- 회차 상태 전이: `pending`→`claimed`→`done`, `pending`→`skipped`, 일감이 영구 실패로 닫히면 `claimed|pending`→`failed`, 재시도·청구 만료·취소 가능 실패는 `claimed`→`pending`. 회차 `(schedule_id, occurrence_at)` UNIQUE.
- 수동 실행(`schedules run`)은 회차를 만들지도 완료하지도 않는다.
- 예약 행·회차 행은 `user_id`(→`brain.users`, self)를 갖는다. self 해석은 20.2의 core self 해석기(`USER_MISSING`)를 쓴다. 이행은 nullable → backfill(self) → NOT NULL이며 self 없이 채울 행이 있으면 migration이 `USER_MISSING` 예외로 rollback한다(0032 패턴). `installPostgres`는 이미 31까지 migrate → `ensureSelfUser` → 나머지 순서다.
- 확장 기본 예약 멱등 키는 `(extension, schedule_key, user_id)`다. 설치·재설치는 없는 키만 만들고, 사용자가 바꾼 trigger·시간대·비활성과 사용자 삭제 표식(`removed_at`)을 보존한다. manifest에서 빠진 키는 `enabled=false`로 바꾸고 설치 결과에 보고한다(삭제하지 않음).
- 새 forward migration `packages/postgres/migrations/0033_schedule_occurrences.sql`만 추가하고 0001~0032 원문은 바꾸지 않는다. `CORE_SCHEMA_VERSION` 32→33.
- 시험 코드는 작성하되 실행하지 않는다(최신 사용자 지시, 21.8 이관). `pnpm build`·`pnpm typecheck`만 실행한다. 시험 fixture는 합성 자료·격리 home·testext·`withoutHarnessFolders`.
- 20.1 확장 명령·20.2 self/설정·확장 pause/resume·실행 잠금 계약을 보존한다.

**Never:**
- 20.4 패키지 공급원·플러그인 틀, 21.x Garmin 기능, 운영 설치본/DB·실제 예약 조작(21.7), 다중 사용자 표면(사용자 인자) 추가.
- `interval_seconds`를 manifest·CLI에 공개하지 않는다(core 내부 호환용 유지).
- core에 croner import, 과거 migration 수정, BMAD setup/update, 시험 실행.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 주간 cron | `0 9 * * 5`, Asia/Seoul, 가짜 clock 4주 진행, 매 tick 정시 | 금요일 09:00 KST마다 회차 1개·일감 1개, 성공 시 그 회차만 `done`, 다른 요일 회차 없음 | — |
| 3주 정지 latest | 같은 예약, 데몬 3주 정지 후 tick | 최근 회차 1개만 일감 연결(입력=그 회차 시각), 이전 2개 `skipped`, 다음 next_run_at=다음 금요일 | — |
| 3주 정지 coalesce | work `missed: coalesce` | 3회차를 일감 하나에 연결, 성공 시 3개 모두 `done`, ABI `BRAIN_OCCURRENCES`에 3시각 | — |
| 3주 정지 skip | work `missed: skip` | 일감 없음, 3회차 `skipped` | — |
| 유예 안 | tick이 회차보다 5분 이하 늦음 | 놓친 회차 아님, 정상 실행 | — |
| 실행 중 새 회차 | attempt A가 회차1을 claimed 중 회차2 발화 | 회차2는 같은 미완료 일감에 `pending`, A 성공 시 회차1만 `done`, 일감 재개되어 다음 attempt가 회차2 | — |
| 실패·재시도 | attempt 일시 실패 | claimed→pending, 다음 attempt가 다시 claimed | 영구 실패면 `failed` |
| once 늦음 | run_at 3일 전, 데몬 재시작 | 한 번 실행, next_run_at NULL, 회차 1개, 다시 발화 안 함 | 정책 무관 |
| DST 없는 시각 | America/New_York `30 2 * * *`, 3월 전환일 | 전환 instant(03:00 EDT) 1회 | — |
| DST 겹친 시각 | America/New_York `30 1 * * *`, 11월 전환일 | 첫 01:30(EDT) 1회만 | — |
| daily 이행 | schema32: daily 09:00 예약, `schedule_successes` 오늘 날짜, 미완료 일감 날짜범위 | 0033 뒤 cron `0 9 * * *`·같은 zone, 성공 날짜→그날 09:00 회차 `done`, 미성공 범위→`pending` 회차(청구 중이면 `claimed`), 같은 날 tick이 재발화·재연결하지 않음 | self 없음 → `USER_MISSING` rollback |
| 재설치 보존 | 사용자가 확장 기본 예약 cron 변경·다른 예약 삭제 | 재설치 후 변경 유지, 삭제 키 재생성 안 함, manifest에서 빠진 키 `enabled=false` 보고 | — |
| 잘못된 식 | `--cron '0 9 * *'`, 6필드, 잘못된 zone, 과거·형식 오류 `--once` | `SCHEDULE_INVALID`, 행 없음 | 종료 코드는 기존 코드 표 |
| trigger 변경 | `schedules update <id> --cron ...` | 이미 만든 회차 유지, next_run_at만 새 식으로 now 이후 | CAS 경합 시 재시도 안내 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0009_local_schedules.sql`(읽기 전용) — 현재 `local_time/time_zone`, `schedules_daily_target_unique`, `work_items.schedule_id/local_date_*/claimed_date_*`, `schedule_successes`. 0001 351~363 `brain.schedules`. 0032는 user_id 이행·`USER_MISSING` 예외 패턴.
- `packages/postgres/src/migrate.ts` `CORE_SCHEMA_VERSION`; 32를 고정한 시험·빌드 기록(`git grep -n "CORE_SCHEMA_VERSION\|schema_version.*32\|coreMaxVersion"`) 따라 갱신. `apps/cli/src/install/postgres.ts:62` 31까지 → self → 나머지(변경 불필요, 확인).
- `packages/core/src/domain/schedule.ts` `Schedule`, `domain/work-item.ts:31` `scheduledDates` — trigger·키·user·enabled 필드, 일감의 회차 입력으로 교체.
- `packages/core/src/ports/store.ts:1430~1460` `ScheduleStore`·`FireScheduleInput`·`ScheduleSuccess`, `:404` `AddWorkInput.scheduledDates`. 새 port `packages/core/src/ports/cron.ts`(`CronCalculator`)와 `ports/index.ts`·`index.ts` export.
- `packages/core/src/queue/schedule-tick.ts` — 현 daily rezone·`dailyOccurrenceDates`·fire. 새 회차·정책 로직의 위치. `queue/schedules.ts` `addDaily/runSchedule/ensureDaily/listSchedules/removeSchedule`.
- `packages/core/src/local-time.ts` `occurrenceAt`·`localDateOf`·`isLocalTime` — DST 규칙 원본(재사용, export해 adapter가 사용).
- `packages/core/src/brain.ts` 18~20·244~249·476~481 `schedules` 연결, `BrainDependencies`(76~)에 cron 주입. CLI 주입처: `apps/cli/src/dispatch.ts:655,806`, `apps/cli/src/daemon/run.ts:346`, `apps/cli/src/install.ts:158`의 `brainDependencies`.
- `packages/postgres/src/schedules.ts` 전체(addSchedule·fireSchedule CAS·listDue·rezone·listScheduleSuccesses), `packages/postgres/src/work.ts` 40~42·97·116~140 `ensureWork` 날짜 병합, 269·382 청구 시 `claimed_date_*`, 480·526 `settleScheduledSuccess`(880~890) 및 실패·재시도·만료·취소 닫기 경로 전부, 849 `toWorkItem`.
- `packages/postgres/src/extensions.ts:98~110` `recordExtensionInstall` — `extension_work_kinds` 교체; `missed_policy` 저장 위치.
- `packages/core/src/testing/fakes/store.ts` 226~242·434~449·751·775~830·1582·1654 — fake 예약·날짜 회계. `testing/contracts/schedule-store.ts`(fake·PG 공통 계약), `apps/cli/src/doctor/store.ts:49,81~84` unavailable 스텁.
- `packages/core/src/extensions/manifest.ts:14,40,106~114`, `packages/core/schemas/extensions/v1/manifest.schema.json:157~`, `packages/core/fixtures/extensions/v1/{manifests.json,check-manifests.py}`(core·Python 공유 fixture) — `default_schedules`·`work[].missed`.
- `packages/core/src/extensions/install.ts:7,272~306` — `ensureDaily` 기반 기본 예약 설치, `progress.scheduleIds`, `EXTENSION_SCHEDULER_UNAVAILABLE`.
- `apps/cli/src/daemon/supervisor.ts:69` `BRAIN_RANGE_FROM/TO`; `packages/core/schemas/process-abi/v1/env.schema.json:54`, `packages/core/fixtures/process-abi/v1/env.json` — ABI env.
- `apps/cli/src/commands/schedules-{add,list,remove,run}.ts`, `commands/index.ts`, `list-options.ts` — CLI. 명령 메타가 MCP·guide를 만든다(AD-28).
- `packages/core/src/codes.ts` — `SCHEDULE_INVALID`·`SCHEDULE_CONFLICT`·`SCHEDULE_NOT_FOUND` 존재, 필요 시 코드 추가.
- 시험 참고: `packages/core/test/{schedule-tick,schedule-daily,contracts}.test.ts`, `packages/postgres/test/{user-keys,core-garmin-cleanup,migrate,schema,work-store,store}.test.ts`, `apps/cli/test/{schedules-queue-list,ext-install,ext-install-resume,daemon-run,daemon-supervisor,process-group}.test.ts`, `ext-fixture.ts`, `tooling/mac-install/run.mjs:34`(legacy `local_time` 사용).
- `tooling/test-changed/rules.mjs` — 새 Python·SQL·자식 프로세스 경로 규칙.

## Tasks & Acceptance

**Execution:**
- [ ] T1 `packages/postgres/migrations/0033_schedule_occurrences.sql`, `migrate.ts` -- schedules에 `trigger_kind('cron'|'once'|'interval')`·`cron_expr`·`run_at`·`time_zone_source('user'|'fixed')`·`extension`·`schedule_key`·`user_id`·`enabled`·`removed_at` 추가와 shape check; daily → `cron_expr='MM HH * * *'`·source user; 확장 kind(`<ext>.*`) 행은 `extension`=접두·`schedule_key`=`<kind>:<target_kind>:<target_id>`; user_id backfill→NOT NULL; `schedules_daily_target_unique` 제거, `unique (extension, schedule_key, user_id) nulls not distinct where schedule_key is not null`; `schedule_occurrences(schedule_id fk cascade, occurrence_at, status, work_id fk, user_id, recorded_at, primary key(schedule_id, occurrence_at))`+work_id 인덱스; `schedule_successes`→`done` 회차, 미완료 일감 날짜범위의 미성공 날짜→`pending`(claimed 범위면 `claimed`) 회차; `extension_work_kinds.missed_policy` 기본 'latest'; 이후 `schedule_successes`·`schedules.local_time`·`work_items.local_date_*/claimed_date_*/local_time_zone` 제거(`schedule_id`는 유지 가능); 권한 유지 -- AD-39·40 이행.
- [ ] T2 `domain/schedule.ts`, `domain/work-item.ts`, `ports/store.ts`, `ports/cron.ts`, `postgres/src/schedules.ts`, `postgres/src/work.ts`, `postgres/src/extensions.ts`, `testing/fakes/store.ts`, `testing/contracts/schedule-store.ts`, `apps/cli/src/doctor/store.ts` -- Store 계약: 예약 CRUD(add/update/remove 표식/find by key/list), `fireSchedule`(CAS+회차 일괄 삽입 `on conflict do nothing`+`ensureWork` 연결, 정책 결과 반영), 청구 시 회차 claimed·일감 `scheduledOccurrences` 채움, 성공 시 claimed만 done 후 pending 남으면 재개, 재시도/만료/취소 시 pending 복귀, 영구 실패 시 failed, `listOccurrences` 조회 -- 날짜 범위 회계 대체.
- [ ] T3 `ports/cron.ts`, `apps/cli/src/runtime/cron.ts`(신규, croner), `apps/cli/package.json`, `pnpm-lock.yaml`, `queue/schedule-tick.ts`, `queue/schedules.ts`, `brain.ts`, `index.ts`, CLI 주입처, `apps/cli/src/daemon/supervisor.ts`, ABI env schema·fixture -- 회차 열거·유예 5분·latest/coalesce/skip·once, user zone 예약의 rezone(trigger·zone 변경은 다음 회차부터), add(cron/once/legacy local_time)·update·run(회차 없음), ABI `BRAIN_OCCURRENCES`(ISO 오프셋 JSON 배열)와 회차 현지 날짜 min/max의 `BRAIN_RANGE_FROM/TO`.
- [ ] T4 `extensions/manifest.ts`, manifest schema, 공유 fixture·`check-manifests.py`, `extensions/install.ts` -- `default_schedules[]`: 선택 `key`(기본 `<kind>:<target_kind>:<target_id>`), `cron`+선택 `time_zone` 또는 legacy `local_time`(정확히 하나), 키 중복 거부; `work[].missed` 선택 enum; 설치는 `(extension,key,self)` 없을 때만 생성, 기존·표식 보존, 빠진 키 비활성화·결과 보고, 식 검증은 cron port.
- [ ] T5 `apps/cli/src/commands/schedules-*.ts`, 새 `schedules-update.ts`, `commands/index.ts` -- `add --cron <expr> [--tz <zone>] | --once <ISO> | --at HH:MM`(정확히 하나), `update <id> [--cron|--once] [--tz] [--enable|--disable]`, `list`에 trigger·zone·source·key·extension·enabled 출력(`local_time` 필드는 cron이 `M H * * *`일 때 호환 값), `remove`는 키 있는 행에 표식.
- [ ] T6 시험 코드(작성만, 실행 금지)와 `tooling/test-changed/rules.mjs` -- `apps/cli/test/schedule-cron.test.ts`(신규; 실제 adapter+memory store+가짜 clock으로 I/O 표 주간·3주 latest/coalesce/skip·유예·실행 중 새 회차·once·DST 두 경우·trigger 변경, 한 달 발화 수를 손으로 센 값과 대조), `packages/postgres/test/schedule-occurrences.test.ts`(신규; 32→33 이행: daily→cron, successes→done, 날짜범위→pending/claimed, 같은 날 재발화 없음, self 없음 rollback, 키 유일성, 대화 수집 표 건수·md5 불변), 계약·fake·work-store·ext-install(재설치 보존·표식·빠진 키 비활성)·manifest fixture·supervisor env·CLI 시험 갱신, 0032 이하를 고정한 기존 이행 시험의 migration 범위 고정.

**Acceptance Criteria:**
- Given 가짜 clock과 Asia/Seoul `0 9 * * 5` 예약, when 4주 동안 tick·drain하면, then 금요일 회차만 각 1회 `done`이고 같은 회차의 일감은 하나다(시험 코드).
- Given 3주 정지, when 재개 tick하면, then 정책별 결과가 I/O 표와 같다(시험 코드).
- Given schema 32 DB의 daily 예약과 성공 날짜, when 0033을 적용하고 같은 날 tick하면, then 같은 날 중복 발화가 없다(시험 코드).
- Given 사용자가 바꾼 확장 기본 예약, when 같은 확장을 재설치하면, then trigger·비활성·삭제 표식이 유지되고 빠진 키는 비활성으로 보고된다(시험 코드).
- Given `brain schedules add --cron '0 9 * * 5' --tz Asia/Seoul`·`--once <ISO>`, when `brain schedules list --json`하면, then trigger와 다음 실행 시각이 보인다.
- Given 변경 완료, when `pnpm build`·`pnpm typecheck`를 실행하면, then 둘 다 종료 0이다. 시험 실행은 21.8 이관·미실행이다.

## Implementation Notes

- 구현 워커 Codex gpt-6.1-terra/medium(자기 Run `run_d01f7facc761`, 최초 Dispatch `ctx_a97eea7fa0b4` ready·depth 1). Task 1(T1) succeeded — 0033·버전 33·이행 시험 코드.
- 결정(지휘자, T2 질문 응답): 다른 예약이 같은 미완료 일감에 회차를 붙일 수 있으므로 `WorkItem.scheduledOccurrences`는 `{scheduleId, timeZone, occurrences}[]`(schedule_id·시각 오름차순) 그룹 배열이다. 청구 때 그 일감에 붙은 모든 회차를 claimed로 묶는다(AD-39 "attempt 시작 때 붙어 있던 회차 집합"). ABI `BRAIN_OCCURRENCES`는 전체 instant 합집합 오름차순, `BRAIN_RANGE_FROM/TO`는 각 회차를 자기 예약 zone으로 현지 날짜화한 min/max.
- Task 2(T2) succeeded(capacity 오류 1회 뒤 같은 Dispatch에서 재개, 모델 변경 없음), Task 3(T3) succeeded — `croner` 11.0.0을 `apps/cli`에만 추가, adapter는 UTC 벽시계 열거 + core `occurrenceAt`, Task 4(T4·T5) succeeded. T6 `tooling/test-changed/rules.mjs`의 `packages/core/src/ports/cron.ts` exact 규칙은 지휘자가 추가.
- 리뷰 반영 fix-r1: 회차 행에 생성 당시 `time_zone` 저장(청구 그룹은 `(schedule_id, time_zone)`), `schedules.trigger_updated_at`으로 rezone 소급 방지, 발화 CAS에 trigger 종류·식·zone 포함, 비daily 확장 행의 이행 키에 id 접미, 재개 없이 닫히는 일감의 남은 회차 `failed`, interval 대량 경로 격자 정렬. fix-r2: 텍스트 출력(예약 trigger·비활성, 비활성화 키), cron 공백 정규화, fake 발화 시각 검증 복원.
- 결정: 10,000개 초과 열거 시 최근 1,000개만 기록(계획 Design Notes) 유지 — 리뷰 low reject 근거는 Triage Log.
- 시험 실행: **21.8로 이관, 미실행**. 지휘자 확인 `pnpm build` 0, `pnpm typecheck` 0, `git diff --check` 0.

## Plan Change Log

## Review Triage Log

### 2026-11-05 — Review pass
- verdicts: 25 findings — high 0, medium 17, low 7, false 1, maybe-false 0
- 리뷰 원문: 로컬 `.brain-automation/review/r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`(Codex gpt-6.1-sol/medium, Dispatch ctx_7f47ec34a87a·ctx_09fc409645ec·ctx_8d6423d9838a·ctx_2409d8c74f93). diff `/tmp/brain-20-3-diff-r1.patch`.
- findings:
  - `[medium]` `[patch]` (blind 1) 10,000 초과 경로에서 interval 시작점이 격자를 벗어나 위상 이동 — `schedule-tick.ts` 시작점 계산 확인. fix-r1: 격자 정렬+시험.
  - `[medium]` `[patch]` (blind 2) 청구 시 회차 현지 날짜를 현재 예약 zone으로 계산 — `work.ts:880` join 확인, AD-39 "이미 만든 회차 그대로" 위반. fix-r1: 회차 행 `time_zone`.
  - `[medium]` `[patch]` (blind 3) trigger 수정 뒤 user zone rezone이 `lastRunAt ?? createdAt`부터 새 식 소급 — tick:20 확인. fix-r1: `trigger_updated_at` 기준.
  - `[medium]` `[patch]` (blind 4) 같은 확장 대상의 비daily 행이 같은 키가 되어 0033 실패 — 0009 유일성은 daily만. fix-r1: 비daily 키에 id 접미.
  - `[medium]` `[patch]` (blind 5) 취소로 닫힌 일감의 회차가 영구 pending — `work.ts` 취소 경로가 pending 복귀만 하고 work_id 유지, 재발화는 `on conflict do nothing`. fix-r1: 닫힘 시 failed.
  - `[low]` `[reject]` (blind 6) `BRAIN_OCCURRENCES` 정규식이 달력 유효성 미검사 — 값은 core supervisor만 생성하므로 일상 사용에서 만나기 어렵고 수정은 새 검증 분기.
  - `[medium]` `[patch]` (blind 7) 3주 정책 시험이 발화 직후에서 끝남 — 시험 코드 확인. fix-r1: 청구·완료·next 단언.
  - `[medium]` `[patch]` (blind 8) supervised 회차 생명주기 계약 부재 — 계약은 claimWork/completeWork만. fix-r1: 두 모드 매개변수화.
  - `[medium]` `[patch]` (blind 9) 이행 후 같은 날 중복 없음을 실제 tick으로 검사 안 함 — fireSchedule 직접 호출 확인. fix-r1: 실제 tick 시험.
  - `[low]` `[reject]` (blind 10) 발화 대 청구·완료 PG 경합 시험 부재 — claim은 READ COMMITTED에서 커밋된 pending만 claimed로 바꾸고 settle은 claimed만 done이므로 교차 시 새 회차는 pending으로 남는 설계; 장벽 시험은 복잡도 대비 일상 위험 낮음.
  - `[medium]` `[patch]` (vgap 1) supervised 도중 도착 회차 재청구 미검증 — blind 8과 같은 원인. fix-r1.
  - `[medium]` `[patch]` (vgap 2) daemon-run interval 기대값이 옛 계산 — 정적 계산 확인(at+55s). fix-r1: 기대값 수정.
  - `[medium]` `[patch]` (vgap 3) 완료 legacy once 0033 이행 미검증 — fix-r1: fallback 두 사례.
  - `[low]` `[patch]` (edge 1) 발화 CAS가 zone·식 미비교 — 옛 코드는 zone을 CAS에 포함했다. 직접 수정이라 patch. fix-r1.
  - `[medium]` `[patch]` (edge 2) = blind 1.
  - `[medium]` `[patch]` (edge 3) = blind 4.
  - `[medium]` `[patch]` (edge 4) = blind 3.
  - `[medium]` `[patch]` (edge 5) = blind 2.
  - `[low]` `[reject]` (edge 6) 예약이 지워진(schedule_id NULL) 미완료 일감의 날짜범위가 이행에서 사라짐 — 회차는 예약 FK가 필요해 보존 위치가 없고, 업그레이드 순간 그런 일감이 열린 드문 상태이며 수정은 새 저장 구조.
  - `[low]` `[reject]` (intent A) 10,000 초과 시 최근 1,000개만 기록 — 분 단위 cron이 7일 이상 멈춘 경우에만 해당하고 latest/skip 결과는 같으며, 무제한 기록은 새 배치 구조가 필요.
  - `[medium]` `[patch]` (intent B) = blind 7.
  - `[low]` `[reject]` (intent C) 금요일 시험이 데몬 전체 경로가 아님 — 원문 verify는 가짜 clock 시험이며 실제 adapter+Store 계약+supervisor env 시험으로 층별 관찰.
  - `[medium]` `[patch]` (intent D) = blind 8.
  - `[false]` `[reject]` (intent E) manifest에 once 없음 — 원문은 CLI `--cron/--once`와 manifest `default_schedules` 확장을 따로 말하고, AD-39의 기본 예약은 설치 단위 반복 예약이다. 사용자 해 없음.
  - `[low]` `[reject]` (intent F) 이행→재설치 단일 흐름 시험 아님 — 키 동일성은 이행 시험이 단언하고 재설치 보존은 CLI 시험이 단언.

### 2026-11-05 — Review pass (후속 r2)
- verdicts: 19 findings — high 0, medium 3, low 12, false 4, maybe-false 0
- 리뷰 원문: 로컬 `.brain-automation/review/r2-*.md`(Dispatch ctx_09e5243185c7·ctx_2c725512f252·ctx_45430229d1fc·ctx_2d995c687b54), diff `/tmp/brain-20-3-diff-r2.patch`(fix-r1 반영).
- findings:
  - `[false]` `[reject]` (blind 1) 수동 실행이 예약 회차를 완료할 수 있음 — 수동 실행은 회차를 만들지 않는다. 같은 미완료 키로 합쳐진 일감이 실제로 실행되면 청구 때 붙어 있던 회차는 그 실행이 처리한 것이므로 done이 맞다(AD-21 합치기, AD-39 attempt 집합). 수동 실행 단독으로 회차를 done 처리하는 경로는 없다.
  - `[medium]` `[defer]` (blind 2) 성공 뒤 새 회차로 재개한 일감이 이전 attempts를 계속 소비 — 기준 `settleScheduledSuccess`도 attempts를 초기화하지 않고 재개했다(기존 동작). deferred에 기록.
  - `[low]` `[patch]` (blind 3) 텍스트 `schedules list`에 cron/once·비활성 누락 — 직접 수정. fix-r2.
  - `[low]` `[patch]` (blind 4) cron 공백 정규화 불일치 — 직접 수정. fix-r2.
  - `[low]` `[reject]` (blind 5) PG getWork/listWork가 scheduledOccurrences를 null로 반환 — 실행 입력은 청구 응답만 쓰며 조회 결과를 읽는 소비자가 없다.
  - `[low]` `[reject]` (blind 6) 3시간 초과 gap(Pacific/Apia 2011)에서 이행 SQL 차이 — 이행 대상 성공 날짜는 설치 이후 날짜이고 해당 전환은 과거라 만날 수 없다.
  - `[low]` `[reject]` (blind 7) 콜론 포함 대상의 키 연결 충돌 — 같은 kind에서 콜론 위치만 다른 두 daily 대상이 필요해 일상 사용에서 만나기 어렵고 수정은 escape/충돌 처리 추가.
  - `[low]` `[reject]` (blind 8) 누적 회차 env 크기 무제한 — 한 tick 기록은 최대 1,000개이고 hold된 예약은 발화하지 않아 3만 개 누적은 비현실적; 수정은 청구 분할 구조.
  - `[low]` `[patch]` (blind 9) 비활성화 키가 텍스트 출력에 없음 — 직접 수정. fix-r2.
  - `[low]` `[reject]` (blind 10) 예약→청구→자식 ABI 단일 통합 시험 부재 — 자식 env는 ext-install 실제 프로세스 시험, claimed 집합은 공통 계약이 덮는다.
  - `[medium]` `[patch]` (vgap 1) fixed zone 예약의 cron만 수정 시 출처 보존 시험 부재 — fix-r2 시험 추가.
  - `[medium]` `[patch]` (vgap 2) 기본 예약 전부 제거 재설치 시험 부재 — fix-r2 시험 추가.
  - `[low]` `[reject]` (edge 1) carried — r1 blind 6과 같은 위치·주장, 코드 동일.
  - `[low]` `[patch]` (edge 2) fake fireSchedule 시각 검증 삭제 — 직접 복원. fix-r2.
  - `[low]` `[reject]` (edge 3) carried — r1 edge 6과 같은 위치·주장, 코드 동일.
  - `[false]` `[reject]` (intent A) carried — r1 intent E.
  - `[low]` `[reject]` (intent B) carried — r1 intent A.
  - `[false]` `[reject]` (intent C) latest가 최신 놓친 회차와 유예 안 회차를 함께 실행 — AD-39의 "나머지 놓친 회차"와 5분 유예 정의를 따른 계획 해석 그대로다.
  - `[false]` `[reject]` (intent D) 외부 효과 exactly-once 미보장 — 원문·AD는 회차 회계의 한 번을 요구하며 외부 효과 보장은 범위가 아니다(research Q1).

## Design Notes

- **cron adapter와 DST:** croner를 현지 벽시계 열거기로만 쓴다. `new Cron(expr, { mode: '5-part', timezone: 'UTC', paused: true })`로 "UTC로 가장한 벽시계"의 다음 일치를 구하고, 각 벽시계(날짜+HH:MM)를 core `occurrenceAt(date, HH:MM, zone)`으로 instant로 바꾼 뒤 `after`보다 큰 첫 instant를 고른다. gap의 두 벽시계가 같은 전환 instant가 되면 하나로 합친다. 이렇게 하면 croner의 DST 해석과 무관하게 현행 규칙과 같다. 5필드 외 형식(초·연·`@reboot`·`?` 등 croner 확장)은 `SCHEDULE_INVALID`.
- **회차 열거와 정책(tick):** due 예약마다 `next_run_at`부터 `now` 이하 회차를 열거한다(안전 한도 10,000; 넘으면 최근 1,000개만 행으로 남기고 나머지는 행 없이 건너뜀·로그). `now - occurrence > 5분`이면 놓친 회차. latest: 가장 최근 회차와 유예 안 회차를 연결, 나머지 놓친 회차 `skipped`; coalesce: 전부 연결; skip: 놓친 회차 `skipped`, 유예 안 회차만 연결; 연결할 회차가 없으면 일감을 만들지 않고 CAS만 전진. 새 next_run_at = `now` 이후 첫 회차(once는 NULL). 이미 있는 회차(`done` 이행분 등)는 `on conflict do nothing`으로 다시 연결하지 않는다.
- **시간대 출처:** `time_zone_source='user'`(이행된 daily, `--tz` 없는 add, `time_zone` 없는 manifest 기본 예약)는 self의 `timezone` 설정을 따라 tick이 rezone한다(현행 동작 보존, `last_run_at ?? created_at` 이후 첫 회차). `fixed`는 rezone하지 않는다.
- **이행의 DST 계산(SQL):** 성공 날짜 d·시각 t·zone z의 회차 instant는 `ts=d+t`, `a=ts at time zone z`, `generate_series(a-3h, a+3h, 1 minute)`에서 `i at time zone z = ts`인 최소 i, 없으면 `> ts`인 최소 i. PG 기본 gap/fold 해석은 규칙과 다르므로 쓰지 않는다. 0033 안의 임시 함수로 두고 이행 뒤 drop.
- **ABI:** `BRAIN_OCCURRENCES`(선택, 그 attempt의 claimed 회차 시각 오름차순)를 env schema·fixture에 추가하고, 있을 때만 `BRAIN_RANGE_FROM/TO`(예약 zone의 현지 날짜 min/max)를 함께 준다. 기존 Python·Node 소비자 호환.
- **결정 근거:** 영구 실패 회차를 `failed`로 두는 것은 Table Contract 상태 목록의 확장이다(`pending`으로 남기면 닫힌 일감에 매달린 고아 행이 된다). 사용자 변경 표면이 없으면 "재설치가 사용자 변경을 보존"을 검증할 수 없으므로 `schedules update`를 둔다. manifest `key` 기본값을 기존 daily 유일 키와 같게 하여 이행된 확장 예약이 재설치에서 중복 생성되지 않는다.

## Verification

**Commands:**
- `pnpm install --frozen-lockfile=false`(croner 추가 후 lockfile 갱신) -- expected: 종료 0
- `pnpm build` -- expected: 종료 0
- `pnpm typecheck` -- expected: 종료 0
- `git grep -n "schedule_successes\|local_date_from\|claimed_date_\|findDailySchedule\|listDailySchedules\|listScheduleSuccesses\|ensureDaily" -- packages apps tooling ':!packages/postgres/migrations/000*' ':!packages/postgres/migrations/001*' ':!packages/postgres/migrations/002*' ':!packages/postgres/migrations/0030*' ':!packages/postgres/migrations/0031*' ':!packages/postgres/migrations/0032*'` -- expected: 0033과 이행 시험의 의도된 참조만
- `git diff --check` -- expected: 출력 없음

**21.8 실행 인계(미실행):** `pnpm test`(→ `apps/cli/test/schedule-cron.test.ts`, `packages/postgres/test/schedule-occurrences.test.ts`, 계약·ext-install·daemon 시험 포함) → `pnpm test:python`(공유 manifest·ABI fixture). 사전 조건: 전용 시험 PG(`compose.test.yaml`), 합성 자료. 정리: 시험이 만든 `brain_test_*` DB와 격리 home 삭제.

## Auto Run Result

**상태:** built (사용자 인수 전, done 아님). 시험 실행은 **21.8로 이관, 미실행**이며 통과로 보고하지 않는다.

**구현 요약:** 예약 trigger를 cron(5필드+IANA)·once·내부 interval로 바꾸고 `schedule_occurrences`를 회계 원본으로 삼았다. core `CronCalculator` port 뒤 Runtime adapter(croner 11 `mode:'5-part'`)가 다음 회차를 계산하며 DST는 현행 `occurrenceAt` 규칙(gap→전환, fold→첫 instant)이다. tick은 유예 5분·latest/coalesce/skip·once 한 번·user/fixed zone을 처리하고, 발화 CAS·회차 삽입·일감 연결을 한 쓰기 트랜잭션에서 확정한다. 청구 때 붙은 회차만 claimed→성공 시 done, 실행 중 도착 회차는 다음 attempt, 재시도는 pending 복귀, 영구 실패·취소 닫힘은 failed. 0033이 daily→cron, `schedule_successes`→done, 미완료 날짜범위→pending/claimed 회차로 옮기고 옛 칼럼·표를 제거한다. CLI `schedules add --cron/--once/--at`, `update`, `list`, `remove`(키 행 삭제 표식), manifest `default_schedules`(key·cron·time_zone 또는 legacy local_time)·`work[].missed`, 설치의 `(extension, schedule_key, user_id)` 멱등·사용자 변경/표식 보존·빠진 키 비활성 보고(20.6 deferred 해소 — 처리·시험 코드 반영, 운영 예약 조작은 21.7). ABI `BRAIN_OCCURRENCES`와 회차 기반 `BRAIN_RANGE_FROM/TO`.

**주요 파일:**
- `packages/postgres/migrations/0033_schedule_occurrences.sql`, `packages/postgres/src/migrate.ts` — 새 forward migration·버전 33.
- `packages/core/src/ports/{cron,store}.ts`, `domain/{schedule,work-item}.ts` — port·도메인 계약.
- `packages/core/src/queue/{schedule-tick,schedules}.ts`, `brain.ts` — 회차 정책·예약 API.
- `apps/cli/src/runtime/cron.ts`, `apps/cli/src/assembly.ts`, `apps/cli/package.json`, `pnpm-lock.yaml` — croner adapter 주입.
- `packages/postgres/src/{schedules,work,extensions}.ts`, `packages/core/src/testing/{fakes,contracts}/*` — Store·fake·공통 계약.
- `packages/core/src/extensions/{manifest,install,...}.ts`, manifest schema·공유 fixture·`check-manifests.py` — manifest·설치.
- `apps/cli/src/commands/schedules-*.ts`, `ext-status.ts`, `daemon/supervisor.ts`, ABI env schema·fixture — 표면·ABI.
- 시험 코드(미실행): `apps/cli/test/{schedule-cron,schedule-migration-tick}.test.ts`, `packages/postgres/test/schedule-occurrences.test.ts` 신규와 계약·work-store·ext-install(-resume)·schedules-queue-list·daemon-run·process-group·extensions 등 갱신.

**리뷰:** thorough 4렌즈(blind-hunter, edge-case-hunter, verification-gap, intent-alignment; Codex gpt-6.1-sol/medium) 2회. r1 25건: patch 18행(medium 17·low 1, 원인 묶음 11), reject 7. r2(후속) 19건: patch 6(medium 2·low 4), defer 1(medium, 기존 동작), reject 12(carried 5 포함). 기각 사유는 Triage Log 각 행. 리뷰 원문 로컬 `.brain-automation/review/`.

**후속 리뷰 권고:** `false` — r1은 medium 2건 이상을 수정해 후속 r2를 수행했고, r2는 high를 수정하지 않았다(patched: medium 2, low 4).

**검증(지휘자 실행):** `pnpm build` 종료 0, `pnpm typecheck` 종료 0, `git diff --check` 종료 0, 제거 API 검색은 0033·이행 시험의 의도된 참조만 남음(`ensureDaily`는 키 기반 `ensureSchedule`을 감싼 미사용 호환 export로 남음). 과거 migration 0001~0032 diff 없음. Matrix 행별 시험 코드는 작성했으나 실행은 21.8.

**21.8 실행 인계(미실행):** 전용 시험 PG(`compose.test.yaml`)·합성 자료에서 `pnpm test` → `pnpm test:python` 순차. 대상: `apps/cli/test/schedule-cron.test.ts`, `apps/cli/test/schedule-migration-tick.test.ts`, `packages/postgres/test/schedule-occurrences.test.ts`(32→33 이행·self 없음 rollback·DST·once fallback·키 충돌), 공통 계약(core·PG), `work-store`·`ext-install`·`ext-install-resume`·`schedules-queue-list`·`daemon-run`·`process-group`·`extensions`, Python 공유 manifest·ABI fixture. 준비: 시험 PG 기동, 정리: 시험이 만든 `brain_test_*` DB·격리 home 삭제.

**잔여 위험·운영 조치:** deferred 1건(재개 일감 attempts 누적). 이 Mac 설치본에 0033 적용·옛 manifest 예약 정리 확인은 21.7. 10,000개 초과 누락 시 최근 1,000개만 기록. 시험 미실행이므로 런타임 결함은 21.8에서 드러날 수 있다.
