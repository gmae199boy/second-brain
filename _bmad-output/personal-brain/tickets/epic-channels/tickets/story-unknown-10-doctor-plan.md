---
title: '불명 발신과 재시도 및 doctor 실패 노출'
type: feature
ticket: 2
created: '2026-10-31'
status: done
baseline_revision: 149039a444fa84c0d4682a6c370bf2b859d29560
route: full
route_source: pinned
risk: high
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 2
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
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
- [x] 1단계: `packages/core/src/channels/`, `packages/core/src/testing/`, `packages/postgres/src/channels.ts`, `packages/postgres/migrations/` 및 관련 시험 — core 채널 계약·send·fake와 PG 채널 저장·새 마이그레이션 및 공유 계약 시험을 수정한다. attempt별 결과·최초 gate 재사용·현재 token·이전 미확정 attempt unknown 복구·sent 재발신 억제·기존 데이터 보존을 검증한다.
- [x] 2단계: `apps/cli/src/adapters/telegram.ts`, `apps/cli/src/workers/channel-send.ts`, `packages/core/src/queue/supervisor.ts` 및 관련 시험 — Telegram adapter·ABI worker·감독자 및 관련 시험을 수정한다. 보수적인 네트워크 구분·HTTP 상태·retry_after·지수 재시도·10회와 첫 영구 실패를 연결한다. 채널 외 종류의 정책은 유지한다.
- [x] 3단계: `apps/cli/test/channels-retry.test.ts`와 fixture·기존 tracer 시험을 보강한다. 행렬 전체를 실제 worker/PG/가짜 서버로 검증하고, 모든 실패·복구에서 실제 테스트 생산자 결과 행과 해시를 전후 비교한다. 시험 이름·명령·실행 결과를 보고서에 남긴다.

**Acceptance Criteria:**
- Given 테스트 생산자와 가짜 서버, When 끊김·연결 거부·429·5xx·깨진 응답을 발생시키고 fake clock을 전진하면, Then 저장 결과의 분류와 재시도 간격·동일 요청·gate 하나·후속 sent를 관찰한다.
- Given 계속 실패하는 발신과 400·설정 누락 발신, When 감독자가 처리하면, Then 각각 10시도와 1시도에서 failures와 doctor 결과에 해당 요청이 보이며 추가 발신이 없다.
- Given 실제 worker와 접수·결과 확정 전 장벽, When worker를 종료하고 다시 띄우면, Then unknown 이력과 같은 요청의 새 시도 성공이 남고 오래된 token은 확정을 못 하며 생산자 결과 행과 해시가 그대로다.


### 리뷰 후 재구현 작업

- [x] `packages/core/src/channels/store.ts`, `packages/core/src/queue/supervisor.ts`, `packages/postgres/src/channels.ts`, `packages/postgres/src/work.ts`와 fake 저장소: channel attempt의 저장 결과를 실행 중 종료·감독자 재시작 모두에서 최우선 근거로 쓴다. 같은 현재 token의 sent는 시도 횟수와 무관하게 HTTP 재발신 없이 succeeded로 수렴한다. 저장된 definite_failed/retryable=false는 crash 뒤에도 첫 영구 실패로 failures를 기록하고 닫는다. 저장된 retry_after와 지수 간격을 보존한다.
- [x] 같은 파일의 정산 경로: 접수 뒤/확정 직전 중단은 다음 gate 유무와 관계없이 unknown 결과와 종료 시각을 확정한다. 열 번째 중단으로 일감이 닫혀도 결과가 NULL로 남지 않는다. 미확인 프로세스를 종료로 추정하지 않으며 현재 token fence·짧은 쓰기 트랜잭션을 유지한다.
- [x] `packages/postgres/migrations/0018_channel_attempt_results.sql`, PG adapter 및 계약 시험: 실제 결과 확정이 INSERT든 UPDATE든 DB 수준에서 현재 token만 허용하고 stale 직접 SQL을 거부한다. 복구가 이전 미확정 행을 unknown으로 바꾸는 연산은 성공 위조·기존 확정 결과 덮어쓰기를 허용하지 않는 좁은 경로로 설계한다. 기존 마이그레이션은 수정하지 않으며 v17 데이터 보존·기존 확정 결과 불변성을 시험한다.
- [x] `apps/cli/test/channels-retry.test.ts`, fixture, core 감독자·PG 계약 시험: 첫 시도와 열 번째 시도 모두에서 sent 저장 후 ABI 출력 전 사망, 영구 실패 저장 후 ABI 출력 전 사망, 미확정 접수 뒤 사망을 검증한다. 실행 중 종료와 감독자 재시작의 복구 양쪽을 덮고, unknown 종료 시각·추가 발신 억제·올바른 failures/doctor·직접 stale UPDATE 거부·생산자 행/해시 보존을 관찰한다.

### 복구 검증 기준

- Given 열 번째 시도에 저장된 sent, When ABI 출력 전 worker 또는 감독자가 종료되고 복구되면, Then 일감은 succeeded이며 failures가 없고 HTTP는 그 성공 이후 추가되지 않는다.
- Given 첫 시도에 저장된 영구 실패, When ABI 출력 전 종료되고 복구되면, Then 첫 영구 실패로 닫히며 새 attempt/HTTP가 없고 failures·doctor에 요청이 보인다.
- Given 열 번째 시도의 원격 접수와 미확정 결과, When worker가 종료되고 정산되면, Then 다음 gate 없이도 unknown·finished_at이 남고 일감은 소진 실패이며 생산자 결과는 같다.
- Given token을 잃은 DB 앱 연결, When 결과 확정을 직접 UPDATE하거나 기존 확정 결과를 덮으려 하면, Then DB가 거부하며 정상 현재 token 확정과 허용된 unknown 복구는 성공한다.


### 현재 실행과 종료·보류의 복구 보강

- [x] `packages/core/src/queue/supervisor.ts`와 `packages/core/test/supervisor-channel.test.ts`: 현재 감독자가 직접 띄운 channel worker의 cleanup이 unknown이면 그 시도를 재검사 대상으로 유지한다. 이후 OS가 종료를 확인하면 같은 감독자에서 안전하게 저장 결과 정산·재시도/소진을 수행한다. 아직 실행 중인 같은 incarnation의 다른 worker는 재조정·종료하지 않으며 활성/보류 token을 구분한다. 기존 시작 시 이전 incarnation 재조정도 유지한다.
- [x] 같은 감독자·store 및 관련 시험: 저장된 결과가 있는 시도는 graceful shutdown 또는 hold와 겹쳐도 sent·영구 실패·retry_after·10회 소진을 우선한다. 최초 발신 전이라 저장할 결과가 없는 시도만 기존의 미실행 반환/횟수 복구 정책을 쓴다. 명시적 사용자 일감 취소는 기존 취소 계약을 유지하되 graceful daemon 종료와 혼동하지 않는다.
- [x] 실제 PG/worker 행렬 또는 감독자+공유 저장 계약 시험에서 첫 영구 실패 저장 후 graceful shutdown, 429 저장 후 shutdown/hold, 열 번째 미확정 접수 후 shutdown/hold를 검증한다. 재기동/보류 해제 후 각각 추가 POST 없음·하한 전 POST 없음·소진 실패를 확인하며 생산자 보존과 doctor를 유지한다.

- Given 같은 감독자가 띄운 worker의 cleanup이 unknown이고 다른 worker도 실행 중, When 이후 OS 조회가 종료를 확인하면, Then 보류 token만 재정산되어 재시도 또는 닫힘으로 수렴하고 다른 worker는 중단/중복 실행되지 않는다.
- Given 저장된 영구 실패·429·열 번째 미확정 결과, When graceful shutdown 또는 hold와 재기동/보류 해제가 겹치면, Then 저장 결과의 영구성·대기 하한·시도 소진을 보존한다.

### 결정적 검증 실패 복구

- [x] 기존 채널 동작과 동결된 의도 계약을 유지하면서 `feedback/15.2-2.md` 및 같은 run의 `verify/verify-15.2-dev-1-1-0.stderr.log`에 기록된 7개 실패를 복구한다. `apps/cli/test/install.test.ts`, `setup.test.ts`, `packages/postgres/test/schema.test.ts`, `store.test.ts`, `work-store.test.ts`의 현재 스키마 기대값과 fixture를 0018 마이그레이션의 실제 계약에 맞춘다. 과거 버전 보존 시험과 버전 불일치 거부 시험은 의미를 보존한다. catalog의 새 기본값은 명시적으로 검증한다. 감독자의 schemaVersions 불일치가 복구 시험 실행을 막는지 확인하고 실제 종료·failure 검증을 유지한다.
- [x] `apps/cli/test/daemon-supervisor.test.ts`의 동시 실행 시험에서 관찰한 core 일감 완료 대기 시간 초과를 조사한다. 동시 실행·완료 순서 assertion을 유지하고 fixture의 실제 경쟁이 있으면 복구한다.
- [x] 해당 시험을 실행한 뒤 지휘자가 계획의 검증 명령과 `bash _bmad/custom/bmad-loop-verify.sh` 전체 검증을 수행한다. 실패를 숨기거나 assertion을 완화하지 않고 실제 계약에 맞춰 복구한다.

## Implementation Notes

- 이번 재시도: 보존 브랜치의 변경은 이전 검증 기록뿐임을 직접 확인했고 복사하지 않았다. 현재 baseline의 기존 구현을 세 단계로 명세와 대조했다. 구현 워커의 새 시험은 1단계 31개, 2단계 210개, 3단계 39개 파일 869개가 통과했으며 소스·시험 변경은 없다. 전체 보고는 `/tmp/brain152-g2-implementation.md`다. 이번 지휘자의 검증·리뷰가 최종 근거이며 이전 결과를 대신 쓰지 않는다.

- 결정적 검증 복구: 설치·설정·PG 최고 스키마 버전 시험과 감독자 fixture를 core 18로 맞추고 새 outcome 기본값을 catalog의 전체 목록에 추가했다. 이전 마이그레이션과 발신 구현은 보존했다. 관련 266개 시험 및 마이그레이션·스키마 24개 시험이 통과했고, 지휘자의 전체 검증은 152개 파일 3767개 통과·1개 skipped다. 계획의 병렬 행렬 재검증도 19개 파일 392개가 통과했다.


- 최종 보강: 현재 감독자가 unknown으로 보류한 channel token만 반복 검사하고, 다른 활성 worker는 보존한다. 저장 결과가 있으면 정상 종료·hold에도 영구성·대기 하한·소진을 우선하며 명시적 사용자 취소는 유지한다. 실제 worker·PG 종료/재기동·hold 해제 행렬과 단위 시험을 추가했다. 지휘자가 최종 diff와 `pnpm build`, `pnpm typecheck`, 계획의 전체 Vitest 명령을 직접 확인했으며 19개 파일·392개 시험이 모두 통과했다. 최종 로그는 `/tmp/brain-15-2-g1-tests3.log`다.

- 리뷰 후 재구현 완료: `recoverChannelAttempt`와 감독자의 공통 정산이 저장된 sent·영구 실패·일시 실패를 우선하며 현재 시도의 미확정 결과는 다음 gate 없이 unknown으로 확정한다. UPDATE trigger가 현재 token·미확정 행만 허용하고 확정 결과는 불변이다. 미확인 프로세스 token은 보존·재검사하고 종료 확인 뒤 같은 트랜잭션에서 복구한다. 지휘자의 `pnpm build`, `pnpm typecheck`, 계획의 전체 Vitest 명령은 19개 파일·382개 시험 모두 통과했다. 최초 368개 결과는 재구현 전 기록이며 최종 근거는 `/tmp/brain-15-2-g1-tests2.log`다.

- 세 단계 구현을 완료했고 지휘자가 전체 diff를 읽고 `pnpm build`, `pnpm typecheck` 및 계획의 전체 Vitest 명령을 직접 실행했다. 최초에는 tracer의 순간 트랜잭션 관찰 경쟁으로 367개 통과·1개 실패였으며, HTTP 응답을 보류한 채 오래 열린 트랜잭션 부재와 즉시 잠금 가능 검사를 유지하도록 수정했다. 재검증은 18개 파일·368개 시험 모두 통과했다. adapter 오류 분류·저장한 retry_after·채널 지수 정책·doctor 요청 ID를 연결했고 ABI v1을 유지했다.

- 새 generation에서 같은 checkout의 Orca 구현 Dispatch로 1단계를 구현했다. 공유 계약·core send·PG 저장·v18 마이그레이션과 데이터 보존 시험을 확인했다. 구현자 검증은 `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run --project core --project postgres channel-store channel-send migrate`이며 5개 파일의 27개 시험이 통과했다. 전체 검증은 모든 단계 완료 뒤 지휘자가 수행한다.

- 첫 구현 Dispatch는 계획·AGENTS.md를 읽은 뒤 별도 bmad-build 렌더링을 시도했으며 PyPI jinja2 다운로드 DNS 실패로 정식 failed를 보고했다. 소스·시험 수정은 없고 구현 단계 전체가 남았다. 보고 전문은 `/tmp/brain-15-2-implementation.md`다.
- 정식 실패를 수락하고 `ctx_866d5928d059`를 release했다. Orca의 정식 재시도는 같은 Task에 `--task`·`--retry-of`가 필요하지만 현재 제어 도구의 start는 `--spec`만 허용한다. 기존 요청을 새 역할·Run·워커로 우회하지 않는다.

## Plan Change Log

- 2026-10-31 감독자 복구 추천: 982c2cb 이후에는 이 계획만 변경되어 엔진이 제품 변경을 감지하지 못한다. b665e91·b1068e3 구현과 d1feae9 검증은 보존한다. 별도 구현 워커가 현재 HEAD 보존 ref, 두 구현 커밋의 소유 경로 patch 및 역적용 가능성을 확인하고 가역적인 준비 커밋을 만든 후 지원되는 `resolve --restore-patch`로 복원·리뷰·전체 검증을 엔진에 맡긴다. 적용 전후 제품 tree 동등성, 선행 작업 보존, 보안 fence·데이터 보존 계약과 기존 시험을 확인한다. 충돌이나 소유권 불명이 있으면 변경하지 않고 진단한다. 가짜 변경·수동 done·검증 생략은 금지한다.

- 2026-10-31 감독자 검증 복구: 엔진 전체 검증에서 별도 sessions-ingest 정리 훅이 60초 초과했으나 기존 자체 전체 검증과 현재 HEAD 재검증(152개 파일, 3767 통과, 1 skipped)이 통과했다. Docker 정상·디스크 여유를 확인했으나 지연 원인은 미확정이다. 구현과 검증 계약을 유지해 새 generation에서 결과와 기존 커밋을 확인하고 엔진 전체 검증을 다시 수행한다. 재발하면 정리 훅 및 리소스 경합을 조사해 단계적으로 복구한다.

- 2026-10-31 Quick 2차의 같은 incarnation unknown 재검사 누락과 deferred의 저장 실패 계약 우회 2건을 high/bad_plan으로 확인했다. KEEP: 382개 통과 구현의 저장 결과 우선 정산, 직접 SQL UPDATE fence·확정 결과 불변, v17 보존, 실제 첫·열 번째 worker 종료와 새 감독자 기동의 생산자 보존 행렬, Telegram·doctor·ABI v1·채널 외 정책을 모두 보존한다. 계획 파일을 제외한 코드를 baseline으로 되돌린 뒤 보존 diff로 검증된 부분을 복원하고 아래 현재 실행 추적·종료/hold 계약으로 다시 도출한다.

- 2026-10-31 Quick 리뷰 1차에서 결과 정산 3건과 UPDATE fence 1건을 확인했다. 의도 계약은 유지하고 아래 복구 설계·시험을 실행 항목에 추가했다. KEEP: 기존 v17 데이터 보존 마이그레이션 시험, adapter 보수적 분류와 마스킹·크기 제한·429 하한, 최초 gate 하나와 같은 요청의 새 token, 채널 외 정책·ABI v1, 실제 생산자 행·해시 비교, 세 실제 프로세스 종료 장벽, tracer의 즉시 잠금 가능·장기 트랜잭션 부재 검사를 보존한다. 기존 코드 변경은 계획 파일을 제외하고 baseline으로 되돌린 뒤 같은 구현 Dispatch에서 재구현한다. 검증된 코드를 보존할 때에도 정산 설계를 새 계획에 맞춰 다시 도출한다.

- 2026-10-31 감독자 추천: 최초 실패 보고·release·ack와 활성 워커 0을 확인했고 현재 PyPI DNS 조회가 성공한다. 기존 generation을 억지 재시도하지 않고 엔진 resolve로 새 generation을 시작한다. 지휘자는 새 배정 전 기존 정리 기록과 Orca 소유권을 확인하고 회로 차단기나 모호한 요청을 우회하지 않는다. 구현 워커에게 별도 bmad-build 재귀 실행 없이 이 계획의 1단계부터 phase-ready·검증·checkpoint 순으로 수행하도록 명시한다. 정식 재시도 제한이 새 generation에도 적용되면 지휘자가 지원 경로를 조사하고 제어 도구 복구를 별도 구현 과업으로 분할한다. 기존 보안·데이터·시험 계약은 유지한다.


## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 4 findings — high 3, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 마지막 시도의 sent를 실패로 닫음 — 실행 종료 경로가 저장한 sent를 읽지 않고 시도 소진 failure를 전달하며 PG가 실패로 닫는다. 실행·재시작 양쪽의 저장 결과 우선 정산과 열 번째 sent crash 시험을 계획에 보강했다.
  - `[high]` `[bad_plan]` 저장한 영구 실패 뒤 crash가 재발신을 허용함 — ABI 출력 전 사망은 retryable=true로 취급하고 재시작도 retryable=false를 읽지 않는다. 영구 실패를 첫 시도에서 닫는 저장 결과 기반 복구를 보강했다.
  - `[medium]` `[bad_plan]` 마지막 중단 결과가 NULL로 잔존함 — 다음 gate에서만 unknown을 기록하므로 열 번째 종료에는 실행되지 않는다. 최종 정산 전 미확정 결과를 unknown으로 확정하는 계약과 시험을 보강했다.
  - `[high]` `[bad_plan]` UPDATE DB fence 누락 — 새 UPDATE 권한과 INSERT 전용 trigger의 조합은 직접 stale UPDATE를 허용한다. 실제 확정 연산의 DB fence와 직접 SQL 회귀를 보강했다.


### 2026-10-31 — Review pass 2
- verdicts: 2 findings — high 2, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 실행 중 unknown의 같은 감독자 재검사 누락 — cleanup unknown 정산 뒤 실행 추적이 제거되고 reconciled가 true로 남으며 own incarnation은 skip된다. 이전 incarnation 시험만으로는 이를 증명하지 못하므로 현재 실행의 보류 시도 추적·재검사와 실시간 동시 실행 보호 시험을 보강했다.
  - `[high]` `[bad_plan]` 종료·보류가 저장 실패 계약을 무시함 — deferred 조기 반환이 영구 실패·retry_after·10회 소진보다 앞서며 cancelled 정산은 횟수를 줄이고 지난 재시도 시각을 유지한다. 저장한 결과가 있으면 종료·hold에도 영구성·하한·소진을 보존하고 명시적 사용자 취소는 기존 정책으로 처리하도록 보강했다.

### 2026-10-31 — Review pass 3
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. Quick 정식 보고는 최종 diff를 주변 코드와 대조했고 확정 결함을 발견하지 못했다.

### 2026-10-31 — 결정적 검증 복구 Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. 독립 Quick 리뷰의 정식 성공 보고와 전문을 확인했다. patch·defer·reject는 각각 0개이며 후속 리뷰 추천은 false다. 보고서는 `/tmp/brain-15-2-repair-review.md`다.

### 2026-10-31 — 이번 재시도 Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. 독립 Quick 리뷰의 정식 succeeded 보고와 전문을 확인했다. 계획 diff의 검증 기록은 새 로그와 시험·fixture 원본에 일치한다. patch·defer·reject는 각각 0개이며 followup_review_recommended는 false다. 보고서는 `/tmp/brain152-g2-review.md`다.

### 2026-10-31 — 복원 변경 Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. 복원된 제품 diff 전체와 수정된 계획을 독립 Quick 리뷰 및 지휘자의 코드 대조로 확인했다. 정식 succeeded 보고와 전문은 `/tmp/brain152-g3-review.md`다. patch·defer·reject는 각각 0개이며 후속 리뷰 추천은 false다.

## Design Notes

- 저장된 gate는 전송 성공의 증거가 아니다. 접수 여부를 알 수 없으면 중복 가능성을 수용하고 재시도한다. sent가 저장됐으면 감독자 crash 뒤에도 HTTP를 반복하지 않는다.
- 작은 명세 공백은 보수적인 해석을 코드와 계획에 [ASSUMPTION]으로 남기고 deferred에 추가한다. 비밀·마이그레이션 안전성·기존 결정 충돌은 추정하지 않는다.

## Verification

**Commands:**
- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 전체 타입 검사 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channel-send channels-tracer channels-retry telegram supervisor process-abi migrate doctor` — 행렬·공유 계약·실제 worker 복구·doctor 및 관련 회귀가 모두 통과한다.

**사전 조건과 정리:** 저장소 Node·pnpm engines와 Docker/OrbStack을 사용한다. Vitest global setup의 시험 전용 PG와 격리 DB·홈을 사용한다. fixture의 finally에서 worker·데몬 종료 대기, 소켓 종료, store close·DB drop·임시 홈 삭제를 수행한다. fake clock은 대기만 앞당기고 관찰을 대신하지 않는다. 별도 운영자 작업은 없다.


## Matrix Test Audit

- `apps/cli/test/channels-retry.test.ts`의 `disconnect 이후 같은 요청을 새 시도로 재발신한다`는 접수 뒤 끊김과 unknown→sent를 검증했다.
- `연결 전 거부를 기록하고 같은 요청을 재발신한다`는 network_before_send와 같은 요청 재시도를 검증했다.
- `broken 이후 같은 요청을 새 시도로 재발신한다`, `bad-ok 이후 같은 요청을 새 시도로 재발신한다`는 깨진 응답·2xx ok=false의 unknown을 검증했다.
- `429 이후 같은 요청을 새 시도로 재발신한다`, `500 이후 같은 요청을 새 시도로 재발신한다`, `일시 실패 열 번은 failures와 doctor에 요청을 남긴다`는 7초 하한·지수 간격·10시도 소진·추가 발신 억제를 검증했다.
- `400/config/too_large 영구 실패는 한 번으로 닫히고 doctor에 요청이 보인다`는 첫 실패와 요청 ID 노출을 검증했다.
- `receipt/before-finish 경계에서 실제 worker 종료 후 안전하게 수렴한다`는 SIGKILL 후 unknown→sent·gate 하나·오래된 token 거부를 검증했다.
- `after-finish 경계에서 실제 worker 종료 후 안전하게 수렴한다`는 sent 저장 뒤 일감 확정 전 종료에도 HTTP 한 번과 성공 수렴을 검증했다.
- 모든 위 행렬 시험은 실제 생산자 메시지 행과 SHA-256 해시를 전후 비교하며, 지휘자 verbose 검증 출력에서 각 시험의 실행·통과를 확인했다. 로그는 `/tmp/brain-15-2-g1-tests.log`다.

### 재구현 후 행렬 감사

- 기존 8개 행렬을 모두 유지했으며 지휘자의 verbose 로그에서 실행·통과를 확인했다.
- `실행 중 1/10번째 시도에서 저장 결과를 우선한다`, `감독자 재시작이 1/10번째 실제 worker의 저장 결과를 우선한다`는 각 저장 성공·영구 실패·미확정 접수의 세 경우를 실행해 결과 종료 시각·HTTP 억제·failure/doctor·생산자 행/해시를 검증했다.
- `packages/core/test/supervisor-channel.test.ts`는 실행·재시작 양쪽 정산과 미확인→종료 확인을 검증한다. 공유 fake/PG 저장 계약은 보류 상태의 worker fence를 유지한다.
- `packages/postgres/test/channel-store.test.ts`의 직접 SQL 시험은 앱 role의 stale UPDATE와 확정 결과 덮어쓰기를 거부하고 종료 확인 후 unknown 확정을 검증했다.
- 재시작 통합 시험은 실제 worker를 청구·기록하고 종료한 뒤 새 감독자를 시작한다. 이전 데몬 프로세스 자체를 죽이는 시험은 아니며, core 감독자 복구 시험과 함께 재조정 경로를 증명한다.

### 최종 보강 행렬 감사

- `현재 감독자의 미확인 worker만 재검사하고 다른 실행은 유지한다`가 own incarnation unknown 복구와 다른 실행의 생존·무신호를 검증했다.
- `shutdown/hold 중 저장 실패의 영구성·대기·소진을 보존한다`와 `명시적 일감 취소는 저장된 실패가 있어도 취소로 닫힌다`가 감독자의 종료·hold·명시적 취소 분기를 검증했다.
- 실제 worker·PG의 `정상 종료·재기동은 permanent/rate_limit/tenth_unknown의 저장 계약을 보존한다`, `보류와 해제는 permanent/rate_limit/tenth_unknown의 저장 계약을 보존한다` 6개 사례가 결과·종료 시각·attempts·POST 횟수·하한·failures/doctor·생산자 행과 해시를 검증했다.
- 기존 8개 행렬과 첫·열 번째 결과 복구 및 DB fence 시험도 유지하며 최종 verbose 출력에서 모든 실행·통과를 확인했다.


### 결정적 검증 복구 행렬 감사

- 지휘자의 전체 검증은 152개 파일에서 3767개 통과·1개 skipped이며 build와 typecheck도 통과했다. 로그는 `/tmp/brain-15-2-repair-full-verification.log`다.
- 계획의 별도 verbose 행렬은 최초 동시 실행 시험 1건 시간 초과 뒤 단독 재실행과 원래 병렬 재실행에서 모두 통과했다. 최종 19개 파일·392개 시험에서 모든 채널 행렬·실제 worker 종료·종료/보류 복구·DB fence·v17 보존의 개별 실행과 통과를 확인했다. 로그는 `/tmp/brain-15-2-repair-matrix2.log`다. 해당 동시 실행 시험은 변경하지 않았고 간헐적 시간 초과 관찰을 보존한다.

### 이번 재시도의 행렬 감사

- 지휘자의 `bash _bmad/custom/bmad-loop-verify.sh`는 build·typecheck와 152개 파일 3767개 시험 통과·1개 skipped로 성공했다. 로그는 `/tmp/brain152-g2-full.log`다. 이번 실행에는 실패나 재실행이 없었다.
- 지휘자의 계획 Vitest 명령에 `--reporter verbose`를 붙인 검증은 19개 파일 392개 시험이 모두 통과했다. 로그는 `/tmp/brain152-g2-matrix.log`다. 8개 행렬의 각 시험과 첫·열 번째 저장 결과 복구, 현재 감독자의 미확인 worker 재검사, 정상 종료·보류 각 3개 사례, 직접 SQL fence와 v17 보존의 개별 실행·통과를 원본 출력에서 확인했다.
- `channels-retry.test.ts`와 `channel-fixture.ts` 원본에서 모든 실패·복구 행렬이 실제 생산자 행과 SHA-256 해시를 전후 비교하는 것을 확인했다. 재시작 사례는 실제 worker를 종료한 뒤 새 감독자를 시작하며 이전 데몬 자체의 강제 종료 시험은 아니다.

### 복원 변경 검증 행렬 감사

- 이번 실행의 `bash _bmad/custom/bmad-loop-verify.sh`가 build·typecheck 및 152개 파일 3767개 시험 통과·1개 skipped로 성공했다. 로그는 `/tmp/brain152-g3-full.log`이며 재실행 없이 통과했다.
- 계획의 Vitest 명령에 `--reporter verbose`를 붙인 검증은 19개 파일 392개 시험이 모두 통과했다. 로그는 `/tmp/brain152-g3-matrix.log`다.
- 원본 출력에서 끊김·연결 거부·깨진 응답·2xx ok=false·429 하한·5xx·10회 소진·첫 영구 실패·세 crash 장벽·첫/열 번째 저장 결과 우선 복구·종료/보류의 각 세 사례·미확인 worker 재검사·직접 SQL fence·v17 보존의 개별 실행과 통과를 확인했다. 실제 생산자 행과 SHA-256 해시 전후 비교를 유지한다.
- 감독자 재시작 사례는 실제 worker 종료 후 새 감독자를 시작하는 시험이며, 이전 데몬 프로세스 자체의 강제 종료를 주장하지 않는다.

## Auto Run Result

- Status: built
- 수정된 계획에 따라 복원 변경의 리뷰·검증을 완료했다. 같은 요청·최초 gate를 보존하는 attempt별 결과, 보수적 발신 오류 분류, 지수 재시도·429 하한·실패 소진, 저장 결과 우선 복구와 doctor 요청 노출을 확인했다.
- 독립 Quick 리뷰: 결함 0건. 적용 patch 0건(high 0, medium 0, low 0), defer 0건, reject 0건. `followup_review_recommended: false`.
- 검증: 전체 build·typecheck·시험 성공(152개 파일, 3767 passed, 1 skipped), 계획의 verbose 행렬 성공(19개 파일, 392 passed). 이번 검증에는 실패·재실행이 없다.
- 잔여 위험: unknown 재시도는 결정된 중복 발신 가능성을 유지한다. 실계정 발신·배포는 후속 티켓 범위이며 이번 수락 조건의 운영자 작업은 없다.
- 티켓 done 표시와 `tickets.py mark`는 실행하지 않았다. 최종 티켓 완료 판정은 오케스트레이터의 별도 검증에 맡긴다.
- Orca 정리: `run_470e73d0f2f0`의 리뷰 `task_fdb96c936d60` / `ctx_3e7376f253be` 정식 succeeded 보고를 수락하고 release했다. 완료 mail을 ack했으며 pending delivery는 없다. 정리 영수증과 검증은 현재 generation의 `orca-coordination.json`에 checkpoint로 남긴다.

### 변경 파일

- `apps/cli/src/adapters/telegram.ts` — 발신 오류 분류·429 하한·크기 제한을 반환한다.
- `apps/cli/src/daemon/supervisor.ts` — 시험용 확정 장벽을 worker에 전달한다.
- `apps/cli/src/doctor/store.ts` — 실패 저장소에 새 복구 포트를 제공한다.
- `apps/cli/src/workers/channel-send.ts` — 설정 실패를 저장하고 재시도 결과·시험 장벽을 연결한다.
- `apps/cli/test/channel-fixture.ts` — 실제 생산자 보존·가짜 서버·clock·재기동 fixture를 확장한다.
- `apps/cli/test/channels-tracer.test.ts` — 새 결과 저장 계약과 HTTP 대기 중 잠금 검증을 유지한다.
- `apps/cli/test/channels-retry.test.ts` — 전체 실패·재시도·실제 worker 복구 행렬을 검증한다.
- `apps/cli/test/dispatch.test.ts` — 새 저장소 포트를 시험 대역에 추가한다.
- `apps/cli/test/install.test.ts` — 설치의 core 18 계약을 검증한다.
- `apps/cli/test/setup.test.ts` — 설정의 core 18 계약을 검증한다.
- `apps/cli/test/telegram.test.ts` — 네트워크·HTTP 분류와 크기 제한을 검증한다.
- `packages/core/src/channels/send.ts` — gate 뒤 attempt 결과를 저장하고 확인된 성공의 재발신을 억제한다.
- `packages/core/src/channels/store.ts` — attempt 결과와 복구 포트를 정의한다.
- `packages/core/src/doctor/doctor.ts` — 실패한 채널 요청 ID를 노출한다.
- `packages/core/src/ports/store.ts` — 종료 확인 뒤 정산 입력을 확장한다.
- `packages/core/src/queue/supervisor.ts` — 저장 결과 우선 정산·지수 간격·보류 재검사를 연결한다.
- `packages/core/src/testing/contracts/channel-store.ts` — fake·PG 공통 결과·복구·fence 계약을 검증한다.
- `packages/core/src/testing/fakes/store.ts` — attempt별 결과와 종료 확인 후 정산을 구현한다.
- `packages/core/test/channel-send.test.ts` — 저장 성공 뒤 HTTP 억제를 검증한다.
- `packages/core/test/supervisor-channel.test.ts` — 실행·재시작·미확인·종료·보류 정산을 검증한다.
- `packages/postgres/src/channels.ts` — 현재 token의 결과 저장과 미확정 복구를 구현한다.
- `packages/postgres/src/migrate.ts` — 최고 core 스키마를 18로 올린다.
- `packages/postgres/src/work.ts` — 종료 미확인 token을 보존하고 확인 뒤 원자 정산한다.
- `packages/postgres/migrations/0018_channel_attempt_results.sql` — 기존 데이터를 보존하며 attempt 결과와 UPDATE fence를 추가한다.
- `packages/postgres/test/channel-store.test.ts` — 결과 이력·직접 SQL fence·종료 확인 복구를 검증한다.
- `packages/postgres/test/migrate.test.ts` — core 18 마이그레이션과 v17 데이터 보존을 검증한다.
- `packages/postgres/test/schema.test.ts` — 새 기본값을 catalog 계약에 추가한다.
- `packages/postgres/test/store.test.ts` — 최고 스키마 버전 계약을 갱신한다.
- `packages/postgres/test/unavailable.test.ts` — 새 포트의 DB 불가 계약을 검증한다.
- `packages/postgres/test/work-store.test.ts` — 기존 감독자 복구 fixture를 core 18로 맞춘다.
- `_bmad-output/personal-brain/tickets/epic-channels/tickets/story-unknown-10-doctor-plan.md` — 복원 변경의 검증·리뷰·정리 결과와 built 상태를 기록한다.
