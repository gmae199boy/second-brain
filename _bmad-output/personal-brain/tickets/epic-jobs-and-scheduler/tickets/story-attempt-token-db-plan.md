---
title: '오래된 쓰기 거부: 회수된 attempt의 token으로는 DB에 쓸 수 없다'
type: 'feature'
ticket: '3'
created: '2026-10-29'
status: done
baseline_revision: c4580ed0b2cca4e476a3b8a0ffa16250fac7b46b
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
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-untitled-plan.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** attempt token의 오래됨은 지금 TS의 PG verb 안 조건(`lockOpenSupervisedWork`)으로만 막힌다. 자식 프로세스나 확장 role이 DB에 직접 INSERT하면 회수·취소·새 attempt 뒤의 옛 token으로도 써진다(E12-4, AD-30·33).

**Approach:** 새 core 마이그레이션 `0004`에 판정 함수 `brain.attempt_is_current(work_item_id uuid, attempt_token uuid) returns boolean` 하나와, 그것을 부르는 공용 INSERT trigger 함수 `brain.reject_stale_attempt()`를 둔다. PG의 supervised token verb(결과 확정 포함)는 판정을 이 함수로 한다. 시험 안에서 만든 계약 표에 trigger를 붙인 예로 계약 시험을 고정한다.

## Boundaries & Constraints

**Always:**
- "살아 있는 attempt" = `work_items.id = $1`, `current_attempt_token = $2`, `completed_at is null`, 그 token의 `work_attempts.outcome is null`. `cancel_requested_at`·`claim_expires_at`은 보지 않는다(취소 요청 뒤에도 정산 전까지 살아 있다. 시각 비교 없음 — 12.2에서 현재 token은 만료로 회수되지 않는다). 인자 중 하나라도 null이면 false.
- 판정 함수는 일치하는 `work_items`·`work_attempts` 두 행을 `for share`로 잠그며 읽는다. 그래야 정산·확정(`for update`)과 trigger의 INSERT가 서로를 기다리고, 판정과 커밋 사이에 token이 바뀌지 않는다. 그래서 `volatile`이다.
- 두 함수 모두 `security definer`, `set search_path = ''`, 이름은 모두 schema로 한정한다. 소유자는 마이그레이션 role(`brain_owner`). 확장 role에게 `work_items`·`work_attempts` 권한을 주지 않아도 된다.
- EXECUTE: `brain.attempt_is_current`는 PUBLIC에 준다(`grant execute ... to public`을 적는다). `brain_app`과 함수가 만들어진 **뒤에** 생긴 확장 role이 따로 grant 없이 부른다(13.4 "함수가 만들어진 뒤 생긴 role에도 이어지게"). trigger 함수는 trigger로만 불린다.
- trigger 함수: `tg_argv[0]`·`tg_argv[1]`이 일감 id·token 칸 이름(인자가 없으면 `work_item_id`·`attempt_token`). 값은 `to_jsonb(new)`로 읽는다. 칸이 없으면 설정 오류로 raise, 판정이 false면 `raise exception 'reject_stale_attempt: invariant refused' using errcode = 'BRS01'`(0001의 `<이름>: invariant refused` 관례 + 호출자가 가릴 전용 SQLSTATE). 통과하면 `return new`.
- 0001~0003은 고치지 않는다. 새 파일 `0004_attempt_fence.sql`, `CORE_SCHEMA_VERSION = 4`. 마이그레이션과 두 함수 본문에 `default now()`·serial·identity·`now()`·`current_timestamp`·`clock_timestamp`·`gen_random_uuid`가 없다(AD-22).

**Never:**
- 실제 core 계약 표(건강 측정·`analyses`·`file_requests`·채널 발신), RLS, 확장 role 생성(13.4·14·15의 몫)은 만들지 않는다. 시험 계약 표·시험 role은 시험 DB 안에서만 만든다.
- core drain 청구(`claimed_by` CAS), WorkStore port·fake store·감독자 동작은 바꾸지 않는다. stale 확정의 결과는 지금처럼 `lost`다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 현재 token | 청구된 supervised 일감, token A | 함수 true, 시험 표 INSERT 성공(`brain_app`·새 role 모두) | — |
| 취소 요청 중 | A 실행 중 `requestWorkCancel` → `requested` | 아직 true, INSERT 성공 | — |
| 회수 | A를 `settleSupervisedAttempt(died)` | false, A INSERT 거부 | `BRS01` |
| 취소 정산 | 요청 뒤 `settle(cancelled)` | false, A INSERT 거부, `finishSupervisedWork(A)` `lost` | `BRS01` |
| 새 attempt | 회수 뒤 token B 청구 | A false·거부, B true·성공 | `BRS01` |
| `unknown` | A를 `settle(unknown)`(token 유지) | false, 거부 | `BRS01` |
| 확정 뒤 | A `succeeded`/`failed` 확정 | false, 거부 | `BRS01` |
| 엉뚱한 짝·빈 값 | 다른 일감 id + A, 없는 token, token null | false, 거부 | `BRS01` |
| 칸 없음 | trigger 인자가 표에 없는 칸 이름 | INSERT 오류 | 설정 오류 메시지 |
| 경합 | 한쪽 트랜잭션이 정산 중(미커밋) / INSERT 중(미커밋) | INSERT가 기다린 뒤 거부 / 정산이 기다린 뒤 성공 | — |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0003_supervised_cancel.sql`·`0002_supervised_attempts.sql` -- 읽기 전용 원본. `work_attempts.outcome`(null = 열림), `work_items.current_attempt_token`·`completed_at`. 권한 문장 꼴.
- `packages/postgres/migrations/0001_initial.sql:374-` -- trigger 함수 관례(`create function brain.<name>_fn() returns trigger language plpgsql`, `raise exception '<name>: invariant refused'`). 고치지 않는다.
- `packages/postgres/src/migrate.ts` -- `CORE_SCHEMA_VERSION`. 실행기는 `set role brain_owner`로 적용한다(함수 소유자).
- `packages/postgres/src/setup.ts:45-53` -- role 준비. `brain` schema USAGE는 `brain_app`·`brain_maintenance`만. 고치지 않는다(새 role의 schema USAGE는 13.4가 준다).
- `packages/postgres/src/work.ts:531-539` `lockOpenSupervisedWork` -- record·renew·settle·finish 넷이 쓰는 helper. `for update`로 일감 행을 먼저 잠그는 것은 그대로 두고(같은 일감의 두 verb가 share→update 승격으로 교착하지 않게), 두 번째 attempt 조회를 `select brain.attempt_is_current(id, token)`로 바꾼다. `finishSupervisedWork`(:280) 마지막 update의 `current_attempt_token` 조건은 그대로 둬도 된다.
- `packages/postgres/test/fixture.ts` -- `database()`(`db.url` 소유자/superuser, `db.appUrl` = `brain_app`), `subject()`(store + `readWorkItem`). `packages/postgres/test/schema.test.ts:14` `refused()`의 savepoint 꼴, `work-store.test.ts`의 12.2 별도 연결·잠금 장벽 경합 시험 꼴.
- 버전 3 고정처(12.2 커밋 `c4580ed`가 2→3으로 바꾼 곳과 같다): `packages/postgres/test/store.test.ts`·`cli.test.ts`·`migrate.test.ts`, `apps/cli/test/install.test.ts`·`setup.test.ts`·`sessions-ingest.test.ts`·`dispatch.test.ts`·`doctor-run.test.ts`·`queue-drain.test.ts`·`daemon-run.test.ts` 등. `schema_version: 3`·`core: 3` → 4, 불일치 시험의 `version = 4` → 5, `/4.*3/` → `/5.*4/`. `grep -rn` 으로 빠짐없이.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0004_attempt_fence.sql`, `packages/postgres/src/migrate.ts` -- 위 Always의 두 함수와 EXECUTE, 머리 주석에 계약 표가 붙이는 예 한 줄(`create trigger <표>_attempt_fence before insert on <표> for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token')`). 버전 4.
- [x] `packages/postgres/src/work.ts` -- `lockOpenSupervisedWork`가 판정 함수를 부른다.
- [x] 버전 고정 시험들 -- 3 → 4(위 Code Map). `migrate.test.ts`의 적용 목록에 `0004_attempt_fence.sql`.
- [x] `packages/postgres/test/attempt-fence.test.ts`(새) -- 각 시험은 격리 DB에서 소유자 연결로 시험 schema·계약 표(`id uuid primary key, work_item_id uuid not null, attempt_token uuid, body text not null`)와 trigger를 만들고, `brain_app`과 **마이그레이션 뒤** 만든 고유 이름의 role(login, nosuperuser, nobypassrls, 시험 schema USAGE·표 INSERT와 `brain` USAGE만; `work_items`·`work_attempts` 권한 없음)에 INSERT를 준다. 일감·attempt 상태는 `subject()`의 store verb(`addWork`/supervised 청구·정산·확정·취소)로 만든다. 행렬 전 행을 시험한다. 시험 role은 finally에서 지운다(cluster 전역).
- [x] 같은 파일 -- 결과 확정 경로가 함수를 부른다는 증거: 시험 DB에서 소유자로 `brain.attempt_is_current`를 항상 false로 `create or replace`한 뒤, 현재 token의 `finishSupervisedWork`가 `lost`이고 일감이 그대로임을 본다.
- [x] 같은 파일 -- AD-22·권한 카탈로그: `0004` 파일 본문과 `pg_get_functiondef`의 두 함수에 금지 낱말이 없음, 두 함수가 `prosecdef`이고 `proconfig`에 `search_path=""`, 새 role이 `has_function_privilege(..., 'EXECUTE')` true이고 `has_table_privilege(role, 'brain.work_items', 'SELECT')` false.

**Acceptance Criteria:**
- Given supervised 일감의 token A가 회수·취소·새 attempt B로 바뀌었다, when 마이그레이션 뒤 만든 확장 꼴 role(work 표 권한 없음)과 `brain_app`이 A로 시험 계약 표에 직접 SQL INSERT한다, then 둘 다 SQLSTATE `BRS01`로 거부되고 표에 행이 없으며, 같은 role의 B INSERT는 들어간다.
- Given 정산 트랜잭션이 A의 일감 행을 잠근 채 커밋하지 않았다, when 다른 연결이 A로 INSERT한다, then INSERT는 정산 커밋까지 기다린 뒤 `BRS01`로 거부된다. 반대로 A INSERT 트랜잭션이 열려 있으면 `finishSupervisedWork(A)`는 그 커밋 뒤에 `done`이다.

## Implementation Notes

- `0004_attempt_fence.sql`에 `brain.attempt_is_current(uuid, uuid)`(volatile·security definer·`search_path = ''`, 두 행 `for share of w, a`, PUBLIC EXECUTE)와 `brain.reject_stale_attempt()`(security definer, `tg_argv` 칸 이름, 거부는 `BRS01`, PUBLIC EXECUTE 회수)를 추가했다. `CORE_SCHEMA_VERSION = 4`.
- `packages/postgres/src/work.ts`의 `lockOpenSupervisedWork`가 일감 행 `for update` 뒤 두 번째 조회를 `brain.attempt_is_current`로 바꿨다. record·renew·settle·finish 네 verb가 같은 판정을 쓴다.
- `packages/postgres/test/attempt-fence.test.ts`(새, 시험 14개): 행렬 전 행, 함수 교체로 확정 경로의 DB 판정 사용 증명, AD-22·definer·권한 카탈로그, 양방향 잠금 경합. `fixture.ts`의 `subject()`가 `db`를 함께 돌려준다.
- 버전 고정 시험(postgres 4파일, cli 7파일)을 3 → 4, 불일치 시험 값을 4 → 5로 맞췄다.
- 2026-10-29(오케스트레이터) 검증: `pnpm build` 성공, plan Verification의 PG 7파일 196개 통과, `pnpm test` 116파일 2,850개 통과. 행렬 10행 모두 위 시험이 덮고 실행·통과했다.

- `0004_attempt_fence.sql`에 두 definer 함수와 권한을 추가하고 core 버전을 4로 올렸다. 판정 함수는 현재 열린 일감·attempt 두 행에 `for share`를 잡으며, trigger는 기본·명시·변경된 칸 이름을 지원하고 오래된 token을 `BRS01`로 거부한다.
- `lockOpenSupervisedWork`는 기존 일감 `for update` 순서를 유지한 채 DB 판정 함수를 호출한다. Store port·fake·감독자·core drain과 기존 0001~0003은 변경하지 않았다.
- `subject()`가 격리 DB를 시험에 노출하게 하고, 새 시험 파일에서 행렬 전체·마이그레이션 뒤 생성한 role·AD-22·권한 카탈로그·함수 교체에 따른 확정 거부·양방향 잠금 경합을 검증한다. attempt 행 자체의 share 잠금도 별도로 관찰한다.
- 기존 PostgreSQL·CLI 시험의 현재 버전·불일치 버전·복원 버전 기대값과 마이그레이션 적용 목록을 갱신했다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 12 findings — high 0, medium 0, low 7, false 5, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind-hunter) 임대 만료 시험이 다른 청구의 `now`만 옮겨 만료 뒤 INSERT 허용을 따로 검증하지 못한다 — 판정 함수는 시각 입력이 없고, 같은 파일의 AD-22 시험이 두 함수 본문에 `now(`·`current_timestamp`·`clock_timestamp`가 없음을 확인한다. 저장된 `claim_expires_at`이 판정에 들어갈 길이 없으므로 만료가 INSERT를 바꾸는 결과는 생기지 않는다.
  - `[low]` `[reject]` (blind-hunter) `w.completed_at is null` 조건을 따로 검증하지 않아 지워도 시험이 통과한다 — 현재 token이 남은 채 `completed_at`만 채워진 상태는 PG verb가 만들지 않는다(완료하는 모든 verb가 token을 비운다). 방어 조건의 회귀를 막는 시험 추가로, 일상에서 만날 결함이 아니다.
  - `[low]` `[reject]` (blind-hunter) 다른 일감의 token을 현재 token으로 가리키는 상태에서 `a.work_item_id = w.id` 연결 조건을 검증하지 않는다 — 청구는 attempt와 일감을 같은 id로 한 트랜잭션에 쓰므로 그런 상태는 코드로 생기지 않는다. 방어 조건 시험 추가로, 일상 결함이 아니다.
  - `[low]` `[reject]` (blind-hunter) 미커밋 `unknown` 정산과 INSERT의 경합 시험이 없다 — 정산이 일감 행을 `for update`로 잡으므로 INSERT의 `for share of w, a`가 기다리고, 커밋 뒤 갱신된 attempt 행을 PG가 다시 평가해(`a.outcome is null` 불성립) 거부한다. 동작은 맞고, attempt 행 잠금은 `also holds a share lock on the attempt row until the INSERT commits`가 확인한다. 시험 추가만 남아 기각.
  - `[low]` `[reject]` (blind-hunter) 정산이 롤백되면 기다리던 INSERT가 성공하는지 시험이 없다 — 롤백이면 행이 바뀌지 않아 잠금을 얻은 INSERT가 그대로 통과한다(PG 행 잠금 의미). 결함은 없고 시험 추가 제안이다.
  - `[low]` `[reject]` (blind-hunter) 판정 함수를 false로 바꾸는 시험이 `finishSupervisedWork`만 본다 — record·renew·settle·finish 넷은 같은 helper `lockOpenSupervisedWork`(`packages/postgres/src/work.ts:531`)를 거치므로 따로 갈라질 길이 없다. 의도가 요구한 것은 결과 확정 경로이고, 그 증거는 있다.
  - `[low]` `[reject]` (blind-hunter) 정산이 장벽 전에 실패하면 `await acquired`가 끝나지 않아 시험이 timeout까지 멈추고 정리가 늦는다 — 이미 실패한 시험에서만 생기고 시험 role 이름은 무작위라 충돌하지 않는다. 고치려면 경합 감시 분기를 더해야 한다.
  - `[false]` `[reject]` (intent-alignment) "DB 함수 하나"인데 함수가 둘이다 — 판정 함수는 `brain.attempt_is_current` 하나이고, `brain.reject_stale_attempt`는 그것을 부르는 trigger 접착부다. 에픽 E12-4가 "INSERT trigger도 그것을 부른다"고 정한 모양이다.
  - `[false]` `[reject]` (intent-alignment) 취소 요청 뒤에도 INSERT가 허용되어 "취소 뒤"의 해석이 갈린다 — 12.2(done)의 계약에서 취소는 DB 요청을 감독자가 실행하는 것이고, 요청 뒤 자식의 `result`는 `succeeded`로 확정된다. 확정이 허용되는 동안 계약 INSERT만 막으면 둘이 어긋난다. 취소 정산(`settle(cancelled)`) 뒤에는 거부됨을 `rejects token A after cancelled for both roles`가 확인한다.
  - `[false]` `[reject]` (intent-alignment) 운영 계약 표와 UPDATE·DELETE는 보호하지 않는다 — 에픽 Boundaries가 계약 표와 그 trigger를 epic 14·15로, AD-30이 확장 role을 INSERT 전용으로 정했다. 의도는 시험 계약 표의 INSERT trigger 예를 요구한다.
  - `[false]` `[reject]` (intent-alignment) B 청구 뒤 옛 A의 결과 확정 시험이 없다 — `packages/core/src/testing/contracts/work-store.ts:132`의 계약 case가 A를 `died`로 정산하고 B를 청구한 뒤 A의 `renewSupervisedLease`·`finishSupervisedWork`가 `lost`이고 일감이 바뀌지 않음을 단언하며, PG에서 `packages/postgres/test/work-store.test.ts`로 돈다.
  - `[low]` `[reject]` (intent-alignment) 시험 이름·실행 명령의 plan 기록이 diff에 없다 — plan의 Verification에 명령과 시험 파일이 있고, 개별 시험 이름은 아래 Auto Run Result에 적었다. 고치려면 이 plan의 본문을 고쳐야 하므로 기각.

### 2026-10-29 — 후속 thorough 검토
- verdicts: 16 findings — high 0, medium 0, low 11, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind-hunter) 정산이 장벽 전에 종료되면 `await acquired`가 끝나지 않는다 — carried: 앞선 동일 위치·주장 판정을 유지한다. 이미 실패한 시험에서만 생기며 조기 종료 감시 분기와 정리 경로 보강이 필요하므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) 두 INSERT가 동시에 통과하는지 시험하지 않는다 — 현재 시험은 INSERT와 확정의 배제만 관찰한다. 실제 SQL은 `for share of w, a`로 쓰기 두 건의 share 잠금이 호환되므로 구현 결함은 없다. 추가 경합 시험과 장벽이 필요한 낮은 위험의 회귀 시험 제안이라 기각한다.
  - `[low]` `[reject]` (blind-hunter) 미커밋 `unknown` 정산과 INSERT의 경합 시험이 없다 — carried: 앞선 동일 위치·주장 판정을 유지한다. 기존 일감 행 잠금과 attempt 상태 재평가가 거부를 보장하며 별도 경합 시험 추가만 남으므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) 정산 롤백 뒤 INSERT 성공 시험이 없다 — carried: 앞선 동일 위치·주장 판정을 유지한다. 롤백 뒤 행이 유지되는 PG 잠금 의미의 추가 시험이며 일상 결함이 없어 기각한다.
  - `[low]` `[reject]` (blind-hunter) `completed_at is null` 조건을 독립적으로 검증하지 않는다 — carried: 앞선 동일 위치·주장 판정을 유지한다. 기존 상태 조합을 소유자 SQL로 인위적으로 만드는 방어 조건 시험이 필요하므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) `a.work_item_id = w.id` 연결 조건을 독립적으로 검증하지 않는다 — carried: 앞선 동일 위치·주장 판정을 유지한다. 정상 청구가 만들지 않는 불일치 상태를 소유자 SQL로 만드는 방어 조건 시험이 필요하므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) trigger 함수의 PUBLIC EXECUTE 회수를 시험하지 않는다 — 마이그레이션 끝에 명시적 `revoke execute on function brain.reject_stale_attempt() from public`가 있다. 직접 실행은 trigger 반환형 제약으로 일반 함수처럼 호출할 수 없고 기존 trigger 실행은 시험한다. 카탈로그 단언을 더하는 회귀 시험 제안이며 실제 권한 결함이 없어 기각한다.
  - `[low]` `[reject]` (blind-hunter) 기본·변경 칸 이름 표에서 stale token을 별도로 시험하지 않는다 — 성공과 null 검사가 칸 매핑을 관찰하고 모든 매핑은 같은 `brain.attempt_is_current` 호출로 합쳐진다. 이 호출의 stale 거부는 두 role로 검증되어 있다. 상태 전환과 추가 INSERT를 반복하는 시험 보강만 필요하므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) 종료 outcome 시험에 `stalled`가 없다 — `settleSupervisedAttempt`는 `stalled`에도 attempt의 non-null outcome 기록과 current token 제거를 수행하고, 판정 함수는 outcome 종류 대신 null 여부만 읽는다. 기존 `died`와 같은 거부 경로이며 별도 회귀 시험 제안이므로 기각한다.
  - `[low]` `[reject]` (edge-case-hunter) 장벽 전 정산 실패에서 시험 정리가 지연된다 — carried: 기존 triage의 같은 `await acquired` 위치와 같은 조기 종료 주장이다. 앞선 low·reject 판정을 유지하며 다시 수정하거나 보류하지 않는다.
  - `[false]` `[reject]` (intent-alignment) 취소 요청 직후에도 INSERT가 허용된다 — carried: 앞선 동일 주장 판정을 유지한다. 취소 요청과 종료 정산은 다르고 기존 감독자 계약은 요청 경합 중 성공 결과를 허용한다. `cancelled` 정산 뒤에는 두 role의 INSERT가 거부된다.
  - `[false]` `[reject]` (intent-alignment) 모든 DB 쓰기를 차단하지 않는다 — carried: 앞선 동일 주장 판정을 유지한다. 티켓 본문은 시험 계약 표의 INSERT trigger를 요구하고 운영 계약 표 연결은 epic 14·15의 몫으로 명시한다.
  - `[false]` `[reject]` (intent-alignment) 함수가 총 두 개다 — carried: 앞선 동일 주장 판정을 유지한다. 판정 함수는 하나이며 다른 함수는 이를 부르는 INSERT trigger 접착부다.
  - `[false]` `[reject]` (intent-alignment) B 청구 뒤 A의 결과 확정 거부가 새 시험에 없다 — carried: 앞선 동일 주장 판정을 유지한다. 기존 `packages/core/src/testing/contracts/work-store.ts`의 PG에서도 실행되는 계약이 B 청구 뒤 A 확정의 `lost`와 일감 불변을 단언한다.
  - `[false]` `[reject]` (intent-alignment) 미래 role의 직접 호출에는 schema USAGE도 필요하다 — 티켓은 EXECUTE 권한을 요구하며 PUBLIC grant가 이후 role에도 이어진다. 새 role의 직접 호출과 work 표 SELECT 부재를 시험하고, schema USAGE 없이도 trigger INSERT가 성공함을 추가로 검사한다. 운영 role 구성은 epic 13의 범위여서 요구 누락이 아니다.
  - `[low]` `[reject]` (intent-alignment) plan에서 개별 시험 이름을 가리키는 결과 절이 없다 — carried: 앞선 동일 plan 기록 주장 판정을 유지한다. 시험 파일·실행 명령은 Verification에 있고, plan 편집만으로 고치는 지적은 워크플로 규칙에 따라 기각한다. 이번 결과 절에는 실제 시험 이름을 기록한다.

## Design Notes

- PUBLIC EXECUTE를 고른 이유: role은 setup·확장 설치가 만들고 마이그레이션은 role을 만들 수 없다. PUBLIC이면 이후의 `brain_ext_<name>`에 따로 grant가 필요 없다. 함수는 (일감 id, token) 짝이 살아 있는지 참·거짓만 답하고, token을 모르면 아무것도 알 수 없다. security definer이므로 확장 role은 work 표 권한 없이 부르고, AD-30의 "그 밖의 core 표 권한 없음"이 유지된다. 직접 부르려면 `brain` schema USAGE가 필요하지만 trigger 경로는 필요 없다(trigger 함수도 definer).
- `for share`의 대가: 계약 INSERT 트랜잭션이 열려 있는 동안 그 일감의 임대 갱신·정산이 기다린다. AD-7(트랜잭션 2초 이내)이 확장에도 걸리므로 받아들인다.
- epic 14·15는 계약 표를 만들 때 `work_item_id uuid`·`attempt_token uuid` 칸을 두고 위 trigger 한 줄을 붙인다. 칸 이름이 다르면 trigger 인자로 준다.

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project postgres test/attempt-fence.test.ts test/work-store.test.ts test/migrate.test.ts test/migrate-files.test.ts test/store.test.ts test/schema.test.ts test/cli.test.ts` -- expected: 통과. PG 사전 조건: test-db global setup(OrbStack의 시험 PG) 또는 `BRAIN_TEST_DATABASE_URL`. `attempt-fence.test.ts`가 행렬과 AC를 시험한다(관찰값: SQLSTATE `BRS01`, 시험 표 행 수, store verb 결과, `pg_locks`의 대기).
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.

**구현 검증 결과 (2026-10-29):**
- `pnpm build`, `pnpm typecheck` 통과.
- 지정 PostgreSQL 7파일 명령의 첫 실행은 195개 중 194개 통과, 기존 `store.test.ts`의 core 버전 기대값 1곳이 실패했다. 기대값을 4로 수정했다.
- 첫 `pnpm test`는 2,850개 중 2,849개 통과했다. 기존 `daemon-run.test.ts`의 스키마 복원값 3을 4로 수정했다.
- 최종 `pnpm test`: build·typecheck 및 116파일·2,850개 시험 전부 통과. 지정 PostgreSQL 7파일과 새 `attempt-fence.test.ts`의 14개 시험을 포함한다.
- 행렬 전체를 검증했다: 현재 token·취소 요청 중 허용, 회수·취소 정산·새 attempt·unknown·성공/실패 확정 뒤 거부, 잘못된 짝·없는 값·null 거부, 누락 칸 설정 오류, 양방향 미커밋 경합. `pg_locks`의 미승인 잠금과 `pg_blocking_pids`로 실제 대기를 확인했다.
- 새 role은 마이그레이션 뒤 생성하며 work 표 SELECT 없이 판정·INSERT를 수행한다. 각 시험의 finally에서 role과 격리 DB를 정리한다.
- `git diff --check` 통과. 계획 범위 내 미완료 없음. 계약 INSERT 트랜잭션이 열려 있으면 해당 일감의 갱신·정산·확정이 기다리는 특성은 계획대로 유지한다. 운영 계약 표의 trigger 연결과 운영 확장 role 구성은 후속 에픽의 범위다.

## Auto Run Result

상태: `built`. ticket 12.3의 기존 구현을 thorough 후속 검토했다. 계획의 `status`는 시작 값 그대로 보존했으며 `in-review`·`done`으로 바꾸지 않았다. `tickets.py mark`를 실행하지 않았다. 최종 완료 판정은 오케스트레이터가 한다. 사람의 결정이 필요한 미해결 항목은 없다.

**구현 요약:** 새 core 마이그레이션의 `brain.attempt_is_current`가 일감과 열린 attempt를 판정하고 두 행에 share 잠금을 유지한다. `brain.reject_stale_attempt` INSERT trigger는 오래된 token을 SQLSTATE `BRS01`로 거부한다. PG supervised 결과 확정도 같은 DB 판정을 사용한다. core 스키마 버전은 4이며 PUBLIC EXECUTE는 마이그레이션 뒤 생성된 role에도 이어진다.

**검토한 변경 파일:**
- `packages/postgres/migrations/0004_attempt_fence.sql` — 판정·trigger 함수, 권한과 계약 표 연결 예.
- `packages/postgres/src/migrate.ts` — `CORE_SCHEMA_VERSION = 4`.
- `packages/postgres/src/work.ts` — supervised token helper의 DB 판정 호출.
- `packages/postgres/test/attempt-fence.test.ts` — 격리 DB·나중에 생성한 role의 계약 시험 14개와 양방향 경합 관찰.
- `packages/postgres/test/fixture.ts` — 시험에 격리 DB 연결 정보 제공.
- `packages/postgres/test/{migrate,store,cli}.test.ts` — 마이그레이션 목록과 버전 기대값 갱신.
- `apps/cli/test/{daemon-run,dispatch,doctor-run,install,queue-drain,sessions-ingest,setup}.test.ts` — 버전 기대값 갱신.
- 이 계획 파일 — 이번 후속 검토의 개별 판정과 결과를 추가했다. 이번 실행의 source·test 수정은 없다.

**시험 이름:** `accepts the current token for both roles, including after lease expiry and a cancellation request`, `rejects token A after %s for both roles`(died·cancelled·unknown·succeeded·failed), `rejects reclaimed token A and admits replacement token B for both roles`, `refuses wrong pairs, missing work or tokens and null arguments`, `supports default and renamed columns and reports missing configured columns`, `uses the database verdict when finishing a current attempt`, `keeps AD-22, definer ownership, empty search paths and privileges for a later role`, `waits for uncommitted settlement, then refuses the stale INSERT`, `holds both rows through INSERT commit, then allows finish to complete`, `also holds a share lock on the attempt row until the INSERT commits`. 실행 명령은 Verification의 첫 명령이며 이번에는 이를 포함하는 전체 `pnpm test`를 실행했다.

**후속 검토 결과:** `blind-hunter`, `edge-case-hunter`, `verification-gap`, `intent-alignment`를 새 read-only codex 세션 네 개로 실행했다. 검증 공백 렌즈는 지적 없음으로 보고했다. 나머지 16건은 high 0·medium 0·low 11·false 5·maybe-false 0이며 각 지적의 기각 근거는 위 후속 triage에 한 행씩 기록했다. 기존 동일 지적은 `carried`로 판정을 유지했다. patch 0(high 0·medium 0·low 0), 추가 deferred 0이며 기존 deferred-work ledger 항목은 수정·재개·재작성하지 않았다.

**후속 리뷰 권고:** `false`. 이번 후속 검토에서 high patch가 없고 새로 남은 미검증 위험도 없다.

**이번 검증:** `pnpm test` 성공 — build·typecheck와 116파일·2,850개 시험 전부 통과했다. 여기에는 새 fencing 시험 14개와 기존 WorkStore 계약이 포함된다. `git diff --check` 통과. 기준 revision `c4580ed0b2cca4e476a3b8a0ffa16250fac7b46b`부터 검토했다. 이번 시작 HEAD는 `26256a60552979c437ebf7ecc78ea4be0d59c122`다.

**남은 위험:** 계약 INSERT 트랜잭션이 열려 있는 동안 같은 일감의 갱신·정산·확정이 기다린다. 짧은 트랜잭션 계약(AD-7)을 지켜야 한다. 운영 계약 표의 trigger 연결은 epic 14·15, 운영 확장 role의 schema USAGE 구성은 epic 13의 몫이다.
