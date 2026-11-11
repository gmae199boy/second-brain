---
title: 결과 이벤트와 core 발송 구독
type: feature
ticket: 8
created: 2026-11-11
status: built
baseline_revision: e407369b57841a5d759945a2a70c38480329e3bb
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: [independent-core-review]
review_loop_iteration: 0
context: []
---

<frozen-after-approval>
## Intent
확장은 결과 이벤트만 기록하고 core 구독이 발송 목적지와 시각을 결정한다. 중앙 고정 계약 `.brain-automation/operations/2026-11-11/event-contract.md`를 그대로 구현한다. Garmin 구현은 별도 워커 소유다.

## Boundaries & Constraints
기존 topic 경로와 명시적 발신·재시도·멱등을 유지한다. 구독은 event별 하나의 목적지와 immediate 또는 현지 HH:MM 정책을 가진다. 시간대 미지정은 사용자 timezone(기본 Asia/Seoul)을 따른다. 이미 접수된 예약은 설정 변경으로 재계산하지 않는다. 운영 DB·실발신·main·plugin/app-ref·version은 변경하지 않는다.

## I/O & Edge-Case Matrix
| 상황 | 입력 | 결과 |
|---|---|---|
| 미구독 | 완료 이벤트 | 이벤트만 보관 |
| 당일 | 현지 오늘 subject_date | 구독으로 한 번 발송 접수 |
| 지난 날짜 | 자동 일감 | 보관, send-pending --event 요청 때 접수 |
| 수동 요청 | 수동 ext run에서 나온 이벤트 | 날짜와 무관하게 구독 정책 적용 |
| 시각 전/후 | HH:MM 구독 | 오늘 시각 예약/즉시, 다음 날로 미루지 않음 |
| 중복 | 같은 event,key | 기존 이벤트 반환, 구독 변경으로 재발송하지 않음 |
| 이행 | 기존 Garmin 두 경로 | 각 .completed immediate 구독으로 이동 |
</frozen-after-approval>

## Code Map
- `packages/postgres/migrations/0045_channel_topics.sql`: 기존 발신 요청·예약·durable 출처 계약. 변경 없이 재사용한다.
- `packages/postgres/migrations/0047_result_events.sql`: 이벤트, 구독, 수동 일감 출처와 core 발송 정책을 추가한다.
- `packages/postgres/src/channel-control.ts`, `packages/core/src/channels/control.ts`, `packages/core/src/channels/manage.ts`: 구독 저장·SDK·입력 검증.
- `packages/postgres/src/extensions.ts`: 수동 ext run 접수를 기록하는 권한 경계.
- `packages/postgres/src/extension-provision.ts`: 이벤트 함수 실행 권한만 허용 목록에 추가.
- `apps/cli/src/commands/channels-control.ts`, `index.ts`: subscribe와 send-pending --event 등록.
- `packages/core/src/doctor/doctor.ts`: 구독·보관 이벤트 진단.
- `plugin/skills/brain-channels/SKILL.md`, `brain-schedules/SKILL.md`, `README.md`: 분석 예약과 발송 구독 분리를 안내.

## Tasks & Acceptance
- [x] migration과 권한·멱등·파일 소유 검증을 구현한다.
- [x] 구독 CLI·보관 이벤트 수동 발신·doctor를 연결한다.
- [x] PG·CLI·가짜 Telegram 수락 시험과 스킬 커버리지를 작성한다.
- [x] 독립 리뷰 수정 뒤 전체 회귀를 순차 실행하고 작업 브랜치를 push한다.

수락조건: 미구독 이벤트 방출 때 요청이 없고, 다음 당일 이벤트는 구독 목적지로 한 번 접수된다. 시각 전 이벤트는 예약되고 이후에는 즉시 접수된다. 과거 이벤트는 수동 요청 전 발송되지 않는다. 같은 이벤트를 재방출해도 POST가 하나다. 기존 topic 발신과 보관 요청·재시도가 유지된다.

## Implementation Notes
- 중앙이 구현 범위와 자율 실행을 명시했으므로 대화형 계획 승인 대신 Dispatch의 고정 계약을 사용한다. 소스는 직접 구현하고 요청된 독립 리뷰만 위임한다.
- 수동 여부 결정 근거: `enqueueExtensionWork`는 공개 ext run의 접수 경계이며 예약 발화는 별도 `fireSchedule`을 쓴다. 입력 유무나 p_key를 추정하지 않고 core 전용 `work_manual_requests`에 접수를 기록하여 이벤트에 requested를 고정한다. 이미 합쳐진 일감도 명시적 수동 요청으로 간주한다.
- [ASSUMPTION] 날짜 판정은 구독의 유효 시간대를 기준으로 한다. 구독이 없던 이벤트는 나중 구독을 등록해도 자동 재생하지 않는다.

## Plan Change Log
중앙 지시에 따라 route deliver-at에서 15.8 core로 범위를 대체했다. 아직 소스 변경 전이었다.

## Review Triage Log
- 1차: medium 1건, patch. 0047 migration의 목적지 고정이 scheduled만 포함하여 기존 unrouted Garmin 요청이 send-pending으로 발송되지 않는 결함을 확인했다. 목적지 고정을 unrouted에도 적용하되 상태와 요청 생성은 그대로 두었고 두 Garmin topic의 보관·경로 등록·이행·명시 발신·반복 0건 시험을 보강했다. 근거: `.brain-automation/event-core-review.md`.

## Verification
개발 중 시험 실행 금지, `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 최종 구현·리뷰 수정 뒤 `pnpm test` → `pnpm test:python`을 순차 한 번 실행한다. 실패 수정 뒤 `pnpm test:changed`와 관련 시험으로 재검증한다.

- 후속 리뷰: `.brain-automation/event-core-review-followup.md`에서 기존 medium 1건 해결, 새 실제 결함 0건. 개발 수정 종료 후 전체 회귀를 진행한다.

## 전체 회귀 1차 처분
- `pnpm test`: 250 파일 중 243 통과·7 실패, 5,429건 중 5,406 통과·23 실패. 첫 공용 DB 시도는 다른 워커 병렬 실행을 확인한 뒤 중단했고 Task 전용 PG 컨테이너(임의 포트, tmpfs)에서 전체 실행했다.
- 검색 도구 16건: schema 47이 고정 manifest·비교 검증 목록에 없어 거부됐다. 47의 실제 migration checksum과 current fixture·이전 버전 검증을 추가한다. 기존 검색 의미나 측정 assertion을 완화하지 않는다.
- 새 PG 시험 3건: 합성 입력의 동일 SQL 인자 uuid/text 추론 충돌 2건, 재provision에 새 비밀번호를 넘긴 fixture 오류 1건. 명시적 uuid cast와 최초 시험 비밀번호 재사용으로 고친다.
- 새 CLI 시험 1건: 데몬이 프로세스 없는 생산자 attempt를 회수한 뒤 재방출해 정상 소유권 거부가 발생했다. 유효 attempt에서의 중복 방출은 데몬 시작 전에 검증하고 시작 뒤에는 기존 이벤트 수동 재접수 0건으로 중복 POST 부재를 확인한다.
- schema 목록 1건: 새 subscription UUID 기본값을 카탈로그 기대값에 추가한다.
- 기존 설치 재개 authWorkId 재사용 1건·Drive 명령 120초 timeout 1건: 관련 시험을 별도 재검증하여 재현 여부를 판정한다.

- 중앙 결정(`msg_5a432e2a0b6b`): Garmin 변경 cherry-pick 금지. 새 함수 실행 권한을 기존 Garmin role_probe가 과잉으로 거부하는 교차 실패는 병합 후 재검증 대상으로 분리한다. core 자체 수정·관련 시험·브랜치 push를 완료하고 중앙이 Garmin 브랜치 통합 뒤 전체 회귀를 수행한다.

## Auto Run Result
core 범위 구현·독립 리뷰·수정 후 관련 검증을 완료했다. 일반 변경 시험 167파일·3,268건과 PostgreSQL 전체 49파일·853건이 모두 통과했다. 기존 확장 설치 재개와 Drive timeout은 코드·assertion 수정 없이 일반 변경 시험에서 통과했고, 기준 SHA의 Drive 단독 시험도 통과했다.

전체 `pnpm test` 1차 실패는 원인별로 수정·재검증했다. 뒤이어 전체 `pnpm test:python`은 32작업 중 26통과·6실패, 91건 중 57통과·34실패로 종료했다. 기존 Garmin role_probe가 새 emit 실행 권한을 과잉으로 거부하는 교차 실패는 중앙 `msg_5a432e2a0b6b`에 따라 병합 후 통합 재검증 대상으로 남긴다. `test:changed`는 일반·PG 단계 통과 뒤 같은 Python 전체를 다시 선택했으며 중복 Python runner만 자체 SIGINT 경로로 종료했다(exit 130, 상위 명령 exit 1). 이 명령 전체나 Python 전체를 통과했다고 주장하지 않는다.

## 중앙 통합 후속
Garmin 브랜치와 통합한 뒤 role_probe·새 이벤트 방출·실제 구독 발신을 포함하는 전체 회귀를 실행해야 한다. 이 계획의 built는 core 과업 범위이며 15.8 전체 통합 인수 완료가 아니다. 운영·실발신·main·plugin/app-ref·version은 변경하지 않았다. 상세 증거와 브랜치 push SHA는 `.brain-automation/route-delivery-time-report.md`에 보존한다.
