---
title: '같은 키 직렬화와 병렬 용량: 같은 계정의 일감은 한 번에 하나, 다른 계정은 함께 돈다'
type: 'feature'
ticket: '7'
created: '2026-10-29'
status: done
baseline_revision: 'b9b89c69cabe1ff2aefc8a46320eb441f4faeea9'
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
deferred:
  - summary: >-
      자식을 띄운 뒤 runSupervisor의 execute()가 예외를 던지면 살아 있는 자식이 실행 집합에서 빠져 용량 계산과 종료 정리를 벗어날 수 있다.
    evidence: |-
      blind-hunter 1, edge-case-hunter 1·4. 기준 커밋도 같은 예외에서 자식을 추적하지 못했다(메인 루프 catch로 빠짐). 확인하지 못함: problem()(options.log), inspector, Store 호출 중 무엇이 실제로 던질 수 있는지. 그런 경로가 있으면 catch에서 그룹 정리와 token 정산을 마친 뒤 슬롯을 돌려줘야 한다.
    location: >-
      packages/core/src/queue/supervisor.ts:245
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** 일감에는 출처+계정 같은 직렬화 키가 없어, 같은 계정의 서로 다른 종류 일감(예: 인증과 수집)이 두 프로세스·두 청구 경로에서 동시에 청구될 수 있다. 감독자는 한 번에 자식 하나만 돌려, 다른 계정의 긴 일감이 서로를 기다린다(E12-8).

**Approach:** 새 마이그레이션 `0008`로 `work_items.serialization_key`를 더하고, 두 청구 경로(`claimWork`·`claimSupervisedWork`)가 "같은 키의 살아 있는 보유자가 없음"을 후보 조건으로 거르고, 키가 있는 후보는 그 키의 트랜잭션 advisory lock을 잡은 뒤 새 스냅샷으로 다시 확인하고서야 청구한다. 감독자는 Core 상수 `SUPERVISOR_CAPACITY = 2`까지 자식을 동시에 돌린다.

## Boundaries & Constraints

**Always:**
- 마이그레이션 `packages/postgres/migrations/0008_work_serialization_key.sql`: `alter table brain.work_items add column serialization_key text` + check(`serialization_key is null or length(serialization_key) between 1 and 200`), 부분 색인 `(serialization_key) where serialization_key is not null and completed_at is null`. `CORE_SCHEMA_VERSION = 8`. 0001~0007은 고치지 않는다. 기본값·backfill 없음(옛 행은 null = 키 없음).
- 타입: `AddWorkInput.serializationKey?: string | null`(생략 = null), `WorkItem.serializationKey: string | null`. `ensureWork`가 새 행에 넣는다. 열린 행과 합쳐지면 그 행의 키를 그대로 둔다(바꾸지 않는다). `addWorkGraph` 노드도 같은 칸을 지나고, `enqueueWorkGraph` 노드에 선택 `serializationKey`를 더해 그대로 넘긴다. 빈 문자열·200자 초과는 Store가 DB 오류로 거부해도 된다(검사 제약).
- **보유자 정의(fake·PG 같음):** 같은 `serialization_key`의 다른 행 `h`가 `h.completed_at is null`이고 (`h.current_attempt_token is not null` 또는 (`h.claimed_by is not null` and `h.claim_expires_at > now`))이면 키가 잡혀 있다. 그래서 `supervised` attempt는 임대가 만료돼도, `unknown`으로 남아도 키를 놓지 않고 token이 비워질 때(결과 확정·재시도·`died`/`cancelled` 정산) 놓는다. `core` 청구는 임대가 끝나거나 완료·재시도·release로 청구 칸이 비면 놓는다. 키가 null인 일감은 지금과 똑같다.
- **청구 조건:** `claimCandidateQuery`(→ `hasDueWork`·`claimWork`)와 `claimSupervisedWork`의 후보 조건에 "키 없음 또는 보유자 없음"을 더한다(fake `candidates`도). 그래서 같은 키에 막힌 일감만 남으면 `hasDueWork`는 false다.
- **DB 보장(advisory lock 선택):** 두 PG 청구 verb는 `for update skip locked`로 후보를 고른 뒤, 후보에 키가 있으면 같은 트랜잭션에서 `pg_advisory_xact_lock(hashtextextended('work-key:' || key, 0))`를 잡고 **다음 문장(새 스냅샷)**으로 보유자 조건을 다시 본다. 잡혀 있으면 그 후보를 버리고 후보 고르기부터 다시 하며(이제 보유자가 보이므로 걸러진다), 비어 있으면 청구한다. 잠금은 커밋 때 풀리므로 같은 키 청구는 모든 프로세스·경로에서 줄을 선다. 키를 놓는 쓰기는 잠금이 필요 없다.
- 용량: `packages/core/src/domain/work-item.ts`에 `export const SUPERVISOR_CAPACITY = 2`. 설정 키·옵션으로 만들지 않는다. `runSupervisor`는 이 incarnation이 띄운 실행 중 자식 수가 용량 미만일 때만 `claimSupervisedWork`를 부르고, 자리가 있고 일감이 나오는 동안 연달아 청구해 동시에 돌린다. 자리가 없거나 일감이 없으면 `pollMs` 또는 실행 하나가 끝날 때까지 기다린다. core drain 회차(`daemon/run.ts`)는 그대로이고 용량과 무관하다.
- 실행 하나의 정산 실패 재시도(`pendingSettlement`)는 실행마다 따로 두고, 확정되지 않은 정산이 하나라도 있으면 새 청구를 하지 않는다(지금 규칙의 일반화). 한 실행의 오류가 다른 실행을 끊지 않는다. abort 때 `runSupervisor`는 돌던 실행 전부의 그룹 정리·정산이 끝난 뒤에 끝난다.
- 새 오류 코드·CLI·SDK·명령 메타·doctor 항목은 없다.

**Never:**
- partial UNIQUE로 키를 보장하지 않는다(core 임대 만료가 `now`에 달려 있어 색인 조건으로 표현할 수 없다). 세션 advisory lock(`sessions.ts`)과 같은 열쇠 문자열을 쓰지 않는다(`work-key:` 접두).
- `unknown`을 푸는 verb, `failures retry`·예약 발화가 키를 되살리는 일, 보류 그룹(12.10), 키를 정하는 실제 일감 종류(epic 14)는 만들지 않는다. `unknown` attempt를 용량에 세지 않는다.
- AD-7: 자식을 기다리는 동안 트랜잭션을 잡지 않는다. 기존 `claimed_by` CAS·token CAS 의미를 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 경로 넘는 같은 키 | core `demo_work` A(키 k) `claimWork`됨 | 같은 키 `demo_other` B의 `claimWork`, `process_probe` P(키 k)의 `claimSupervisedWork` 모두 null. 키 k2 일감은 청구됨 | — |
| 반대 방향 | P(키 k) 감독 청구됨 | A(키 k) `claimWork` null, `hasDueWork`(A만 남음) false | — |
| core 임대 만료 | A 청구 뒤 `now + claimForMs` | B 청구됨 | — |
| core 닫힘 | A `completeWork`·`retryWork`·`releaseWork`·`recordFailure` closeWork | 각 뒤에 B 청구됨 | — |
| 감독 닫힘 | P finish succeeded / failed 재시도 / settle died·cancelled | 각 뒤에 A 청구됨 | — |
| `unknown` | P settle `unknown`, 임대 만료 뒤까지 | A·같은 키 P2 청구 안 됨, `hasDueWork` false | PG: token을 직접 SQL로 비우면 A 청구됨 |
| 합치기 | 열린 X(키 k)에 `addWork` 같은 대상·키 k2 | `created: false`, X 키는 k | — |
| 키 없음 | 키 null 두 일감 | 지금처럼 둘 다 차례로 청구 | — |
| 잘못된 키 | `serializationKey: ''` | 행 안 생김 | `DB_UNAVAILABLE` 계열 실패(검사 제약) |
| 용량 | 키 k1·k2·k3 probe 셋, 감독자 하나 | 둘이 동시에 시작, 셋째는 하나가 끝난 뒤 시작 | — |
| 같은 키 대기 | 키 k probe 둘, 자리 2 | 하나씩 차례로 | — |
| 용량 가득 | probe 둘 실행 중 | core 일감은 drain이 처리 | — |

</intent-contract>

## Code Map

- `packages/postgres/src/work.ts:37-54` `WorkItemRow`·`:690-713` `toWorkItem` -- `serialization_key` 추가. `:57-76` `claimCandidateQuery` -- from이 별칭 없는 `brain.work_items`라 보유자 서브쿼리는 별칭 `h`, 바깥은 `brain.work_items.serialization_key`·`.id`로 가리킨다(12.6 선행 조건과 같은 모양). select 목록에 칸 추가. `:79-95` `ensureWork` insert에 칸. `:163-205` `claimWork`·`:271-301` `claimSupervisedWork` -- 후보 고르기를 루프로 감싸 키 잠금·재확인을 넣는다. 공통 helper(예: `keyHeld(held, row, now)`, `lockKey(held, key)`)로 두 verb가 같은 SQL을 쓰게 한다. `:690` `readOpenWork` select 목록에도 칸.
- `packages/postgres/src/write.ts` -- `withWrite`의 `key` 인자는 트랜잭션 처음에 잠그므로 후보를 고른 뒤 잠그는 이 경우엔 직접 `sql\`select pg_advisory_xact_lock(hashtextextended(${'work-key:' + key}, 0))\``를 쓴다.
- `packages/postgres/migrations/0007_work_dependencies.sql` -- 모양 선례. `packages/postgres/src/migrate.ts:7` 버전. 버전 고정 시험: `grep -rln "CORE_SCHEMA_VERSION\|core: 7\|0007" packages/postgres/test apps/cli/test packages/core/test`로 찾은 곳을 7→8(불일치 값 8→9), `migrate.test.ts` 목록에 `0008`.
- `packages/core/src/domain/work-item.ts:28-52` `WorkItem`(필드 doc 주석 문체 유지), `:155-171` 감독자 상수 옆에 `SUPERVISOR_CAPACITY`. `packages/core/src/index.ts`에서 내보낸다.
- `packages/core/src/ports/store.ts:403-417` `AddWorkInput`, `claimWork`·`claimSupervisedWork`·`hasDueWork` doc 주석에 키 규칙 한두 줄.
- `packages/core/src/testing/fakes/store.ts:371` 내부 `addWork`(키 저장, 합칠 때 유지), `:1162-1166,1236-1237` 호출부, `:1489` `candidates` -- 보유자 검사는 `allItems`와 `query.now`로 한다(감독 경로는 이미 걸러진 목록을 넘기므로 보유자는 전체 목록에서 찾는다).
- `packages/core/src/testing/contracts/work-store.ts`·`fixtures.ts:133` `sampleWorkInput` -- 새 case를 배열에 더한다. `readItem`이 `serializationKey`를 준다.
- `packages/core/test/contracts.test.ts:566-595` -- "catches a store that …" 변이 시험 모양.
- `packages/core/src/queue/supervisor.ts:203-226` 메인 루프, `:18-35` `pendingSettlement`·`retrySettlement`, `execute` -- 실행 집합과 실행별 정산으로 바꾼다. `execute` 안의 지역 상태는 이미 실행마다 따로다. `reconcile`은 그대로 한 번.
- `packages/core/test/supervisor.test.ts:13-27` `kit`(`fakeProcessLauncher`·`manualTime`·`memoryStore`) -- 용량 시험은 여기 모양으로, kit에 일감 목록을 받게 넓히거나 새 helper를 둔다. `launcher.processes[i]`로 자식마다 `push`·`exit`.
- `packages/postgres/test/work-store.test.ts:92-123,355-380` barrier plugin(결과를 gate로 붙잡는 `KyselyPlugin`)·두 연결 store 모양, `:280-327` 두 프로세스 drain 시험과 `fixtures/drain-worker.mjs`(stdin으로 URL을 받고 `ready`/`go` 동기화) -- 새 두 프로세스 시험이 같은 모양의 새 fixture를 쓴다.
- `apps/cli/test/daemon-supervisor.test.ts`·`supervisor-fixture.ts:12-21` `enqueueProbe(durationMs)` -- 키 인자를 더한다. probe의 `targetId`는 지속 ms라 열린 대상 UNIQUE를 피하려면 일감마다 다른 값(예: 3000·3001·3002)을 쓴다. `apps/cli/src/daemon/supervisor.ts`는 바꿀 필요가 없다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0008_work_serialization_key.sql`, `packages/postgres/src/migrate.ts`, 버전 고정 시험들 -- 칸·검사·색인, 버전 8.
- [x] `packages/core/src/domain/work-item.ts`, `packages/core/src/ports/store.ts`, `packages/core/src/index.ts`, `packages/core/src/queue/work-graph.ts` -- 타입·상수·export, 그래프 노드 키 전달.
- [x] `packages/core/src/testing/fakes/store.ts` -- 키 저장·합치기 유지·후보 보유자 검사.
- [x] `packages/postgres/src/work.ts` -- 칸 읽기·쓰기, 후보 조건, 두 청구 verb의 잠금·재확인 루프.
- [x] `packages/core/src/queue/supervisor.ts` -- 용량까지 동시 실행, 실행별 정산, abort 때 전부 기다림.
- [x] `packages/core/src/testing/contracts/work-store.ts` -- 행렬의 Store 행(경로 넘는 같은 키, 반대 방향, core 임대 만료, core 닫힘 네 가지, 감독 닫힘 네 가지, `unknown`, 합치기, 키 없음)을 case로. 이름 예: `one serialization key is claimed once across kinds and claim paths`, `an unknown attempt keeps its serialization key`.
- [x] `packages/core/test/contracts.test.ts` -- `catches a store that ignores serialization keys`(후보 보유자 검사를 끈 fake 래퍼가 첫 키 case에서 실패).
- [x] `packages/core/test/supervisor.test.ts` -- `runs two keys at capacity and starts a third only when a slot frees`, `same-key supervised work waits although capacity is free`, `core drain completes while supervised capacity is full`, `abort cleans and settles every running child`, `one settlement failure does not stop the other running child`.
- [x] `packages/postgres/test/fixtures/key-claim-worker.mjs`(새), `packages/postgres/test/work-store.test.ts` -- (1) `claims one serialization key once when two connections race`: barrier로 첫 연결의 후보 select 결과를 붙잡은 동안 둘째 연결이 같은 키의 다른 일감을 청구·커밋하면, 풀려난 첫 연결은 null을 받는다. core→core, core↔감독 두 방향. (2) `two processes never hold one serialization key at once`: 자식 프로세스 둘(하나는 `claimWork` kinds `[demo_work, demo_other]`, 하나는 `claimSupervisedWork` kinds `[process_probe]`)이 20회 동안 `go`마다 동시에 청구하고, 회차마다 같은 키 k_r의 `demo_work`·`process_probe` 중 정확히 하나, 다른 키 x_r·y_r 일감은 둘 다 청구됨. (3) `releasing an unknown attempt token frees its key`(직접 SQL로 token을 비운 뒤 청구됨). (4) 빈 키 거부.
- [x] `apps/cli/test/supervisor-fixture.ts`, `apps/cli/test/daemon-supervisor.test.ts` -- 실제 Node probe 자식과 PG: `runs two keyed probes at once and a third after a slot frees`(키 셋, 각 ~2500ms. attempt 시작·끝 시각으로 동시 열린 수 최대 2, 셋째 시작 ≥ 앞 둘 중 하나의 끝), `never overlaps two probes of one key`(같은 키 둘, 구간이 겹치지 않음). 용량이 찬 동안 core 일감이 끝나는지도 첫 시험에서 본다.

**Acceptance Criteria:**
- Given PG에 같은 키 k의 `demo_work`와 `process_probe`, 서로 다른 키의 일감 둘, when 두 OS 프로세스가 서로 다른 청구 경로로 동시에 청구한다, then 같은 키 둘 중 하나만 청구되고 다른 키 둘은 모두 청구된다(위 (2)).
- Given 데몬 감독자와 키가 다른 probe 셋, when 데몬을 돌린다, then 한 번에 최대 두 attempt만 열려 있고 셋째는 앞의 하나가 끝난 뒤에 시작하며, 그동안 넣은 core 일감은 끝난다.
- Given `unknown`으로 정산된 키 k의 attempt, when 시간이 임대 만료를 지나 같은 키의 다른 일감을 청구한다, then 어느 경로로도 청구되지 않고, token이 비워진 뒤에야 청구된다.

## Implementation Notes

- 구현 완료: 키 저장·그래프 전달, 두 청구 경로의 advisory lock과 새 스냅샷 재확인, 용량 2 감독자와 실행별 정산 재시도.
- 검증 완료: `pnpm test`의 build·typecheck·전체 vitest(119 files, 3,173 tests) 통과. PG 두 연결 경합·20회 두 프로세스 경합·실제 데몬 probe 시험 포함. `git diff --check` 통과.
- I/O 행렬의 모든 행을 계약·PG·감독자·CLI 시험으로 확인했다. quick 검토에서 지적 사항과 보류 항목 없음.
- 시험 중 `pg` 동시 `client.query()` 사용에 대한 deprecation warning이 출력됨.
  - (조율자 주: 위 "quick 검토"는 구현 세션이 스스로 한 점검이고 step-04 리뷰가 아니다. 구현 세션이 frontmatter를 `built`·`quick`으로 바꿔 커밋 `ea3ec32`에 넣었으므로, 조율자가 `in-review`·`thorough`로 되돌린 뒤 네 렌즈 리뷰를 돌렸다.)
- 리뷰 패치(2026-10-29): 키 잠금은 savepoint 안에서 잡고, 재확인이 실패하면 `rollback to savepoint`로 그 키의 advisory lock을 풀고 다음 후보로 간다. 그래서 청구 트랜잭션은 다른 키를 기다리는 동안 키 잠금을 쥐지 않는다(Design Notes의 "교착이 없다"가 이제 성립한다). 감독자는 종료 때 남은 정산을 한 번만 다시 시도하고 끝난다. 실패한 attempt는 token을 유지하고, 다음 incarnation의 reconcile이 정산한다(기준 커밋과 같은 동작). 빈 성공 청구도 로그 중복 억제 상태를 다시 설정한다. 실제 데몬 시험의 probe는 약 6초로 늘렸다.
- 조율자 검증 중 관찰(2026-10-29): 첫 `pnpm test`에서 `apps/cli/test/capture-scan.test.ts`의 `collects every session on the disk as an import, and finds nothing the second time`이 한 번 실패했다(두 번째 drain이 exit 2). 단독으로 세 번, 전체로 두 번 다시 돌리니 모두 통과했다. 키가 없는 일감만 쓰는 시험이라 이 변경과 관련 없는 부하 의존 흔들림으로 본다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 20 findings — high 0, medium 5, low 6, false 6, maybe-false 3
- findings:
  - `[maybe-false]` `[defer]` blind-hunter 1: 자식 시작 뒤 `execute()`가 예외를 던지면 살아 있는 자식이 용량·종료 대기에서 빠짐 — 기준 커밋도 같은 예외에서 자식을 추적하지 못했다(그때는 메인 루프 catch로 빠졌다). 남은 예외원은 `options.log` 쓰기 실패 정도라 실제로 닿는지 확인하지 못했다. 확정하려면 `problem()`·inspector·Store 호출이 던질 수 있는 실제 경로를 보여야 한다. 기존 문제로 보류한다.
  - `[false]` `[reject]` blind-hunter 2: 청구가 진행되는 동안 다른 실행의 정산이 실패해도 반환된 일감을 실행함 — 청구는 이미 커밋되어 token을 가졌으므로 실행하지 않으면 다음 reconcile까지 묶일 뿐이다. 규칙은 "새 청구를 하지 않는다"이고, 다음 청구 전에 `while` 조건이 다시 확인한다.
  - `[medium]` `[patch]` blind-hunter 3: 재확인에 실패한 키의 advisory lock을 쥔 채 다른 키 후보를 기다려 X→Y/Y→X 교착(PG가 한쪽을 deadlock 오류로 끊음)이 생길 수 있음 — 키 잠금을 savepoint 안에서 잡고 실패 때 `rollback to savepoint`로 풀었다. `releases a discarded key before selecting another candidate (core|supervised)` 시험이 다음 후보를 고르는 동안 다른 연결이 그 키를 잡을 수 있음을 확인한다.
  - `[low]` `[reject]` blind-hunter 4: 청구가 null인 동안 끝난 실행을 `waitForWork()`가 놓쳐 다음 청구가 최대 `pollMs` 늦어짐 — 지연은 기준 커밋의 poll 주기(5초)와 같다. 고치려면 완료 세대 같은 알림 장치를 더해야 해서 기각했다.
  - `[low]` `[reject]` blind-hunter 5: 시험 helper `receive()`가 응답 사이에 죽은 worker를 기다리며 멈춤 — 시험은 vitest 시간 제한(40초)으로 어차피 실패하므로 잘못된 통과가 없다. 오류 문구만 덜 분명하다. 가드를 더해야 해서 기각했다.
  - `[medium]` `[patch]` blind-hunter 6: barrier 시험이 실제 잠금 대기를 강제하지 않아, advisory lock을 빼고 재확인만 남긴 Store도 통과함 — `waits for the key lock before rechecking a concurrent holder`(네 경로 조합)를 더했다. 둘째 청구가 재확인 뒤·커밋 전에 키 잠금을 쥔 동안 첫째가 `pg_locks`에서 대기(`granted = false`)로 보이고, 풀린 뒤 null을 받는다.
  - `[low]` `[reject]` blind-hunter 7: fake는 빈 키·200자 초과 키를 받아들이고 PG는 거부함 — 계획이 "Store가 DB 오류로 거부해도 된다"로 열어 두었고, 키를 넣는 실제 호출자는 아직 없다. 맞추려면 fake에 검증 분기를 더해야 해서 기각했다.
  - `[low]` `[reject]` blind-hunter 8: 두 실행의 정산이 동시에 실패하는 경우를 시험하지 않음 — 새 시험 `returns after abort even when settlement fails for both running children`이 두 정산이 모두 실패할 때 각자 token을 유지함을 확인한다. 남은 부분은 코드 결함을 보이지 않는다.
  - `[medium]` `[patch]` blind-hunter 9: abort 뒤 정산 재시도 루프를 검증하지 않음 — verification-gap 1과 같은 원인이다. 확인해 보니 그 루프는 abort되지 않는 sleep으로 끝없이 재시도해, 종료 때 DB가 죽어 있으면 데몬이 멈추지 않았다. 남은 정산을 한 번만 다시 시도하고 끝나게 고쳤고(실패한 token은 다음 reconcile이 정산한다), 위 시험이 두 자식의 SIGTERM과 열린 attempt를 확인한다.
  - `[medium]` `[patch]` blind-hunter 10: 실제 데몬 용량 시험이 2.5초 probe 안에 DB 조회·core 처리까지 끝내야 해서 부하가 크면 흔들림 — probe를 약 6초(서로 다른 값)로 늘리고 poll 시간 제한을 맞췄다.
  - `[maybe-false]` `[defer]` edge-case-hunter 1: `execute()` 예외로 살아 있는 자식이 추적에서 빠짐 — blind-hunter 1과 같은 원인이다. 같은 이유로 보류한다.
  - `[low]` `[reject]` edge-case-hunter 2: `receive()`가 이미 끝난 worker를 기다림 — blind-hunter 5와 같다. 같은 이유로 기각했다.
  - `[low]` `[patch]` edge-case-hunter 3: 청구 오류 뒤 빈 성공 청구가 로그 중복 억제 상태를 다시 설정하지 않아, 같은 오류가 다시 나도 로그가 남지 않음 — `await problem()`을 null 검사 앞으로 옮겨 기준 커밋의 동작을 되살렸다(한 줄 교정). `logs a recurring claim error after an empty successful claim` 시험을 더했다.
  - `[maybe-false]` `[defer]` edge-case-hunter 4: abort 때 모든 실행의 정리를 기다린다는 계획 주장이 `execute()` 예외에서는 깨짐 — blind-hunter 1과 같은 원인이다. 같은 이유로 보류한다.
  - `[medium]` `[patch]` verification-gap 1: 종료 중 정산 실패를 복구할 때까지 기다리는 동작이 검증되지 않음 — 렌즈의 검색 근거를 받아들였다. blind-hunter 9와 묶어, 끝없이 기다리는 동작을 한 번 재시도하고 끝나는 동작으로 바꾸고 그 동작을 시험했다.
  - `[false]` `[reject]` intent-alignment 1: 키를 출처·계정에서 만들지 않고 호출자가 넘김 — 티켓은 "선택 직렬화 키"를 두라고 한다. 실제 출처·계정 일감(Garmin)은 에픽 Boundaries가 epic-garmin-runtime으로 뺐다.
  - `[false]` `[reject]` intent-alignment 2: 보장이 스키마 불변식이 아니라 두 Store 청구 verb의 advisory lock 규약임 — 티켓이 "partial UNIQUE나 advisory lock 중 plan이 정한다"고 허용했다. 키를 얻는 경로는 그 두 verb뿐이다.
  - `[false]` `[reject]` intent-alignment 3: core 일감은 임대가 끝나기만 해도 키를 놓음 — core 청구에는 attempt 행이 없다. 임대가 끝난 청구는 기존 규칙(AD-21, `DEFAULT_WORK_POLICY`)에서 이미 잃은 청구라 같은 행도 다시 청구된다. 그래서 "attempt가 끝남"에 해당한다(Design Notes).
  - `[false]` `[reject]` intent-alignment 4: 두 프로세스 PG 시험과 용량 시험이 따로임 — verify는 시험 이름과 명령을 plan에 적으라고 한다. 용량 시험도 PG와 실제 probe 자식 프로세스로 돌고, 용량은 감독자 하나 안의 성질이다.
  - `[false]` `[reject]` intent-alignment 5: `unknown` 해제를 직접 SQL로 흉내 냄 — `unknown`을 푸는 verb는 아직 없다(12.2가 정함). verify가 요구하는 "풀릴 때까지 막는다"는 계약 시험이 fake·PG에서 확인한다.

### 2026-10-29 — Review pass (후속 thorough)
- verdicts: 20 findings — high 0, medium 2, low 9, false 6, maybe-false 3
- findings:
  - `[maybe-false]` `[defer]` blind-hunter 1: 예외 후 살아 있는 자식이 실행 집합에서 빠짐 — carried: 이전 blind-hunter 1과 위치·주장이 같고 해당 catch/finally도 그대로다. 기존 판정을 유지하며 원장과 기존 deferred 항목은 변경하지 않는다.
  - `[false]` `[reject]` blind-hunter 2: 로깅 실패가 종료 정리를 건너뜀 — 실제 조립은 `apps/cli/src/daemon/supervisor.ts`의 `daemonLog.write`를 쓰며, `daemon/log.ts`는 파일 쓰기·회전 오류를 내부에서 모두 삼킨다. 실제 호출자가 reject하는 경로를 제시하지 못했으므로 이 주장은 성립하지 않는다.
  - `[low]` `[reject]` blind-hunter 3: poll마다 미완료 Promise에 race 반응이 누적됨 — 실제로 실행이 끝날 때까지 등록이 남지만 기본 5초 주기의 수 시간 작업에서는 회차 수가 수천이고 완료 때 해제된다. 일상 사용에서 유의미한 장애를 보이지 않았으며 별도 완료 알림 장치를 추가해야 해서 기각한다.
  - `[low]` `[reject]` blind-hunter 4: advisory lock 대기 중 다른 키 청구도 기다림 — 잠금 보유자는 외부 실행을 기다리지 않는 짧은 청구 트랜잭션이며 `connect.ts`가 설정한 pool의 lock timeout으로 대기가 제한된다. 경쟁 시 짧은 지연은 실제이나 try-lock·재선택 정책을 더할 정도의 일상 피해가 없으므로 기각한다.
  - `[low]` `[reject]` blind-hunter 5: 청구 중 abort되면 새 자식이 잠깐 시작됨 — 기준 구현도 청구 뒤 execute를 시작하며, execute는 abort 신호를 등록한 직후 이미 abort됐는지 검사해 그룹 정리와 cancelled 정산을 한다. 누수 없이 종료되는 짧은 경쟁이고 별도 미실행 정산 분기가 필요하므로 기각한다.
  - `[low]` `[reject]` blind-hunter 6: 공유 lastProblem으로 실행 사이 오류 로그가 반복될 수 있음 — 오류와 성공이 교차하면 재출력이 가능하나 기존 단일 실행도 빈 성공 청구로 초기화했다. 로그 회전이 있고 실행·키 보장에는 영향이 없으며 출처별 상태 장치를 추가해야 해서 기각한다.
  - `[low]` `[reject]` blind-hunter 7: fake와 PG의 잘못된 키 수용 차이 — carried: 이전 blind-hunter 7과 동일한 코드·주장이다. 계획이 PG 검사 제약 오류를 허용하며 실제 키 호출자는 후속 에픽 소유라는 기존 기각 근거를 유지한다.
  - `[low]` `[patch]` blind-hunter 8: PG 그래프 경로의 키 저장·병합 보존 검증 누락 — PG addWorkGraph는 공통 ensureWork를 거쳐 실제 동작은 맞지만 그래프 소비자의 키 전달 회귀를 직접 잡는 시험은 없었다. `round trips graph serialization keys and preserves them when nodes merge`를 추가해 키와 null을 모두 확인했다.
  - `[medium]` `[patch]` blind-hunter 9: 종료 중 정산 실패 뒤 다음 incarnation 회수 검증 누락 — 종료 시험은 열린 token 보존에서 끝나고 다음 감독자의 reconcile까지 잇지 않는다. `a new incarnation settles failed shutdown attempts and runs waiting work with the same keys`를 추가해 이전 두 attempt의 정산·token 해제와 같은 키 대기 일감의 새 incarnation 실행을 확인했다.
  - `[low]` `[patch]` blind-hunter 10: 업그레이드 후 기존 행 null 키 보존 검증 누락 — SQL은 nullable 칸을 기본값 없이 추가하므로 현재 동작은 맞다. v1·v2 업그레이드 시험에 null 키와 claim/token 보존 assertion을 추가했다.
  - `[maybe-false]` `[defer]` edge-case-hunter 1: 예외로 자식이 용량·abort 정리에서 빠짐 — carried: 이전 blind-hunter 1·edge-case-hunter 1과 위치·주장이 같고 코드도 그대로다. 기존 판정을 유지하며 다시 보류하거나 원장을 수정하지 않는다.
  - `[low]` `[reject]` edge-case-hunter 2: 장기 실행 Promise의 race 핸들러 누적 — blind-hunter 3과 같은 원인이다. 기본 poll 주기의 실제 작업 길이에서 피해가 미미하고 수정은 알림 장치를 더해야 하므로 같은 이유로 기각한다.
  - `[low]` `[reject]` edge-case-hunter 3: worker 종료 뒤 receive가 제한시간까지 기다림 — carried: 이전 blind-hunter 5·edge-case-hunter 2와 동일한 코드·주장이다. vitest 제한시간으로 잘못된 통과 없이 실패하며 추가 상태 가드가 필요하다는 기존 기각을 유지한다.
  - `[maybe-false]` `[defer]` edge-case-hunter 4: 예외로 추적에서 빠진 자식은 abort 뒤 기다리지 못함 — carried: 이전 edge-case-hunter 4와 동일한 코드·주장이다. 기존 판정을 유지하며 원장과 기존 deferred 항목은 변경하지 않는다.
  - `[medium]` `[patch]` verification-gap 1: 종료 중 마지막 정산 재시도가 성공하는 경로 검증 누락 — 렌즈의 검색·시험 근거를 받아들였다. `settles both aborted children on the final retry after each token fails once`를 추가해 각 token이 정확히 두 번 정산되고 반환 전에 둘 다 cancelled이며 token·청구 칸이 비워짐을 확인했다.
  - `[false]` `[reject]` intent-alignment 1: 실제 계정 일감에 키 부여가 없음 — carried: 이전 intent-alignment 1과 같은 지적이다. 티켓은 선택 키 기반 계약이며 실제 인증·수집 종류는 에픽 경계가 후속 에픽으로 정했다.
  - `[false]` `[reject]` intent-alignment 2: 용량이 다중 감독자 공유 DB 슬롯이 아님 — 데몬 잠금이 단일 감독자를 보장하며 티켓은 감독자의 Core 상수 용량을 요구한다. 두 청구 경로의 키는 DB advisory lock으로 프로세스를 넘어 보장한다. 용량을 공유 슬롯으로 읽어야 하는 요구는 없다.
  - `[false]` `[reject]` intent-alignment 3: 두 프로세스 경합과 용량 검증이 별도 시험임 — carried: 이전 intent-alignment 4와 같은 지적이다. 실제 PG·자식 프로세스의 키 경합 시험과 실제 데몬의 용량·셋째 대기 시험이 각각 외부 표면에서 요구를 확인한다.
  - `[false]` `[reject]` intent-alignment 4: unknown 차단·해제가 다중 프로세스 시험에 함께 없음 — carried: 이전 intent-alignment 5와 같은 지적이다. 계약 시험이 양 청구 경로의 차단을, PG 시험이 token 해제 후 청구를 확인하며 해제 verb는 이 티켓의 요구가 아니다.
  - `[false]` `[reject]` intent-alignment 5: epic 18 분석 대신 probe로 core 소유 supervised를 검증함 — 에픽은 모델·실계정 없이 fake·probe로 확인하라고 명시한다. 등록부가 core 소유 process_probe를 supervised로 분류하고 실제 데몬 시험이 용량과 키를 확인하므로 요구 표면과 일치한다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): DB 보장은 advisory lock + 재확인이다. partial UNIQUE는 "살아 있는 core 임대"(`claim_expires_at > now`)를 색인 조건으로 쓸 수 없어, 죽은 drain의 만료된 청구가 다른 일감의 키를 영영 막거나 별도 정리 쓰기가 필요하다. 잠금은 키를 얻는 두 청구 verb만 잡고, 잠금 뒤 새 문장의 READ COMMITTED 스냅샷이 앞 보유자의 커밋을 본다. 잠금 순서는 행 잠금(skip locked) → 키 잠금이고 재확인은 잠그지 않는 select라 교착이 없다.

```text
loop:
  c = 후보(… and 키 없음 or 보유자 없음) for update skip locked
  c 없음 → null
  c.key 있음 → pg_advisory_xact_lock('work-key:'||key); 보유자 있음 → loop
  청구(update) → 커밋(잠금 풀림)
```

- Decision(2026-10-29, 추천으로 정함): core 일감의 키는 임대가 만료되면 놓인다. core drain 예산(30초)이 임대(600초)보다 훨씬 짧아 만료는 작업자가 사라졌다는 뜻이라는 기존 규칙(`DEFAULT_WORK_POLICY` 주석)을 그대로 따른다. `supervised`는 token이 진실이라 만료와 무관하다.
- Decision(2026-10-29, 추천으로 정함): 용량은 이 감독자 incarnation이 띄운 실행 중 자식 수다. 데몬 잠금으로 감독자는 한 번에 하나라 DB 슬롯이 필요 없다. `unknown` attempt는 세지 않는다. 풀 수단이 아직 없어 세면 두 건으로 감독자가 영영 멈추고, 같은 키 재실행은 키가 이미 막는다.
- 키는 넣는 쪽이 정한다. `failures retry`와 예약 발화는 키 없이 다시 넣으므로, 키가 필요한 일감 종류를 만드는 에픽(14)이 그 경로를 함께 정한다.

## Verification

**Commands:**
- `pnpm exec vitest run --project core test/contracts.test.ts test/supervisor.test.ts test/work-graph.test.ts` -- expected: fake 계약·변이 시험·감독자 용량 시험 통과.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts` -- expected: PG 계약 suite, 두 연결 경합, 두 프로세스 시험(`two processes never hold one serialization key at once`), 0008 통과. PG 사전 조건: OrbStack이 켜져 있다(global setup이 `second-brain-test-postgres-1`을 띄운다). 두 프로세스 fixture는 `dist`를 읽으므로 먼저 `pnpm build`.
- `pnpm exec vitest run --project cli test/daemon-supervisor.test.ts` -- expected: 실제 probe 자식의 용량·같은 키 시험 통과(`pnpm build` 뒤).
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.
- `git diff --check` -- expected: 출력 없음.

## Auto Run Result

Status: built

- 구현 요약: 티켓 12.7의 기존 직렬화 키·advisory lock·용량 2 구현을 후속 thorough 리뷰했다. 이번 실행은 소스를 바꾸지 않고 종료 정산·재시작 회수·PG 그래프·업그레이드 경로의 회귀 검증을 보강했다.
- 바뀐 파일:
  - `packages/core/test/supervisor.test.ts` — token별 첫 정산 실패 후 종료 직전 재시도 성공, 지속 실패 후 다음 incarnation의 두 attempt 회수와 같은 키 대기 일감 실행 시험.
  - `packages/postgres/test/work-store.test.ts` — 그래프로 넣은 키·null 왕복과 노드 병합 시 기존 키 보존 시험.
  - `packages/postgres/test/migrate.test.ts` — v1·v2 업그레이드 후 null 키와 기존 claim/token 보존 확인.
  - 이 계획 파일 — 후속 리뷰 판정과 검증 결과. `status`는 시작 때의 `built`를 유지했다.
- 리뷰 판정: 네 렌즈의 20건 전부 기록했다. high 0, medium 2, low 9, false 6, maybe-false 3. 패치 네 묶음(medium 2, low 2)을 모두 적용했다. 기존 보류 판정을 이월한 세 지적은 기존 항목 한 건과 같은 원인이므로 새 deferred 항목을 만들지 않았다.
- 기각 근거:
  - blind-hunter 2 — 실제 `daemonLog.write`가 오류를 내부에서 삼켜 reject하지 않는다.
  - blind-hunter 3, edge-case-hunter 2 — 실행 종료까지 race 반응이 남지만 기본 주기의 수 시간 작업에서 유의미한 피해를 보이지 않았고 별도 알림 장치가 필요하다.
  - blind-hunter 4 — 외부 실행을 기다리지 않는 짧은 청구 트랜잭션의 경합 지연이며 pool lock timeout으로 제한된다.
  - blind-hunter 5 — 기존 동작이며 execute가 이미 abort된 신호를 바로 처리해 정리·정산한다. 별도 미실행 정산 분기를 더할 실익이 작다.
  - blind-hunter 6 — 로그 재출력은 실행·키 보장에 영향이 없고 회전되며 출처별 상태를 더해야 한다.
  - blind-hunter 7 — 기존 판정 이월. 계획이 PG 검사 제약 오류를 허용한다.
  - edge-case-hunter 3 — 기존 판정 이월. worker 종료를 놓쳐도 시험 제한시간으로 실패하므로 잘못된 통과는 없다.
  - intent-alignment 1 — 선택 키 계약이며 실제 인증·수집 종류는 후속 에픽 소유다.
  - intent-alignment 2 — 데몬 잠금이 단일 감독자를 보장하고 키 상호배제만 프로세스를 넘는다.
  - intent-alignment 3 — 키 경합과 실제 데몬 용량을 각각 PG·실제 프로세스에서 확인한다.
  - intent-alignment 4 — 양 청구 경로의 unknown 차단과 PG token 해제를 확인하며 해제 verb는 요구가 아니다.
  - intent-alignment 5 — 에픽이 fake·probe로 확인하도록 정했고 core 소유 supervised probe가 용량·키를 검증한다.
- 후속 리뷰 권고: `false`. 후속 pass의 패치 묶음은 high 0, medium 2, low 2이므로 high 패치가 있을 때만 재리뷰하는 규칙에 따라 수렴했다.
- 검증:
  - 첫 `pnpm test`: build·typecheck 성공, 3181개 중 3180개 통과. `dispatch.test.ts`의 paragraph separator 시험이 PG 준비 중 연결 시간 초과로 실패했다.
  - 실패 파일 단독 재실행 `pnpm exec vitest run --project cli test/dispatch.test.ts`: 87개 전부 통과.
  - 구현 세션의 변경 파일 한정 검증: 세 파일 156개 시험 전부 통과.
  - 보강 뒤 `pnpm test`: build·typecheck 성공, 119개 파일·3184개 시험 전부 통과. 두 프로세스 키 경합, 실제 advisory lock 대기·버린 키 해제, 실제 probe 병렬 용량, 데몬 종료·재시작 시험 포함.
  - `git diff --check`: 통과.
- 보존 확인: 시작 때 존재하던 `deferred-work.md` 변경(DW-21 추가)은 내용을 바꾸지 않았다. 기존 원장 항목·상태·해소 근거와 계획의 기존 deferred 항목도 그대로다. `tickets.py mark`는 실행하지 않았다.
- 남은 위험: 기존 보류된 execute 예외 경로는 기존 판정을 유지했다. PG 동시 query deprecation 경고는 남고, 첫 전체 실행의 DB 연결 시간 초과는 단독·전체 재실행에서 재현되지 않았다.
- 인계: `built` 결과로 HALT한다. 티켓 done 처리는 오케스트레이터의 자체 검증 뒤에 맡기며, 필요한 사람 결정은 없다.
