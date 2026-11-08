---
title: 'Garmin artifacts locator 정리 경합 회귀 복구'
type: 'bugfix'
ticket: 12
created: '2026-11-08'
status: 'built'
baseline_revision: '720df8ef2f20b9e1b39d93ecec376b79ab9aacb5'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
operator_actions:
  - 중앙은 제출된 정확 source와 19.5의 fixture/시험/workload/measurement 영향 및 동결 선정 규칙을 독립 대조한다. 이전 source 성능 표본은 재사용하지 않는다.
  - 중앙 수락과 main 병합·push는 별도 판단이다. 기존 자동 승인 거절을 이 브랜치로 우회하지 않는다.
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 동일 locator 재발행과 core 정리 시험의 세 번째 동기 Python 반입이 간헐적으로 실패한다. 과거 stdout·SQLSTATE가 없어 W9의 실제 원인은 미확정이다.

**Approach:** 실제 호출 순서와 세션 잠금을 구별하는 결정적 barrier 회귀를 작성하고 시험 전제 또는 보존 어댑터를 최소 교정한다. 과거 원인 확정과 새 회귀가 증명하는 결함을 구별한다.

## Boundaries & Constraints

**Always:** 실제 반입·locator 잠금·cleanup·작업 fence·바이트·멱등성·가림 계약을 유지한다. 개발과 리뷰 수정 중 시험 실행 금지, 컴파일 확인만. 마지막 독립 후속 뒤 전체 TS→Python을 순차 각1회 실행하고 실패 수정은 관련 재검증한다. 자기 합성 PG·home·TMPDIR·venv만 사용하고 정확한 소유 자원을 정리한다.

**Never:** 19.5 runner/config·slot·동결 집합·성능 gate, schema42·적용 migration, 8.4 소유 파일을 변경하지 않는다. sleep·timeout 증가·재시도·단언 완화·4slot 제외를 금지한다. 제품 source 변경 필요시 구체 원인·최소 diff·독립 근거로 중앙 범위를 먼저 요청한다. main/state 수정·병합·push 및 승인 거절 우회 금지.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 재발행과 정리 | 두 번째 실제 반입이 locator 잠금을 보유 | core가 대기하며 staging을 너무 일찍 삭제하지 않음 | 자식 원래 결과와 실패 단계 보존 |
| 정리 표시와 해제 간극 | cleaned_at 커밋 후 unlock 전을 결정적으로 제어 | 실제 잠금 보유를 확인하고 세 번째 반입과 해제 순서를 보장 | 같은 Node 타이머만으로 진행을 증명하지 않음 |
| 세 번째 반입 | 완료된 기존 요청·현재 work fence | 정상 result, 재staging·중복 발행·오래된 작업 쓰기 없음 | 원래 child status/signal/stdout/stderr/output·phase/SQLSTATE 가림 보존 |

</intent-contract>

## Code Map

- `apps/cli/python-test/fixtures/artifacts-lifecycle.ts` — 실제 경합 시험과 격리 timeout fixture가 공유하는 중단 fence·본문 정착·최종 dispose·재귀 오류 가림.
- `apps/cli/python-test/fixtures/lifecycle-timeout.fixture.ts`, `lifecycle-vitest.config.mjs` — 바깥 정상 시험이 예상 timeout을 확인하는 독립 자식 Vitest. 정규 선택은 이 fixture를 직접 실행하지 않는다. 새 경로는 test-changed exact 규칙에 등록했다.

- `apps/cli/python-test/garmin-artifacts.test.ts:452` — 대상 case(원본 경로 344행). installPreservationAdapter가 설치 import.py를 시험 어댑터로 교체한다. 두 번째 stage barrier는 실제 locator session lock 안이다. cleaned_at poll 뒤 세 번째 execFileSync는 같은 Node 비동기 unlock 발송을 막을 수 있다.
- `extensions/garmin/tests/preservation_entry.py` — 실제 진입점. lock1500/statement1900/transaction2000ms 제한과 광역 catch→IMPORT_INVALID 축약 경로. 원문 메시지 대신 안전한 구조 필드로 실패 단계 관측을 보강한다.
- `packages/postgres/src/imports.ts:20` — cleanupImport는 session lock→deleting_at→remove→cleaned_at→별도 unlock 순서. 읽기 전용 조사 대상이며 제품 변경은 중앙 범위 승인 전 금지.
- `extensions/garmin/src/artifact_publish.py:36` 및 `artifacts.py` — prepare_locator는 completed 검사 전 잠금 획득. 실제 경로 유지, 읽기 전용.
- `.brain-automation/tickets/19.12/independent-spec.md`, `evidence/` — 중앙 명세·과거 실패·후속 독립 추적. W9-failure의 파일 사이 경계 해석은 w9-trace의 fixture 획득 검사 정정을 따른다.

## Tasks & Acceptance

**Execution:**
- [x] 1. 대상 시험과 보존 어댑터의 실제 Promise/query·세션 호출 순서를 정적으로 조사하고 `.brain-automation/tickets/19.12/cause-analysis.md`에 원인 확정 범위를 기록한다. 결정적 barrier 설계와 최소 교정을 작성한다. 제품 source 변경이 필요하면 편집 전에 중앙 요청 근거를 보고한다.
- [x] 2. `apps/cli/python-test/garmin-artifacts.test.ts` 및 필요한 시험 전용 helper/`extensions/garmin/tests/preservation_entry.py`에 결정적 경합 회귀·최소 교정·가림된 실패 관측을 구현한다. 새 Python/자식 경로가 생기면 `tooling/test-changed/rules.mjs` 선택 규칙을 보완한다. 기존 case·timeout·단언·실제 호출을 보존한다.
- [x] 3. 독립 4렌즈와 필요한 개별 수정 후속 확인을 마치고 마지막 전체 회귀 및 관련 처분·정확 자원 부재를 보존한다. 계획과 최종 보고에 19.5 fixture/시험/workload/measurement 의미 변경을 인계한다. 범위 커밋·브랜치 push·원격 SHA 확인·중앙 제출은 지휘자가 수행한다.

**Acceptance Criteria:**
- Given 동일 locator 반입과 정리, when 원래 잠금 보유·cleaned_at·unlock·세 번째 반입 순서를 강제, then 실제 보유/대기와 정상 반입 및 staging·작업 소유 계약을 관측한다.
- Given 오류 경계, when 자식 또는 DB 작업 실패, then 원래 status/signal/stdout/stderr/output와 phase/SQLSTATE가 비밀·원시 URL·snapshot·개인 홈 절대 경로 없이 보존된다.
- Given 독립 리뷰 완료 source, when 필수 TS→Python 순차 회귀와 실패별 관련 재검증, then 미해결 필수 실패가 없고 최초 실패·명령·exit·source·소유 자원 정리 증거 및 19.5 인계가 남는다.
- Given 수정 불필요 판단, when 보고 당시 조건 대조, then 결정적 반증을 제시한다. 단일 성공·미재현만으로 충족하지 않는다.

## Implementation Notes

- 최종 어댑터 진단은 stderr의 고정 preservation_diagnostic 한 줄이며 stdout error는 원래 strict ABI 네 필드를 유지한다. 실제 adapter 출력에 decoder/run 소비자와 report-not-ready 계약 회귀를 연결했다. 마지막 소비자 시험은 가려진 공개 work_id와 명령 전/후 유일한 rawId를 구별해 실제 보고서 파일을 읽는다. 제품 source와 가림 정책은 유지했다.

- 후속 최종 설계는 stdin 선행 해제를 제거하고 세 번째 실제 원래 entry 직전 query gate 해제 microtask를 예약한다. 원래 동기 호출로 회귀하면 Node continuation이 멈춰 실제 기존 locator lock_timeout으로 유한 실패한다. 정상은 실제 unlock 발송/응답/true·PG 잠금 부재와 정확 result ABI를 단언한다.
- 마지막 수정은 공통 lifecycle의 stopped fence→interrupt→본문 정착→dispose와 재귀 AggregateError/cause 보존이다. 실제 Vitest timeout fixture에서 늦게 푼 await 뒤 spawn/query override0·child 종료·복원을 검사한다. 모든 실질 수정은 독립 후속 개별 확인을 마쳤다.

- 구현 보고 1~2에서 잘못 삽입한 별도 case gate를 제거했고 대상 case만 교정했다. pnpm typecheck는 python-test를 포함하지 않아 별도 임시 TS 설정으로 해당 파일을 컴파일했다.
- 재도출 1은 fixture·application_name·정확 locator/source의 pg query 발송 전을 제어하고 세 번째 자식을 획득 전 stdin handshake로 대기시킨다. unlock 발송/응답·잠금 부재 뒤 실제 import를 진행시킨다. 잘못된 동기 실행에서는 제어 루프가 멈추어 handshake가 끝나지 않는다.
- 자식 close/error 즉시 수집, 가림 후 전체 출력 보존, 모든 정리 시도, 실제 완료 token 거부와 mapping/request/staging 불변, locator 획득/본문/해제 및 verify 오류의 시험 코드를 작성했다. 기존 timeout과 제품 source는 유지했다.
- `pnpm build`, `pnpm typecheck`, python-test 포함 별도 TS 컴파일, Python AST 구문 확인, diff check는 종료0. 개발/리뷰 중 시험은 실행하지 않았다. 독립 후속과 최종 회귀는 아직 미완료다.

## Plan Change Log

### 2026-11-08 — 공개 work_id와 실제 보고서 경로의 구별

최종 실패 관련 재검증에서 확인된 같은 adapter 소비자 시험의 잘못된 경로 전제만 `apps/cli/python-test/garmin-import-verify.test.ts`에서 최소 교정한다. 명령 전/후 새 garmin.import_verify 작업의 유일성과 공개 값의 maskOutputText 투영을 확인하고, 결과에 별도 실제 id를 두어 파일만 읽는다. 공개 id를 역가림하거나 일반 가림을 완화하지 않는다. 알려진 card-like UUID와 모호한/없는 작업 경계 회귀를 작성한다. 이는 시험 교정이며 제품 source·19.5 runner/config·적용 migration은 불변이다. KEEP: 실제 CLI/감독자·파일/보존 검증·private 값 비노출·모든 기존 assertion과 timeout. 앞선 구현자의 6 Task 완료/자동 해제 증거를 확인했으므로 새 Terra medium 구현자를 같은 checkout에 한 명만 배정한다.

### 2026-11-08 — 후속 잔여 최소 교정

재도출1의 세 번째 stdin 선행 해제 설계는 교정 필요성을 직접 검출하지 못하므로 정상 세 번째 실제 entry 시작 직전에 미발송 unlock gate의 해제 continuation을 queueMicrotask로 예약한다. 비동기 spawn 뒤 await로 제어를 돌려 actual query가 진행하고, 원래 execFileSync로 회귀하면 같은 예약 continuation이 멈춰 실제 locator lock_timeout으로 유한 실패한다. 자식 stdin 교착에 의존하지 않는다. 실제 query의 호출/미발송·발송/완료와 PG lock 보유·부재를 계속 확인한다. 이 설명을 로컬 cause-analysis의 최종 설계로 정정하며 W9 원인은 미확정으로 유지한다. 나머지 후속 patch는 독립 리뷰 pass2 지적을 따른다. KEEP: 기존 실제 두 번째 blocker/바이트, 정상·오래된 token 경로, 전체 가림 출력·locator phase, 제품/runner/migration 불변과 모든 기존 단언/timeout.

### 2026-11-08 — 독립 리뷰에 따른 재도출 1

BH1/IA1과 IA2가 드러낸 설계 공백을 Execution 1~2의 아래 완료 조건으로 보완한다. intent-contract는 유지한다.

- 실제 core cleaned_at 커밋 뒤 unlock query의 **발송 전**을 시험 전용으로 제어한다. 제품 source는 바꾸지 않는다. 예를 들어 현재 fixture/application_name의 pg query 호출만 가로채 발송 전 Promise gate를 두고, 호출/발송/완료를 구별한다. 전역 가로채기를 쓰면 정확 범위·복원·다른 case 불변을 보장한다.
- 세 번째 자식은 실제 DB의 해당 locator 잠금 보유를 독립적으로 확인한 후 stdin handshake 등으로 잠금 시도 직전 잠시 멈출 수 있다. Node가 실제 unlock을 발송·완료한 뒤 이 자식을 풀어 원래 import/lock을 통과시킨다. 1500ms 잠금 대기 중 Node poll이 제때 관측되리라는 전제를 제거한다. 기존 동기 child로 돌아가면 handshake가 완료되지 않아 회귀가 실패해야 한다. 잠금 보유/해제와 실제 쿼리 순서·세션을 직접 단언하고 관측 한계를 명시한다.
- 원래 child status/signal/code/stdout/stderr/output의 줄·공백·복수 출력은 원문 구조를 유지해 **가림 후** 보존한다. 전체 해시만으로 대체하지 않는다. 기존 maskOutputText 재사용과 fixture URL/암호/settings snapshot/내용/개인 home 경로의 정확 가림을 결합하고 비정형·JSON·traceback 합성 비밀로 검증한다. stdout을 ABI 파싱용으로 가공하더라도 보존 필드는 원래 전체 가림 출력을 유지한다. 실제 비밀/원시 URL/snapshot은 로컬 보고에도 쓰지 않는다.
- 조기 barrier 실패·무출력 close·spawn error와 gate 연결/해제 실패에도 즉시 정착하는 child 결과와 모든 소유 자원 정리·최초 오류를 보존한다. 이 경계에 의미 있는 시험 코드를 작성한다.
- 실제 오래된 attempt 음성 실행과 request/mapping/staging 불변, locator 획득/해제 실패 phase, verify 단계 표시를 검증한다. 획득/본문/해제 중 겹친 예외는 실제 최종 예외 경계와 원인을 정확히 구별한다.
- KEEP: 실제 import/locator/core cleanup·바이트·멱등성·timeout·작업 fence 유지, 정상 세 번째 비동기 실행, 두 번째 importer와 core의 실제 차단/원래 staging 확인, 제품 source·19.5 runner·migration 불변, W9 원인 미확정 서술.
- 개발/리뷰 수정 중 **시험 실행 금지, 컴파일 확인만**. python-test 대상까지 포함한 임시 TS 설정으로 컴파일한다. 최종 독립 후속 뒤 TS→Python 순차 각1회 규칙은 유지한다.

## Review Triage Log

### 2026-11-08 — work-ID 최종 실질 수정 독립 확인

- work-id-final-review가 신규 작업 유일성, 공개 값의 기존 mask 투영, 응답 보존, 실제 id의 보고서 파일 조회 전용, 기존 CLI/감독자/checks/privacy/timeout과 결정적 card-like UUID·음성 경계 회귀를 각각 최종 코드로 확인했다. Luhn 합40인 합성 UUID가 실제 가림 대상임도 정적으로 대조했다. 추가 findings0.
- 마지막 한정 import-verify 파일은 exit0/4pass/33.92s로 실행됐다. adapter ABI 교정 뒤 통과한 artifacts12·batch5는 같은 파일 지문을 유지했고, 마지막 수정은 import-verify 시험에만 한정됐다. 최초·관련 실패 원문은 삭제하거나 통과로 고쳐 쓰지 않았다.

### 2026-11-08 — 관련 재검증 뒤 발견한 보고서 경로 전제

- TS 실패 세 파일과 선택 규칙: 4files/121tests pass, exit0, 49.05s. Drive 최초 timeout의 root cause는 미확정이며 한정 재검증 성공만 기록한다.
- adapter 소비 관련 Python: 2files pass/1 fail, 19pass/1fail, 79.03s. 원래 ABI_LINE_INVALID 세 오류와 batch report 부재는 해결됐고, 새 잔여는 import-verify 변조 반복의 public.json 경로 ENOENT다. 실제 경로에 `[REDACTED:card_number]`가 들어있어 CLI 출력의 무작위 UUID 가림값을 실제 파일 이름으로 사용한 시험 전제가 원인이다. 제품 card-number 가림은 유지한다.
- `[medium]` `[patch]` 보고서 파일 조회가 공개 가림 work_id를 원래 식별자로 오인 — `garmin-import-verify.test.ts:159`의 public response id 사용은 올바른 가림과 양립하지 않는다. 실제 명령 전/후 해당 kind의 새 작업을 유일하게 대조해 raw id와 공개 마스킹 id의 일치도 확인하고 raw id를 파일 조회에만 사용한다. 실제 명령·감독자·보고서 checks와 비밀 부재 단언은 유지한다. known card-like UUID를 결정적으로 포함한 회귀로 공백을 막는다. 제품 source/가림 규칙은 수정하지 않는다.

### 2026-11-08 — ABI 최종 실질 수정 독립 확인

- adapter-abi-final-review가 strict stdout·원래 code/retryable·안전 stderr 진단·공개 phase 가림·실제 decoder/run 소비 단언·실제 report-not-ready 보고서 경로를 각각 최종 코드·시험 및 제품 소비자로 해결 확인했다. 추가 결함0. 정상 locator 경합/fence/lifecycle/원문 관측 유지도 확인했다.
- 새 최상위 진단 필드 도입으로 생긴 실제 비호환은 adapter에서만 고쳤으며 제품 codec/schema/supervisor는 바꾸지 않았다. 최초 전체 실패를 통과로 바꾸지 않고 관련 재검증을 아래에 별도로 기록한다.

### 2026-11-08 — 최초 전체 실패와 ABI 독립 확인

- `[medium]` `[patch]` adapter 진단 필드가 strict 오류 ABI에 비호환 — codec error 최상위는 abi/type/code/retryable/message만 허용한다. 실제 supervisor가 ABI_LINE_INVALID로 바꿔 원래 오류·retryable·report-not-ready 보고서 경로를 잃는다. 독립 adapter-abi-followup이 실제 소비 경로로 확정했다. 제품 codec/schema는 유지하고 adapter stdout을 원복, 고정 안전 진단은 stderr로 분리하며 실제 decoder 계약 회귀를 추가한다.
- 최초 전체 TS: exit1, 221 files pass/3 fail, 4852 pass/6 fail/1 skip, 595.44s. 저장소 내부 TMPDIR가 runtime/sessions-ingest의 저장소 밖 전제5건을 깨뜨렸음을 git 부모 조회와 실제 실패 결과로 확인했다. 저장소 밖 자기 TMPDIR로 실패 파일만 재검증한다. Drive timeout1건은 독립 정적 추적에서 원인 미확정이며 별도 한정 재검증한다.
- 최초 전체 Python: exit1, 14 files pass/2 fail, 71 pass/4 fail, 814.01s. artifacts 전체는 실패 없이 실행됐다. batch-import1·import-verify3은 오류 ABI 비호환으로 data.report 부재가 드러난 경로와 일치한다. 실제 실패 위치를 로그에 보존했다. ABI 교정 뒤 adapter 소비 세 파일만 재검증한다.
- 두 전체 명령은 source-manifest 지문이 같은 상태에서 TS→Python 순차 각1회 실행했다. 최초 원문은 가림 로그와 execution.json에 보존하며 통과로 바꾸지 않는다. 전체를 반복하지 않는다.

### 2026-11-08 — Review pass 4 (잔여 개별 최종 확인)

- EC3-1 중첩 errors/cause 보존과 BH3-1/EC3-2 timeout 뒤 재생성 차단을 edge-case-hunter가 실제 최종 코드·시험으로 개별 해결 확인했다.
- VG3-1 실제 timeout hook 검증과 신규 세 경로 선택 규칙·중첩 오류 검증을 verification-gap이 실제 격리 fixture와 외부 단언으로 해결 확인했다.
- 추가 발견사항0, 미해결 지정 지적0. 구현자 처방 준수 자기보고나 high0 수렴으로 대체하지 않고 각 보고서의 실제 호출·단언 근거를 대조했다. 실행 성공은 이 정적 확인과 구별하며 아래 최종 회귀가 맡는다.

### 2026-11-08 — Review pass 3 (마지막 수정 개별 확인)

- BH2-1/3/4/5/6, EC2-2/3, VG2-1은 실제 최종 코드·시험으로 독립 정적 해결 확인. 잠금 미발송 microtask 순서는 원래 동기 호출에서 기존 PG lock_timeout 유한 실패를 강제하며 stdin 교착을 사용하지 않는다. 가림·정확 ABI·verify 각 단계·활동 자식 결과 보존도 확인했다.
- verdicts: 4 residual findings — high0/medium4/low0/false0/maybe-false0
- findings:
  - `[medium]` `[patch]` BH3-1 timeout 뒤 본문 재개 — 현재 hook은 정리만 하므로 pending claim/조회 뒤 spawn이 가능하다. 정리 시작을 fence하고 비동기 경계 뒤 자원 생성/query override를 거부하며 진행 중 본문을 정착시킨 뒤 마지막 정리를 완료한다.
  - `[medium]` `[patch]` EC3-1 중첩 AggregateError 소실 — 실제 ext-fixture.cleanup의 errors에 role/DB/home 실패 원인이 들어있다. name/message만으로 축약하면 누락된다. errors/cause를 재귀적으로 가리고 cycle을 안전히 처리해 보존한다.
  - `[medium]` `[patch]` EC3-2 timeout 뒤 재생성 — BH3-1과 동일 근본 원인. 취소 fence와 늦게 풀린 await 뒤 spawn/query 변경 0을 검증한다.
  - `[medium]` `[patch]` VG3-1 실제 timeout hook 검증 공백 — onceCleanup 직접 두 번 호출은 Vitest hook을 실행하지 않는다. 격리된 자식 Vitest의 의도된 timeout과 실제 같은 수명 관리/정리 helper를 연결하고 외부에서 예상 실패 및 child 종료·override 복원·정리 표식을 검증한다. 정상 전체 suite의 실패로 남기지 않는다.

새 시험 전용 helper/자식 fixture 경로를 만들면 test-changed 선택 규칙에 정확한 경로 규칙을 추가한다. 이는 명세가 허용한 신규 자식 경로 등록이며 19.5 runner/config는 바꾸지 않는다. 개발 중 실행 금지는 유지한다.

### 2026-11-08 — Review pass 2 (실질 수정 독립 후속)

- 기존 16행 개별 확인: BH2/BH3/BH5/BH6/BH7·EC2/EC3/EC4·VG1/VG2·IA1/IA2는 최종 코드·시험으로 정적 해결 확인. BH1의 1500ms poll 전제와 EC1/BH4의 정리 연속 실행은 해결했으나 아래 잔여를 별도 처분한다. IA3은 locator 경계 분류 시험으로 해결하며 실제 PG 오류를 관측했다고 주장하지 않는다.
- 신규/잔여 verdicts: 10 findings — high 0, medium 10, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` BH2-1 동기 회귀 검출 근거 — 현재 unlock을 완료한 뒤 stdin을 푸므로 일반 동기 import 재도입은 실패하지 않는다. 실제 gate 해제 continuation을 queueMicrotask로 예약한 뒤 직접 비동기 세 번째 원래 entry를 시작하고 await한다. 동기 호출이면 예약 해제 자체가 Python lock_timeout 뒤로 밀리므로 유한 실패한다. 같은 Node 타이머 표본으로 진행을 주장하지 않으며 실제 query 발송/응답·PG 잠금으로 확인한다.
  - `[medium]` `[patch]` BH2-2 timeout 시 정리 누락 — Vitest timeout은 pending 함수에 예외를 주입하지 않는다. onTestFinished에 같은 단일 실행 정리 Promise를 연결해 timeout에도 gate/child/query/fixture 정리를 시도한다.
  - `[medium]` `[patch]` BH2-3 stdin EPIPE — ChildProcess error와 stdin error는 다른 emitter다. listener와 write callback을 연결하고 안전한 code·결과를 수집한다.
  - `[medium]` `[patch]` BH2-4 report 문자열 가림이 reports phase 손상 — manifest의 report가 부분치환돼 실제 공개 phase가 바뀐다. 고정 공개 ABI 진단 필드는 엄격한 값 allowlist로 보호하고 비정형 원문/비밀은 계속 가린다. 실제 fixture report 문자열로 reports/verify_reports 검증.
  - `[medium]` `[patch]` BH2-5 추가 cleanup 오류 폐기 — 첫 오류를 primary로 유지하면서 추가 오류의 가림된 목록도 함께 보존한다.
  - `[medium]` `[patch]` BH2-6 정상 ABI 단언 완화 — result 문자열 포함만으로 malformed/mixed JSON도 허용한다. 가림 원문은 유지하며 barrier를 뺀 파싱 사본의 정확 ABI result를 검사한다.
  - `[medium]` `[patch]` EC2-1 복수 cleanup 오류 누락 — BH2-5와 동일 근본 원인. 모든 오류를 보존한다.
  - `[medium]` `[patch]` EC2-2 marker 뒤 stdin 오류 — BH2-3과 동일 근본 원인. stream 오류와 자식 결과를 보존한다.
  - `[medium]` `[patch]` EC2-3 primary 실패 시 활동 자식 결과 폐기 — 정리에서 수집한 가림 child status/signal/code/streams/output을 오류에 함께 포함한다.
  - `[medium]` `[patch]` VG2-1 verify 연결 이후 phase 공백 — 실제 claim/연결 뒤 DB·외부 전파 compare·reports 경계 오류를 매개변수화해 검증한다. compare 내부에서 차이로 변환하는 오류와 구별한다.

IA2는 최종 출력 문맥 보존으로 해결됐으나 새 phase 마스킹 결함은 BH2-4로 별도 수정한다. IA3의 실제 PG 오류 관측은 합성 주입 시험의 주장 범위 밖이며 미해결 수락조건으로 숨기지 않는다. 새 회귀의 정상 실제 PG 경로와 잠금 상태를 최종 실행으로 검증한다. blind-hunter 산식 N=8 대비 근거6건만 보고한 것은 결함을 만들어내지 않은 것으로 수용한다.

### 2026-11-08 — Review pass 1

- verdicts: 16 findings — high 0, medium 16, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` BH1 세 번째 실제 대기 관측·gate 해제가 1500ms 내 Node 응답에 의존 — lock_timeout 유지 상태에서 충분히 가능한 지연이다. 시간 예산에 기대지 않는 handshake로 재설계한다.
  - `[medium]` `[patch]` BH2 barrier 이전 종료 진단 누락 — 단일 data 이벤트는 무출력 close를 관측하지 못한다. 누적 barrier와 close/error를 함께 수집한다.
  - `[medium]` `[patch]` BH3 spawn Promise 미처리 거부 — once(close)는 error에 reject하고 늦게 await한다. 즉시 결과 객체로 정착시킨다.
  - `[medium]` `[patch]` BH4 gate 정리 실패가 뒤 정리 생략 — 순차 finally의 첫 await 실패가 나머지를 건너뛴다. 모든 정리 시도와 최초 오류를 보존한다.
  - `[medium]` `[patch]` BH5 실제 오래된 작업 쓰기 거부 검증 부재 — 주입 check 오류는 실제 fence를 검증하지 않는다. 완료 token 음성 사례와 mapping/request/staging 불변을 추가한다.
  - `[medium]` `[patch]` BH6 unlock 실패 phase 오표기 — observed_stage가 stage를 남기고 original_lock exit 실패 시 갱신하지 못한다. 실제 획득/본문/해제 경계와 중첩 오류를 구별한다.
  - `[medium]` `[patch]` BH7 verify phase가 settings로 고정 — 공통 error ABI가 실제 import_verify 소비자에 오정보를 준다. 실제 verify 경계를 갱신한다.
  - `[medium]` `[patch]` EC1 gate 정리 실패 — BH4와 같은 원인. connect 실패 포함 모든 정리를 보장한다.
  - `[medium]` `[patch]` EC2 spawn 오류 Promise — BH3와 같은 원인. 즉시 오류 code를 가림된 결과에 수집한다.
  - `[medium]` `[patch]` EC3 unlock 오류 phase — BH6와 같은 원인. 실제 unlock 실패와 본문 실패를 구별한다.
  - `[medium]` `[patch]` EC4 barrier 이전 진단 — BH2와 같은 원인. 조기 종료를 가림된 전체 결과로 남긴다.
  - `[medium]` `[patch]` VG1 locator 획득 오류 phase 검사 공백 — 초기 check 주입은 locator 경계를 검사하지 않는다. 해당 경계 오류의 phase/SQLSTATE/exit를 결정적으로 검증한다.
  - `[medium]` `[patch]` VG2 불투명 출력 가림 검사 공백 — 현재 주입 오류는 어댑터가 이미 가린 ABI만 지나간다. 비정형 stdout/stderr 및 허용 밖 JSON의 가림과 진단 문맥 보존을 검증한다.
  - `[medium]` `[bad_plan]` IA1 원인 간극과 관측 표면 차이 — DB shadow는 이미 발송된 unlock을 막는다. BH1과 함께 실제 미발송 간극과 원래 잘못된 동기 전제의 실패를 검출하는 handshake를 설계한다.
  - `[medium]` `[bad_plan]` IA2 원래 출력의 해시 축약 — 지문은 원문 진단 문맥 보존을 충족하지 않는다. 원래 줄/공백/복수 출력과 OS 결과를 가림 후 보존하도록 관측 설계를 바꾼다.
  - `[medium]` `[patch]` IA3 초기 check 오류와 locator 오류 차이 — VG1과 같은 공백. 초기 check를 실제 연결 실패로 주장하지 않고 locator 경계 오류를 별도 검증한다.

재도출 전 시도 diff는 로컬 `.brain-automation/tickets/19.12/pre-rederive-1.patch`에 보존했다. 수정 소유 두 파일만 HEAD로 복원했으며 등록 커밋은 보존했다. 필수 조건을 deferred로 바꾸지 않았다.

## Design Notes

Implementation Notes의 재도출1 stdin/미완료 문구는 당시 중간 기록이다. 최종 설계·독립 확인·실행 완료는 최근 기록과 Auto Run Result가 원천이며, 최종 세 번째 반입은 stdin wrapper 없이 원래 entry를 직접 비동기로 실행한다.

cleaned_at은 잠금 해제 완료 신호가 아니다. 동기 자식 중 Node 이벤트 루프가 멈추므로 비동기 cleanup 진행을 같은 루프의 타이머 표본만으로 주장하지 않는다. 결정적 회귀는 실제 PG 잠금과 통제한 해제 순서를 관측해야 한다. 동기 진단 로그는 타이밍에 영향을 줄 수 있음을 보고한다.

## Verification

- 개발/리뷰 수정: `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 시험·진단·eval·부하계측 금지.
- 마지막 구현·독립 후속 뒤: `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 순차 각1회. 자기 격리 자원에서 실행하고 최초 실패 원문·source·환경·exit·처분 보존. 실패 수정 뒤 관련 시험/test:changed만 실행한다.
- 실제 트리 status/find19.12, 기존 entry 불변·after 추가 없음, 최종 diff 범위와 개인 경로/비밀 가림을 확인한다.

## Auto Run Result

- 상태: built. 사용자 인수 done과 중앙 main 수락을 뜻하지 않는다. 원본 main은 `720df8ef2f20b9e1b39d93ecec376b79ab9aacb5`, 등록 커밋은 `5d938a795f1a904e671727108823364280d1d73b`다. 구현 source는 로컬 최종 source-manifest와 범위 커밋의 파일 지문으로 대조하며 최종 canonical SHA·원격 SHA는 지휘자 최종 보고서에 기록한다.
- 교정: cleaned_at을 잠금 해제 완료로 보던 시험 전제를 고쳤다. 실제 core locator 잠금을 보유한 채 unlock query 발송 전 gate를 두고 세 번째 원래 entry 직전 해제 microtask를 예약한다. 비동기 진행은 정상 완료하고 원래 동기 호출은 예약된 해제를 막아 기존 PG lock_timeout에서 실패하는 순서다. 실제 blocker·잠금 보유/해제·staging·바이트·작업 fence·멱등성 단언을 유지했다. 제품 core/PG/확장 source, schema42·적용 migration, 19.5 runner/config, 8.4 소유 파일은 변경하지 않았다.
- 파일: garmin-artifacts 시험은 결정적 경합·자식 결과/가림·실제 timeout 수명 회귀를, preservation_entry는 ABI 호환 안전 stderr 진단을, 시험 전용 lifecycle helper/timeout fixture/config는 취소 fence·정착·정리를, garmin-import-verify 시험은 공개/실제 작업 ID 구별을 담당한다. test-changed exact 규칙에 신규 자식 경로 세 개를 등록했다. 등록 문서는 허용한 handoff 외 기존 entry와 의존관계를 보존했다.
- 독립 검토: 최초 Sol medium 4렌즈와 필요한 개별 후속, ABI 소비 계약 및 마지막 work-ID 실질 수정을 각각 최종 코드·시험으로 독립 확인했다. 모든 확인된 결함을 수정했고 미해결 지정 finding은 없다. finding별 원래 판정과 처분은 위 Review Triage Log 및 로컬 review 보고서들에 보존한다. 마지막 후속의 high patch0, medium patch1이며 그 수정도 독립 확인·관련 실행을 마쳐 추가 후속 권고는 false다. 실제 소비자 계약을 놓친 최초 ABI 검토의 한계와 후속 정정도 보존했다.
- 개발/리뷰 중 시험은 실행하지 않았다. build·typecheck·Python AST·대상 python-test와 신규 fixture를 포함한 임시 TS 컴파일·diff check를 수행했다. 공용 pnpm typecheck가 python-test를 포함하지 않는 점을 별도로 확인했다.
- 최초 전체: `VITEST_MAX_WORKERS=2 pnpm test` exit1, 4852pass/6fail/1skip, 595.44s → `pnpm test:python` exit1, 71pass/4fail, 814.01s를 같은 source 지문에서 순차 각1회 실행했다. 내부 Python unittest244도 모두 통과했다. 최초 실패는 성공으로 쓰지 않는다.
- 실패 처분: TS5건은 저장소 안 TMPDIR의 부모 Git 발견으로 깨진 시험 환경이었고 밖의 자기 TMPDIR로 교정했다. Drive timeout1건은 원인 미확정으로 남기되 관련 파일 재검증은 통과했다. Python4건은 새 진단 필드의 strict ABI 비호환으로 원래 오류/report 반환을 잃은 결함이며 stdout 유지·stderr 분리로 고쳤다. 관련 검증에서 발견한 masked UUID 경로 ENOENT는 제품 가림을 유지한 시험 교정으로 해결했다.
- 관련 재검증만 수행: 실패 TS3파일+test-changed 규칙 4files/121tests exit0(49.05s), adapter 소비3파일은 19pass/1fail(79.03s) 뒤 그 잔여 import-verify 한 파일을 교정·독립 확인하고 4pass exit0(33.92s)였다. 최종 변경 파일 지문을 대조해 artifacts12·batch5의 기존 통과를 유지하고 verify4를 확인했다. 전체 회귀를 반복하거나 부하 성공을 기다리는 반복은 하지 않았다. 현재 필수 실패는 남지 않았다.
- 자원: 자기 PostgreSQL admin cluster/role과 전용 HOME·TMPDIR, fixture별 venv·PG, 합성 Clock/가짜 외부 서버를 사용했다. 실제 DOCKER_CONFIG/OrbStack context/Compose/socket을 확인했다. 격리 HOME의 orb 상태 조회가 불가해 한 인자 status만 실제 CLI에 해당 자식 HOME으로 위임하고 다른 인자는 exit2로 거부했으며 실제 반환값·원문 지문을 보존했다. 가짜 Running이나 전역 서비스 시작·상태 디렉터리 링크·비밀 복사는 없었다.
- 정확 자원 감사: fixture 컨테이너292개와 volume1개는 정확 ID/이름으로 부재를 확인했다. 자기 admin container도 정확 소유 label 확인 뒤 제거해 부재를 확인했다. 제거 전 DB0·확장 role0·다른 client연결0이었다. 자기 HOME/TMP 두 곳과 외부 TMP도 제거했다. 중간 remove-failed5건은 후속 제거/정확 부재와 대조했다. 최초 감사의 Docker 부재 메시지 대소문자 판독 exit1은 정리 전 종료였고 판독만 고쳐 재감사했다. 시험이 바꾼 추적 pyc 한 파일은 정확 HEAD bytes로 복원해 변경 범위에서 제외했다. 워크트리·브랜치·세션·로컬 원문 증거는 보존한다.
- 19.5 인계: 원래 artifacts10case에 자식/가림과 실제 timeout 외부 시험2case, import-verify3case에 masked-ID 회귀1case가 더해졌다. 대상 case에는 오류/오래된 token/verify/report/ABI 경계 반입과 DB 관측이 추가됐고 verify 명령 전후 ID 조회도 추가됐다. 실제 제품 동작·단언·timeout·slot 정책은 유지하지만 시험 workload/fixture 의미와 비용은 달라졌다. 중앙과 19.5는 수락한 정확 새 source로 같은 동결 선정 규칙과 각 구성 측정의 필요 범위를 최종 독립 대조해야 한다. 기존 표본은 역사로 보존하고 새 source 표본으로 재사용하지 않는다. 성능 gate 절반 이하와 4slot 포함은 유지하며 본 작업은 성능 성공을 판정하지 않는다.
- 한계: W9 원래 stdout/stderr/SQLSTATE가 없어 그 실패의 유일한 원인은 소급 확정하지 않는다. 새 회귀가 증명한 시험 전제 결함과 구별한다. 합성 locator 오류 주입은 실제 PG 오류 발생 관측과 다르다. 알려지지 않은 임의 비밀의 완전 탐지는 보장하지 않으며 가림된 UTF-8 문맥을 보존한다. 진단 출력과 handshake는 일정에 영향을 줄 수 있다. Drive 최초 timeout의 원인은 미확정 관찰 위험으로 남기고 단일 한정 통과를 원인 해결로 주장하지 않는다.
- operator_actions는 frontmatter에 보존했다. 중앙 수락·원격 main 변경과 성능 측정 대조는 본 지휘자의 완료 판정과 별개다. main 변경 금지를 유지하며 거절된 변경을 브랜치 등록으로 우회하지 않았다.
