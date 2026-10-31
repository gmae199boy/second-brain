---
title: 'legacy 이력과 확장 INSERT 경계'
type: feature
ticket: 3
created: '2026-10-31'
status: done
baseline_revision: 5ff04c455d93c3280a588c237f67e4e2d7b98e4e
route: full
route_source: pinned
risk: high
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 옛 Garmin 알림·전송 이력을 받을 core 계약과 확장의 채널 INSERT 권한이 없다. 이전 이력을 보존하면서 재발신을 막고 확장이 자기 출처만 쓰도록 해야 한다.

**Approach:** notification과 delivery를 별도 legacy 표로 받고 같은 conversation에 연결한다. 요청·legacy 공개 계약에 role 결합 RLS와 현재 attempt 검사를 붙이고 실제 프로세스 종료로 내구성 인계를 검증한다. 보안·저장 경계이므로 고정 full 경로를 사용한다.

## Boundaries & Constraints

**Always:** notification의 local_date/event/detail/at와 delivery의 원래 id/local_date/kind/event/ok/reason/at를 보존한다. dataset·원래 표·원래 키·import batch·작성 출처를 남긴다. 원본에 없는 외부 message id·본문은 null과 누락 표시로 표현한다. 같은 dataset·원래 표·원래 키의 같은 원문은 멱등이고 다른 원문은 명시적 충돌이다. 다른 dataset의 같은 키는 독립 행이다. import batch가 달라도 같은 원문은 중복되지 않는다. legacy는 인계 표와 구조적으로 분리되고 resend 부적격 표식을 갖는다. 새 요청과 legacy는 같은 봇·채팅 conversation을 참조한다. 확장은 자기 출처 INSERT만 가능하고 UPDATE·DELETE·다른 core 권한은 없다. 직접 SQL에도 현재 attempt 검사가 적용된다. core 요청의 기존 호출·저장 결과 복구·단일 gate·기존 데이터와 마이그레이션 checksum을 보존한다.

**Never:** legacy를 발신 요청으로 변환하거나 channel_send를 만들지 않는다. 누락 metadata를 추정하지 않는다. CLI resend 거부 완성은 15.5 범위다. epic 14의 실제 import, bundle, 실계정 발신·설치·배포는 범위 밖이다. push·티켓 done·tickets.py mark·구현자 커밋은 금지한다. 계획 상태와 최종 완료 판정은 지휘자·오케스트레이터 소관이다.

## I/O & Edge-Case Matrix

| 시나리오 | 입력·상태 | 관찰 결과 | 실패 처리 |
|---|---|---|---|
| legacy 재입력 | 같은 합성 notification/delivery batch 두 번 | 표별 한 행, 출처·원래 값·누락 표시·resend 부적격 보존, 가짜 서버 POST와 channel_send 0 | 다른 원문은 충돌 |
| dataset 분리 | 다른 dataset의 같은 원래 키 | 두 행 유지 | 같은 dataset 충돌을 조용히 버리지 않음 |
| 확장 쓰기 | brain_ext_testext와 현재 token | 자기 출처 요청·legacy INSERT 성공 | 다른 출처·UPDATE·DELETE 거부 |
| 회수 token | 확정·회수된 attempt로 직접 INSERT | 요청·legacy 모두 BRS01 거부 | 행 생성 없음 |
| INSERT 뒤 crash | 요청 commit 직후 실제 자식 종료·재기동 | 같은 요청이 한 번 인계 | 의미 키·요청 ID 유지 |
| 인계 중 crash | 일감 INSERT와 인계 표식 사이 실제 자식 종료 | 미완료 트랜잭션 rollback 뒤 같은 요청·일감 하나로 수렴 | 부분 인계 없음 |
| 대화 연속성 | legacy와 새 요청 | 같은 conversation id로 재조회 | 외부 id·본문 발명 없음 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0017_channels.sql`, `0018_channel_attempt_results.sql` — 기존 표·결과 fence. 변경하지 않고 다음 번호 `0019_*.sql`로 확장한다. `src/migrate.ts`의 현재 최고 버전은 18이다.
- `packages/postgres/src/channels.ts` — 요청 생성·조회, 미인계 발견, `withWrite` 안의 `ensureWork`와 인계 UPDATE를 재사용한다. legacy는 별도 표이므로 발견 쿼리에 포함하지 않는다.
- `packages/postgres/src/extension-provision.ts`, `migrations/0015_extension_status_public.sql` — 역할 검증·최소 grant·기존 역할 migration 관례다. 허용 INSERT를 정확히 whitelist하고 다른 권한 검사를 약화하지 않는다. 새 역할과 이미 설치된 역할 모두 권한을 받는다.
- `packages/postgres/migrations/0004_attempt_fence.sql` — `attempt_is_current`와 `reject_stale_attempt`를 재사용한다. 확장의 요청 INSERT는 producer와 role을 결합하고 서버 관리 칸 위조를 막는다. 기존 core 요청에는 호환 가능한 token 규칙을 적용하되 확장의 null token 우회를 허용하지 않는다.
- `packages/core/src/channels/store.ts`, `packages/core/src/testing/fakes/store.ts`, `testing/contracts/channel-store.ts` — 필요 시 legacy 입력·조회 capability와 fake·공유 계약을 함께 확장한다. `packages/postgres/src/store.ts`가 PG capability를 조립한다.
- `packages/postgres/test/extension-permissions.test.ts`, `attempt-fence.test.ts`, `channel-store.test.ts`, `migrate.test.ts` — 실제 연결·역할 정리·격리 DB·기존 데이터 보존 시험 관례다.
- `apps/cli/test/channel-fixture.ts`, `channels-tracer.test.ts`, `channels-retry.test.ts` — 실제 PG·데몬·Node worker와 가짜 HTTP 서버를 재사용한다. 실제 자식 종료 장벽은 시험 fixture로 두고 운영 설정·HTTP endpoint를 열지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] 1단계: `packages/postgres/migrations/0019_*.sql`, `src/channels.ts`, `src/extension-provision.ts`, `src/migrate.ts`, 필요한 core 채널 계약·fake·공유 시험 및 PG 시험 — legacy 입력·조회·충돌·비인계 표식, role/source RLS·INSERT 열 제한·attempt trigger, 기존/새 확장 role grant, v18 데이터 보존을 구현하고 표적 시험한다. 기존 최고 버전 고정 시험은 새 실제 계약에 맞춘다.
- [x] 2단계: `apps/cli/test/channels-legacy.test.ts`, `channel-fixture.ts`와 필요한 시험 전용 자식 fixture, PG 인계 시험 — 합성 batch 중복·dataset 충돌·무발신·conversation 연속성과 두 실제 프로세스 종료 경계의 수렴을 증명한다. 장벽으로 트랜잭션 중간을 관찰하고 실제 프로세스 종료·연결 종료·rollback을 기다린다.

**Acceptance Criteria:**
- Given 격리 PG와 brain_ext_testext, When 현재·회수 token과 자기·타 출처로 요청 및 두 legacy 표에 직접 INSERT하고 UPDATE·DELETE를 시도하면, Then 자기 현재 INSERT만 성공하고 나머지는 권한 또는 BRS01로 거부된다.
- Given 합성 Garmin notification/delivery와 가짜 Telegram 서버, When 같은 batch를 두 번 넣고 core 인계를 실행하면, Then 원래 값·출처·누락·resend 부적격을 재조회하고 표별 한 행·POST 0·channel_send 0을 관찰한다.
- Given 두 dataset과 같은 원래 키, When 각각 넣고 같은 dataset의 변경 원문도 넣으면, Then 두 dataset은 유지되고 변경 원문은 명시적 충돌로 드러난다.
- Given 동일 conversation에 연결한 legacy와 새 요청, When 요청 INSERT 직후와 인계 트랜잭션 중간에 각각 실제 프로세스를 종료하고 재시작하면, Then 각 요청은 일감 하나·인계 표식으로 수렴하고 legacy와 요청을 같은 conversation id로 읽는다.

## Implementation Notes

- 1단계 저장·권한 구현을 대조했다. 구현자의 build·typecheck와 표적 49개 및 후속 21개 시험 통과 보고를 확인했다. delivery.event의 NULL 보존을 반영했다. 전체 검증과 실제 프로세스 종료 행렬은 다음 단계에서 수행한다.

- 2단계와 실제 testext 세 표의 권한 행렬을 완료했다. 지휘자가 전체 unified diff를 읽고 `pnpm build`, `pnpm typecheck`, 계획의 verbose 행렬(24개 파일·276개 통과), 전체 필수 검증(153개 파일·3772개 통과·기존 1개 skipped)을 직접 통과했다. 로그는 `/tmp/brain153-parent-build.log`, `/tmp/brain153-parent-typecheck.log`, `/tmp/brain153-parent-matrix.log`, `/tmp/brain153-parent-full.log`다.
- 구현자 첫 전체 실행의 시간 초과는 새 시험 잠금 15319001의 유휴 연결이 후속 시험을 막은 문제였다. 이를 제거하고 upgrade 시험은 고유 role, 실제 testext 검증은 기존 설치 fixture로 옮겼다. 최종 구현자·지휘자 전체 검증은 통과했다.

## Plan Change Log

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. 독립 Quick의 정식 succeeded 보고와 전문 `/tmp/brain153-quick-review.md`를 확인했다. patch·defer·reject는 각각 0개이며 후속 리뷰 추천은 false다.

### 2026-10-31 — 복구 재검증 Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. 독립 Quick의 정식 succeeded와 전문 `/tmp/brain153-dev2-quick-review.md`를 수락했다. patch·defer·reject 각각 0개, 후속 리뷰 추천 false다.

## Design Notes

- 출처의 신원은 사용자 설정 GUC가 아니라 실제 role에 결합한다. 요청의 work_item_id/status/external_message_id를 확장이 위조하지 못하게 한다. legacy 원문 비교는 import batch 등 실행 metadata와 분리한다.
- 작은 비보안 명세 공백만 보수적으로 정하고 코드·계획에 [ASSUMPTION]과 deferred를 남긴다. 보안·마이그레이션 안전성·기존 결정 충돌은 추정하지 않는다.

## Verification

- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 전체 타입 검사 성공.
- `pnpm exec vitest run --project core --project postgres --project cli channel-store channels-legacy channels-tracer extension-permissions attempt-fence migrate schema install setup --reporter verbose` — 행렬 각 시험과 기존 권한·마이그레이션·발신 회귀 통과.
- `bash _bmad/custom/bmad-loop-verify.sh` — 저장소 전체 필수 검증 통과.

시험은 Docker/OrbStack의 전용 PG·격리 DB/홈과 가짜 서버만 사용한다. 자식·데몬·소켓·DB 연결 종료를 기다리고 DB·role·임시 파일을 정리한다. 운영자 작업은 없다.

## Matrix Test Audit

- `channel-store.test.ts`의 `legacy 원문 중복과 충돌, dataset 분리`가 fake·PG 양쪽에서 통과했다. notification 원문·batch 재입력·변경 원문 충돌·dataset 분리와 delivery NULL·누락·resend 부적격·인계 제외를 확인했다.
- `channels-legacy.test.ts`의 `legacy 중복과 충돌을 보존하고 두 실제 종료 경계 뒤 같은 대화의 요청을 인계한다`가 실행·통과했다. 두 표 원문 재조회·중복·dataset 분리·충돌·POST 0·channel_send 0을 확인하고, 실제 자식 SIGKILL 후 PG 연결 소멸·미완료 인계 rollback·재기동 뒤 일감 하나·같은 conversation 재조회를 관찰했다.
- `ext-install.test.ts`의 `installs testext through the real CLI, records its owner migration and reads registry facts on repeat`가 실행·통과했다. 실제 `brain_ext_testext`가 세 표에 자기 현재 INSERT만 수행하고 타 출처·UPDATE·DELETE·null/회수 token·요청 관리 열 위조를 거부하며 최종 표별 행 수가 하나다.
- `extension-permissions.test.ts`의 실제 role 계약과 v18 역할 이전, `migrate.test.ts`의 v18 보존 시험도 실행·통과했다. 모든 행렬 행에 실행된 통과 시험을 대조했다.


## 검증 실패 복구 — 2026-10-31

- 오케스트레이터 피드백 `.bmad-loop/runs/20261030-175233-8a92/feedback/15.3-1.md`에서 전체 검증은 `apps/cli/test/daemon-status.test.ts`의 heartbeat age 89000 사례만 30000ms 시간 초과로 실패했다. 기존 15.3 구현과 동결 계약을 유지한다.
- 복구 1단계: 해당 시험과 설치·명령 fixture의 대기 및 자원 정리를 조사하고, 시간 초과 원인을 증거로 좁혀 필요한 최소 수정을 한다. 단순한 검증 생략이나 기대값 약화는 하지 않는다. 표적 시험을 실행하고 변경·원인·검증을 한국어 보고 파일로 남긴다.
- 복구 2단계: 지휘자가 diff와 표적 근거를 확인한 뒤 계획의 build·typecheck·행렬·전체 필수 검증과 독립 Quick 리뷰를 수행한다. 모든 검증이 끝날 때까지 같은 구현 Dispatch를 유지한다.

- 복구 전체 재현: `bash _bmad/custom/bmad-loop-verify.sh`는 build·typecheck를 통과했지만 `apps/cli/test/dispatch.test.ts:648`의 `still prints its result when it succeeds`가 30000ms 시간 초과로 실패했다(152개 파일·3771개 시험 통과, 1개 실패·1개 skipped). 로그 `/tmp/brain153-dev2-full-initial.log`. daemon 상태의 표적 4개는 통과했다. 최초 피드백의 정확한 중단 지점은 미확정이므로 성공으로 덮지 않고 fixture 준비·자식 종료 지연을 계측하여 최소 수정한다.

- 임시 계측 전체 vitest 두 번은 각각 153개 파일·3772개 통과·기존 1개 skipped였다. 공통 fixture 594건의 최장 준비 3271ms, 마이그레이션 285ms, 두 번째 실행의 dispatch 자식 최장 238ms·정리 129ms를 관찰했다. 정상 실행 관측으로 이전 timeout의 원인을 입증할 수는 없어 임시 계측을 모두 제거하고 소스·시험 변경을 남기지 않았다. 전문 `/tmp/brain153-dev2-implementer.md`.
- 계측 제거 후 지휘자가 `pnpm build`, `pnpm typecheck`, 계획의 verbose 행렬(24개 파일·276개 통과), `bash _bmad/custom/bmad-loop-verify.sh`(153개 파일·3772개 통과·기존 1개 skipped)를 직접 통과했다. 로그 `/tmp/brain153-dev2-build.log`, `/tmp/brain153-dev2-typecheck.log`, `/tmp/brain153-dev2-matrix.log`, `/tmp/brain153-dev2-full-final.log`. 모든 행렬 행의 실제 통과 시험을 다시 대조했다.
- 동결된 intent contract를 기존 구현 커밋 `64d60e6cde2d278e4b5c092121b4260bef273926`과 직접 비교하여 동일함을 확인했다. timeout 재발 원인은 미확정이며 재발 시 단계별 대기·PG 상태를 수집해야 한다. 검증 범위·기대값·시간 제한은 완화하지 않았다.

## Auto Run Result

- Status: built
- legacy notification·delivery의 출처·원문·누락·resend 부적격과 같은 conversation 연결, 확장 자기 출처의 현재 attempt INSERT 경계를 보존했다. 동결 계약은 기존 구현 커밋과 동일하다.
- 이번 재개에서는 소스·시험의 영구 변경 없이 계획 파일에 조사·계측·검증 근거를 기록했다. 임시 계측은 모두 제거했다. 이전 daemon-status 시간 초과와 이번 첫 전체 실행의 dispatch 시간 초과 원인은 미확정이다. 이를 원인 수정 완료로 주장하지 않는다.
- 검증: `pnpm build`, `pnpm typecheck`, verbose 행렬 24개 파일·276개 통과, `bash _bmad/custom/bmad-loop-verify.sh` 153개 파일·3772개 통과·기존 1개 skipped. 계측 제거 후 공식 명령이 통과했으며 행렬 모든 행의 실행·통과를 확인했다. 로그는 위 복구 기록에 있다.
- 독립 Quick 리뷰 0 findings. 적용 patch 0개(high 0, medium 0, low 0), defer 0개, reject 0개. `followup_review_recommended: false`.
- 잔여 위험: timeout이 간헐적으로 재발할 수 있으며 재발 시 실패 단계·PG 대기·자식 종료를 함께 관찰해야 한다. 정상 실행 계측은 실패 원인의 증명이 아니다. 실제 Garmin import는 epic 14, CLI resend 거부 완성은 15.5 범위다. 이번 수락 조건의 운영자 작업은 없다.
- `tickets.py mark`·티켓 done·push는 실행하지 않았다. 티켓 완료 판정은 오케스트레이터가 수행한다.

- Orca 정리: 자기 Run `run_78a1a259c2e9`의 구현 `task_3693eed87c8f`/`ctx_3439ecf18000`와 Quick `task_9e7b56d52124`/`ctx_315783ccaf85`의 정식 succeeded 및 전문을 수락하고 모두 release했다. 완료 mail은 ack했으며 restore의 pending delivery는 없다. worker-list는 released 2개·reclaimable 0개를 확인했다. 취소할 과업이나 소유권 미확인 워커는 없다. 이전 관측의 transcript source 변경은 완료 보고와 실제 released 영수증으로 해소했다. 최종 checkpoint 뒤 자기 전용 제어 셸만 닫는다.

### 변경 파일

- `packages/postgres/migrations/0019_channel_legacy.sql` — legacy 표·RLS·출처 attempt fence·기존 role 최소 grant를 추가했다.
- `packages/postgres/src/channels.ts` — legacy 입력·조회·원문 충돌을 구현했다.
- `packages/postgres/src/extension-provision.ts` — 신규·재설치 확장의 승인 INSERT 열과 권한 검사를 연결했다.
- `packages/postgres/src/migrate.ts` — core 최고 버전을 19로 올렸다.
- `packages/core/src/channels/store.ts` — legacy 입력·조회·누락·resend 부적격 계약을 추가했다.
- `packages/core/src/testing/fakes/store.ts` — fake의 legacy 멱등·충돌·조회를 구현했다.
- `packages/core/src/testing/contracts/channel-store.ts` — fake·PG 공통 legacy 계약을 검증한다.
- `apps/cli/test/channels-legacy.test.ts` — 합성 legacy 비발신·대화 연속성·두 실제 종료 복구를 검증한다.
- `apps/cli/test/fixtures/channel/handoff-child.mjs` — 요청 commit·인계를 실제 자식 프로세스에서 수행한다.
- `apps/cli/test/ext-install.test.ts` — 실제 testext 연결에서 세 표의 전체 쓰기 권한 행렬을 검증한다.
- `packages/postgres/test/extension-permissions.test.ts` — 실제 연결의 RLS·attempt 거부와 기존 role 업그레이드를 검증한다.
- `packages/postgres/test/migrate.test.ts` — v18 데이터 보존과 최고 마이그레이션 계약을 검증한다.
- `packages/postgres/test/schema.test.ts` — 새 표·누락·resend 기본값을 catalog에 반영했다.
- `packages/postgres/test/store.test.ts` — 최고 스키마 버전 검증을 갱신했다.
- `packages/postgres/test/work-store.test.ts` — 감독자 fixture의 core 버전을 갱신했다.
- `packages/postgres/test/unavailable.test.ts` — 새 legacy capability의 연결 불가 계약을 검증한다.
- `apps/cli/src/doctor/store.ts` — 설정 실패 대체 저장소에 새 capability를 추가했다.
- `apps/cli/test/dispatch.test.ts` — 저장소 시험 대역을 새 계약에 맞췄다.
- `apps/cli/test/install.test.ts` — 설치의 core 19 계약을 검증한다.
- `apps/cli/test/setup.test.ts` — 설정의 core 19 계약을 검증한다.
- 이 계획 파일 — 구현·행렬 감사·검증·독립 리뷰와 최종 결과를 기록한다.
