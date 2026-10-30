---
title: '17.2 대화 조각과 redact 재생성'
type: 'feature'
ticket: '2'
created: '2026-10-30'
status: in-progress
baseline_revision: '520ed113226821afc48b7e7f5fb6f6308e24724f'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: "검토 필요: [ASSUMPTION] 일반 메시지는 줄바꿈 하나로 결합하며 목표 이상이 되는 시각 묶음까지 포함한 뒤 닫는다."
---

<intent-contract>

## Intent

**Problem:** 대화 조각 writer와 검색 port가 없어 대화 검색의 기반이 없고, 같은 시각·긴 메시지의 조각 키가 충돌하며 redact 뒤 재생성되지 않는다.

**Approach:** 설정을 소비하는 Core 순수 chunker와 drain 일감, 입력 fingerprint로 보호한 PG 확정, 원자적인 수집·redact enqueue, 공통 literal LIKE 질의와 최소 대화 검색 port를 만든다.

## Boundaries & Constraints

**Always:** 원문은 불변이며 redact만 예외다. 설정 행이 조각 규칙의 진실이다. 목표 1,200 코드 포인트, 메시지 경계, 겹침 1메시지, 2,400자 초과 메시지 분할, 머리말 없음이다. 같은 시각 묶음은 일반 경계에서 나누지 않는다. 같은 시각 범위의 단일 조각은 part 0, 분할 조각은 메시지마다 초기화하지 않고 1..n이다. 원문 U+0000은 기존 PG 쓰기 코덱으로 text/bytea에 보존한다. ingest·redact·chunk 확정은 세션 잠금과 fingerprint로 경합을 막는다. redact enqueue 실패는 전체 롤백하고 spool하지 않는다. 같은 원문 재청구는 같은 경계이며 새 메시지는 필요한 뒤쪽만 갱신한다.

**Never:** 공개 recall 명령·결과 budget·도구 메모 검색·문서 검색·전체 index rebuild·임베딩·미러를 구현하지 않는다. 기존 expression GIN·baseline migration을 다시 만들거나 수정하지 않는다. 티켓 파일·완료 상태·다른 작업의 변경을 건드리지 않는다. 구현자는 커밋하지 않는다. 공개 기록은 합성 자료만 사용한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 경계·설정 | 손으로 경계를 정한 합성 메시지와 다른 chunk_params | 설정별 목표·겹침과 같은 본문/시각, 머리말 없음 | 잘못된 설정은 확정하지 않음 |
| 동일 시각·긴 본문 | 같은 시각 메시지 셋 및 5,000자 한 메시지 | 일반 묶음 보존, 긴 본문 part 1..3, UNIQUE 충돌 없음 | 시각 조작 금지 |
| 반복·증분 | 동일 세션 재처리 및 새 메시지 추가 | 중복 없음, 이전의 불변 prefix 유지와 뒤쪽 갱신 | 재청구 가능 |
| 새 메시지 경합 | snapshot 읽기 barrier 뒤 ingest | 낡은 snapshot 확정 거부, 재시도로 최신 조각 생성 | 일감 유실 없음 |
| redact 경합 | snapshot 읽기 barrier 뒤 redact | 낡은 본문 확정 거부, 재생성 뒤 삭제 문자열 없음 | 재생성 유지 |
| redact 실패 | 재생성 enqueue를 강제로 실패시킴 | 본문·조각·redactions·큐 전부 롤백 | spool 없음 |
| NUL | U+0000 포함 합성 메시지 | 검색용 U+FFFD와 bytea 원문 보존, port 읽기에서 원문 복원 | 입력 거부 금지 |
| 최소 검색 | 한국어 두 글자, %, _, 역슬래시, 혼합 대소문자 | Core escape + lower(col) LIKE lower(pattern) 결과가 독립 전수 LIKE와 동일 | DB 실패는 0건과 구분 |

</intent-contract>

## Code Map

- `packages/core/src/domain/chunk.ts`, `domain/index-config.ts`: 기존 Chunk/ChunkParams와 시드 설정 식별자. part 및 규칙 버전 계약을 확장한다.
- `packages/core/src/ports/store.ts`, 신규 `ports/conversation-index-store.ts`: 기존 Store capability 구성에 조각 snapshot/확정 및 최소 검색 capability를 연결한다.
- 신규 `packages/core/src/recall/conversation-chunker.ts`, `conversation-work.ts`, `text-query.ts`: 순수 경계·fingerprint·literal pattern 및 drain handler. 안정적인 동일 시각 순서는 영속 메시지 식별자를 쓴다.
- `packages/core/src/brain.ts`: coreHandlers에 대화 조각 handler를 연결한다. `queue/drain.ts`의 기존 청구/완료/재시도 정책을 재사용한다.
- `packages/core/src/testing/fakes/store.ts`, `src/index.ts`, `src/testing/index.ts`: fake 및 공개 타입/계약을 동기화한다.
- `packages/postgres/src/sessions.ts`: ingest와 redact가 `withWrite(..., harness + ':' + harnessSessionId)` 잠금을 공유한다. 트랜잭션 안에서 세션/설정 열린 일감을 멱등 등록한다.
- `packages/postgres/src/work.ts`의 `ensureWork`: 열린 일감 UNIQUE와 완료 경합 재시도를 재사용한다.
- 신규 `packages/postgres/src/conversation-index.ts`, `store.ts`: snapshot 일관성, 동일 세션 잠금 아래 fingerprint 비교 후 조각 확정, 검색 adapter를 조립한다. 큐 완료 직전 ingest/redact가 일감을 놓치지 않는지도 보장한다.
- 신규 `packages/postgres/migrations/0014_conversation_chunks.sql`, `src/migrate.ts`: 현재 HEAD core 최신은 0013이다. 새 migration으로 part 키·body_raw·규칙 버전과 필요한 파생 상태를 추가한다. 기존 migration checksum은 보존한다.
- `packages/postgres/src/text.ts`: `pgText`/`originalText`를 조각에도 적용한다.
- `packages/postgres/test/fixture.ts`, `tooling/test-db/src/index.ts`, `compose.test.yaml`: 실제 격리 DB 생성/삭제 및 자동 PG 기동. 기존 역할/권한/잠금 제한을 유지한다.
- `packages/postgres/test/redaction.test.ts`, `session-concurrency.test.ts`, `migrate.test.ts`: 기존 롤백·세션 잠금·migration 검증을 보존하고 필요한 기대 버전만 갱신한다.

## Tasks & Acceptance

**Execution:**

- [x] Core domain/port/recall 파일에 순수 chunker·규칙·검색 질의·drain 계약을 구현한다.
- [x] PG migration/adapter와 sessions ingest/redact를 원자적으로 연결하고 fake·exports·brain 조립을 맞춘다.
- [x] `packages/core/test/conversation-chunker.test.ts`에 손으로 고정한 경계·같은 시각·긴 메시지·설정·코드 포인트 시험을 추가한다.
- [x] `packages/postgres/test/conversation-index.test.ts`와 재사용 가능한 `conversation-fixture.ts`에 합성 대화·도구 메모 입력 기반, 격리 홈·DB 정리, 반복·증분·검색·NUL·경합·실패 롤백 시험을 추가한다.
- [x] 변경된 migration의 기존 설치 업그레이드·checksum·권한 검증을 갱신하고 관련 회귀를 실행한다.

**Acceptance Criteria:**

- Given 합성 대화와 저장 설정, When drain이 처리하면, Then 수작업 기대 경계·겹침·본문·part가 일치하고 같은 시각·5,000자 입력이 충돌 없이 저장된다.
- Given 처리된 세션, When 재처리와 append 후 drain을 실행하면, Then 중복이 없고 안정된 앞 조각은 유지되며 최신 뒤쪽 조각이 생성된다.
- Given 읽기가 끝난 snapshot, When 두 번째 연결이 새 메시지 또는 redact를 커밋하고 확정을 풀면, Then 낡은 snapshot은 반영되지 않고 후속 drain이 최신 조각을 만든다.
- Given 이미 조각이 있는 세션, When messages.redact가 성공하면, Then 지운 문자열이 조각에서 즉시 사라지고 재생성 후 가린 본문을 담는다.
- Given 재생성 일감 insert 실패 장치, When redact를 실행하면, Then 실패 값과 함께 본문·조각·기록·spool이 이전 상태로 보존된다.
- Given 한국어·literal 특수문자·NUL 합성 대화, When 최소 검색 port를 호출하면, Then 독립 전수 LIKE 적중 id와 같고 읽기 원문은 손실 없이 복원된다.

## Implementation Notes

- 재도출 검증: 긴 메시지 외부 겹침·NUL 검색 투영·잠금 대기 중 만료를 수정했다. 지휘자가 전체 빌드/타입과 순수 조각기 7개, Core+PG 69파일 2,083개 시험을 통과했고 기존 행렬 시험도 모두 실행됐다. 원본 3개 findings에 대한 회귀가 포함된다.

- 리뷰 재도출 절차: 구현자는 기존 소스 변경을 고유한 /tmp patch로 저장한 뒤 이 티켓의 apps/packages 변경만 baseline으로 되돌린다. 다른 작업의 _bmad 변경·계획·스테이징은 보존한다. KEEP 동작은 저장 patch에서 재구성하되 수정된 설계에 따라 chunker·검색 투영·확정 유효기간을 재도출한다. 이후 전체 검증과 implementation-ready 중간 보고를 보내고 같은 Dispatch에서 대기한다.

- 구현: 설정 세대 003·part·body_raw·Core 조각기/지문/검색 패턴·drain·Store/fake·PG 어댑터·수집/직접 SQL redact 재생성 enqueue를 연결했다. 이전 규칙 행과 baseline checksum은 보존했다.
- 원자성: 입력 변경 시 열린 일감 청구를 무효화하고, 확정은 세션 advisory lock 아래 현재 일감 소유권·유효기간·입력 지문을 비교한다. 확정 뒤 완료 전 입력 변경도 completeWork의 lost로 남아 후속 drain이 처리한다. 동일 prefix 행은 id를 유지한다.
- 검증: 지휘자가 pnpm build && pnpm typecheck, 순수 조각기 6개, Core 전체 47파일 1,628개, PG 전체 21파일 451개 시험 통과를 확인했다.
- 경합: 실제 handler의 snapshot 뒤 비동기 barrier 두 시험과 별도 Store 연결의 수집/redact, 완료 직전 입력 변경 두 시험, 만료/교체 claim 거부를 실행했다. 잠금 연결은 세션 advisory lock을 잡고 별도 adapter의 lockTimeoutMs 100·queryTimeoutMs 2000에서 DB_LOCKED를 관찰한다. 각 시험 30초 한도이며 finally에서 barrier 해제·연결/store 종료·격리 DB와 홈 삭제를 수행한다.
- redact 실패: 공개 Core redact use case가 spool 의존성 없이 실패하고 본문·조각·redactions·큐가 원복되며 임시 홈 파일이 증가하지 않음을 검증했다. 디스크 spool adapter 자체를 실행한 시험은 아니다.
- 행렬 점검: 경계/설정·동시각/긴 본문은 conversation-chunker 및 PG 동시각 시험, 반복/증분·입력 경합·redact 실패·NUL·검색은 conversation-index의 17개 시험에 대응하며 모두 실행됐다.

- 첫 구현 시도는 시제품 빌드만 성공했고 통합 구현 전에 실제 미완료 실패를 보고했다. 시제품은 제거되어 소스 변경이 없다. 같은 Task·모델로 재시도한다. 구현은 단계별로 작은 변경과 시험을 쌓아 전체 수락 조건까지 계속한다. 임의 시간 한도나 단순 미검증을 수행 불가로 간주하지 않는다. 진행이 어려운 구체적 설계 질문은 활성 Dispatch의 ask로 지휘자에게 전달한다.

## Plan Change Log

### 2026-10-30 — 긴 메시지 겹침과 확정 검증 보강

리뷰가 긴 메시지 경로의 pending 초기화로 겹침이 유실됨을 확인했다. 긴 메시지 내부 분할은 원문 B를 2,400자 부분들로 나누는 것이고, 앞뒤 메시지 경계의 문맥 겹침은 원래 메시지 단위로 유지하도록 Design Notes를 보강했다. 보존할 KEEP: 기존 snapshot 격리·세션 잠금·claim 무효화와 완료 CAS·NUL 원문 보존·독립 LIKE 대조·451개 PG 및 1,628개 Core 회귀·기존 prefix id 유지·원본 설정과 checksum 보존이다. 재도출에서는 이 동작을 유지하며 세 findings를 함께 닫는다.

## Review Triage Log

### 2026-10-30 — Review pass

- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` 긴 메시지 앞뒤 겹침 누락 — chunker가 긴 묶음 전후 pending을 비우므로 서로 다른 시각 A·긴 B·C 사이 겹침이 사라진다. 계획의 일반 겹침 불변식을 긴 메시지의 내부 분할과 외부 문맥으로 구분해 설계에 명시하고 재도출한다.
  - `[medium]` `[patch]` NUL 검색어 실패 — literal pattern을 PG text에 그대로 바인딩하여 NUL 원문 질의가 DB_UNAVAILABLE이 된다. 저장용 치환과 같은 검색 투영으로 맞추는 작은 수정이며 상위 bad_plan 재도출에 포함한다.
  - `[medium]` `[patch]` 잠금 대기 중 청구 만료를 놓침 — handler가 호출 전에 읽은 input.now를 잠금 후에도 쓰므로 대기 중 지난 유효기간을 통과한다. 잠금 취득 뒤의 실제 경과시간까지 반영해 비교하고 같은 소유자의 만료 대기 시험을 추가한다. 상위 bad_plan 재도출에 포함한다.


### 2026-10-30 — Review pass 2

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 긴 묶음 끝의 목표 경계 누락 — 같은 시각 긴 B와 일반 C 뒤 continue가 목표 판정을 건너뛰는 것을 확인했다. 분기 밖의 기존 목표 검사를 공통 적용하고 B 5,000자+C 1,200자+D 다음 시각의 수작업 기대 시험을 추가했다.
  - `[medium]` `[patch]` 첫 검사 뒤 DB 대기에서 만료 — snapshot과 chunks 조회/쓰기 뒤에는 재검사가 없음을 확인했다. 마지막 쓰기 후 경과시간을 반영해 재검사하고 만료 예외로 전체 트랜잭션을 롤백해 committed:false로 답하도록 고쳤다. ACCESS EXCLUSIVE 대기를 관측한 뒤 만료시켜 쓰기 롤백을 증명했다.

## Design Notes

긴 메시지 B의 최초 출현은 splitMessagesOverChars 단위로 나누며, 그 내부 part 사이에는 원래 메시지 전체를 겹쳐 복제하지 않는다. A→B의 첫 부분 앞에는 직전 원래 메시지 A(설정이 정한 겹침 수)를 문맥으로 붙이고 실제 fromAt을 유지한다. B→C에는 직전 원래 메시지 B 전체를 겹침 문맥으로 보존하고 C의 새 본문을 붙인다. 이미 겹침 문맥인 B를 다시 새 메시지로 처리해 분할/무한 반복하지 않는다. 조각 길이는 목표이지 상한이 아니므로 겹침 문맥 때문에 2,400자보다 커질 수 있다. B만 있는 5,000자 입력은 여전히 2,400+2,400+200의 part 1..3이다. 동시각 묶음의 일반 경계 불분할과 같은 범위의 part 연속성을 유지한다. A·긴 B·C 및 연속 긴 메시지의 수작업 기대값을 시험한다.

검색은 원문의 U+0000을 저장 검색 투영과 같은 U+FFFD로 치환한 뒤 literal LIKE를 적용한다. fake와 PG에서 같은 질의가 같은 논리 원문을 찾는다. 확정 시각은 잠금 전의 주입 clock 시각에 잠금/DB 대기의 실제 단조 경과시간을 더해 판정한다. SQL wall clock으로 주입 clock을 대체하지 않고, 만료 전 호출했으나 잠금 해제 뒤 만료된 동일 소유자의 확정을 거부한다.

[ASSUMPTION] 일반 메시지 본문은 줄바꿈 하나로 결합하고 그 구분자도 코드 포인트 길이에 센다. 목표 이상이 되는 시각 묶음까지 포함한 뒤 닫는다. 겹침만으로 새 조각을 만들지 않는다. 긴 메시지는 splitMessagesOverChars(기본 2,400) 크기로 나누므로 5,000자는 2,400 + 2,400 + 200의 세 조각이다. 1,200자로 나누면 part 1..3 수락 조건에 어긋난다. 이 세부 일반 경계 가정을 코드 주석과 설정 규칙에 남긴다.

기존 config 행은 수정하지 않는다. 새 migration은 추가 키를 허용하는 제약과 규칙 버전·동시각 정렬·코드 포인트·part 정책을 담은 새 chunk config 행을 만들고 이 티켓의 대화 drain이 그 세대를 명시적으로 사용한다. 기존 문서 설정과 세대는 보존한다. 직접 SQL brain.redact_message 진입점도 재생성 enqueue 불변식을 지키며 기존 SECURITY DEFINER·search_path·권한 경계를 유지한다. 열린 chunk 일감의 입력 변경 시 기존 cleanup 무효화 선례처럼 claim을 무효화하고, 확정 port가 현재 claim과 fingerprint를 검사하도록 하여 완료 직전 변경 유실과 lease 만료 구 worker 쓰기를 막는다. 변경 입력의 원자 enqueue와 완료 CAS가 같은 열린 일감 상태를 보호해야 한다.

전체 순수 경계를 재계산해 비교하더라도 동일한 prefix 행을 다시 쓰지 않아 증분의 안정성을 보존한다. fingerprint는 메시지 식별자·시각·논리 본문과 설정을 포함해 append와 redact 모두를 감지한다. snapshot 읽기는 일관된 DB snapshot이어야 하고 확정은 기존 세션 advisory lock 아래 현재 입력을 다시 읽어 비교한다. 큐의 열린 행이 이미 청구된 상태에서 새 입력이 들어오는 경합도 최신 입력 상태와 일감 완료를 함께 대조하거나 후속 일감을 보장해 닫는다.

## Verification

**Commands:**

- `pnpm build && pnpm typecheck` — 전체 워크스페이스 빌드와 타입 검사 성공.
- `pnpm exec vitest run --project core test/conversation-chunker.test.ts` — 순수 행렬 시험 전부 성공.
- `pnpm exec vitest run --project postgres` — 실제 PG 신규 조각·검색·경합·redact 및 기존 migration/수집/확장 회귀 성공.
- `pnpm exec vitest run --project core` — 기존 fake·drain·출력 계약 회귀 성공.

사전 조건은 Node/pnpm과 OrbStack Docker다. vitest global setup이 compose.test.yaml의 개발 전용 PG를 준비하며 각 시험은 brain_test_* 격리 DB와 임시 Brain 홈을 쓴다. 운영 홈·DB는 사용하지 않는다. 경합 연결 A는 snapshot/확정, B는 ingest/redact를 맡는다. snapshot 완료 barrier 이후 B를 커밋하고 A를 풀어 낡은 확정 거부를 관찰한다. 실제 잠금 시험은 B가 세션 advisory lock 또는 필요한 ACCESS EXCLUSIVE를 잡고 A가 대기하는 것을 관찰하며 timeout을 명시한다(시험 30초, 잠금 시험은 50~500ms 한도). finally에서 barrier를 풀고 ROLLBACK·client.end·store.close·db.drop·임시 홈 삭제를 수행한다. global setup이 자신이 시작한 PG를 종료하며 수동 시작분은 `docker compose -f compose.test.yaml down`으로 정리한다. 실제 사용한 시험 이름·연결·timeout과 결과는 구현 메모에 남긴다.


## Auto Run Result

- Status: blocked
- 구현: 설정 기반 대화 조각·분할 part·NUL 원문 보존·멱등 수집 일감·원자적 redact 재생성·입력 지문/청구 소유권/유효기간 확정·최소 literal LIKE 검색 port를 완성했다.
- 범위: 공개 recall 명령과 결과 budget은 후속 티켓이며 이 티켓은 검색 Store 기반과 대화 조각 writer를 제공한다. 저장소 밖 HUMAN 전용 수락 작업은 없어 operator_actions가 필요하지 않다.
- 리뷰: 독립 quick 검사 2회를 실행했다. 첫 회 medium 3건은 계획 재도출 1건과 함께 수정 2건으로 반영했고, 두 번째 medium 2건도 작은 수정으로 반영했다. 기각 0건, 새 리뷰 이월 0건이며 기존 일반 경계 [ASSUMPTION] 1건을 deferred에 보존한다.
- 이번 회 수정 집계: high 0, medium 2, low 0. followup_review_recommended: true. 복합 동시각·긴 메시지 겹침의 part/증분 경계와 최종 DB 쓰기 뒤 만료 롤백은 회귀로 검증했으나 마지막 수정 후 독립 재리뷰를 하지 않았으므로 후속 검토를 권고한다.
- 지휘자 검증: pnpm build && pnpm typecheck 성공. pnpm exec vitest run --project core test/conversation-chunker.test.ts 8개 성공. pnpm exec vitest run --project core --project postgres 69파일 2,085개 성공(Core 1,631개, PG 454개). git diff --cached --check 성공.
- 행렬: 저장 설정/수작업 경계·동시각/긴 메시지·재청구/증분·새 메시지/redact barrier·재생성 실패 롤백·NUL 읽기/검색·전수 LIKE 적중 id와 DB 실패 구분 시험이 모두 실행돼 통과했다.
- 잠금·정리: snapshot handler A와 입력 writer B를 분리한다. 만료 시험은 세션 advisory 또는 chunks ACCESS EXCLUSIVE 보유 연결과 pg_stat_activity 관측 연결을 사용한다. lockTimeoutMs 100 또는 2000, queryTimeoutMs 2000 또는 4000, 시험 한도 30초이며 finally에서 barrier/잠금 해제·연결 종료·격리 DB/홈 삭제를 수행한다.
- 한계: 공개 Core redact 실패가 spool 의존성을 사용하지 않고 임시 홈 파일이 늘지 않음을 확인했다. 디스크 spool adapter 자체의 실행 시험은 아니다. 운영 Brain 자료나 홈은 검증에 사용하지 않았다.
- 티켓 done 표시와 push는 하지 않았다. 완료 판정은 외부 오케스트레이터에 남긴다.

### 변경 파일

- `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/story-tracer-plan.md` — 계획·수락 기준·검증·리뷰·실행 결과를 기록한다.
- `apps/cli/src/doctor/store.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `apps/cli/test/dispatch.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/src/brain.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/domain/chunk.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/domain/index-config.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/index.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/ports/conversation-index-store.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/ports/store.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/src/recall/conversation-chunker.ts` — 순수 대화 조각·지문·일감 또는 literal 검색 규칙을 제공한다.
- `packages/core/src/recall/conversation-fingerprint.ts` — 순수 대화 조각·지문·일감 또는 literal 검색 규칙을 제공한다.
- `packages/core/src/recall/conversation-work.ts` — 순수 대화 조각·지문·일감 또는 literal 검색 규칙을 제공한다.
- `packages/core/src/recall/text-query.ts` — 순수 대화 조각·지문·일감 또는 literal 검색 규칙을 제공한다.
- `packages/core/src/testing/fakes/store.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/core/test/brain-drain.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/conversation-chunker.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/conversation-fingerprint.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/conversation-search.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/document-extract.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/session-identity-work.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/core/test/text-query.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/migrations/0014_conversation_chunks.sql` — part 키·원문 짝 칸·새 규칙 세대·원자적 재생성 함수를 추가한다.
- `packages/postgres/src/conversation-index.ts` — 일관된 snapshot·원자 확정·검색 PG 경계를 구현한다.
- `packages/postgres/src/migrate.ts` — core schema 버전을 14로 올린다.
- `packages/postgres/src/sessions.ts` — 수집 트랜잭션에 멱등 조각 일감과 청구 무효화를 연결한다.
- `packages/postgres/src/store.ts` — 도메인·Store 계약·fake·조립·공개 타입을 확장한다.
- `packages/postgres/test/cli.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/conversation-fixture.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/conversation-index.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/migrate.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/schema.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/store.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/unavailable.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.
- `packages/postgres/test/work-store.test.ts` — 대화 조각·경합·검색 또는 기존 동작의 회귀 검증을 반영한다.

### Orca 정리

- 자기 Run run_b44c973fa3d5의 조사 1·실패 구현 1·성공 구현 1·리뷰 2 Dispatch를 모두 정식 결과 수락 후 release했다. worker-list는 released 5, active/reclaimable 0이며 coordinator mail은 0이다. 실패 구현은 새 Task로 우회하지 않고 같은 Task의 retry-of로 복구했다. 소유권이나 생존 미확인 워커는 없다.


### 종료 판정

- status: blocked
- 차단 조건: finalization left repository dirty. 티켓 구현은 커밋 `ed89726b5ade660d2e6c5c5e5d4501a6160a6803`에 보존됐고 이 티켓의 검토 파일은 모두 커밋돼 있다. 다음 별도 작업 파일 5개 때문에 build-auto의 전체 작업 트리 clean 종료 조건을 충족하지 못했다.
- 별도 수정: `_bmad/custom/bmad-build-auto.toml`, `_bmad/custom/bmad-orca-workers.md`.
- 별도 미추적: `_bmad-output/personal-brain/plan-orca-worker-recovery.md`, `_bmad/custom/bmad-orca-control.py`, `_bmad/custom/test_bmad_orca_control.py`.
- 이 변경은 실행 시작 후 생겼으며 이 티켓의 구현자가 만들지 않았다. 덮어쓰기·제거·커밋·stash하지 않고 보존했다. 기능 실패나 저장소 밖 HUMAN 작업이 차단 원인은 아니다.
- HALT 절차에서만 tickets.py mark 17.2 blocked를 실행했다. done 표시·push는 하지 않았다. 자기 Orca Run은 워커 released 5, mail 0으로 정리했고 전용 제어 셸만 닫는다.
