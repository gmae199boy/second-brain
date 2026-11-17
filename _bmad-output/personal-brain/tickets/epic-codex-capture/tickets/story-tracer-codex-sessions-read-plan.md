---
title: 'Tracer: Codex 세션 파일 하나가 수집되어 sessions read로 읽힌다'
type: feature
ticket: '2'
created: '2026-11-17'
status: built
baseline_revision: '3995c2aa1a3f391339d68e2fd0f364514a67581c'
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [quick, edge-case-hunter, verification-gap]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-codex-capture/epic-codex-capture-research.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Codex 파일은 Brain 수집 경로에 등록되지 않아 대화가 읽히지 않으며 부모와 자식이 공유하는 `session_id`를 키로 쓰면 충돌한다.

**Approach:** 합성 파일의 `session_meta.payload.id`를 검증하여 Codex parser와 기존 세션 수집·읽기를 잇고, 호출과 결과를 중복 없이 대응한다.

## Boundaries & Constraints

**Always:** 실제 기록·설정·운영 DB 대신 합성 자료와 전용 PG를 쓴다. 기존 Store 계약과 Claude 저장 결과를 보존한다. 파일별 ID와 요청 토큰을 저장 전에 검증하고 원문은 저장하며 출력 마스킹을 유지한다. 시험은 마지막 구현·리뷰 수정 이후 관련 파일만 실행한다.

**Never:** 23.3의 두 루트 스캔·트리거·이동 복구, 23.4 태그 개선, 23.5 connect/doctor, 23.6 운영 설치를 구현하지 않는다. Store 계약 변경이 불가피하면 근거와 대안을 지휘자에게 질문하고 구현을 멈춘다. 실제 세션·식별자·개인 경로·토큰을 fixture나 보고서에 넣지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 식별 | 파일 첫 완결 `session_meta.payload.id`와 명시 토큰이 일치; 부모와 자식은 다른 id와 같은 `session_id` | 각 id가 별도 `codex:<id>` 세션 | `session_id`로 대체하지 않는다 |
| 신원 오류 | id 누락·빈 값·복수 메타 불일치 또는 토큰과 id 불일치 | 세션·메시지·이력 쓰기 전 거부 | `TRANSCRIPT_UNREADABLE` 등 기존 오류 계약 사용; 파일명은 권위가 아니다 |
| 대화 | `response_item.message`와 같은 발화의 `event_msg` | user/assistant 텍스트를 파일 순서대로 한 번 저장 | developer·이벤트·비대화는 명시적으로 계수해 제외 |
| 도구 | 일반/custom call과 output이 `call_id`로 연결, output은 다음 수집에서 도착 | 호출당 메모 하나; 결과에서 성공 여부를 반영; cursor 뒤로 밀린 호출도 빠짐없이 대응 | 미완료 호출은 결과 전 확정하지 않음; 고아 output은 메시지로 저장하지 않음 |
| 증분 | 마지막 줄 개행 전/후, 이전 cursor, 접두부 변경 또는 축소 | 미완성 줄 보류 후 완성 시 1회 반영; 유효 cursor 재개, 불일치 시 reset과 멱등 재읽기 | 완결된 깨진 줄은 unreadable 계수·경고, 미완성 줄은 cursor에 포함하지 않음 |

</intent-contract>

## Code Map

- `packages/core/src/ports/parser.ts`, `domain/ingest-batch.ts`, `domain/session.ts` — parser는 메시지·메모·cursor/version을 반환하고 호출 메모는 `(message, ordinal)`과 `callId`, `tool`, `target`, `ok`만 가진다. Store 계약 확장 금지.
- `packages/claude-code/src/parser.ts`, `test/parser.test.ts` — prefix fingerprint, cursor 재개·reset, call-id와 ordinal 및 원문/필터 테스트를 참조한다. Claude 동작은 수정하지 않는다.
- `packages/core/src/sessions/ingest.ts` — 토큰→parser→파일 읽기→parse→ensure→원자 ingest→best-effort history; 현재 parser는 토큰을 받지 않는다. 신원 검사는 읽은 내용과 토큰을 비교하고 어떤 쓰기보다 앞서야 한다.
- `packages/core/src/sessions/read.ts`, `packages/postgres/src/sessions.ts` — 메시지는 `occurredAt` 후 DB id 순, 같은 시각의 원본 순서는 보장되지 않는다. tool output 원문을 저장하는 필드는 없으며 `ok`와 호출 target만 노출한다.
- `apps/cli/src/harnesses.ts`, `commands/sessions-ingest.ts` — 기존 registry는 parser와 connector/hook/folder/watch를 묶는다. Codex parser를 명시 파일 수집 경로에 등록하되 가짜 connector나 운영 watch를 만들지 않는다.
- `packages/claude-code/package.json`, `packages/second_brain/package.json`, `packages/second_brain/src/index.ts`, `pnpm-workspace.yaml`, `tooling/test-changed/vitest.config.aliases.mjs` — workspace 패키지·barrel·의존성·테스트 해석 패턴을 재사용한다.
- `packages/core/test/sessions-ingest.test.ts`, `apps/cli/test/sessions-ingest.test.ts`, `packages/postgres/test/store.test.ts`, `packages/claude-code/test/parser.test.ts` — 수집, CLI와 PG, 기존 Claude 회귀의 직접 관련 검증 위치다.

## Tasks & Acceptance

**Execution:**
- [x] Execution 1 `packages/codex/` 및 workspace export/의존성 — 합성 JSONL parser, 완결 줄 판별, 안정적 메시지 ID·prefix cursor, call/output 대응을 구현하고 parser 시험을 쓴다. 출력이 나중에 도착하거나 다른 메시지가 끼어도 재읽어 정확히 한 메모로 확정한다.
- [x] Execution 2 `packages/core/src/sessions/ingest.ts`, `apps/cli/src/harnesses.ts` 및 필요한 CLI 조립 — 명시 파일의 메타 id와 세션 토큰을 모든 쓰기 전에 검증하고 Codex parser만 등록한다. 기존 범용 계약을 바꿔야만 한다면 중단·질문한다. 해당 경계 시험을 쓴다.
- [x] Execution 3 `apps/cli/test/`의 합성 PG tracer와 기존 관련 시험 — 실제 수집 경로로 부모·자식 각각 두 번 수집하고 `sessions read`를 호출해 저장 건수·원문·순서·메모와 추적 정보를 확인한다. Claude 결과도 기존 시험과 합성 비교로 보존한다. `plugin/skills/brain-sessions/SKILL.md`에 새 공개 ingest 변형의 id/path 입력과 제한을 반영하고 `tooling/bootstrap/test/cli-skill-coverage.test.ts`의 기존 패턴으로 커버리지를 확인·필요 시 갱신한다.

**Acceptance Criteria:**
- Given 합성 부모·자식 파일이 같은 `session_id`와 서로 다른 메타 id를 가질 때, when 각 파일을 실제 수집 경로로 두 번 처리하면, then 별도 세션과 동일한 전체 저장 건수가 유지된다.
- Given 시간순 합성 발화와 일반/custom 도구 쌍이 있는 파일, when `sessions read`를 호출하면, then 중복 없는 메시지 원문과 대응 메모가 순서대로 나온다. 출력 내용은 기존 Store의 `ok` 판단에 사용되며 output 원문 보존을 주장하지 않는다.
- Given 기존 Claude fixture, when 동일 경로로 수집하면, then 이전 본문·건수·꼬리표 결과가 유지된다.

## Implementation Notes

- Decision(2026-11-17, Execution 2 질문): Parser에 선택적 `validateSessionId(content, harnessSessionId)` 검증 기능을 추가하는 최소안을 승인한다. Store/domain/schema 계약은 변경하지 않는다. Core에 Codex JSON 형식을 넣는 대안은 harness 중립 경계를 깨므로 채택하지 않는다. 검증 기능이 없는 Claude의 읽기·spool 순서는 보존하고 기능이 있는 parser만 읽은 동일 content를 검증한 뒤 재사용한다. CLI의 guard/spool 우회 경로도 같은 검증을 거쳐 잘못된 토큰의 spool 기록을 막는다. 오류는 기존 TRANSCRIPT_UNREADABLE 계약을 사용하며 미구현 hook/스캔을 추가하지 않는다. 기존 계획의 범용 계약 변경 질문 절차에 대한 독립 지휘자의 결정이며 Store 변경 승인이 아니다.

- 지휘자 ready gate: 실제 parser/domain/Store 코드를 대조했다. 부모 링크 필드가 없고 continuedFromSessionId는 예약 필드이므로 사용하지 않는다. 티켓의 부모·자식 별도 보존과 기존 호출/출력 메모 대응은 Store 변경 없이 검증 가능하다. 출력 원문·부모 링크 저장을 새로 약속하지 않는다. full/pinned 경로는 parser·CLI·PG를 잇는 변경이라 유지한다. 모든 AC는 CLI 읽기·수집 외부 표면과 연결되어 있다.

## Plan Change Log

## Review Triage Log

### 2026-11-17 — Follow-up review pass 2
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- Q1·E1·V1은 모두 resolved. `review-followup.md`의 독립 코드·시험 대조를 지휘자가 확인했다. 원 지적 3 medium은 모두 patch 완료, defer/reject 없음. 새 patch가 없으므로 추가 후속 리뷰 권고 false. 이제 개발 종료 후 관련 파일 시험을 수행한다.

### 2026-11-17 — Review pass 1
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` Q1 최초/reset 집계가 첫 메시지 앞의 완결 손상 줄을 누락 — readFrom이 항상 첫 메시지 lineIndex여서 unreadable 경고가 누락된다. 유효 cursor 재개에만 해당 경계를 쓰고 최초/reset은 0부터 집계하도록 직접 수정한다.
  - `[medium]` `[patch]` E1 출력 내 예시 Exit code 문구가 성공으로 오인 — outcome의 비고정 regex가 임의 문자열의 부분 일치만으로 true를 반환한다. 인식된 명시 상태 또는 실행 결과 envelope만 성공 근거로 사용하는 직접 판정 수정을 요구한다.
  - `[medium]` `[patch]` V1 완전히 동일한 메시지 줄의 ID 구별 시험 누락 — 검증 렌즈가 전 소비 경로와 시험을 확인한 근거를 수용한다. 내용 해시만 쓰는 회귀를 막는 반복·재파싱·append ID 시험을 추가한다.
- 리뷰 전문: `.brain-automation/tickets/23.2/review-quick.md`, `review-edge.md`, `review-verification.md`. 세 항목을 같은 parser 계약 수정 Task에 전달하며 개발 중 시험은 실행하지 않는다. 두 개 이상 medium patch이므로 수정 뒤 독립 후속 리뷰로 성공 판정과 계수 경계를 확인한다.

## Design Notes

Store에는 부모 링크가 없고 예약된 `continuedFromSessionId`는 사용하지 않는다. 이 티켓은 부모·자식의 독립 보존을 검증하며 관계 자체를 저장한다고 주장하지 않는다. 메타 id 누락·불일치는 오수집보다 거부를 택한다. 호출의 output은 기존 메모의 성공 여부에만 반영되며 원문 저장은 지원되지 않는다. 읽기 순서는 기존 Store의 occurredAt 오름차순을 보존하며 같은 timestamp의 순서는 미정이다. parser는 동일 시각·역전 시각에도 파일 배열 순서를 그대로 반환하는 시험을 작성하고, CLI tracer는 구별되는 시각으로 기존 읽기 계약을 검증한다. timestamp 조작이나 가짜 메시지로 Store 한계를 우회하지 않는다. 메시지에 자연 ID가 없으면 완결 줄의 안정 위치와 내용을 기반으로 결정적 ID를 만들고 prefix 변경 시 reset을 시험한다.

## Verification

최종 실행 증거는 `.brain-automation/tickets/23.2/terra-verify-report.md`와 `terra-verify-vitest.log`, `terra-verify-tracer-retry.log`에 있다. 최초 7파일 실행은 318/319 통과·종료1이며 새 tracer 오류 출력 단언만 실패했다. 기존 hook 실패 계약(stdout 비움·stderr 한 줄·종료0)에 맞춰 시험만 수정했고 tracer 2건 재검증은 종료0이다. 지휘자가 제품 dispatch와 시험 수정 diff·SHA를 확인했으며 오류 코드·DB 무변경 검증을 보존한 단순 시험 수정이라 추가 독립 리뷰는 불필요하다. 최종 7파일 총319건 각각 통과: Codex parser11, Core ingest94, registration9, PG tracer2, Claude parser121, skill coverage10, 기존 CLI ingest72. 초기 실행 실패를 통과로 소급하지 않는다.

실제 최초 명령은 전용 소유 PG URL을 BRAIN_TEST_DATABASE_URL에 제공하여 `pnpm exec vitest run packages/codex/test/parser.test.ts packages/core/test/sessions-ingest.test.ts apps/cli/test/codex-registration.test.ts apps/cli/test/codex-tracer.test.ts packages/claude-code/test/parser.test.ts tooling/bootstrap/test/cli-skill-coverage.test.ts apps/cli/test/sessions-ingest.test.ts --reporter=verbose --maxWorkers=1`이었다. 재검증은 자리표시자 URL로 공유 Compose 시작을 막고 `pnpm exec vitest run apps/cli/test/codex-tracer.test.ts --reporter=verbose --maxWorkers=1`을 수행했다. tracer는 자체 전용 PG를 생성했다. 전용 자원 소유·라벨·tmpfs·임시 포트·정확 정리 및 test-lock 획득/해제 증거를 보고서에 남겼다. 자체 run별 남은 컨테이너0, 운영54320/공유54329 미사용이다.


**Commands:**
- `pnpm build` 및 `pnpm typecheck` — 구현 중 컴파일 확인.
- `git diff --check` — 공백 오류 없음.
- 최종 수정 후 `pnpm exec vitest run packages/codex/test/parser.test.ts packages/core/test/sessions-ingest.test.ts apps/cli/test/sessions-ingest.test.ts packages/claude-code/test/parser.test.ts` — 직접 관련 시험 통과; 새 tracer가 별도 파일이면 그 경로도 명시한다.
- PG tracer가 `packages/postgres/test/store.test.ts`를 변경하거나 직접 검증한다면 해당 파일도 명시해 실행한다. 전용 PG 및 합성 환경만 사용하고 종료 코드와 소유 자원 정리를 기록한다. 전체 회귀는 중앙 통합 단계에서 수행한다.

## Auto Run Result

- 결과: built. 합성 Codex 명시 파일 → CLI/Core → parser → 전용 PostgreSQL → sessions read 경로를 검증했다. 파일별 payload.id가 권위이며 공유 session_id의 부모·자식은 별도 세션이다. 두 번 수집해 모든 brain 테이블 건수가 같고 원문·메모·추적·지연 출력·부분 줄·커서 경계와 기존 Claude 보존을 확인했다.
- 변경: `packages/codex/` parser·workspace·시험; `packages/core/src/ports/parser.ts` 선택적 신원 검증과 `sessions/ingest.ts` 저장 전 검증·해당 시험; `apps/cli/src/` parser 등록·명시 입력·spool 검증; CLI registration/PG tracer 시험; second_brain export·의존성·lock; 배포 brain-sessions 스킬·커버리지·내부 예외 갱신; 이 계획.
- 독립 리뷰: Sol/medium Quick·edge-case·verification-gap에서 medium3을 확인해 모두 patch했다. 후속 Quick/경계/검증 확인에서 기존3 resolved·신규0. defer0/reject0, 추가 후속 리뷰 권고 false. 보고서는 `.brain-automation/tickets/23.2/review-{quick,edge,verification,followup}.md`에 있다.
- 검증: 최종 수정 뒤 build/typecheck 성공. 시험 수정 뒤 typecheck·diff --check 성공. 관련7파일 총319건은 위 최초/재검증에서 모두 통과했다. I/O 모든 행과 외부 AC의 실제 통과 시험 매핑은 검증 보고서에 있다. 전체 pnpm test → test:python은 실행하지 않았으며 중앙 통합 단계의 필수 회귀로 남는다.
- 결정·한계: Store/domain/schema를 바꾸지 않았다. 부모 관계 필드와 도구 output 원문 저장은 제공하지 않으며 호출/결과는 기존 도구 메모 계약에 대응한다. 읽기는 기존 occurredAt 순서이고 동일 시각 순서는 미정이다. 알 수 없는 output은 성공으로 추정하지 않는다. 실제 모든 Codex 버전 형식의 호환성을 주장하지 않는다. 후속23.3~23.6 스캔·태그·connect/doctor·운영 설치는 구현하지 않았으며 수락조건 미충족의 defer는 없다.
- 전달: 티켓 브랜치에만 커밋·일반 push하고 원격 SHA를 확인한다. main 병합/push는 하지 않는다. 시작 depth1 ready 영수증 `start-receipt.json`, worker checkpoint `.brain-automation/worker.json`, 최종 보고 `.brain-automation/tickets/23.2/ticket-result.md`를 중앙이 복사할 수 있도록 보존한다.
