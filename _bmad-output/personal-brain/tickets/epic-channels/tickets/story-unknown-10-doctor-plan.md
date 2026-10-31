---
title: '불명 발신과 재시도 및 doctor 실패 노출'
type: feature
ticket: 2
created: '2026-10-31'
status: blocked
baseline_revision: ebbbcbfdc837168ece52de082d6771fe147c99e3
route: full
route_source: pinned
risk: high
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
blocked_at: "2026-10-31"
blocked_reason: "Orca 정식 재시도 불가: 최초 구현 워커가 별도 bmad-build 렌더링의 PyPI jinja2 DNS 오류로 failed를 보고했다. 제어 도구 start가 --task·--retry-of를 unsupported or duplicate worker-start flag로 거부하므로 동일 Task의 정식 재시도를 배정할 수 없다. 소스·시험 변경 없음. 구현 실패 1회이며 implementer unavailable의 2회 실패 판정은 아니다."
---

<intent-contract>

## Intent

**Problem:** 최초 발신 실패와 crash가 결과 없이 남고 gate가 재시도를 막는다. 발신 누락과 끝없는 발신을 막을 결과·재시도 계약이 필요하다.

**Approach:** 같은 요청·일감과 최초 gate를 보존하면서 attempt마다 `sent`·`definite_failed`·`unknown`을 남긴다. 현재 token만 확정하며 감독자의 재시도·실패 기록과 doctor를 연결한다. 고위험 저장·프로세스 복구이므로 고정된 full 경로를 쓴다.

## Boundaries & Constraints

**Always:** 요청 전 연결 실패는 `definite_failed`/`network_before_send`, 요청 뒤 응답 유실·깨진 응답·2xx인데 ok가 아니면 `unknown`이다. 요청 전 연결 실패·429·5xx·unknown은 AD-21 지수 간격으로 다시 보내며 429는 `retry_after` 이상 기다린다. 10시도 소진은 `failures`와 doctor에 요청 식별자로 보인다. 영구 오류(429 이외 4xx·설정 없음·too_large)는 첫 실패에서 닫힌다. 결과 확정 직전 crash와 접수 직후 worker 종료 모두 unknown 복구·같은 요청 재시도를 증명한다. 최초 gate는 한 번이며 새 시도는 새 token이다. 생산자 결과 행·해시는 모든 실패·복구에서 유지한다. 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않으며 현재 attempt fence·비밀 가리기를 유지한다.

**Never:** 기존 0017 등 마이그레이션을 수정하지 않는다. 임의 메시지 CLI·resend·legacy/RLS·bundle/사진/문서·실계정 발신·배포는 후속 티켓 범위다. 생산자 데이터를 삭제하거나 되돌리지 않는다. 불명 결과를 sent로 추정하거나 HTTP 본문·token·설정을 로그에 노출하지 않는다. 티켓 done·tickets.py mark·push는 구현자가 실행하지 않는다. 계획·티켓 상태와 커밋은 지휘자·오케스트레이터 소관이다.

## I/O & Edge-Case Matrix

| 시나리오 | 입력·상태 | 관찰 결과 | 실패 처리 |
|---|---|---|---|
| 접수 뒤 끊김 | 가짜 서버가 요청을 받은 뒤 연결 종료 | unknown 기록 후 다음 지수 간격에 같은 요청을 보내 sent | gate 한 행, 새 attempt |
| 연결 전 실패 | 포트 연결 거부 | definite_failed/network_before_send 기록 후 재시도 sent | 모호한 네트워크 오류는 unknown |
| 깨진 응답 | 잘못된 JSON 또는 2xx ok 아님 | unknown 후 재시도 | 외부 message id를 만들지 않음 |
| 일시 오류 | 429 retry_after 또는 5xx | 지수 간격·retry_after 하한 전에는 POST 없음, 이후 재시도 | 10시도면 failures·doctor 노출 |
| 영구 오류 | 400·설정 없음·too_large | 첫 실패 후 failures, 자동 재발신 없음 | 생산자 결과 유지 |
| 접수 뒤 crash | 서버 접수 직후 실제 worker 강제 종료 후 재시작 | 이전 attempt unknown, 새 attempt sent | gate·요청·일감은 유지 |
| 확정 직전 crash | 응답 수신 뒤 결과 확정 직전 실제 worker 종료 | unknown 복구 후 같은 요청 sent | 오래된 token 쓰기 거부 |
| 성공 확정 뒤 복구 | sent 기록 후 감독자 확정 전 종료 | 확인된 sent는 재발신하지 않음 | 결과와 일감 확정 수렴 |

</intent-contract>

## Code Map

- `packages/core/src/channels/store.ts`, `send.ts`, `testing/fakes/store.ts`, `testing/contracts/channel-store.ts` — 현재 요청 상태는 pending/sent뿐이며 send port 실패는 ok false뿐이다. gate가 이미 있으면 재실행을 막고 결과가 요청당 한 행이다. attempt 결과와 진행 중 표시·복구를 추가하되 기존 호출 호환성을 검토한다.
- `packages/postgres/src/channels.ts`, `migrations/0017_channels.sql`, `src/work.ts`, `connect.ts`, `migrate.ts` — 최초 gate는 요청 PK이고 token은 최초 시도 값이다. 새 번호 마이그레이션으로 결과를 attempt별로 확장한다. `attempt_is_current`와 `withWrite`를 재사용한다. 기존 sent/gate 데이터 보존과 마이그레이션 시험이 필요하다. baseline schema 17이며 현재 디렉터리에서 다음 번호를 재확인한다.
- `packages/core/src/queue/supervisor.ts`, `domain/work-item.ts`, `ports/store.ts` — MAX_WORK_ATTEMPTS=10, retryDelayMs는 1초부터 지수 증가·1시간 상한이다. 기존 감독자는 모든 일시 실패를 transientDelayMs(15분)로 처리하므로 채널에 한정해 지수 간격과 저장한 retry_after를 반영한다. 기존 다른 종류 정책과 ABI v1을 보존한다. work.ts의 finishSupervisedWork는 종료·failures 기록을 원자적으로 처리한다.
- `apps/cli/src/adapters/telegram.ts`, `workers/channel-send.ts`, `daemon/supervisor.ts` — fetch 실패를 모두 합치던 adapter를 보수적으로 분류하고 worker가 재시도 가능한 결과를 전달한다. 기존 설정 누락은 CHANNEL_CONFIG_INVALID/retryable false다. 송신 텍스트 UTF-16 4096 상한도 전송 전에 확인한다. 운영 endpoint는 고정하고 시험만 의존성으로 주입한다.
- `apps/cli/test/channel-fixture.ts`, `channels-tracer.test.ts`, `supervisor-fixture.ts`, `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/checks.ts` — 15.1의 실제 데몬·PG·Node worker·가짜 HTTP fixture를 확장한다. 기존 fake clock으로 간격을 앞당기고 실제 프로세스 종료를 관찰한다. doctor의 기존 실패 조회를 재사용한다. production 홈·DB·실계정은 쓰지 않는다.

## Tasks & Acceptance

**Execution:**
- [ ] 1단계: `packages/core/src/channels/`, `packages/core/src/testing/`, `packages/postgres/src/channels.ts`, `packages/postgres/migrations/` 및 관련 시험 — core 채널 계약·send·fake와 PG 채널 저장·새 마이그레이션 및 공유 계약 시험을 수정한다. attempt별 결과·최초 gate 재사용·현재 token·이전 미확정 attempt unknown 복구·sent 재발신 억제·기존 데이터 보존을 검증한다.
- [ ] 2단계: `apps/cli/src/adapters/telegram.ts`, `apps/cli/src/workers/channel-send.ts`, `packages/core/src/queue/supervisor.ts` 및 관련 시험 — Telegram adapter·ABI worker·감독자 및 관련 시험을 수정한다. 보수적인 네트워크 구분·HTTP 상태·retry_after·지수 재시도·10회와 첫 영구 실패를 연결한다. 채널 외 종류의 정책은 유지한다.
- [ ] 3단계: `apps/cli/test/channels-retry.test.ts`와 fixture·기존 tracer 시험을 보강한다. 행렬 전체를 실제 worker/PG/가짜 서버로 검증하고, 모든 실패·복구에서 실제 테스트 생산자 결과 행과 해시를 전후 비교한다. 시험 이름·명령·실행 결과를 보고서에 남긴다.

**Acceptance Criteria:**
- Given 테스트 생산자와 가짜 서버, When 끊김·연결 거부·429·5xx·깨진 응답을 발생시키고 fake clock을 전진하면, Then 저장 결과의 분류와 재시도 간격·동일 요청·gate 하나·후속 sent를 관찰한다.
- Given 계속 실패하는 발신과 400·설정 누락 발신, When 감독자가 처리하면, Then 각각 10시도와 1시도에서 failures와 doctor 결과에 해당 요청이 보이며 추가 발신이 없다.
- Given 실제 worker와 접수·결과 확정 전 장벽, When worker를 종료하고 다시 띄우면, Then unknown 이력과 같은 요청의 새 시도 성공이 남고 오래된 token은 확정을 못 하며 생산자 결과 행과 해시가 그대로다.

## Implementation Notes

- 첫 구현 Dispatch는 계획·AGENTS.md를 읽은 뒤 별도 bmad-build 렌더링을 시도했으며 PyPI jinja2 다운로드 DNS 실패로 정식 failed를 보고했다. 소스·시험 수정은 없고 구현 단계 전체가 남았다. 보고 전문은 `/tmp/brain-15-2-implementation.md`다.
- 정식 실패를 수락하고 `ctx_866d5928d059`를 release했다. Orca의 정식 재시도는 같은 Task에 `--task`·`--retry-of`가 필요하지만 현재 제어 도구의 start는 `--spec`만 허용한다. 기존 요청을 새 역할·Run·워커로 우회하지 않는다.

## Plan Change Log

- 2026-10-31 감독자 추천: 최초 실패 보고·release·ack와 활성 워커 0을 확인했고 현재 PyPI DNS 조회가 성공한다. 기존 generation을 억지 재시도하지 않고 엔진 resolve로 새 generation을 시작한다. 지휘자는 새 배정 전 기존 정리 기록과 Orca 소유권을 확인하고 회로 차단기나 모호한 요청을 우회하지 않는다. 구현 워커에게 별도 bmad-build 재귀 실행 없이 이 계획의 1단계부터 phase-ready·검증·checkpoint 순으로 수행하도록 명시한다. 정식 재시도 제한이 새 generation에도 적용되면 지휘자가 지원 경로를 조사하고 제어 도구 복구를 별도 구현 과업으로 분할한다. 기존 보안·데이터·시험 계약은 유지한다.


## Review Triage Log

## Design Notes

- 저장된 gate는 전송 성공의 증거가 아니다. 접수 여부를 알 수 없으면 중복 가능성을 수용하고 재시도한다. sent가 저장됐으면 감독자 crash 뒤에도 HTTP를 반복하지 않는다.
- 작은 명세 공백은 보수적인 해석을 코드와 계획에 [ASSUMPTION]으로 남기고 deferred에 추가한다. 비밀·마이그레이션 안전성·기존 결정 충돌은 추정하지 않는다.

## Verification

**Commands:**
- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 전체 타입 검사 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channel-send channels-tracer channels-retry telegram supervisor process-abi migrate doctor` — 행렬·공유 계약·실제 worker 복구·doctor 및 관련 회귀가 모두 통과한다.

**사전 조건과 정리:** 저장소 Node·pnpm engines와 Docker/OrbStack을 사용한다. Vitest global setup의 시험 전용 PG와 격리 DB·홈을 사용한다. fixture의 finally에서 worker·데몬 종료 대기, 소켓 종료, store close·DB drop·임시 홈 삭제를 수행한다. fake clock은 대기만 앞당기고 관찰을 대신하지 않는다. 별도 운영자 작업은 없다.

## Auto Run Result

- Status: `blocked`
- 차단 원인: 첫 구현 워커가 별도 bmad-build 렌더링 중 PyPI jinja2 다운로드 DNS 실패로 정식 `failed`를 보고했다. 소스·시험은 수정하지 않았다. 정식 재시도는 같은 Task의 `--task`·`--retry-of`가 필요하지만 `_bmad/custom/bmad-orca-control.py` start가 두 flag를 허용하지 않으며 실제 호출도 `unsupported or duplicate worker-start flag`로 거부했다. 새 Task·Run이나 직접 worker-start로 우회하지 않았다.
- 완료한 부분: 티켓 15.2와 에픽·선행 계획을 읽고 현행 저장·adapter·감독자·fixture를 조사해 실행 가능한 3단계 full 계획을 작성했다. 기준 revision은 `ebbbcbfdc837168ece52de082d6771fe147c99e3`다. 구현·검증·리뷰·커밋은 아직 수행하지 않았다.
- 검증: build·typecheck·행렬 시험은 미실행이다. 최초 워커의 실제 요청·모델과 유효 모델이 모두 codex/gpt-6.1-terra/medium임을 확인했다. 구현 실패는 1회이며 `implementer unavailable`의 연속 2회 실패 판정이 아니다.
- 보존한 근거: `/tmp/brain-15-2-implementation.md`, `/tmp/brain-15-2-retry.err`, `/tmp/brain-15-2-release1.json`. 체크포인트는 `.bmad-loop/runs/20261030-175233-8a92/tasks/15.2-dev-1/orca-coordination.json`이다.
- 정리: 실패 보고의 Task/Dispatch를 대조하고 전체 보고를 읽은 뒤 해당 Dispatch를 `released`로 정리했으며 Delivery를 ack했다. restore 결과 pending mail과 미확인 요청은 없다. 마지막 Run 워커·mail 확인 후 전용 제어 셸을 닫는다.
- 다음 행동: 제어 도구가 동일 Task의 정식 재시도를 지원하도록 복구한 뒤 이 계획의 1단계부터 재개한다. 별도 워크플로를 재귀 실행하지 않도록 구현 배정에도 명시한다.
- 운영자 수락 작업: 없음. 외부 HUMAN 작업에 의한 차단이 아니다. 티켓 done은 표시하지 않았고 `tickets.py mark`는 build-auto HALT의 blocked 기록에만 사용했다.
- 최종 정리 확인: 해당 Run의 worker-list는 released 1·활성 0·reclaimable 0이며 마지막 check는 pending_delivery null·미확인 요청 없음이다. 미확인 워커·mail 상태는 없다. 정리 체크포인트 저장 후 지휘자 전용 제어 셸만 닫았다.
