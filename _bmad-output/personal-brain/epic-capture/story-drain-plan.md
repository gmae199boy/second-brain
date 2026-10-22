---
title: '일감 대기열과 drain'
type: 'feature'
ticket: '11'
created: '2026-10-19'
status: done
baseline_revision: '46c93ffed3bc800bb98a7ebb13bff8802263b799'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: [oversized]
deferred:
  - summary: >-
      spool `failure` 레코드를 DB로 되돌리는 재주입 handler가 없다(쓰는 쪽만 있다).
    evidence: |-
      drain이 실패 기록을 DB에 못 쓰면 `kind: 'failure'` 줄을 spool에 남긴다. `replaySpool`은 handler가 없는 kind를 되돌리고 멈추므로 그 줄은 안전하게 남지만 다시 들어가지 않는다. 재주입은 story 12의 몫이다.
    location: >-
      packages/core/src/queue/drain.ts
    severity: medium
  - summary: >-
      데몬이 살아 있으면 기회적 drain을 끄는 예외(AD-7·27)가 아직 없다.
    evidence: |-
      소켓 handshake가 필요하므로 epic-daemon이 더한다(plan Never).
    location: >-
      apps/cli/src/dispatch.ts
    severity: low
  - summary: >-
      같은 실패 키가 다시 날 때 `occurred_at`·`message`를 최신으로 바꿀지 사람이 정해야 한다.
    evidence: |-
      Decision 2는 Table Contract("`resolved_at`만 바뀜")를 지켜 `resolved_at`만 비운다. 그래서 100번째 실패도 처음 시각과 문장을 보인다. doctor·`failures list`(2.12)가 보일 값이다.
      해결됨(2026-10-19 사용자, B): 다시 날 때 `occurred_at`·`message`를 방금 것으로 바꾼다(이 커밋에서 고침). 처음 난 때와 횟수는 스토리 18의 0005가 칸으로 더한다.
    location: >-
      packages/sqlite/src/work.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** `work_items`·`failures` 테이블은 있지만(0002·0004) 쓰는 코드가 없다. 밀린 일을 청구하고, 다시 시도하고, 끝내 실패한 것을 기록할 길이 없다. 그래서 2.12(수집 일감)·2.20(꼬리표 다시 채우기)·다른 에픽의 일감이 올라설 틀이 없다(AD-21, H-8).

**Approach:** Core에 `WorkStore` 능력(넣기·할 일 읽기·청구·완료·다시 시도·돌려주기·실패 기록)과 종류별 정책 상수, 오류 분류, fingerprint, 실패 문자열 다듬기, drain 루프를 둔다. SQLite가 그것을 구현한다. CLI에는 `brain queue drain`을 더하고, hook이 아닌 명령 끝에서 기회적 drain을 돈다. 이 스토리는 실제 일감 종류를 하나도 만들지 않는다. handler는 주입으로만 들어오고, 첫 종류는 2.12가 더한다.

## Boundaries & Constraints

**Always:**
- **넣기.** 넣기는 미완료 키 `(kind, target_kind, target_id)`의 find-or-create다(`work_items_open_key_idx`). 이미 열린 행이 있으면 `created: false`이고 아무것도 바꾸지 않는다. id·시각은 호출자(Core)가 정한다(AD-8·13).
- **청구.** 청구는 `withWrite` 트랜잭션 하나에서 한다. 후보 한 행을 고른다(`completed_at is null and next_attempt_at <= now and (claim_expires_at is null or claim_expires_at <= now) and kind in (handler가 있는 종류)`, `order by attempts asc, id asc limit 1`). 같은 트랜잭션에서 `claimed_at = now`, `claim_expires_at = now + 그 종류의 청구 기간`, `claimed_by = 이 drain 실행의 id`, `attempts = attempts + 1`로 바꾼다. handler가 없는 종류는 청구하지 않고 그대로 둔다(그 종류를 아는 빌드의 몫).
- **청구 질의는 한 곳에서.** adapter가 쓰는 청구 질의는 export한 함수 하나가 만든다. `EXPLAIN QUERY PLAN` 테스트도 그 함수의 결과를 쓴다(SQL을 테스트에 베끼지 않는다). 결과에 `work_items_due_idx`가 있고 `TEMP B-TREE`가 없어야 한다.
- **끝내기.** 완료·다시 시도·돌려주기·실패 기록은 모두 `id`와 `claimed_by`가 둘 다 맞을 때만 바꾼다. 맞지 않으면(청구 기간이 지나 다른 워커가 가져감) 아무것도 바꾸지 않고 `lost`로 답한다.
  - 완료: `completed_at` = now, 청구 칸 셋을 비운다.
  - 다시 시도: `next_attempt_at`, `last_error`를 쓰고 청구 칸을 비운다.
  - 돌려주기: `attempts - 1`, 청구 칸을 비운다(`next_attempt_at`은 그대로).
- **정책 상수(Core).** `MAX_WORK_ATTEMPTS = 10`. 기본 정책은 청구 기간 10분, 지수 간격 `min(1000·2^(n−1), 3_600_000)` ms(n은 방금 끝난 시도 번호), 외부 일시 오류의 긴 간격 15분이다. 종류별 덮어쓰기 표는 처음에 비어 있다(`workKindPolicy(kind)`가 표 또는 기본값을 준다). 예산은 `DRAIN_BUDGET_MS = { command: 30_000, opportunistic: 2_000 }`이다.
- **오류 분류(AD-21).** handler는 던지지 않고 `{ok: true}` 또는 `{ok: false, code, message, retryable?, retryAfter?: Date}`로 답한다. `retryAfter`는 절대 시각이다(adapter가 `Retry-After`를 바꿔 넣는다). 판정 순서는 다음과 같다.
  1. code가 `DB_UNAVAILABLE`·`DB_LOCKED`·`SCHEMA_MISMATCH`이면 DB에 쓸 수 없음이다. 실패가 아니다. 돌려주기(시도 횟수 되돌림)를 하고 그 실행을 멈춘다.
  2. 그다음은 `retryable`이다. handler가 붙인 값이 먼저이고, 없으면 `errorCodeSpec(code)?.retryable`이다. `false`면 영구 오류다. 첫 실패에서 실패 기록과 닫기를 한다.
  3. `true`면 외부 일시 오류다. n < 10이면 `retryAfter ?? now + 긴 간격`으로 다시 시도한다.
  4. 그 밖(표에 없거나 `retryable`이 없음)은 모르는 오류다. n < 10이면 지수 간격으로 다시 시도한다.
  5. 일시 오류와 모르는 오류는 n ≥ 10이면 실패 기록과 닫기를 한다.
- **던진 handler.** handler가 던지면 drain이 잡는다. 모르는 오류(code `HANDLER_THREW`, Core 상수. 코드 표에 넣지 않는다)로 다룬다. 한 일감의 버그가 drain 전체를 죽이지 않는다.
- **실패 기록 함수 하나(Store `recordFailure`).** `failures`에 쓴다. 키는 `(target_kind, target_id, stage, fingerprint)`, 정보 칸은 `harness`·`session_id`(nullable), 그리고 `code`, `message`, `occurred_at`이다.
  - 같은 키가 있으면 그 행을 다시 연다(`resolved_at = null`). `occurred_at`·`message`는 방금 것으로 바꾸고, id와 정보 칸은 처음 것 그대로다(2026-10-19 사용자, Decision 2).
  - 선택 인자 `closeWork: {id, claimedBy, now}`가 있으면 같은 트랜잭션에서 그 일감을 닫는다(`completed_at`, `last_error`, 청구 칸 비움). 청구가 우리 것이 아니면 실패 행도 쓰지 않고 `lost`로 답한다.
  - drain은 마지막 시도에서만 이 함수를 부른다. `stage`는 일감 종류다. drain이 넘기는 `harness`·`session_id`는 null이다(2.12가 세션 대상에 채운다).
- **fingerprint(Core 함수 하나).** `failureFingerprint({stage, input, code})` = `sha256:` + `JSON.stringify([stage, input, code])`의 해시(`domain/sha256.ts`)다. 오류 문장·시각·경로·스택은 넣지 않는다. drain의 `input`은 `${target_kind}:${target_id}`다.
- **오류 문자열(Core 함수 하나).** `failures.message`와 `work_items.last_error`에 들어가는 문자열은 둘 다 이 함수를 지난다. `maskSecrets(text, 'body').text`로 가린 뒤 UTF-8로 8192바이트 이하가 되게 코드 포인트 경계에서 자른다(서로게이트 쌍을 가르지 않는다). payload는 두지 않는다.
- **실패 기록을 DB에 못 쓰면 spool.** `recordFailure`가 `DB_LOCKED`·`DB_UNAVAILABLE`로 답하면, 같은 내용을 spool 레코드 `kind: 'failure'`로 남긴다. payload는 키·정보 칸·code·message·`occurred_at`·`work_item_id`다. 줄 코덱(`spool-record.ts`)이 이 kind를 알게 한다. 재주입 handler는 2.12가 만든다. 그다음 drain 실행을 멈춘다.
- **drain 루프(Core `drainQueue`, SDK `brain.queue.drain({budgetMs, handlers?})`).**
  - 실행마다 `claimedBy = idGen.next()`다.
  - 매 청구 전에 잠금 없는 읽기 `hasDueWork({now, kinds})`로 할 일이 있는지 먼저 본다. 없으면 쓰기 잠금을 잡지 않고 끝낸다.
  - 시작부터 예산이 다 되면 새 청구를 하지 않는다. 처리 중인 일감은 끊지 않는다.
  - 결과 값은 `{claimed, completed, retried, failed, released, lost, spooled, stopped: 'empty' | 'budget' | 'unwritable', code?}`다.
  - handler는 `BrainDependencies.workHandlers`(Core가 나중에 더할 기본 종류와 합침, 지금은 비어 있음)와 호출 인자에서 온다.
- **`brain queue drain [--budget <seconds>]`.**
  - 메타: `risk: write`, `writes: true`, `hook: false`, `spool` 갈래 없음.
  - 쓰기 가드가 막으면 코드 표의 종료 코드로 거부한다.
  - `--budget`은 1~3600의 정수(초)다. 없으면 `DRAIN_BUDGET_MS.command`이다. 범위 밖이면 `USAGE`다.
  - `stopped: 'unwritable'`이면 그 code의 실패로 답한다(message에 그때까지의 건수). 아니면 ok와 `data` = 결과 값(snake_case)이고, 텍스트는 한국어 한 줄이다.
- **기회적 drain(디스패처).** 다음이 모두 맞을 때만 `execute()`에서 명령 결과를 만든 뒤, `brain.close()` 전에 한 번 돈다.
  - DB를 쓰는 명령이다(standalone 아님).
  - `spec.hook !== true`이다.
  - 명령이 기회적 drain을 끄지 않았다(새 칸 `drain?: false`. `queue drain` 자신이 끈다).
  - 설정이 읽혔다.
  - 명령 결과가 `ok: true`다.
  - `checkSchema`가 통과한다(어긋난 DB에는 쓰지 않는다).
  
  예산은 `DRAIN_BUDGET_MS.opportunistic`이다. 결과는 명령의 envelope·종료 코드를 바꾸지 않는다. 던지면 stderr 한 줄(한국어)만 남긴다. 테스트를 위해 `DispatchRuntime.workHandlers?`로 handler를 주입할 수 있다.
- 사람이 읽는 새 문구는 한국어다(Conventions '출력 언어'). README와 코드 대조, 출력 언어 검사가 통과해야 한다.
- Decision(2026-10-19, 무인 실행에서 에이전트가 고름) 다섯 가지:
  1. 시도 횟수는 **청구할 때** 올린다. 처리 중에 죽은 일감도 한 번으로 세어, 워커를 죽이는 일감이 끝없이 돌지 않게 한다. DB에 쓸 수 없어 멈출 때만 돌려주기로 되돌린다. 돌려주기마저 못 쓰면 그 한 번은 남는다. 다른 안: 실패를 기록할 때 올림(죽은 워커는 세지 않음).
  2. (2026-10-19 사용자가 B로 정함 — 처음 에이전트는 `resolved_at`만 비우는 안을 골랐다) 같은 실패 키가 다시 나면 행을 다시 열고 `occurred_at`·`message`를 방금 것으로 바꾼다. 그래서 `occurred_at`은 마지막으로 난 때다. 처음 난 때(`first_occurred_at`)와 횟수(`occurrences`)는 스토리 18의 0005가 칸으로 더하고 `recordFailure`가 채운다. 다른 안: A(칸 없이 최신으로만), C(실패한 일감마다 한 행).
  3. 기회적 drain은 hook이 아닌 DB 명령 전부(지금은 `doctor run`)가 결과를 만든 뒤 돈다. 명령이 성공했고 스키마가 맞을 때만이다. 다른 안: `doctor`는 제외(그러면 지금 기회적 drain을 부르는 명령이 없다).
  4. handler가 없는 종류는 청구하지 않는다. 다른 안: 영구 오류로 닫음(새 빌드가 넣은 일감을 옛 빌드가 지워 버린다).
  5. 오류 문자열은 저장 전에 가린다. 티켓이 그렇게 정했고, 마스킹 B("저장은 원문")는 대화 데이터에 대한 결정이다. 오류 문자열은 대화가 아니고 로그에 가깝다.

**Never:**
- 다음 일감 종류는 만들지 않는다: 세션 수집·폴더 스캔·spool 재주입 handler·`failures list/retry`·doctor 실패 항목(2.12), `session_identity`(2.20), 다른 에픽의 종류.
- 데몬이 살아 있을 때의 예외(AD-27, epic-daemon), `.open` 회수(2.12로 넘긴다), Postgres 구현(epic 7)은 하지 않는다.
- 새 오류·경고 코드를 코드 표에 더하지 않는다. 마이그레이션을 더하지 않는다(스키마는 0004 그대로). Core에서 I/O를 하지 않는다(AD-1).
- `failures`에 청구 칸이나 payload를 두지 않는다. 쓰기 가드가 막은 DB에 기회적 drain이 쓰는 일은 없다. hook 경로에서는 drain하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 겹친 drain | 같은 DB에 두 프로세스가 동시에 drain, 일감 20개, handler가 처리한 id를 파일에 적음 | 모든 id가 정확히 한 번, 모두 `completed_at` | — |
| 10번 실패 | 모르는 오류로 계속 실패, `next_attempt_at`을 테스트 clock으로 넘김 | 10번째 시도에서 `failures` 한 행, 일감 닫힘. 같은 키로 넣기는 새 행(`created: true`) | 1~9번째는 다시 시도, 지수 간격 1s·2s·4s… |
| 영구 오류 | `retryable: false`(예: `USAGE`, 또는 handler가 붙인 false) | 첫 시도에서 `failures` 한 행, 닫힘 | — |
| Retry-After | 일시 오류, `retryAfter` = now+90s | 그 시각 전 청구에는 나오지 않고, 그 시각에 나온다 | 없으면 now+15분 |
| 같은 원인 100번 | 같은 (stage, input, code)로 `recordFailure` 100번 | 한 행. 분류 코드가 다르면 다른 행 | 해결된 행은 다시 열림 |
| 청구를 놓침 | A가 청구 → 기간 지남 → B가 청구 → A가 완료·실패 | A는 `lost`이고 아무것도 바뀌지 않는다. `attempts`는 B의 청구만큼만 늘었다 | — |
| DB에 쓸 수 없음 | handler가 `DB_LOCKED` | 돌려주기(`attempts` 되돌림), `stopped: 'unwritable'`, 실패 행 없음 | — |
| 실패 기록 잠김 | `recordFailure`가 `DB_LOCKED` | spool에 `kind: 'failure'` 한 줄, `spooled: 1`, 멈춤 | — |
| 긴 오류 문자열 | 9000바이트 한국어·이모지와 `token=sk-…` | 저장 길이 ≤ 8192바이트, 깨진 글자 없음, 비밀 없음 | — |
| 모르는 종류 | handler 없는 kind만 있음 | 청구 0건, 행 그대로 | — |
| 예산 | handler가 clock을 예산보다 더 넘김 | 처리 중인 것은 끝내고 `stopped: 'budget'` | — |
| 할 일 없음 | 빈 대기열, 다른 프로세스가 쓰기 잠금을 쥠 | 청구(쓰기)를 부르지 않고 곧바로 `empty` | — |
| 기회적 drain | 주입한 handler + 열린 일감, `doctor run` | 명령이 끝난 뒤 일감이 처리됨. 출력·종료 코드는 drain이 없을 때와 같음 | hook 명령·스키마 불일치·명령 실패면 돌지 않음 |
| `queue drain` | 빈 대기열 / 가드 실패 / `--budget 0` | exit 0 `stopped: empty` / 코드 표 exit / `USAGE` exit 2 | — |

</intent-contract>

## Code Map

- `packages/core/src/ports/store.ts:304` -- `Store = HealthStore & SessionStore & UserStore`. 여기에 `WorkStore`를 더한다. 결과는 값이다(`DB_UNAVAILABLE`·`DB_LOCKED`, 읽기는 `DB_UNAVAILABLE`만). `findSession`·`ReadSelfUserResult` 주석 문체를 따른다. Postgres는 `Store`가 아니라서(`postgres/src/store.ts:49`, `HealthStore & SchemaStore`) 영향이 없다.
- `Store`를 넓히면 깨지는 곳: `packages/core/src/testing/fakes/store.ts`(`memoryStore`, 54·70행), `apps/cli/src/doctor/store.ts:21`(`failedConfigStore`, 모든 메서드를 나열한다), `apps/cli/test/dispatch.test.ts:1092`(`recorder` 리터럴).
- 새 `packages/core/src/domain/work-item.ts` -- 두 가지를 둔다. 하나는 `WorkItem` 타입(칸 = 0002 `work_items`)이다. 다른 하나는 정책 상수(`MAX_WORK_ATTEMPTS`, 기본 정책, 덮어쓰기 표, `workKindPolicy`, `retryDelayMs(n)`)와 `DRAIN_BUDGET_MS`다. `domain/index.ts`와 `src/index.ts`에서 export한다.
- `packages/core/src/domain/failure.ts` -- `Failure`를 대상 키 모양(`targetKind`, `targetId`, `harness: string|null`)으로 바꾼다(0004, deferred-work 항목). 같은 파일에 `failureFingerprint`, `FAILURE_MESSAGE_MAX_BYTES = 8192`, `truncateUtf8`, `failureText`를 둔다. 해시는 `domain/sha256.ts`(`sha256Hex` 계열, `utf8Bytes` 162행)를, 가리기는 `domain/secret-patterns.ts:265` `maskSecrets(text, 'body')`를 쓴다.
- 새 `packages/core/src/queue/drain.ts`(+ `src/index.ts`) -- `drainQueue(deps, input)`, `WorkHandler` 타입, 분류 함수(`classifyWorkFailure`, 테스트하기 쉽게 export). deps는 `{store: WorkStore, spool, clock, idGen}`이다. 분류는 `codes.ts`의 `errorCodeSpec`을 쓴다.
- `packages/core/src/brain.ts` -- `BrainDependencies.workHandlers?`, `BrainQueue { drain(input) }`, `Brain.queue`.
- `packages/core/src/domain/spool-record.ts` -- 70·77·109행의 kind 목록과 레코드 union에 `'failure'`와 그 payload(snake_case)를 더한다. 코덱 테스트 `packages/core/test/spool-record.test.ts`. `spool/replay.ts`는 handler가 없는 kind를 이미 "되돌리고 멈춤"으로 다룬다. 그대로 둔다.
- `packages/core/src/testing/{fakes/store.ts, contracts/work-store.ts(새), contracts/index.ts, index.ts}` -- 가짜 구현과 `workStoreContract()`. 본보기는 `contracts/user-store.ts:22`, `contract.ts`의 `contractCase`·`withSubject`다. 계약 사례:
  - 넣기 멱등
  - 청구 순서 `attempts, id`
  - 청구는 attempts+1
  - 살아 있는 청구는 다시 나오지 않음, 만료되면 나옴
  - `next_attempt_at` 미래는 안 나옴
  - kind 거름
  - 남의 청구로 끝내기는 `lost`
  - 완료 뒤 같은 키 넣기는 새 행
  - `recordFailure` 같은 키 한 행·다른 code 다른 행·`closeWork`가 닫음
  - 돌려주기는 attempts−1
  
  음성 가짜는 `packages/core/test/contracts.test.ts:380+` 방식으로 둘 둔다(attempts를 안 올리는 청구, 남의 청구로 완료하는 store).
- 새 `packages/sqlite/src/work.ts` + `store.ts:78-80`에 펼치기 -- `sqliteWorkStore(connect)`. 본보기는 `users.ts`다. 쓰기는 `withWrite(opened.connection, held => …)`이고, 안에서는 반드시 `held`만 쓴다(`write.ts:44-50`, 아니면 멈춘다). 읽기(`hasDueWork`)는 `opened.connection.db`다. 시각은 Core `formatInstant`/`parseInstant`(`core/src/instant.ts`)를 쓴다. 넣기는 `insert … on conflict (kind, target_kind, target_id) where completed_at is null do nothing`, 실패는 `on conflict (target_kind, target_id, stage, fingerprint) do update set resolved_at = null`이다. 청구 질의 빌더를 export한다(Always).
- `packages/sqlite/test/work-store.test.ts`(새) -- 계약 실행(`users.test.ts:65-71`처럼 `migratedPath()`), `EXPLAIN QUERY PLAN`(빌더 결과로; `schema-0004.test.ts:66-69`·769-810 방식 참고), `failures`·`work_items` 칸 값. 겹친 drain은 새 fixture `packages/sqlite/test/fixtures/drain-worker.mjs`로 한다. 빌드된 `dist`의 `sqliteStore`와 `@second-brain/core`의 `drainQueue`로 진짜 프로세스 둘을 돌린다. handler는 id를 파일에 append하고 조금 기다린다. 본보기는 `apps/cli/test/fixtures/spool-claimer.mjs`다.
- `packages/core/test/queue-drain.test.ts`(새) -- 가짜 store·`memorySpool`·조절 가능한 clock으로 매트릭스의 Core 행(10번, 영구, Retry-After, 놓침, unwritable, 실패 기록 잠김→spool, 던진 handler, 예산, 할 일 없음이면 `claimWork`를 부르지 않음)을 본다. `packages/core/test/failure.test.ts`(새)는 fingerprint·자르기·가리기를 본다.
- `apps/cli/src/dispatch.ts` -- `DatabaseCommandSpec`(263-294)에 `drain?: false`를 더하고, `DispatchRuntime`(318-329)에 `workHandlers?`를 더해 `createBrain`(510-528)에 넘긴다. 기회적 drain은 `execute()`의 `spec.run`·`finish` 뒤(약 575행), `finally { brain.close() }`(576) 앞에 둔다. spool 갈래(542-553)와 standalone(473)은 일찍 돌아가므로 닿지 않는다. 스키마는 `checkSchema(store, SQLITE_SCHEMA_VERSION)`(가드와 같은 함수)로 본다. `validateCommandMeta`(816-870)는 그대로 둔다.
- 새 `apps/cli/src/commands/queue-drain.ts` + `commands/index.ts` 등록부 -- 순서는 `doctor`, `guide`, `queue`, `sessions`, `setup`이다. 메타 7칸, `nsDescription`, 옵션 `{flags: '--budget <seconds>', description}`, `context.options['budget']`. 본보기는 `doctor-run.ts:35-72`, 옵션은 `setup-run.ts:40-49`다.
- `apps/cli/test/queue-drain.test.ts`(새) -- `dist/bin.js`로 빈 대기열 exit 0, `--budget 0`·`abc`는 exit 2, 스키마 불일치는 exit 1, DB 없음은 exit 2를 본다. 헬퍼는 `sessions-ingest.test.ts`의 `installedHome`·`runBrain`·`childEnvironment`이고, 불일치 home은 2.10 테스트 방식이다.
- `apps/cli/test/dispatch.test.ts` -- `runDispatch`(290-325, `node -e` 인라인 등록부)에 handler를 주입하는 사례를 더한다. 확인할 것:
  - hook 아닌 가짜 명령 뒤에 일감이 처리된다.
  - hook 명령·스키마 불일치·실패한 명령·`drain: false` 명령 뒤에는 처리되지 않는다.
  - 출력 envelope가 drain 없을 때와 같다.
  
  `recorder`(1092)에 새 메서드를 더한다.
- 등록부 순서를 단정하는 테스트: `apps/cli/test/guide.test.ts:89-160`, `command-meta.test.ts:45-60`, `output-language.test.ts:61-77`(`COMMAND_WORDS`는 등록부에서 만든다). 새 명령이 자동으로 들어가는지 확인하고, 순서를 박은 곳만 고친다.
- `README.md` -- 275행의 "뒤 스토리입니다" 문장을 고친다. 새 절 `## 밀린 일 처리`(`queue drain`, 예산, 기회적 drain, 실패 기록·10번·분류 요약)를 `## 하네스 세션 읽기`(239) 뒤에 둔다. 오류·경고 코드 표는 그대로다.
- `_bmad-output/personal-brain/deferred-work.md` -- `Failure` 항목(대상 키)을 해결로 표시한다. `.open` 회수 항목의 처분을 "story 12"로 좁힌다. 새 항목 둘을 더한다: spool `failure` 레코드 재주입 handler(2.12), 데몬 켜짐 예외(epic-daemon). 같은 키 실패의 `occurred_at` 갱신 여부(Decision 2)도 사람 확인 거리로 적는다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/{work-item,failure}.ts`, export, `packages/core/test/failure.test.ts` -- 타입·정책·fingerprint·오류 문자열 함수 -- 규칙을 Core 한 곳에.
- [x] `packages/core/src/ports/store.ts` -- `WorkStore` 능력과 결과 타입, 규칙 주석 -- 두 구현이 같은 약속.
- [x] `packages/core/src/testing/{fakes/store.ts,contracts/work-store.ts,contracts/index.ts,index.ts}`, `packages/core/test/contracts.test.ts` -- 가짜·계약·음성 가짜 둘.
- [x] `packages/core/src/domain/spool-record.ts`, `packages/core/test/spool-record.test.ts` -- `failure` kind.
- [x] `packages/core/src/queue/drain.ts`, `brain.ts`, `src/index.ts`, `packages/core/test/queue-drain.test.ts` -- 루프·분류·SDK -- 매트릭스 Core 행.
- [x] `packages/sqlite/src/{work.ts,store.ts,index.ts}`, `packages/sqlite/test/work-store.test.ts`, `packages/sqlite/test/fixtures/drain-worker.mjs` -- adapter, 계약, EXPLAIN, 겹친 drain 두 프로세스.
- [x] `apps/cli/src/dispatch.ts`, `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` -- 기회적 drain과 주입 seam.
- [x] `apps/cli/src/commands/{queue-drain.ts,index.ts}`, `apps/cli/test/queue-drain.test.ts`, 등록부 순서 테스트 -- 명령.
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문서와 항목.

**Acceptance Criteria:**
- Given `setup run --yes`로 만든 임시 home, when `brain queue drain --json`, then exit 0이고 `data.stopped`가 `empty`이며 envelope가 `ok`다. `brain guide schema queue drain --json`이 메타 7칸을 낸다.
- Given 같은 home, when `brain doctor run`, then 점검 보고와 종료 코드가 이 스토리 전과 같다(일감이 없으므로 기회적 drain은 쓰기 잠금을 잡지 않는다).
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과하고 출력 언어 검사와 README 코드 대조도 통과한다.

## Implementation Notes

구현 중 플랜이 정하지 않아 고른 것들.

- **`WorkStore` 모양.** `addWork`·`hasDueWork`·`claimWork`·`completeWork`·`retryWork`·`releaseWork`·`recordFailure` 일곱 개. 끝내기 셋은 `{ok: true, outcome: 'done' | 'lost'}`로 답한다(바뀐 행 수 0이 `lost`). `recordFailure`는 `{outcome: 'recorded', created, failureId}` 또는 `{outcome: 'lost'}`다 — `created`가 새 행과 다시 열린 행을 가른다.
- **청구 질의는 Kysely 빌더 하나.** 플랜은 "SQL 문자열을 만드는 함수"를 말했지만, 종류 목록을 placeholder로 넣으려면 Kysely의 템플릿을 거쳐야 한다. 그래서 `claimCandidateQuery(query)`가 `RawBuilder`를 돌려주고, EXPLAIN 테스트는 그것을 `compile(db)`해서 쓴다. 베끼는 자리가 없다는 성질은 그대로다.
- **`indexed by work_items_due_idx`.** `kind in (?, ?)`가 붙으면 플래너가 `work_items_open_key_idx (kind=?)`를 고르고 뒤에 정렬한다(실측: `USE TEMP B-TREE FOR ORDER BY`). 그 계획은 첫 종류의 밀린 일을 다 처리한 뒤 다음 종류로 가는 것이어서, 이 인덱스가 막으려던 굶김이다. 인덱스를 이름으로 박으면 계획이 고정되고, 인덱스를 지우면 질의가 컴파일되지 않는다.
- **`SpoolRecord`는 kind 기준 union.** `failure` payload를 더하면서 레코드를 `SessionIngestSpoolRecord | FailureSpoolRecord`로 나눴다. 그래서 payload를 kind를 묻지 않고 뜯는 코드는 컴파일되지 않는다. `encodePayload`는 `switch`라서 kind를 더하고 case를 빼면 빌드가 깨진다. 기존 테스트의 `payload.cause` 두 곳은 narrow하도록 고쳤고, `sessions-ingest.test.ts`의 `spooled()`는 `session_ingest`만 거르는 helper가 되었다.
- **handler 없는 kind를 청구했을 때.** 청구가 `kinds`로 거르므로 일어날 수 없지만, store가 그 필터를 무시하면 handler가 `undefined`다. 결과 값의 `stopped`는 세 가지로 고정되어 있어 새 값을 넣을 수 없으므로, Core 상수 `WORK_HANDLER_MISSING`(코드 표 밖)으로 "모르는 오류"로 다룬다. 지수 간격으로 물러나고 열 번째에 기록되므로 루프가 돌지 않는다. 던진 handler의 `HANDLER_THREW`와 같은 길이다.
- **읽기 실패도 `unwritable`.** `hasDueWork`가 `DB_UNAVAILABLE`로 답하면 `stopped: 'unwritable'`과 그 코드로 멈춘다. 플랜이 그 갈래를 적지 않았고, "닿지 않는 DB에서 청구를 시도한다"보다 이것이 맞다.
- **돌려주기마저 실패하면.** `releaseWork`가 실패해도 멈추는 코드는 handler가 낸 원인 코드 그대로다(돌려주기 실패가 다른 문제는 아니다). 그 한 번의 시도는 남는다 — 플랜의 Decision 1이 그렇게 정했다.
- **기회적 drain의 자리.** `execute()`에서 `finish()`로 결과를 만든 **뒤** 돌고, `finally { brain.close() }` 앞이다. 조건 다섯(`hook !== true`, `drain !== false`, 설정이 읽힘, `outcome.ok`, `outcome.failed !== true`)은 `shouldDrain()` 하나에 있고, `checkSchema`는 질의 비용이 있으므로 그 뒤 `drainOpportunistically()`에서 본다. 던지면 stderr 한 줄만 남기고 봉투·종료 코드는 건드리지 않는다.
- **`failed: true`도 돌지 않는다.** 플랜은 "명령 결과가 `ok: true`"라고 적었지만, `doctor run`은 점검이 실패하면 `ok: true, failed: true`(exit 1)로 답한다. 그 보고가 "이 brain은 망가졌다"고 말한 직후에 drain이 그 DB에 쓰면 안 되므로 조건을 하나 더 봤다.
- **기회적 drain은 연결을 따로 연다.** 예산 2초는 "또 청구할지"만 정하고 한 번의 청구가 잠금을 기다리는 시간은 묶지 않는다. 명령의 store는 `BUSY_TIMEOUT_MS.command`(10초)로 열려 있으므로, 다른 프로세스가 쓰는 중이면 아무도 부탁하지 않은 drain 때문에 명령 출력이 10초 늦는다. 그래서 `createStore({path, busyTimeoutMs: DRAIN_BUDGET_MS.opportunistic})`로 자기 연결을 열고, 스키마도 그 store로 보고, 끝나면 닫는다. 새 공개 표면은 없다.
- **`validateCommandMeta`는 그대로.** `drain: false`에 대한 규칙을 더하지 않았다(플랜 Code Map). `queue drain`이 유일한 선언자이고, 더할 규칙이 생기면 그때가 자연스럽다.
- **`created`는 넣기 전 조회로 정한다.** 두 adapter 모두 "그 행이 이 호출 전에 있었나"로 답한다. `row.id === input.id`로는 안 된다 — spool의 `failure` 레코드를 되넣는 쪽(2.12)은 처음 만든 id를 그대로 제안하므로 두 번째 호출이 `created: true`가 되고, 키로 찾는 가짜 구현과 어긋난다. 계약 사례 하나가 둘을 묶는다.
- **`--budget` 거부.** `/^\d+$/`로 먼저 보므로 `-1`·`1.5`·`abc`·`0`·`3601`이 모두 `USAGE` exit 2다. commander가 값을 문자열로 주기 때문에 숫자 변환만으로는 `1.5`가 통과한다.
- **점검 수는 그대로.** doctor에 아무것도 더하지 않았으므로(spool 점검은 2.10) README의 요약 예시와 점검 id를 박은 테스트는 손대지 않았다.

- (메인 세션, 검증 단계) 리뷰 수정 5에서 `packages/sqlite/test/fixtures/lock-holder.mjs`를 실제 스키마용으로 바꿨더니, 그 fixture가 `notes`에 쓴 행을 단정하던 `write.test.ts`가 깨졌다. 공용 fixture는 원래대로 되돌렸다. 실제 스키마의 잠금은 새 `schema-lock-holder.mjs`(자기 테이블을 만들고 rollback)가 쥔다. 그리고 매트릭스의 "같은 원인 100번" 행을 그대로 도는 SQLite 사례를 하나 더했다(계약은 두 번만 기록한다).

## Plan Change Log

## Review Triage Log

### 2026-10-19 — Review pass
- verdicts: 7 findings — high 0, medium 3, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `apps/cli/src/dispatch.ts` `shouldDrain`이 `ok: true, failed: true`(exit 1)를 성공으로 본다. 그래서 점검이 실패한 `doctor run` 뒤에 기회적 drain이 돈다. `doctor-run.ts:69`로 확인했다. 고침: `outcome.failed !== true` 조건을 더하고 `failed: true` 가짜 명령 사례를 더했다.
  - `[low]` `[patch]` `queue drain` 텍스트 줄의 마지막 절 `spool 0.`에 한글이 없어 출력 언어 검사기에 걸린다. 테스트가 `toContain`만 봐서 놓쳤다. 고침: 절마다 `건`을 붙이고 `assertKoreanLines`로 단정한다.
  - `[medium]` `[patch]` SQLite `addWork`·`recordFailure`가 `created`를 제안 id 비교로 정한다. 같은 id로 두 번 부르면 거짓 `created: true`가 나고, 가짜 store와 답이 다르다(2.12의 spool 재주입이 만난다). 고침: 같은 트랜잭션에서 넣기 전에 읽어 정한다. 계약 사례 "같은 제안 id 두 번"을 더했다.
  - `[low]` `[reject]` `hasDueWork`가 할 일이 없을 때 미완료 일감 전체를 훑는다(선두 열이 `attempts`). 사실이다. 하지만 개인 규모의 밀린 일, 그것도 모두 미래로 미뤄졌거나 청구 중인 수천 행이어야 체감된다. 고치려면 새 질의나 인덱스가 필요하다(마이그레이션 금지).
  - `[medium]` `[patch]` 기회적 drain의 2초 예산이 쓰기 잠금 대기를 막지 못한다. 명령 store가 `BUSY_TIMEOUT_MS.command`(10초)라서, 경합 중이면 명령 출력이 최대 약 10초 늦게 나온다. 고침: 기회적 drain이 `createStore({busyTimeoutMs: DRAIN_BUDGET_MS.opportunistic})`로 자기 연결을 열고, 스키마도 그 연결로 보고, 닫는다(dispatch.ts 안, 공개 표면 없음). 기록 테스트는 두 번의 createStore를 단정한다.
  - `[low]` `[patch]` 매트릭스 "할 일 없음"(다른 프로세스가 쓰기 잠금을 쥠)이 메모리 store로만 덮였다. 고침: 다른 프로세스가 잠금을 쥔 SQLite 파일에서 `drainQueue`·`hasDueWork`가 곧바로 `empty`인 사례를 더했다(새 `schema-lock-holder.mjs`. 공용 fixture를 바꾼 첫 시도는 `write.test.ts`를 깨서 되돌렸다).
  - `[low]` `[patch]` `addWork`의 `row === null` 갈래의 주석·메시지가 닿지 않는 경우를 설명한다. 다른 행의 id는 기본 키에서 실패해 `catch`로 간다. 고침: 방어용 갈래라고 문구만 바로잡았다(`recordFailure`도 같음).

## Design Notes

청구와 끝내기를 compare-and-set으로 묶은 이유: 청구 기간이 지나면 다른 워커가 같은 행을 가져갈 수 있다. 옛 워커의 늦은 완료나 실패가 새 워커의 상태를 덮으면, "놓친 워커는 시도 횟수를 올리지 않는다"와 "한 번만 처리한다"가 둘 다 깨진다. 그래서 모든 끝내기는 `where id = ? and claimed_by = ?`이고, 바뀐 행이 0이면 `lost`다.

```ts
// drain, one item
const claim = await store.claimWork({ now, claimedBy, kinds });   // attempts+1 inside
const outcome = await safely(handlers[item.kind], item);
const verdict = classifyWorkFailure(outcome, item.attempts, policy, now);
// 'complete' | {retry: Date} | 'record' | 'release'
```

## Verification

**Commands:**
- `pnpm test` -- expected: 모두 통과(Postgres 프로젝트는 globalSetup이 준비한다)
- `pnpm typecheck` -- expected: 오류 없음

**Manual checks (if no CLI):**
- 임시 home에서 `node apps/cli/dist/bin.js queue drain`과 `queue drain --help`의 한국어 줄을 눈으로 읽는다.

## Auto Run Result

**요약:** `work_items` 대기열과 drain의 틀을 만들었다. Core에는 다음을 두었다.
- `WorkStore` 능력(넣기·할 일 읽기·청구·완료·다시 시도·돌려주기·실패 기록)
- 정책 상수(10번, 지수 1초~1시간, 청구 10분, 일시 오류 15분, 예산 30초·2초)
- 오류 분류(`classifyWorkFailure`), fingerprint, 오류 문자열 다듬기(가린 뒤 8KB에서 UTF-8 경계로 자름)
- spool `failure` 레코드
- drain 루프와 SDK `brain.queue.drain`

SQLite가 이 능력을 구현한다. 청구는 트랜잭션 하나이고 compare-and-set이며 `work_items_due_idx`를 쓴다. CLI에는 `brain queue drain [--budget <초>]`와, hook이 아닌 성공한 명령 끝의 기회적 drain(자기 연결, 2초)을 더했다. 실제 일감 종류는 없다. 첫 종류는 2.12가 더한다.

**바뀐 파일:**
- `packages/core/src/domain/{work-item,failure,spool-record}.ts` — 일감 타입·정책, `Failure` 대상 키·fingerprint·오류 문자열, `failure` spool kind
- `packages/core/src/ports/store.ts` — `WorkStore`, `Store`에 합침
- `packages/core/src/queue/drain.ts`, `brain.ts`, `index.ts` — drain 루프, `Brain.queue`
- `packages/core/src/testing/{fakes/store,contracts/work-store,fixtures}.ts` — 가짜·계약
- `packages/sqlite/src/{work,store,index}.ts` — adapter, 청구 질의 빌더
- `apps/cli/src/{dispatch.ts,commands/queue-drain.ts,commands/index.ts,doctor/store.ts}` — 명령, 기회적 drain, 주입 seam
- 테스트: `packages/core/test/{failure,queue-drain,contracts,spool-record}.test.ts`, `packages/sqlite/test/work-store.test.ts`와 fixture `drain-worker.mjs`·`schema-lock-holder.mjs`, `apps/cli/test/{queue-drain,dispatch,sessions-ingest}.test.ts`
- `README.md`(`## 밀린 일 처리`), `deferred-work.md`

**리뷰:** quick 1회, 7건이다.
- 패치 6건: medium 3(실패한 doctor 뒤 drain, 거짓 `created`, 잠금 대기 10초), low 3(출력 언어, 잠금 상태 테스트, 주석)
- 기각 1건(low): 할 일 없을 때 백로그 전체 훑기. 일상 규모에서 만나지 않고, 고치려면 새 질의나 인덱스가 필요하다.
- 보류 3건(frontmatter `deferred`): spool `failure` 재주입(2.12), 데몬 켜짐 예외(epic-daemon), 같은 실패 키의 시각·문장 갱신 여부(사람 확인)

**후속 리뷰 권고: true** — 첫 회차에서 medium 3건을 패치했다. 검증되지 않은 위험이 하나 남았다. 기회적 drain이 이제 성공한 hook 아닌 명령마다 같은 파일에 두 번째 연결을 연다. 그 연결이 일감이 있을 때 실제 handler와 겹쳐 쓰는 동작은 2.12의 첫 종류가 생기기 전까지 주입된 handler로만 시험된다.

**검증:**
- `pnpm test`(build → typecheck → vitest, Postgres 포함): 53파일 1747건 통과
- 겹친 drain(두 프로세스, 일감 20개): 모두 정확히 한 번 처리
- 청구 질의의 `EXPLAIN QUERY PLAN`: `work_items_due_idx`를 쓰고 `TEMP B-TREE`가 없다
- 임시 home 수동 확인: `queue drain`이 한국어 한 줄과 exit 0을 내고, `doctor run`은 그대로다(12점검, exit 0)

**에이전트가 대신 내린 결정**(Always의 Decision 1~5, Implementation Notes):
1. 시도 횟수는 청구 때 올린다.
2. 같은 실패 키가 다시 나면 `resolved_at`만 비운다. 사람 확인 뒤 B로 바뀌었다(아래 사람 확인 결과).
3. 기회적 drain은 hook이 아닌 DB 명령 전부에서 돈다. 성공·스키마 일치일 때만이고, 리뷰 뒤 `failed: true`도 뺐다.
4. handler가 없는 종류는 청구하지 않는다.
5. 오류 문자열은 저장 전에 가린다.

구현이 더한 결정도 있다. 청구 질의에 `indexed by work_items_due_idx`를 박았다. 이것이 없으면 플래너가 `kind`의 인덱스와 임시 정렬을 고른다(실측).

**남은 위험:** 실제 일감 종류가 없어서 루프는 주입된 handler로만 돌았다. spool `failure` 줄은 2.12 전까지 다시 들어가지 않는다. `hasDueWork`·청구는 미완료 백로그가 커지면 선형으로 훑는다.

**사람 확인 결과(2026-10-19):**
- Decision 1·3·4·5는 그대로다. 3(기회적 drain)은 남기고, 데몬이 살아 있을 때 끄는 예외는 epic-daemon이 맡는다. 4의 빈틈(모르는 종류의 일감이 doctor에 보이지 않음)은 남겨만 둔다.
- Decision 2는 B로 바뀌었다. 같은 원인이 다시 나면 행을 다시 열고 시각·문장을 방금 것으로 바꾼다(`work.ts`, 가짜 store, 포트 주석, README, SQLite 테스트). 처음 난 때와 횟수 칸은 스토리 18(0005)의 티켓에 넣었다. Table Contract·epic Notes·deferred-work도 맞췄다.
