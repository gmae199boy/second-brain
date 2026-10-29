---
title: '예약·작업 명령: schedules와 queue list가 상태·걸린 시간·토큰을 보인다'
type: 'feature'
ticket: '9'
created: '2026-10-29'
status: done
baseline_revision: '73f4bf272429d680e48872b96275845ab382c43a'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 12.8이 만든 매일 예약·수동 실행은 SDK(`brain.schedules.addDaily`·`run`)에만 있고, 예약을 보거나 지우는 길과 CLI가 없다. 작업 목록도 없어서 일감의 상태·attempt·걸린 시간·토큰 사용량을 볼 수 없고, doctor는 모델 일감의 토큰과 걸린 시간을 보이지 않는다(E12-10).

**Approach:** `brain schedules add|list|remove|run`과 `brain queue list`를 CommandSpec 하나씩으로 등록부에 더하고, 각 verb가 같은 이름의 Brain SDK 메서드 하나를 부르게 한다. Store에 읽기 verb `listSchedules`·`listWork`와 쓰기 verb `removeSchedule`을 더하고(fake·PG·계약), doctor에 모델 일감 사용량 check 하나를 더한다.

## Boundaries & Constraints

**Always:**
- **SDK 1:1:** `Brain.schedules`는 `add`·`list`·`remove`·`run`(+데몬 전용 `tick`), `Brain.queue`는 `list`·`cancel`·`drain`이다. `schedules.addDaily`는 `add`로 이름을 바꾼다(호출부는 `packages/core/test/schedule-daily.test.ts`뿐). 명령 파일은 `apps/cli/src/commands/schedules-{add,list,remove,run}.ts`, `queue-list.ts`이고 `commands/index.ts`의 `queueCancelCommand` 뒤에 `queueListCommand`, 그 뒤에 schedules 네 개를 넣는다. `nsDescription`은 schedules가 `'예약한 일을 관리합니다'`, queue는 기존 문장 그대로다.
- **schedules add:** `brain schedules add --kind <kind> --target-kind <kind> --target-id <id> --at <HH:MM>`(네 옵션 모두 `required`). SDK `add({kind, targetKind, targetId, localTime})`는 기존 `addDaily` use case다. kind·targetKind·targetId가 공백뿐이면 `SCHEDULE_INVALID`. 시간대는 사용자 설정 `timezone`이다. `writes: true`, `risk: 'write'`.
- **schedules list:** 모든 예약(매일·interval·끝난 one-shot)을 `created_at`, `id` 오름차순으로, `--limit`(1~200, 기본 100, Core 상수 `SCHEDULES_LIST_LIMIT`) 만큼 돌려준다. 행: `id`, `kind`, `target_kind`, `target_id`, `local_time`, `time_zone`, `interval_seconds`, `next_run_at`, `last_run_at`, `created_at`(시각은 `isoWithOffset`). meta `count`·`has_more`. `risk: 'read'`.
- **schedules remove <id>:** 예약 행을 지운다(0009의 FK대로 일감의 `schedule_id`는 null이 되고 성공 기록은 함께 지워진다). 이미 만든 열린 일감은 그대로 돈다. 없는 id → `SCHEDULE_NOT_FOUND`(exit 1). 지운 뒤 tick은 그 예약으로 일감을 만들지 않는다.
- **schedules run <id>:** 기존 `runSchedule`. data는 `{schedule_id, work_id, created}`. 같은 대상의 열린 일감이 있으면 `created: false`, 같은 `work_id`다.
- schedules·queue의 id 인자는 `queue-cancel.ts`의 preflight처럼 UUID가 아니면 `USAGE`(exit 2)다. schedules의 쓰기 세 명령은 `drain: false`다(명령 끝 drain이 방금 만든 일감을 닫아 "두 번 불러도 하나"가 흐려지지 않게).
- **queue list:** 기본은 열린 일감(`completed_at is null`)만, `--all`이면 닫힌 것도, `--kind <kind>`로 거르고, `--limit`(1~200, 기본 50, Core 상수 `QUEUE_LIST_LIMIT`). 순서는 `created_at` 내림차순, `id` 내림차순. 행(snake_case): `id`, `kind`, `target_kind`, `target_id`, `execution_class`, `state`, `attempts`, `next_attempt_at`, `created_at`, `completed_at`, `cancel_requested_at`, `last_error`, `attempt_outcome`, `attempt_started_at`, `last_progress_at`, `elapsed_ms`, `usage`. `risk: 'read'`, meta `count`·`has_more`.
- **state 규칙(Core 함수 하나, 예: `workListState(item, latestAttempt)`):** `completedAt`이 있으면 `outcome`(`succeeded`|`failed`|`cancelled`|`dependency_failed`) → 현재 attempt(`currentAttemptToken`이 가리키는 것)의 결과가 `unknown`이면 `unknown` → `claimedAt`이 있으면 `running` → 그 밖은 `queued`.
- **attempt 칸:** 가장 최근 attempt(`started_at` 내림차순, token 내림차순) 하나의 값이다. attempt가 없는 일감(core drain 일감)은 `attempt_outcome`·`attempt_started_at`·`last_progress_at`·`elapsed_ms`·`usage`가 모두 null이다. `elapsed_ms`는 저장된 `elapsed_ms`가 있으면 그것, 없고 끝났으면 `finished_at - started_at`, 아직 안 끝났으면 `clock.now() - started_at`이다(Core가 계산한다. DB는 값을 만들지 않는다, AD-22). `usage`는 `{input_tokens, cached_input_tokens, output_tokens}` 또는 null이다(값 없음과 0을 구분한다). `stderr`는 목록에 내지 않는다.
- **doctor check `work-model-usage`:** 등록부에서 `callsModel: true`인 종류(새 `modelWorkKinds()`, `domain/work-item.ts`)의 모든 attempt에 대해 입력·캐시·출력 토큰 합과 걸린 시간 합(`elapsed_ms` 합, 없는 attempt는 빼기)을 보이고, 가장 최근 attempt(종류, 일감 id, 걸린 시간, 토큰)를 덧붙인다. 상태는 늘 `ok`이고(상한 없음), 모델 종류가 없거나 기록이 없으면 합이 0이다. 읽기는 새 `WorkStore.readModelWorkUsage({kinds})`이고 `DoctorReadStore`에 더한다. `DoctorOptions.modelWorkKinds?`가 기본값(`modelWorkKinds()`)을 대신할 수 있다(시험용). 호출 횟수·attempt 수는 보이지 않는다. DB 오류면 다른 work check처럼 `fail`과 코드.
- 출력은 dispatcher의 envelope·`encodeTextLine`(Core 출력 코덱)을 거친다. 사람용 줄은 모든 절에 한국어가 있다(output-language 시험). 0건일 때도 건수 줄을 낸다(`failures-list.ts` 선례).
- 새 Store verb 셋은 fake·PG에 같은 의미로 두고 계약 suite가 fake와 PG에서 돈다. 새 오류 코드·마이그레이션은 없다(`CORE_SCHEMA_VERSION`은 9 그대로).

**Never:**
- `queue cancel`의 동작, 청구·임대·token CAS, 예약 tick·발화 규칙, 성공 기록 의미는 바꾸지 않는다. interval 예약을 CLI로 만드는 길은 만들지 않는다.
- 보류 그룹·`extension_disabled`(12.10)와 install 스킬(epic 13)은 만들지 않는다. 모델 adapter가 usage를 채우는 일(epic 18)도 아니다.
- 호출 횟수나 사용량 상한·경고를 두지 않는다. CLI가 프로세스를 직접 건드리는 길을 만들지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 예약 추가·목록 | `schedules add … --at 11:00` 뒤 `schedules list --json` | 행 하나, `local_time: "11:00"`, `time_zone`은 설정값, `next_run_at` 있음 | — |
| 수동 실행 두 번 | 같은 예약에 `schedules run` 두 번 | 첫째 `created: true`, 둘째 `created: false`, 같은 `work_id`, 열린 일감 하나 | — |
| 지운 뒤 | `schedules remove <id>` 뒤 발화 시각이 지나 tick | 목록에서 빠지고 tick이 일감을 만들지 않는다 | — |
| 잘못된 입력 | `--at 24:00` / 없는 id / 같은 대상 두 번째 add / UUID 아닌 id | 아무것도 쓰지 않는다 | `SCHEDULE_INVALID` / `SCHEDULE_NOT_FOUND` / `SCHEDULE_CONFLICT`(exit 1) / `USAGE`(exit 2) |
| probe 목록 | probe 일감 청구 뒤 progress, usage `{10,2,5}`와 `elapsedMs: 1500`으로 성공 | `--all` 목록에 `state: succeeded`, `attempts: 1`, `attempt_outcome: succeeded`, `elapsed_ms: 1500`, `usage` 그 값 | — |
| 진행 중 | 청구만 된 probe, 시계가 시작 뒤 4초 | `state: running`, `elapsed_ms: 4000`, `usage: null` | — |
| unknown | 현재 attempt가 `unknown`으로 정산 | `state: unknown` | — |
| core 일감 | attempt 없는 대기 일감 | `state: queued`, attempt 칸 전부 null | — |
| 기본 필터 | 열린 것 하나와 닫힌 것 하나 | 기본은 열린 것만, `--all`은 둘 다 | `--limit 0` → `USAGE` |
| doctor | 모델 종류(시험 주입) attempt 둘: usage `{10,2,5}`·1000ms, `{1,0,1}`·500ms | `work-model-usage` ok, 입력 11·캐시 2·출력 6 토큰, 걸린 시간 1.5초, 최근 attempt | DB 불가 → `fail` |

</intent-contract>

## Code Map

- `packages/core/src/brain.ts:199-231,408-421` -- `BrainQueue`에 `list`, `schedules` 타입을 이름 붙은 인터페이스 `BrainSchedules`(`tick`·`add`·`list`·`remove`·`run`)로. 조립은 같은 `readTimeZone` 람다를 재사용한다. `queue.cancel` 구현(`:414`)이 Store 결과를 SDK 결과로 바꾸는 선례다.
- `packages/core/src/queue/schedules.ts` -- `addDaily`·`runSchedule`이 있다. 빈 문자열 검사를 `addDaily`에 더하고 `listSchedules`·`removeSchedule` use case(얇은 위임)를 더한다. 새 `packages/core/src/queue/list.ts`(이름 자유)에 `listWork` use case·`workListState`·`QUEUE_LIST_LIMIT`을 둔다.
- `packages/core/src/ports/store.ts:1415-1437` `ScheduleStore`에 `listSchedules({limit}) → {ok, schedules, hasMore}`, `removeSchedule({id}) → {ok, removed: boolean}`. `:682` `WorkStore`에 `listWork({includeClosed, kind?, limit}) → {ok, entries: {item: WorkItem; latestAttempt: WorkAttempt | null}[], hasMore}`와 `readModelWorkUsage({kinds}) → {ok, usage: {inputTokens, cachedInputTokens, outputTokens, elapsedMs, latest: {workItemId, kind, at, elapsedMs, usage|null} | null}}`. 실패 타입은 기존 `DB_UNAVAILABLE | DB_LOCKED`.
- `packages/core/src/domain/work-item.ts:160-171` -- `WORK_KINDS`의 `callsModel`을 읽는 `modelWorkKinds()`를 더한다. `WorkAttempt`(`:178`) 모양을 그대로 쓴다.
- `packages/core/src/doctor/doctor.ts:99-126,276-286` -- `DoctorReadStore`에 `readModelWorkUsage`, `DoctorOptions.modelWorkKinds?`, `workAttemptChecks` 곁에 새 check. `apps/cli/src/doctor/store.ts`가 doctor용 store를 조립하므로 함께 맞춘다.
- `packages/core/src/testing/fakes/store.ts` -- 예약 맵(`:185`, `:413-438`), 일감·attempt 맵, `cloneSchedule`(`:1582`). 지운 예약은 일감의 `scheduledDates.scheduleId`를 null로, 성공 기록을 지운다(PG FK와 같게). 반환은 `structuredClone`.
- `packages/core/src/testing/contracts/schedule-store.ts`, `.../work-store.ts` -- 새 verb case.
- `packages/postgres/src/schedules.ts` -- `rowSchedule`·`readSchedule` 재사용. `remove`는 `delete … returning id`. UUID가 아닌 id는 CLI preflight가 막는다.
- `packages/postgres/src/work.ts` -- `toWorkItem`·`readOpenWork` select 목록 재사용. 최신 attempt는 `left join lateral (… order by started_at desc, token desc limit 1)`. `limit + 1`로 `hasMore`. `readWorkAttemptHealth`(`:349-373`)가 attempt 읽기·시각 변환(`at(...)`) 선례다. 사용량은 `work_attempts.input_tokens` 등(0005)의 `sum`·`coalesce(…,0)`.
- `apps/cli/src/commands/queue-cancel.ts`, `failures-list.ts` -- 명령 파일 모양, UUID preflight, `--limit` 파싱, `isoWithOffset`, 건수 줄의 선례. `index.ts`가 등록부이고 `guide schema`가 그것을 읽는다.
- `apps/cli/test/queue-cancel.test.ts`, `supervisor-fixture.ts`, `pg-home.ts` -- PG CLI 시험 선례(`runPgCommand`, `enqueueProbe`, `claimSupervisedWork`·`finishSupervisedWork`를 store로 직접 부름). 설정 `timezone` 쓰기는 `config set` 명령이나 store `setSetting`.
- `apps/cli/test/command-meta.test.ts`, `guide.test.ts`, `output-language.test.ts`, `doctor-run.test.ts`, `packages/postgres/test/unavailable.test.ts` -- 등록부·schema·언어·doctor id 목록·DB 불가 verb 목록 시험. 새 verb와 check가 이들에 걸리면 함께 맞춘다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `domain/work-item.ts`, `queue/schedules.ts`, `queue/list.ts`(새), `brain.ts`, `index.ts` -- 타입·verb·use case·SDK 표면, `addDaily`→`add` 이름 변경 -- SDK 1:1.
- [x] `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/store.ts` -- `work-model-usage` check.
- [x] `packages/core/src/testing/fakes/store.ts`, `packages/postgres/src/schedules.ts`, `packages/postgres/src/work.ts` -- 새 verb 넷의 fake·PG 구현.
- [x] `packages/core/src/testing/contracts/schedule-store.ts`, `work-store.ts` -- case: `lists schedules in creation order with has_more`, `removing a schedule stops its firing and keeps its open work`, `remove reports a missing schedule`, `lists open work newest first with the latest attempt`, `lists closed work only when asked and filters by kind`, `sums model usage over the given kinds only`.
- [x] `apps/cli/src/commands/schedules-{add,list,remove,run}.ts`, `queue-list.ts`, `commands/index.ts` -- 명령 다섯.
- [x] `packages/core/test/queue-list.test.ts`(새, `memoryStore`·`manualTime`·`createBrain`) -- 행렬의 state·elapsed·usage·필터 행: `derives queued, running, unknown and closed states`, `computes elapsed from the clock for a running attempt`, `keeps usage null apart from zero`. `packages/core/test/doctor.test.ts` -- `reports model work tokens and elapsed time without counts`, `fails the model usage check when the store cannot be read`. `packages/core/test/schedule-daily.test.ts` -- `add` 이름으로 고친다.
- [x] `apps/cli/test/schedules-queue-list.test.ts`(새, PG) -- `adds a local schedule and lists it`, `runs a schedule twice into one open work`, `stops firing after remove`, `rejects invalid schedule input with codes`, `lists a finished probe with state, attempt, elapsed and usage`, `shows the new verbs in guide schema`, `doctor shows model tokens and elapsed time`(CLI에서는 모델 종류가 없으므로 `work-model-usage`가 `ok`이고 토큰·걸린 시간 0을 보인다). 지운 뒤 발화는 CLI로 만든 예약을 `remove`한 뒤, 시험 안에서 PG store와 Core `tickSchedules`(시계는 원래 `next_run_at` 뒤)를 직접 불러 `fired`가 0이고 그 대상의 일감이 늘지 않음을 본다. 같은 절차를 지우기 전 예약에 하면 발화한다는 대조도 둔다.

**Acceptance Criteria:**
- Given 이 Mac의 PG 시험 DB, when CLI 시험이 `schedules add`·`list`·`run` 두 번·`remove`·`queue list --json --all`·`guide schema`·`doctor run --json`을 차례로 부른다, then 예약이 목록에 보이고, 수동 실행 두 번이 열린 일감 하나를 남기며, 지운 예약은 tick에서 일감을 만들지 않고, probe 행에 상태·attempt·걸린 시간·`usage`가 있으며, schema에 다섯 verb가 있고, doctor에 `work-model-usage`가 토큰과 걸린 시간을 보인다.
- Given 새 Store verb 넷, when 계약 suite가 fake와 PG에서 돈다, then 같은 결과를 낸다.

## Implementation Notes

- 구현 세션(codex, 커밋 `31653e4`)이 명령 다섯(`schedules add|list|remove|run`, `queue list`), SDK `BrainSchedules`·`queue.list`(`addDaily`→`add`), Store verb 넷(`listSchedules`·`removeSchedule`·`listWork`·`readModelWorkUsage`)의 fake·PG·계약, doctor `work-model-usage`를 만들었다.
- `CommandOption.required`를 더해 commander `requiredOption`으로 등록한다(`apps/cli/src/dispatch.ts`). 빠진 옵션은 `USAGE`(exit 2)다.
- 구현 세션의 자체 점검: 시작 시각이 같은 두 attempt에서는 최신 attempt만으로 `unknown`을 판정할 수 없어서, `listWork`가 표시용 `latestAttempt`와 상태 판정용 `currentAttempt`(현재 token)를 따로 돌려준다. 재현 시험을 fake·PG 계약과 Core에 더했다.
  - (조율자 주: 구현 세션이 frontmatter를 `built`·`quick`으로 바꾸고 자체 점검을 Review Triage Log에 적었다. 조율자가 `in-progress`로 되돌리고 그 내용을 여기로 옮겼다.)

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` quick 1: `apps/cli/src/commands/queue-list.ts`의 사람용 줄이 마지막 진행 시각과 최근 attempt 결과를 빠뜨려 텍스트 모드 `brain queue list`가 E12-10의 "마지막 진행"을 보이지 않음 — 확인: JSON 행에는 `attempt_outcome`·`last_progress_at`이 있으나 `text`에는 없었다. 구현 세션이 각 행 줄에 `attempt 결과 …`·`마지막 진행 …` 절을 더했고, probe CLI 시험에 텍스트 모드 단언을 더했다. 대상 CLI 시험 247개와 `pnpm test` 3,300개가 통과했다.

### 2026-10-29 — 후속 Quick 검토
- 판정: 지적 0건 — high 0, medium 0, low 0, false 0, maybe-false 0.
- 지적: 없음. 새 읽기 전용 codex 세션이 기준 커밋 `73f4bf272429d680e48872b96275845ab382c43a` 이후 전체 diff와 수용 조건을 정적으로 대조했다.
- 이번 검토의 수정 0건, 새 보류 0건, 기각 0건. 기존 deferred-work 항목은 변경하지 않았다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): "모델 분류 일감"은 등록부 `WORK_KINDS`의 `callsModel: true` 종류다(정체 창이 이미 이 칸을 읽는다). 지금은 그런 종류가 없어서 CLI의 doctor는 0을 보이고, 0이 아닌 합은 Core 시험이 `modelWorkKinds`를 주입해 확인한다. usage가 있는 attempt를 모두 모델 일감으로 치는 안은 등록부를 우회하므로 택하지 않았다.
- Decision(2026-10-29, 추천으로 정함): 작업 목록의 걸린 시간·usage는 가장 최근 attempt의 값이다. 일감 전체 합은 doctor가 종류별로 보인다. 목록의 기본 범위는 열린 일감(지금 무엇이 걸려 있나가 질문이다), `--all`이 닫힌 것을 더한다(`failures list` 선례).
- Decision(2026-10-29, 추천으로 정함): `schedules add`는 매일 예약만 만든다. interval 예약은 Core 내부 용도로 남는다. kind 이름은 검증하지 않는다(확장 종류는 epic 13 registry가 생기기 전에는 Core가 모른다).

## Verification

**Commands:**
- `pnpm exec vitest run --project core test/queue-list.test.ts test/doctor.test.ts test/schedule-daily.test.ts test/contracts.test.ts` -- expected: 새 시험 이름 전부 통과.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/unavailable.test.ts` -- expected: PG 계약 suite 통과. PG 사전 조건: OrbStack이 켜져 있다(global setup이 시험 컨테이너를 띄운다).
- `pnpm exec vitest run --project cli test/schedules-queue-list.test.ts test/command-meta.test.ts test/guide.test.ts test/output-language.test.ts test/doctor-run.test.ts` -- expected: CLI 시험 통과(관찰값은 행렬과 AC).
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.
- `git diff --check` -- expected: 출력 없음.

**Results (2026-10-29):**
- `pnpm test`: build·typecheck 및 123개 파일, 3300개 시험 통과.
- Core 집중 시험: 331개 통과. PostgreSQL 집중 시험(`test/store.test.ts` 포함): 239개 통과.
- `git diff --check`: 통과. Quick 검토에서 발견한 현재 attempt 상태 판정 문제를 수정하고 fake·PG 계약 및 Core 재현 시험을 추가했으며, 재검토에서 남은 지적 없음.
- 중간 전체 실행에서 기존 redaction cleanup 대기 및 시험 DB migration 연결 timeout이 각각 한 번 발생했으나 단독/집중 시험과 최종 전체 재실행은 통과했다. PostgreSQL client 병렬 query deprecation warning은 남아 있다.

## Auto Run Result

- 인계 상태: `built`. 기존 계획의 `status: 'built'`를 유지했다. 티켓을 `done`으로 표시하지 않았고 `tickets.py mark`는 실행하지 않았다. 최종 완료 판정은 오케스트레이터가 한다.
- 구현 요약: 기존 구현의 `schedules add|list|remove|run`·`queue list`와 SDK·CommandSpec의 대응, 예약 수동 실행 중복 방지·삭제, 작업 상태·attempt·마지막 진행·걸린 시간·토큰, doctor 모델 사용량 표시를 후속 검토했다. 이번 실행에서는 소스를 수정하지 않았다.
- 기준 커밋: `73f4bf272429d680e48872b96275845ab382c43a`. 검토한 구현 커밋: `31653e49513aadb3f6b5cd7fc2016ed5fa4e4185`, `8d97ff9bebac60aa1cb1311e6f43bb331083c4e5`.
- 검토 대상 파일:
  - `apps/cli/src/commands/schedules-{add,list,remove,run}.ts`, `queue-list.ts`, `list-options.ts`, `index.ts` — 예약·작업 명령과 옵션 검증·등록부.
  - `apps/cli/src/dispatch.ts`, `doctor/store.ts` — 필수 옵션 처리와 doctor Store 조립.
  - `packages/core/src/brain.ts`, `index.ts`, `queue/{list,schedules}.ts`, `ports/store.ts`, `domain/work-item.ts`, `doctor/doctor.ts` — SDK·Store 계약·작업 표시·모델 사용량 집계.
  - `packages/core/src/testing/fakes/store.ts`, `testing/contracts/{schedule,work}-store.ts` — fake 구현과 공통 계약 시험.
  - `packages/postgres/src/{schedules,work}.ts`, `test/unavailable.test.ts` — PG 예약·작업 조회·삭제·사용량 구현과 DB 불가 시험.
  - `apps/cli/test/{schedules-queue-list,dispatch,doctor-run}.test.ts`, `packages/core/test/{queue-list,doctor,schedule-daily}.test.ts` — 명령·SDK·출력·사용량 검증.
- 이번 실행의 변경 파일: 이 계획 파일 — 후속 검토 기록과 실행 결과를 추가했다.
- 후속 Quick 검토: 새 지적 0건. 적용한 patch 0건(high 0, medium 0, low 0), 새 보류 0건, 기각 0건. 기존 deferred-work ledger의 항목·상태·해결 기록은 수정하지 않았다.
- 후속 리뷰 권고: `false`. 이번 후속 검토에서 high patch나 미검증 위험이 발견되지 않았다.
- 검증: `pnpm test` 종료 코드 0. build·typecheck 및 123개 파일의 시험 3,300개가 통과했다. 검토자는 정적 검토만 수행했고 전체 시험은 조율자가 실행했다.
- `git diff --check 73f4bf272429d680e48872b96275845ab382c43a`: 최종 계획 기록 후 통과했다.
- 남은 한계: 현재 등록부에는 `callsModel: true`인 종류가 없어 실제 doctor의 모델 합계는 0이며, 0이 아닌 합은 주입한 종류로 시험한다. 모델 adapter는 epic 18 소관이다. 기존 PostgreSQL client 병렬 query deprecation 경고가 시험 중에도 출력되었으나 실패는 없었다.
