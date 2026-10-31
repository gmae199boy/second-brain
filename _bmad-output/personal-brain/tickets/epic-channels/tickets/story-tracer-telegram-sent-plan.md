---
title: 'Tracer: 테스트 생산자의 요청 한 건이 가짜 Telegram 서버에 한 번 나가고 sent로 남는다'
type: feature
ticket: 1
created: '2026-10-31'
status: done
baseline_revision: d490bccb3641e95a2d6684957ec21bf706f414de
route: full
route_source: pinned
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 공통 채널 발신 요청을 감독자와 Telegram adapter로 보내고 결과를 보존하는 길이 없다.

**Approach:** channel·conversation·요청·인계·최초 gate·attempt 결과의 최소 계약을 만들고 PG → 데몬 감독자 → ABI v1 Node worker → 로컬 가짜 Telegram HTTP → 현재 token 결과 확정을 관통한다. 워크플로가 고정한 full 경로로 고위험 계약을 검증한다.

## Boundaries & Constraints

**Always:** 의미 키는 요청 UUID와 별도로 `(생산 결과 식별자, conversation, 목적, 개정)` UNIQUE이며 NULL로 우회할 수 없다. channel의 비밀 아닌 봇 참조, conversation의 외부 참조, 선택 thread, 생산자 출처·결과 참조와 응답에 있는 message id를 보존한다. core 인계는 일감 생성과 표식을 한 트랜잭션에 확정한다. 최초 gate와 결과 확정은 현재 attempt token을 검증한다. HTTP 전에 짧은 gate 트랜잭션을 닫으며 DB 원문은 보존하고 발신 텍스트는 등록된 출력 코덱으로 가린다. `.env` 비밀은 Runtime 설정 코덱만 읽고 argv·로그·ABI stdout에 내지 않는다. `channel_send`는 supervised다.

**Never:** 기회적 drain·hook에서 발신하지 않는다. 실계정 설정·발신·배포(15.7), 재시도·불명 복구(15.2), legacy·RLS(15.3), bundle·사진·문서(15.4), channels 명령·스킬(15.5)은 구현하지 않는다. 기존 마이그레이션을 수정하거나 티켓 상태·done·커밋을 구현자에게 맡기지 않는다. 외부 message id를 만들지 않는다.

## I/O & Edge-Case Matrix

| 시나리오 | 입력·상태 | 관찰 결과 | 실패 처리 |
|---|---|---|---|
| 정상 발신 | 테스트 생산자 요청 하나 | 가짜 서버 sendMessage POST 하나, 요청 sent, 정상 ABI 종료, identity·provenance·message id 되읽기 | 실패를 sent로 추정하지 않는다 |
| 중복·경쟁 | 같은 의미 키 재삽입과 동시 삽입 두 건 | 요청·최초 gate·HTTP POST 각각 하나 | NULL 개정도 같은 정규형으로 중복 억제한다 |
| 출력 가리기 | 본문에 시험 비밀 문자열 | 수신 HTTP 본문은 가려지고 DB 원문은 유지 | 실제 HTTP payload와 코덱 등록부로 확인한다 |
| 트랜잭션 경계 | 가짜 서버가 응답을 보류 | gate가 다른 연결에 보이고 HTTP 동안 DB 쓰기 트랜잭션·관련 행 잠금 없음 | 응답 해제 후 sent로 종료한다 |
| 인계 복구 | 요청 INSERT 후 아직 인계되지 않은 상태 | core 인계 재실행으로 일감·표식 한 벌 | 인계 반복·동시 실행은 일감을 늘리지 않는다 |
| 실행 격리·token | 데몬 없는 queue drain, 오래된 token 결과 쓰기 | POST 없음, 오래된 결과 확정 거부 | 현재 attempt 결과만 보존한다 |

</intent-contract>

## Code Map

- `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/` — Store 기능별 port·fake·공유 계약 패턴. `domain/work-item.ts`의 실행 분류를 재사용한다.
- `packages/postgres/src/store.ts`, `connect.ts`, `work.ts`, `write.ts`, `migrate.ts`, `migrations/` — `withWrite(connection, held => …)` 안에서 `ensureWork(held, input)`과 인계 표식을 함께 쓴다. `0004_attempt_fence.sql`의 `attempt_is_current`·`reject_stale_attempt`를 실제 gate·결과 표에 적용한다(BRS01). `CORE_SCHEMA_VERSION`은 16→17로 올린다. main과 baseline은 동일하고 마지막 번호는 0016이다.
- `packages/core/src/queue/supervisor.ts`, `process-abi/codec.ts` — 감독자의 청구·token·그룹 수명·ABI 검증을 유지한다.
- `apps/cli/src/daemon/supervisor.ts`, `daemon/run.ts`, `workers/process-probe.ts`, `runtime/brain-store.ts` — 일반 launches와 명시적 env allowlist로 Node worker를 띄우고 데몬 반복의 schema 확인 뒤 인계를 호출한다. worker는 채널 결과를 저장하고 ABI result만 출력하며 work 완료는 감독자에 맡긴다.
- `apps/cli/src/config/codec.ts`, `packages/core/src/output/codecs.ts` — 설정 비밀과 출력 가리기의 유일한 경계다.
- `packages/postgres/test/fixture.ts`, `apps/cli/test/pg-home.ts`, `supervisor-fixture.ts`, `daemon-supervisor.test.ts`, `tooling/test-db/` — 격리된 PG·홈·실제 데몬 시험과 정리를 재사용한다.

## Tasks & Acceptance

**Execution:**
- [x] 1단계: `packages/core/src/channels/`, `ports/store.ts`, `testing/fakes/store.ts`, 새 `testing/contracts/channel-store.ts`, `packages/postgres/migrations/0017_channels.sql`, `src/channels.ts`, `store.ts`, `connect.ts` 및 export·schema 상수 — 최소 channel·conversation·요청·gate·attempt 계약과 fake/PG 구현, 원자적 인계, token 확정을 추가한다. 공유 계약을 fake와 PG에서 실행하고 중복·동시 인계·stale token을 검증한다.
- [x] 2단계: `packages/core/src/channels/`, `domain/work-item.ts`, `output/codecs.ts`, `apps/cli/src/config/codec.ts`, 새 `adapters/telegram.ts`, `workers/channel-send.ts`, `daemon/supervisor.ts` 및 필요한 데몬 반복 조립 — sendMessage port·코덱·설정(`BRAIN_TELEGRAM_BOT_TOKEN`, `BRAIN_TELEGRAM_CHAT_ID`)·ABI worker·core 인계 반복을 연결한다. production endpoint는 Telegram HTTPS로 고정하고 가짜 서버 주입은 명시적인 시험 의존성으로만 제공한다.
- [x] 3단계: 새 `apps/cli/test/channels-tracer.test.ts`, `channel-fixture.ts`, `packages/core/test/channel-store.test.ts`, `packages/postgres/test/channel-store.test.ts` 및 관련 기존 시험 — 테스트 생산자·가짜 서버(응답·지연·끊김·429 제어)·격리 홈/PG·정리 도구를 만든다. 행렬의 모든 행을 실제 실행해 증거를 남긴다.

**Acceptance Criteria:**
- Given 격리 PG·Brain 홈·가짜 서버, When 테스트 생산자 요청을 넣고 실제 데몬과 Node worker를 실행하면, Then sendMessage 하나와 sent 결과·정상 ABI attempt 및 channel·conversation·thread·생산자 출처·외부 message id를 관찰한다.
- Given 같은 의미 키, When 재삽입하거나 두 생산자가 동시에 삽입하면, Then gate 승자 하나와 POST 하나만 관찰한다.
- Given 비밀을 포함한 원문과 응답 보류 서버, When 발신 중 DB를 별도 연결로 관찰하면, Then HTTP payload의 비밀은 가려지고 원문은 유지되며 gate 커밋과 트랜잭션 미보유를 증명한다.
- Given 미인계 요청과 데몬 중지, When 인계를 반복한 뒤 `brain queue drain`을 실행하면, Then 일감·표식은 한 벌이고 발신은 없으며 이후 데몬만 발신한다.

## Implementation Notes

- 1·2단계는 저장 계약·PG 0017·원자적 인계·fence·설정/출력 코덱·adapter·Node worker·데몬 연결을 구현했다. `sent`는 외부 message id 없이도 보존하고 null로 되읽는다. 구현 보고의 관련 시험 110개 통과와 회귀 시간초과 한 건의 단독 통과를 로그로 확인했으며 최종 회귀에서 재확인한다.
- phase-ready는 단계 중간 보고로만 수락했다. 실제 HTTP tracer와 최종 검증·리뷰가 끝날 때까지 구현자의 같은 Dispatch를 유지한다.

- 지휘자 Verify: `pnpm build`, `pnpm typecheck`, 관련 8파일 115시험, 회귀 13파일 373시험 모두 통과했다. 로그는 `/tmp/brain-15-1-verify-{build,typecheck,contract,regression}.log`다.
- 행렬 감사: `channels-tracer.test.ts`의 동시 생산·인계·drain·HTTP 대기 시험이 정상·중복·마스킹·트랜잭션·복구·token을 관통하고, null-id 성공 및 429/끊김 시험도 실행됐다. fake/PG 공유 계약이 token과 중복 억제를 양쪽에서 증명한다. 건너뛴 시험은 없다.

## 검증 실패 복구 기록

- 이전 결정적 검증의 마이그레이션 기대값 `16`을 `CORE_SCHEMA_VERSION`으로 바꿨다. `0017_channels.sql`과 기존 마이그레이션은 그대로 유지했다.
- 스키마 확인 뒤 채널 인계가 `DB_UNAVAILABLE`을 반환하면 기존 데몬 재연결 흐름으로 진입하도록 보완했다. drain 복구 시험의 인계 대역을 명시하고 인계 실패에서도 새 복구 구간이 즉시 시작되는지 검증했다. 지정 두 파일 55시험과 타입 검사가 통과했다.
- 첫 전체 검증은 원래 실패 두 건을 통과했지만 별도 감시·재기동 시험이 전체 20초 제한에 걸렸다. 단계별 대기 합이 전체 제한을 넘던 시험의 시작·재기동 대기를 각각 4초로 제한하고, 실패 시 자식 프로세스 종료를 기다리도록 보강했다. 감시 수집 9.5초 기준과 전체 20초 제한은 유지했다. 해당 파일 53시험이 통과했으며 전체 부하 재검증을 진행한다. 원래 로그만으로 지연 단계는 특정하지 못했다.
- 동결된 `<intent-contract>`와 `baseline_revision`은 변경하지 않았다. 이 티켓에는 저장소 밖에서 사람이 수행할 수락 작업이 없다.

## Plan Change Log

- 기존 계획은 제목·ticket·ready-for-dev만 있고 본문이 없었다. 구현 전 현행 main 코드 조사로 실행·검증 계약을 보완했다.

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `apps/cli/src/daemon/supervisor.ts:83`의 설정 누락이 null launch→`PROCESS_START_FAILED` 재시도로 분류돼 15분 간격으로 10시도를 소진한다. `runSupervisor`의 kinds 생성·125~129행·298~313행과 ABI retry 분류를 확인했다. 기존 worker 설정 검증으로 연결하고 `CHANNEL_CONFIG_INVALID`/retryable false를 첫 시도에 확정하도록 고쳤다. 실제 데몬 시험에서 attempts 1·실패·gate/HTTP 없음과 ABI 오류 구분을 확인했다. 청구 제외 제안은 에픽 E15-5의 설정 없음 첫 실패 영구 오류 결정에 맞지 않아 채택하지 않았다.

### 2026-10-31 — 검증 실패 복구 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 독립 quick 리뷰가 계획·문맥·전체 diff와 주변 코드를 검사했고 확인된 미충족 수락 기준·규칙 위반·버그는 없었다. 이번 패치·defer·reject는 모두 0건이며 후속 리뷰 권고는 `false`다.

## Design Notes

- 보존한 최초 gate는 성공 추정 근거가 아니다. 정상 tracer 이후 실패·unknown 재시도는 15.2가 확장한다. 비밀 없는 봇 참조와 비밀 token은 별개이며 DB에 token을 저장하지 않는다.

## Verification

**Commands:**
- `pnpm build` 및 `pnpm typecheck` — 전체 빌드와 시험 타입 검사 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channel-send channels-tracer telegram output-codecs config` — 공유 계약·PG·실제 worker tracer·출력·설정 시험 성공. 구현 보고에 실제 시험 이름과 개수를 남긴다.
- `pnpm exec vitest run --project core --project postgres --project cli supervisor work-store attempt-fence migrate schema` — 기존 감독자·queue·token·마이그레이션 회귀 성공.

**사전 조건·관찰·정리:** Node·pnpm은 저장소 engines를 충족하고 Docker/OrbStack이 실행 중이어야 한다. Vitest global setup이 `compose.test.yaml`의 시험 전용 PG를 준비하며 시험마다 별도 DB와 임시 Brain 홈을 쓴다. fixture는 finally에서 데몬 abort·종료 대기, HTTP close, store close, DB drop, 임시 홈 삭제를 수행한다. 수동 시험 컨테이너를 시작했다면 `docker compose -f compose.test.yaml down`으로 정리한다. production 홈·DB·실계정은 사용하지 않는다. 행동 평가는 15.5가 추가하며 이 기본 suite와 별도다.

## Auto Run Result

- Status: `built`
- 기존 채널 발신 tracer의 동결 의도 계약을 유지하면서 결정적 검증 피드백의 두 회귀를 복구했다. 채널 인계 연결 실패도 데몬의 기존 재연결 정책을 따른다. 기존 구현 커밋은 `384e1aa8907d43aaa4592b44cfa4b51f0afce92f`로 유지했다.
- 이번 변경 파일:
  - `apps/cli/src/daemon/run.ts` — 채널 인계의 `DB_UNAVAILABLE`을 재연결 경로로 전달한다.
  - `apps/cli/test/daemon-run.test.ts` — 인계 대역과 drain·handoff 복구 행렬을 검증하고, 감시 시험의 단계별 진단 및 자식 종료 대기를 보강한다.
  - `packages/postgres/test/extension-permissions.test.ts` — 전체 마이그레이션 목표를 `CORE_SCHEMA_VERSION`에 맞춘다.
  - 이 계획 파일 — 복구·검증·리뷰·정리 근거를 기록한다.
- 리뷰: 독립 quick findings 0건. 이번 패치 적용 0건(high 0, medium 0, low 0), defer 0건, reject 0건. `followup_review_recommended: false`다. 이전 리뷰의 설정 누락 수정은 보존했다.
- 검증: `bash _bmad/custom/bmad-loop-verify.sh` 종료 코드 0. 내부 `pnpm build`, `pnpm typecheck`, 전체 Vitest 150파일·3723시험이 통과했다. `BRAIN_PYTHON_UPDATE_TEST`로 따로 켜는 기존 bootstrap Python 갱신 시험 1개는 skipped이며 채널 행렬과 무관하다. 최종 로그는 `/tmp/brain-15-1-repair-full-verify-2.log`다. 구현자의 지정 시험 55개 및 데몬 파일 재실행 53개도 통과했다.
- 행렬 감사: 정상·의미 키 중복/동시 생산·출력 가리기·HTTP 대기 중 gate 커밋과 DB 잠금 부재·인계 복구·기회적 drain 격리·stale token 거부가 `channels-tracer`, fake/PG `channel-store`, `channel-send` 시험에서 모두 실행되어 통과했다.
- 잔여 관찰: 첫 전체 검증에서 별도 감시·재기동 시험이 20초 제한에 걸렸으며 원래 로그로 지연 단계는 특정하지 못했다. 단계별 대기 진단과 자식 정리를 보강한 뒤 해당 파일 및 전체 검증은 통과했다. 감시 수집 9.5초와 시험 전체 20초 기준은 유지했다.
- 운영자 작업: 없음. 실계정 설정·발신은 이 티켓의 수락 범위 밖이다. 티켓 `done`과 `tickets.py mark`는 실행하지 않았으며, 완료 판정은 오케스트레이터의 자체 검증에 맡긴다.
- 정리: 이번 Run의 구현·quick 리뷰 워커 모두 정식 `succeeded` 보고를 수락한 뒤 `released`로 정리했다. 미처리 mail·미확인 요청·미정리 워커는 없다. 체크포인트는 `.bmad-loop/runs/20261030-175233-8a92/tasks/15.1-dev-2/orca-coordination.json`에 저장하며, 커밋·깨끗한 작업 트리 확인 뒤 전용 제어 셸을 마지막에 닫는다.
