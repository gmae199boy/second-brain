---
title: '일감 의존: 뒤 일감은 앞 일감이 모두 성공한 뒤에만 시작한다'
type: 'feature'
ticket: '6'
created: '2026-10-29'
status: done
baseline_revision: '042ec28769cf536c986328a8385fbb3842f01b03'
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

**Problem:** 일감에는 선행 관계가 없어, 분석 순서(day → 7d → 30d → all, AD-35)처럼 앞 일감이 성공한 뒤에만 돌아야 하는 일감을 표현할 수 없다. 청구 조건은 `completed_at`·임대만 보고, 선행이 실패해도 뒤 일감을 닫는 규칙이 없다(E12-7).

**Approach:** 새 마이그레이션 `0007`에 선행 관계 표를 두고, 모든 청구 경로(core·감독)에 "선행이 모두 `succeeded`로 닫힘" 조건을 더한다. 일감이 `failed`·`cancelled`·`dependency_failed`로 닫히는 모든 Store 경로가 같은 트랜잭션에서 열린 후행을 (전이적으로) `dependency_failed`로 닫는다. 일감 묶음을 한 트랜잭션에 넣는 Store verb `addWorkGraph`와 그것을 부르는 Core use case `enqueueWorkGraph`를 만들고, 계약 suite를 fake와 PG에서 돌린다.

## Boundaries & Constraints

**Always:**
- 표 `brain.work_dependencies(work_item_id uuid not null references brain.work_items(id), prerequisite_id uuid not null references brain.work_items(id), primary key (work_item_id, prerequisite_id), check (work_item_id <> prerequisite_id))`, `prerequisite_id` 색인, `brain_app`에 select·insert. `packages/postgres/migrations/0007_work_dependencies.sql`, `CORE_SCHEMA_VERSION = 7`. 0001~0006은 고치지 않는다. 시각·ID 기본값 없음(AD-22).
- 청구 조건: 일감은 모든 선행 행이 `completed_at is not null and outcome = 'succeeded'`일 때만 청구된다(`outcome is distinct from 'succeeded'`인 선행이 하나라도 있으면 아님). `claimCandidateQuery`(→ `hasDueWork`·`claimWork`)와 `claimSupervisedWork` 모두, fake `candidates`도 같다. 선행이 없는 일감의 동작은 바뀌지 않는다.
- 전파: 일감이 `failed`·`cancelled`·`dependency_failed`로 닫히면 그 일감에 (직접·간접으로) 기대는 열린 일감 전부를 같은 트랜잭션에서 `completed_at = <닫은 쪽의 now>`, `outcome = 'dependency_failed'`, 청구 칸 null, `last_error = dependencyFailedText(<닫힌 일감 id>, <그 outcome>)`로 닫는다. PG 경로: `recordFailure`(closeWork), `requestWorkCancel`(바로 닫기), `settleSupervisedAttempt`(취소 요청으로 닫기), `finishSupervisedWork`(`cancelled`·`failed` 닫기). 닫기가 `lost`면 전파도 없다. `succeeded` 닫기와 재시도·release는 후행을 건드리지 않는다.
- `dependencyFailedText(id, outcome)`는 Core(`work-item.ts`)의 한국어 고정 문장 함수이고 PG와 fake가 같이 쓴다. `failures`에는 남기지 않는다.
- `addWorkGraph({ nodes })`: `nodes[i]`는 `AddWorkInput & { after: readonly number[] }`이고 `after`는 앞쪽 색인(`< i`)만 가리킨다. 한 트랜잭션에서 노드마다 `ensureWork`(같은 열린 키면 그 행과 합침)를 하고, **새로 만든 행에만** 선행 edge를 넣는다(합쳐진 행이 선행이 되는 것은 된다). 결과는 입력 순서의 `{ created, item }[]`. 합쳐진 행은 자기 선행을 그대로 두고 새 선행을 얻지 않는다. 일반 `addWork`(수동 실행·`failures retry`·예약 발화)도 edge를 더하거나 지우지 않는다.
- `enqueueWorkGraph({ store, clock, idGen }, { nodes: [{ key, kind, targetKind, targetId, after: string[] }] })`: 비지 않음, key 중복 없음, `after`가 그래프 안의 key, 같은 `(kind,targetKind,targetId)` 두 번 없음, 순환 없음을 검사하고 어기면 Store를 부르지 않고 새 코드 `WORK_GRAPH_INVALID`(exit 1, `retryable: false`, 한국어 meaning·hint, README 오류 코드 표도)로 돌려준다. 통과하면 위상 정렬(같은 단계는 입력 순서)한 뒤 노드마다 `idGen.next()`, `createdAt = nextAttemptAt = clock.now()`(한 번 읽음)로 `addWorkGraph`를 부르고 `{ ok: true, items: { [key]: { id, created } } }`를 돌려준다. Store 실패는 그대로 돌려준다. `packages/core/src/index.ts`에서 내보낸다.

**Never:**
- CLI·SDK·명령 메타·doctor 항목을 더하지 않는다(epic 18이 use case를 부른다). 같은 키 직렬화·용량(12.7), 보류 그룹(12.10)은 만들지 않는다.
- DB trigger로 전파하지 않는다(fake와 같은 모양으로 Store가 명시적으로 닫는다). 이미 실행 중인 attempt를 끊지 않는다. 옛 행의 `outcome`을 채우지 않는다. 새 의존을 더하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 선행 대기 | A → B, A 열림(청구 중 포함) | `claimWork`는 A만, A 청구 뒤엔 null. B만 남으면 `hasDueWork` false | — |
| 선행 성공 | A `completeWork` | B 청구됨 | — |
| 둘 중 하나 | A, B → C, A만 성공 | C 청구 안 됨. B 성공 뒤 청구 | — |
| 선행 재시도 | A `retryWork` | B 열림·청구 안 됨 | — |
| 실패 전파 | A → B → C, A `recordFailure` closeWork | B·C `dependency_failed`, `completedAt` = 닫은 now, `lastError` = `dependencyFailedText(A, 'failed')` | — |
| 취소 전파 | 대기 중 A `requestWorkCancel` | B `dependency_failed` | — |
| 감독 실패·취소 | `process_probe` A → B, finish failed(+failure) / 취소 요청 뒤 finish / 취소 요청 뒤 settle | 셋 모두 B `dependency_failed` | — |
| 감독 후행 | A(core) → `process_probe` B | A 성공 전 `claimSupervisedWork` null, 뒤엔 B | — |
| 잃은 닫기 | 남의 claim으로 `recordFailure` closeWork | `lost`, B 열림 | — |
| 합치기 | 열린 X 있음, 그래프 [P, X(after P)] | X `created: false`·같은 id, X는 P 성공 전에도 청구됨 | — |
| 합친 선행 | 열린 X 있음, 그래프 [X, Y(after X)] | Y 새 행, X 성공 전엔 청구 안 됨 | — |
| 잘못된 그래프 | 순환·없는 key·key 중복·같은 대상 두 번·빈 목록 | `WORK_GRAPH_INVALID`, Store 호출 없음 | — |

</intent-contract>

## Code Map

- `packages/postgres/src/work.ts:56-70` `claimCandidateQuery` -- from이 별칭 없는 `brain.work_items`이므로 not-exists 안의 선행 행은 별칭(`p`)으로, 바깥 행은 `brain.work_items.id`로 가리킨다(또는 바깥에 별칭을 주고 select 목록을 맞춘다). `:243-268` `claimSupervisedWork` 같은 조건. `:73-89` `ensureWork` -- graph verb가 재사용(합친 행은 `readOpenWork`가 `for update`로 잠가 동시 닫기가 커밋 뒤의 edge를 보게 한다). `:181-201,226-242,305-334,387-448` -- 전파를 부를 네 닫기 경로. 공통 helper(예: `closeDependents(held, rootId, rootOutcome, now)`)는 `with recursive`로 열린 후행을 모아 한 update로 닫는다. `:657` `encodedFailure`로 `last_error`를 쓴다.
- `packages/postgres/migrations/0006_work_outcome_closed.sql`·`0002_supervised_attempts.sql` -- 마이그레이션 모양과 grant 선례. `packages/postgres/src/migrate.ts:7` 버전. 버전 고정 시험(`grep -rn "CORE_SCHEMA_VERSION\|0006" packages/postgres/test apps/cli/test`)은 12.5가 5→6으로 바꾼 곳을 6→7, 불일치 값 7→8, `migrate.test.ts` 목록에 `0007`.
- `packages/core/src/ports/store.ts:403-430,670-732` -- `AddWorkInput` 옆에 `AddWorkGraphInput`·`AddWorkGraphResult`(`DB_UNAVAILABLE | DB_LOCKED`), `WorkStore.addWorkGraph`. 기존 verb의 doc 주석 문체를 따른다.
- `packages/core/src/testing/fakes/store.ts:186,370-396,1132-1345,1460-1480` -- `workDependencies` 배열, 내부 `addWork` 재사용, `candidates`에 선행 검사(지금 모듈 함수라 의존 목록을 인자로 넘긴다), 네 닫기 경로(`requestWorkCancel`·`settleSupervisedAttempt`·`finishSupervisedWork`·`recordFailure`)에 같은 전파. `snapshot()`에 `workDependencies`를 더해도 된다.
- `packages/core/src/testing/contracts/work-store.ts` -- 새 case는 이 배열에 더한다(`readItem`이 `outcome`·`completedAt`·`lastError`를 준다). `sampleWorkInput`(`fixtures.ts:133`)과 id 상수 재사용, 더 필요한 id는 fixtures에 더한다.
- `packages/core/test/contracts.test.ts:120,566-595` -- fake runner, "catches a store that …" 변이 시험 모양.
- `packages/core/src/queue/schedule-tick.ts` -- `{ store, clock, idGen }` use case 모양. 새 `packages/core/src/queue/work-graph.ts`.
- `packages/core/src/domain/work-item.ts:28-52` -- `WorkItem.outcome`에 `dependency_failed`가 이미 있다. `dependencyFailedText`를 여기 둔다.
- `packages/core/src/codes.ts`·`README.md` 오류 코드 표 -- `WORK_GRAPH_INVALID`(교차 시험이 둘을 맞춘다).

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0007_work_dependencies.sql`, `packages/postgres/src/migrate.ts`, 버전 고정 시험들 -- 표·버전 7.
- [x] `packages/core/src/domain/work-item.ts`, `codes.ts`, `README.md` -- `dependencyFailedText`, `WORK_GRAPH_INVALID`.
- [x] `packages/core/src/ports/store.ts` -- `addWorkGraph` 타입·verb.
- [x] `packages/core/src/testing/fakes/store.ts` -- edge 저장, 청구 조건, 전파, `addWorkGraph`.
- [x] `packages/postgres/src/work.ts` -- 청구 조건 두 곳, `closeDependents`와 네 닫기 경로, `addWorkGraph`.
- [x] `packages/core/src/testing/contracts/work-store.ts` -- 행렬의 Store 행 전부를 case로: `dependent waits for its prerequisite to succeed`, `one of two prerequisites is not enough`, `prerequisite retry keeps the dependent waiting`, `failed prerequisite closes dependents transitively`, `cancelled prerequisite closes its dependent`, `supervised failure, cancel finish and cancel settle close dependents`(세 case로 나눠도 된다), `supervised dependent waits for its core prerequisite`, `lost close does not propagate`, `merged node keeps its own prerequisites`, `merged prerequisite gates the new dependent`.
- [x] `packages/core/test/contracts.test.ts` -- `catches a store that drops prerequisites`(`addWorkGraph`가 `after`를 버리는 래퍼가 첫 case에서 실패).
- [x] `packages/core/src/queue/work-graph.ts`, `packages/core/src/index.ts`, `packages/core/test/work-graph.test.ts`(새, `memoryStore`·고정 clock·`sequenceIdGen`) -- 검사 다섯 가지의 `WORK_GRAPH_INVALID`, 입력 순서가 섞인 day → 7d → 30d → all 사슬이 정렬되어 들어가고 순서대로만 청구됨, 합친 노드의 `created: false`, Store 실패 전달.
- [x] `packages/postgres/test/work-store.test.ts` -- 계약 suite는 기존 runner가 돈다. PG 고유 하나: 자기 자신 edge와 없는 일감 edge를 직접 SQL로 넣으면 거부된다.

**Acceptance Criteria:**
- Given PG에 `enqueueWorkGraph`로 넣은 A → B, when A가 열린 동안 `claimWork`를 두 번 부른다, then 첫 번째는 A, 두 번째는 null이고, A를 `completeWork`한 뒤의 `claimWork`가 B를 준다.
- Given 같은 그래프, when A가 영구 실패로 `recordFailure` closeWork된다, then 같은 트랜잭션 뒤 B를 읽으면 `outcome = 'dependency_failed'`이고 다시 청구되지 않는다.

## Implementation Notes

- `enqueueWorkGraph`와 Store 타입을 공개 export하고, 설정 실패 Store의 대체 구현에도 `addWorkGraph`를 추가했다.
- PostgreSQL 전파는 잠금 대기 중 커밋된 edge를 놓치지 않도록 새 스냅샷에서 반복한다. 이미 닫힌 중간 행도 탐색하되 열린 행만 갱신하고, 실제 두 트랜잭션의 잠금 대기로 회귀를 검증했다.

- 후속 thorough 검토(2026-10-29): 프로덕션 동작 변경 없이 공통 계약과 PG 오류 주입 시험을 보강했다. 그래프 중간 실패, 일반·감독 루트 종료와 전파의 원자성, 기존 선행 보존, 두 선행 역순 완료, 감독 성공·재시도·사망 재시도, failures 부수 기록, 반환 key/id 대응을 검증한다. 오류 코드의 잘못 붙은 주석도 옮겼다.

## Plan Change Log

## Review Triage Log

- high · patch — `packages/postgres/src/work.ts`, `closeDependents`: 기존 A → B에서 B를 합치는 그래프가 C를 추가하는 동안 A 실패 전파가 B 잠금을 기다리면, 단일 SQL 스냅샷이 C의 edge를 놓친다. `readOpenWork`는 B만 잠그며 전파 SQL은 대기 뒤 재탐색하지 않으므로 C가 열린 채 막힌다. 새 스냅샷으로 전파를 끝내고 PG 동시성 회귀 시험을 추가했다. 수정 전 재현 실패를 확인했고 수정 후 해당 시험과 전체 검증이 통과했다.
  - (조율자 주: 위 행은 구현 세션이 구현 중 자기 점검으로 적은 것이고, step-04 리뷰 렌즈의 지적이 아니다. 구현은 커밋 `d1c877a`에 들어 있다.)

### 2026-10-29 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: quick 렌즈(codex 읽기 전용 리뷰어)가 수용 기준 미충족·규칙 위반·버그를 하나도 보고하지 않았다.

### 2026-10-29 — Review pass
- verdicts: 18 findings — high 0, medium 11, low 1, false 6, maybe-false 0
- findings:
  - `[medium]` `[patch]` blind-hunter 3: 그래프 삽입 중 실패의 롤백 검증 누락 — PG 시험에서 앞 노드와 edge 삽입 후 마지막 INSERT를 거부해 전체 상태 보존을 검증하는 PG 오류 주입 시험을 추가했다. verification-gap 1과 같은 원인이다.
  - `[medium]` `[patch]` blind-hunter 7: 감독 성공·일시 실패·died 뒤 후행 검증 누락 — finish 성공의 해제와 failed finish·died settle의 대기 보존 및 다음 attempt 성공 후 해제를 공통 계약으로 확인하는 회귀 시험을 추가했다. verification-gap 2와 같은 원인이다.
  - `[medium]` `[patch]` verification-gap 1: 그래프 중간 실패 롤백 시험 누락 — 검증 렌즈의 검색 근거를 수용했다. blind-hunter 3과 묶어 PG 오류 주입 회귀를 추가했다.
  - `[medium]` `[patch]` verification-gap 2: 감독 재시도의 후행 보존 시험 누락 — 검증 렌즈의 검색 근거를 수용했다. blind-hunter 7과 묶어 fake·PG 공통 계약을 추가했다.
  - `[false]` `[reject]` intent-alignment 1: 합쳐진 X는 제출 그래프의 P보다 먼저 실행될 수 있음 — 티켓은 합치기와의 관계를 계약으로 정하도록 요구한다. intent-contract·Design Notes가 새 행에만 edge를 붙이는 정책을 명시하고 구현·계약이 이를 따른다. 제출 그래프 전체에 새 선행을 강제한다는 대안은 확정된 요구가 아니다.
  - `[false]` `[reject]` intent-alignment 2: 필수 검증 시나리오는 공용 suite에 포함됨 — 이는 이탈 지적이 아니라 충족 확인이다. 실제 전체 검증에서도 fake·PG 계약을 포함해 3118개 시험이 통과했다.
  - `[medium]` `[patch]` intent-alignment 3: 기존 선행 유지 시험이 선행 없는 행만 다룸 — blind-hunter 5와 같은 검증 공백이며 기존 P→X를 사용한 계약으로 보강했다.
  - `[medium]` `[patch]` intent-alignment 4: 같은 트랜잭션 속성은 최종 상태 시험만으로 증명되지 않음 — blind-hunter 3·4와 같은 원자의 경계 검증 공백이다. 그래프 삽입과 루트 종료·전파의 오류 주입 회귀를 함께 추가했다.
  - `[false]` `[reject]` intent-alignment 5: 이미 dependency_failed인 행을 독립 전파 시작점으로 시험하지 않음 — dependency_failed는 닫기 전파 내부에서만 만들어지고 열린 행만 다시 닫는다. A→B→C에서 B·C가 같은 트랜잭션에 닫히는 계약이 해당 요구를 검증하며, 닫힌 B를 별도로 닫는 공개 Store 경로는 없다.
  - `[false]` `[reject]` edge-case-hunter 1: 잘못된 색인에서 fake 부분 삽입 — blind-hunter 2와 동일한 계약 밖 입력이다. Store 주석의 앞쪽 색인 사전 조건과 검증된 enqueueWorkGraph 호출이 반증이다.
  - `[low]` `[reject]` blind-hunter 1: 위상 정렬 O(V²) — epic 18의 네 단계 사슬과 현재 호출자는 작은 그래프다. 큰 입력의 실제 피해는 확인되지 않았고 진입 차수 자료구조 추가는 단순 교정을 넘으므로 기각했다.
  - `[false]` `[reject]` blind-hunter 2: 잘못된 after 색인의 fake 부분 삽입 — AddWorkGraphInput은 모든 색인이 자기 노드보다 앞이어야 한다고 명시한다. enqueueWorkGraph가 검증·위상 정렬 후 이 조건을 지켜 호출하므로 제시한 입력은 계약 밖이며 지원 경로의 부분 저장 결함을 보이지 못한다.
  - `[medium]` `[patch]` blind-hunter 4: 루트 종료와 전파의 원자성 검증 누락 — recordFailure와 감독 finish의 후행 UPDATE를 거부해 루트·후행·failures·attempt가 함께 롤백됨을 확인하는 회귀 시험을 추가했다.
  - `[medium]` `[patch]` blind-hunter 5: 합쳐진 행의 기존 선행 보존 검증 누락 — 현재 계약은 기존 X의 선행이 없어 삭제 회귀를 잡지 못한다. 기존 P→X와 새 Q→X를 합쳐 P만 보존됨을 공통 계약에서 확인하는 회귀 시험을 추가했다.
  - `[medium]` `[patch]` blind-hunter 6: 선행 둘의 역순 완료 검증 누락 — 현재 시험은 첫 선행을 먼저 성공시켜 첫 edge 누락 회귀를 놓친다. 두 번째 선행 먼저 성공·첫 선행 대기 중 후행 차단을 검증하도록 전달했다.
  - `[false]` `[reject]` blind-hunter 8: 완료됐지만 outcome NULL인 옛 선행의 청구 검증 누락 — 0007이 새 edge 표를 빈 상태로 만들고 addWorkGraph는 기존 열린 행만 합친다. 연결 후 Store의 정상 완료는 succeeded를 남기므로 완료된 옛 NULL 행을 선행으로 연결하는 시나리오는 공개 Store 호출로 도달하지 않는다. 직접 SQL로 계약 밖 상태를 만드는 검증은 요구하지 않았다.
  - `[medium]` `[patch]` blind-hunter 9: 전파의 failures 부수 기록 검증 누락 — 현재 전파 시험이 후행 행만 읽어 후행별 failures 기록 회귀를 놓친다. 영구 실패는 루트 한 개·취소는 0개를 확인하는 회귀 시험을 추가했다.
  - `[medium]` `[patch]` blind-hunter 10: 정렬 후 반환 key와 id 대응 검증 누락 — 기존 사슬은 저장·청구 순서만 확인한다. 각 targetId의 실제 청구 id와 반환 items[targetId].id 일치를 확인하는 회귀 시험을 추가했다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): 합치기. 그래프 노드가 같은 대상의 열린 행과 합쳐지면 그 행은 자기 선행을 그대로 두고 새 선행을 얻지 않는다. 새로 만든 행만 edge를 받는다. 새 행은 이미 있는 행이나 같은 그래프의 앞 노드만 가리키므로 그래프 사이에 순환이 생기지 않고, 이미 실행 중인 행에 선행이 붙어 재시도가 엉뚱하게 멈추는 일도 없다. 대가: 미리 열려 있던 행은 그래프 순서를 따르지 않을 수 있다(원래 돌 일감이었다).
- Decision(2026-10-29, 추천으로 정함): 전파는 DB trigger가 아니라 Store의 닫기 경로가 한다. fake와 같은 모양으로 계약 suite가 경로마다 확인한다. 열린 후행은 청구된 적이 없다(선행이 성공하기 전에는 청구되지 않고, 합친 행은 edge를 얻지 않는다). 그래서 전파는 실행 중 attempt를 만나지 않는다.
- Decision(2026-10-29, 추천으로 정함): `succeeded`는 끝 상태라 한 번 풀린 후행은 다시 막히지 않는다. 같은 대상을 `failures retry`로 다시 넣은 새 행은 edge가 없어 바로 청구된다.

## Verification

**Commands:**
- `pnpm exec vitest run --project core test/contracts.test.ts test/work-graph.test.ts` -- expected: fake 계약 suite와 use case 시험 통과.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts` -- expected: PG 계약 suite·0007 통과. PG 사전 조건: OrbStack이 켜져 있다(global setup이 `second-brain-test-postgres-1`을 띄운다).
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.
- `git diff --check` -- expected: 출력 없음.

**실행 결과 (2026-10-29):**
- core 대상 명령: 2개 파일, 250개 테스트 통과.
- postgres 대상 명령: 2개 파일, 103개 테스트 통과(동시성 회귀 포함).
- `pnpm test`: build·typecheck 성공, 119개 파일, 3118개 테스트 통과.
- `git diff --check`: 출력 없음.
- quick 검토: 동시성 문제 1건을 재현·수정했다. 미완료·보류 항목 없음.

## Auto Run Result

Status: built

- 구현 요약: 기존 일감 의존성 구현을 네 thorough 렌즈로 후속 검토했다. 동작 결함은 확인되지 않았고, 검증 공백 일곱 묶음을 회귀 시험으로 보강했다. 프로덕션 동작은 그대로이며 오류 코드 주석 위치만 교정했다.
- 바뀐 파일:
  - `packages/core/src/testing/contracts/work-store.ts` — 두 선행의 역순 완료, 기존 선행 보존, 감독 성공·일시 실패·사망 후 재시도, 전파의 실패 기록 수를 fake·PG 공통 계약으로 검증한다.
  - `packages/postgres/test/work-store.test.ts` — 그래프 마지막 삽입 실패와 일반·감독 루트 종료 중 후행 갱신 실패를 주입해 전체 롤백을 검증한다.
  - `packages/core/test/work-graph.test.ts` — 위상 정렬 뒤 반환 key별 id가 실제 청구된 일감과 대응하는지 확인한다.
  - `packages/core/src/codes.ts` — WORK_NOT_FOUND 설명 주석을 해당 코드 위로 옮겼다.
  - 이 계획 파일 — thorough 렌즈 실행 내역, 18건 판정, 검증 결과와 인계 상태를 기록했다.
- 리뷰 판정: 18건(high 0, medium 11, low 1, false 6, maybe-false 0). 중복 원인을 묶은 수정은 medium 7묶음이며 high 0, low 0이다. 주석 교정 1건은 별도로 반영했다. 새 보류 항목은 0건이고 기존 deferred-work ledger와 deferred 목록은 변경하지 않았다.
- 기각 근거:
  - blind-hunter 1 — 현재의 작은 그래프에서 피해가 확인되지 않은 O(V²) 최적화는 자료구조 복잡도를 늘리므로 기각했다.
  - blind-hunter 2와 edge-case-hunter 1 — 잘못된 after 색인은 Store의 명시된 사전 조건 밖이며 Core 검증·정렬 경로에서 생성되지 않는다.
  - blind-hunter 8 — 빈 새 edge 표와 열린 행만 합치는 Store 계약상, 완료된 옛 outcome NULL 행을 새 선행으로 연결하는 경로가 없다.
  - intent-alignment 1 — 티켓이 열어 둔 합치기 관계를 intent-contract가 기존 선행 유지로 결정했고 구현과 계약이 이를 따른다.
  - intent-alignment 2 — 요구된 공용 계약 시나리오의 충족 확인으로 결함 지적이 아니다.
  - intent-alignment 5 — dependency_failed는 내부 전이 전파가 만들며, 기존 사슬 계약이 같은 트랜잭션의 전이적 종료를 검증한다. 이미 닫힌 행을 독립적으로 다시 닫는 공개 경로는 없다.
- 후속 리뷰 권고: `false` — built 계획에 대한 후속 pass이며 patched high가 없다. patched medium 7묶음은 모두 검증 보강이고 수정 파일 검사와 최종 전체 검증으로 확인했다.
- 검증:
  - 수정 전 `pnpm test`: build·typecheck 성공, 119개 파일·3118개 시험 통과.
  - 구현 세션의 변경 파일 대상 Vitest: 4개 파일·535개 시험 통과.
  - 수정 후 `pnpm test`: build·typecheck 성공, 119개 파일·3129개 시험 통과.
  - `git diff --check`: 출력 없음.
- 남은 위험: addWorkGraph 직접 호출자는 문서의 앞쪽 색인 사전 조건을 지켜야 한다. 위상 정렬은 긴 직렬 그래프에서 O(V²)이며 현재 소비 대상은 작은 단계 그래프다. 새로 확인된 실행 결함이나 사람의 결정이 필요한 미해결 사항은 없다.
- 인계: 최종 상태는 `built`다. 티켓을 done으로 표시하지 않았고 tickets.py mark를 실행하지 않았다. 완료 판정과 기존 deferred-work 항목의 상태·해결은 오케스트레이터가 맡는다.
