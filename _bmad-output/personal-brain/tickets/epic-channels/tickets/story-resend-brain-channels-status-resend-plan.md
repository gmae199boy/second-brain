---
title: '채널 상태 조회와 실패 요청 재전송 스킬'
type: feature
ticket: 5
created: '2026-10-31'
status: done
baseline_revision: ae2b65b6df09325712affa9818e914a41871ccd3
route: full
route_source: pinned
risk: medium
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: [AGENTS.md]
warnings: [oversized]
deferred:
  - summary: >-
      검토 필요: [ASSUMPTION] 과거 생성·시작 시각이 완전히 같은 시도는 안정적 ID 순서로 정렬한다.
    evidence: |-
      v20에는 동일 시각 시도의 실제 삽입 순번이 없다. 0021은 확인 가능한 시각을 보존하고 동률만 식별자로 정렬한다. 다른 선후 증거가 확보되면 기존 공개 결과와 비교해야 한다.
    location: >-
      packages/postgres/migrations/0021_channel_attempt_order.sql
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 기존 채널 발신은 실패·불명을 저장하지만 사용자가 상태를 조회하거나 닫힌 실패 요청을 다시 열 CLI·SDK·스킬이 없다.

**Approach:** `brain channels list`, `status <request-id>`, `resend <request-id>`와 SDK 1:1 계약을 추가한다. 기존 요청과 항목별 성공을 유지하면서 닫힌 실패만 원자적으로 재개하고 실제 재조회 상태로 보고하는 플러그인 스킬을 제공한다. 저장·SDK·CLI를 함께 바꾸므로 고정 full 경로다.

## Boundaries & Constraints

**Always:** 동일 요청·의미 키·최초 gate·기존 attempt 이력·sent 항목은 보존한다. 닫힌 definite_failed·unknown 또는 미해결 failures 요청만 새 attempt를 실행할 일감으로 다시 연다. 병행 resend는 하나만 성공한다. 진행 중·대기 재시도·아직 인계 전 요청은 거부한다. failure는 재개 접수 시 지우지 않고 실제 발신 성공 시 기존 성공 정산으로 해소한다. status는 발신 결과와 일감 상태·시도·다음 시도·미해결 failures·legacy·재전송 적격성을 구분한다. SDK 공개 projection부터 본문·bundle·외부 chat/thread 참조·설정 비밀은 내보내지 않고 문자열은 기존 출력 코덱을 거친다. 거부 코드는 `CHANNEL_REQUEST_NOT_FOUND`, `CHANNEL_ALREADY_SENT`, `CHANNEL_LEGACY_NOT_RESENDABLE`, `CHANNEL_REQUEST_IN_PROGRESS`, `CHANNEL_NOT_RESENDABLE`로 등록한다. UUID 형식 오류는 INVALID_ARGUMENT다. legacy id는 15.3의 두 legacy 표에서 찾고 항상 resendEligible=false를 보존한다.

**Never:** 임의 메시지 생성·수신·실계정 발신·설정 이전·배포·app-ref 변경은 하지 않는다. 기존 migration 0017~0020의 checksum과 RLS·확장 최소 권한·attempt fence를 바꾸지 않는다. 필요하면 새 migration만 추가한다. 소스·시험 편집은 구현 워커 한 명만 한다. 워커는 계획의 Implementation Notes만 덧붙이고 상태·ticket·tickets.toml·커밋·push·tickets.py mark는 건드리지 않는다. 지휘자와 엔진이 상태·커밋·완료 판정을 소유한다. 모든 설명·보고는 한국어다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 결과 | 실패 처리 |
|---|---|---|---|
| 실패 재개 | unknown·definite_failed·failures로 닫힘 | 동일 요청의 새 attempt, 성공 뒤 sent와 failures 해소 | 접수만으로 성공 보고 금지 |
| 이미 성공 | sent 요청 | 재전송 없음 | CHANNEL_ALREADY_SENT |
| 옛 이력 | notification·delivery legacy id | 상태 legacy·부적격, HTTP·일감 없음 | CHANNEL_LEGACY_NOT_RESENDABLE |
| 진행 중 | 미인계·대기·실행·자동 재시도 대기 | 새 일감 없음 | CHANNEL_REQUEST_IN_PROGRESS |
| 입력·동시성 | 잘못된 UUID·없는 id·동시 resend | 입력 오류·not found, 병행 승자 한 명 | 명시 코드와 이력 보존 |
| 공개 조회 | 비밀 포함 원문·오류·외부 참조 | list/status·SDK·텍스트/JSON 비밀 없음 | 출력 코덱 적용 |
| 스킬 행동 | 못 간 알림·이미 보낸 것·legacy·명령 없음 | schema→status→필요한 resend→status, 마지막 관찰만 보고 | 우회·거짓 성공 없음 |

</intent-contract>

## Code Map

- `packages/core/src/channels/store.ts`, `packages/postgres/src/channels.ts`: 기존 요청 조회·legacy 조회·현재 token 검사·withWrite/행 잠금·ensureWork 패턴을 재사용한다. 신규 공개 조회와 원자적 재개 계약을 fake와 PG에 함께 구현한다. 닫힌 work를 재개하든 새 work를 잇든 기존 attempt 이력과 시도 예산의 재시작, 단일 활성 work와 request.workItemId 일치를 입증한다.
- `packages/core/src/brain.ts`, `index.ts`, `codes.ts`, `output/`: channels SDK와 export·거부 코드 등록, 기존 envelope/text 코덱과 공개 마스킹을 재사용한다. `apps/cli/src/commands/index.ts`, `dispatch.ts`, 새 channels 명령 파일은 CommandSpec·guide schema·메타 표면이다.
- `packages/core/src/testing/fakes/store.ts`, `testing/contracts/channel-store.ts`: fake·PG 공유 계약을 확장한다. capability 추가로 깨지는 unavailable/doctor/dispatch 대역도 갱신한다.
- `packages/postgres/src/work.ts`, core supervisor와 `apps/cli/test/channel-fixture.ts`, `channels-retry.test.ts`: 실제 PG·감독자·Node worker·가짜 HTTP·clock으로 unknown과 소진 failure를 재개해 성공까지 관찰한다. 기존 성공 정산의 failures 해소를 재사용한다. HTTP 동안 쓰기 트랜잭션을 열지 않는다.
- `plugin/skills/install/SKILL.md`, `tooling/bootstrap/test/install-skill.test.ts`, `tooling/install-eval/eval.mjs`: 13.7의 CommandSpec 정적 검사·격리 fake CLI 준비/판정 구조다. 새 channels 스킬·평가를 같은 방식으로 제공한다. 고정 스크립트 재생과 판정기 자기시험을 실제 에이전트 행동 평가로 주장하지 않는다. plugin version은 스킬 캐시를 위해 증가 가능하나 app-ref 배포는 후속 15.7 범위다.
- 선행 15.4 계획의 항목별 sent 보존·현재 attempt fence·PG v20 및 13.7 계획의 실제 에이전트 평가 원칙을 이어받는다. 최상위 research-* 폴더는 없다. 참조 연구 §6의 명령 부재와 현재 구현을 재확인했다.

## Tasks & Acceptance

**Execution:**
- [x] 1단계: `packages/core/src/channels/`, `brain.ts`, `index.ts`, `codes.ts`, fake·공유 channel-store 계약과 `packages/postgres/src/channels.ts`에 조회·원자적 resend를 구현한다. 필요 새 migration과 버전 fixture만 추가하고 공유 계약·단위 시험으로 거부·병행·이력·비밀 경계를 검증한다. phase-ready로 보고한다.
- [x] 2단계: `apps/cli/src/commands/channels-*.ts`와 등록부·메타·회귀 대역 및 `apps/cli/test/channels-commands.test.ts`를 구현한다. `plugin/skills/channels/SKILL.md`, `tooling/channels-eval/` 준비·판정 도구와 bootstrap 정적/판정기 시험, package.json 진입점·README 실행법을 추가한다. 네 행동 case를 실제 에이전트가 수행할 수 있게 준비하고 implementation-ready를 보고한다.

**Acceptance Criteria:**
- Given 실제 PG·감독자·가짜 HTTP에서 unknown과 failures로 닫힌 요청, When 실제 `brain channels resend`를 실행하고 감독자를 진행하면, Then 같은 요청에 새 attempt가 남고 sent로 수렴하며 미해결 failures가 해소되고 최초 gate·기존 sent 항목은 유지된다.
- Given sent·legacy 두 종류·진행 중·동시 요청·잘못된 입력, When CLI와 공유 저장 계약을 실행하면, Then 행렬의 명시 코드와 단일 재개를 관찰하고 불필요한 HTTP가 없다.
- Given 등록부와 배포 폴더, When 정적 검사와 guide schema를 실행하면, Then 모든 스킬 명령·옵션이 CommandSpec·SDK 1:1이고 비밀 없는 list/status를 얻는다.
- Given 실제 스킬과 격리 fake CLI, When 별도 실제 에이전트가 못 간 알림·이미 보낸 것·legacy·명령 없음 네 case를 수행하면, Then 호출 기록과 마지막 상태 기반 보고가 일치하며 우회·거짓 완료·비밀 노출이 없다.

## Implementation Notes

- 동일 요청에 새 channel_send 일감을 원자적으로 연결하고 기존 gate·attempt·sent 항목을 보존한다. 발신 성공 정산에서만 failures를 해소한다. 공개 SDK·CLI는 본문·외부 참조를 제외하고 대기·실행·종료·legacy를 구분한다. plugin version은 0.1.13이며 app-ref는 그대로다.
- 새 0021 migration의 삽입 순번으로 이후 동시각 시도의 UUID 순서 문제를 방지한다. 기존 0017~0020 checksum은 변경하지 않았다. 리뷰에서 기존 이력의 기록 시각순 백필을 보완했고, 완전히 같은 시각의 실제 선후가 없는 경우만 안정적인 ID 순서를 쓴다.
- 지휘자 독립 검증: pnpm build·pnpm typecheck·staged diff 공백 검사 exit 0, 표적 11파일 130개 통과, 전체 158파일 3849개 통과·기존 선택 시험 1개 skip. 원본 로그는 /tmp/bmad155-{build,typecheck,targeted,full}.log다. SDK 비밀 경계 시험 channels-sdk도 표적에 포함했다.
- 실제 평가 워커가 네 사례에서 fake CLI를 9회 직접 호출했다. 호출·응답·최종 상태·한국어 보고를 직접 읽었다. failed의 접수·발신 미확인 보고를 판정기가 오판해 같은 구현자가 수정했고 원본 20파일 hash를 보존한다. /tmp/bmad155-behavior.md는 최초 판정을 보존한다.

- 행렬 감사: 실패 재개·sent 거부는 channels-commands의 두 결과별 시험, legacy·진행 중·없는 ID·출력은 동 파일의 CLI 행렬 시험, 동시 승자·이력·실패 해소는 fake/PG 공유 계약, SDK 비밀·UUID는 channels-sdk가 담당한다. 해당 시험은 모두 실행·통과했고 담당 skipped 시험은 없다. 스킬 행은 정적/판정기 시험과 실제 4개 사례로 확인했다.
- 판정기 보정 뒤 지휘자 자기시험 5개와 실제 원본 재판정 4/4가 통과했다. 원본 20파일 hash는 동일하다. 실제 행동 보고의 최초 실패 기록은 보존하며 자동 판정은 자연어 의미 검토를 완전히 대체하지 않는다.

- [ASSUMPTION] 과거 생성·시작 시각이 완전히 같으면 복구할 실제 선후가 없어 안정적 ID 순서로 정렬한다. SQL 주석과 frontmatter deferred에 같은 판단을 남긴다. 원문·결과·시간을 바꾸지 않는 metadata 순서의 한계이며 데이터 손실이나 권한 변경은 없다.

## Plan Change Log

## Review Triage Log

### 2026-10-31 — Quick 리뷰

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `packages/postgres/migrations/0021_channel_attempt_order.sql:2`의 기존 이력 순번이 물리적 저장 순서를 따랐다. `channels.ts`가 sequence만 내림차순으로 읽어 기록된 최신 unknown 대신 이전 실패를 표시할 수 있음을 확인했다. 새 migration에서 기록된 시각과 연결된 work 시각으로 순번을 채우고 identity를 최대값 뒤로 잇는다. migration 실행 트랜잭션 안에서만 갱신 fence를 비활성화·복원하며 역순 v20 데이터 시험으로 원문·시각·checksum과 fence 및 새 삽입 순서를 검증한다. 기존 계약의 지역 순서 산정 보정이며 새 공개면이 없어 patch다.
  - `[medium]` `[patch]` `apps/cli/src/commands/channels-status.ts:4`의 텍스트가 nextAttemptAt을 누락했다. SDK와 JSON에 값이 있어도 일반 status/list에서는 재시도 시각을 볼 수 없음을 확인했다. 공통 포맷에 ISO 시각 또는 예정 없음을 추가하고 CLI 시험으로 확인한다. 기존 필드 출력의 직접 보정이므로 patch다.
- 리뷰 findings의 기각·defer·의도 공백·계획 loopback은 없다. 별도 작은 결정 공백의 [ASSUMPTION] deferred 1개는 보존한다. 서로 다른 원인의 medium patch 2개이므로 후속 리뷰 권고는 true다. 과거 생성·시작 시각이 모두 같은 상이한 결과의 원래 선후는 기록에서 복구할 수 없어 안정적 ID 순서로 결정하며, 이 경계와 추가 자연어 판정 표현은 잔여 확인 범위다.

## Verification

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 성공.
- `pnpm exec vitest run --project core --project postgres --project cli --project bootstrap channel-store channels-commands channels-retry channels-bundle channels-tracer channels-skill channels-eval output-codecs guide-schema --reporter verbose`: 행렬 담당 시험이 모두 실행·통과한다. 부족한 거부/동시성은 해당 표적 파일에 추가한다.
- `pnpm eval:channels prepare <case> <새 임시 폴더>`로 네 사례를 준비하고 실제 평가 워커가 스킬을 읽어 fake CLI를 호출한 후 `pnpm eval:channels verify <폴더>`로 판정한다. 지휘자는 원본 호출·출력·보고를 직접 읽는다.
- `bash _bmad/custom/bmad-loop-verify.sh`: 필수 전체 회귀 성공. Docker 전용 PG·격리 DB·임시 홈·가짜 서버만 사용하고 종료 시 자식·서버·연결·DB를 정리한다. 외부 운영자 작업은 없다.


## Auto Run Result

Status: built

채널 list/status/resend의 CLI·CommandSpec·메타·SDK 1:1 경로와 플러그인 channels 스킬을 구현했다. 닫힌 실패·불명 요청만 같은 요청의 새 attempt로 다시 열고 sent·legacy·진행 중은 명시 코드로 거부한다. 요청 의미 키·최초 gate·기존 시도·항목별 sent는 유지하며 실제 발신 성공 때만 failures를 해소한다. 공개 JSON·텍스트·SDK는 본문과 외부 참조를 내보내지 않으며 기존 오류 마스킹을 사용한다.

변경 파일:

- `README.md`: 새 거부 코드와 별도 행동 평가 실행법.
- 이 계획: 계약·단계·검증·리뷰 판정·결과 및 잔여 가정.
- `apps/cli/src/commands/channels-status.ts`: list/status/resend 명령과 다음 시도 텍스트 표시.
- `apps/cli/src/commands/index.ts`: 세 명령 등록.
- `apps/cli/src/doctor/store.ts`: 새 capability의 연결 실패 대역.
- `apps/cli/test/channels-commands.test.ts`: 실제 CLI·PG·감독자·가짜 HTTP와 거부·출력 행렬.
- `apps/cli/test/dispatch.test.ts`: 새 capability 대역.
- `apps/cli/test/install.test.ts`: v21 설치 회귀.
- `apps/cli/test/setup.test.ts`: v21 설정 회귀.
- `package.json`: eval:channels 진입점.
- `packages/core/src/brain.ts`: 공개 SDK·입력 검사·오류 마스킹.
- `packages/core/src/channels/store.ts`: 상태 projection·조회·resend 저장 계약.
- `packages/core/src/codes.ts`: 거부 코드 등록.
- `packages/core/src/testing/contracts/channel-store.ts`: 원자적 재개·legacy·이력·실패 해소 공유 계약.
- `packages/core/src/testing/fakes/store.ts`: fake 조회·재개·성공 정산.
- `packages/core/test/channels-sdk.test.ts`: SDK의 비밀 배제·UUID 검사.
- `packages/core/test/codes.test.ts`: 오류 코드 표 회귀.
- `packages/postgres/migrations/0021_channel_attempt_order.sql`: 과거 이력 시각순 백필과 새 삽입 순번.
- `packages/postgres/src/channels.ts`: 공개 조회·요청 행 잠금을 이용한 단일 재개.
- `packages/postgres/src/migrate.ts`: core v21.
- `packages/postgres/src/work.ts`: 발신 성공의 failures 해소.
- `packages/postgres/test/channel-store.test.ts`: 새 저장 계약과 동일 시각 역순 UUID 회귀.
- `packages/postgres/test/extension-permissions.test.ts`: v21 최소 권한 회귀.
- `packages/postgres/test/migrate.test.ts`: v21 적용·역순 v20 이력·checksum·fence 보존.
- `packages/postgres/test/schema.test.ts`: identity catalog 회귀.
- `packages/postgres/test/store.test.ts`: v21 schema 계약.
- `packages/postgres/test/unavailable.test.ts`: 새 capability 연결 실패 계약.
- `packages/postgres/test/work-store.test.ts`: v21 감독자 fixture.
- `plugin/.claude-plugin/plugin.json`: 스킬 캐시용 version 0.1.13.
- `plugin/skills/channels/SKILL.md`: 지원 확인·상태·적격 재전송·실제 관찰 보고.
- `tooling/bootstrap/test/channels-eval.test.ts`: 판정기의 양성·음성·거짓 성공 및 미확인 표현 회귀.
- `tooling/bootstrap/test/channels-skill.test.ts`: 명령·인자·옵션의 CommandSpec 대조.
- `tooling/channels-eval/eval.mjs`: 격리 fake CLI 네 사례·원본 기록·판정 도구.

리뷰는 총 2건이며 medium patch 2개를 반영했다. high·low·false·maybe-false·기각·리뷰 defer는 각각 0개다. 별도로 기존 동률 이력 순서에 대한 [ASSUMPTION] deferred 1개가 있다. 새 공개면 없이 기존 순서 산정과 텍스트 포맷을 보정했다. `followup_review_recommended: true`: 서로 다른 medium patch 2개이며, 과거 생성·시작 시각이 모두 같은 시도의 선후 복구 한계와 추가 자연어 판정 표현은 미검증 범위다.

최종 지휘자 검증:

- `pnpm build`, `pnpm typecheck`: exit 0. 로그는 /tmp/bmad155-final-build.log와 /tmp/bmad155-final-typecheck.log다.
- 계획 표적 명령에 channels-sdk와 migrate.test를 더한 실행: 12개 파일 149개 통과, exit 0. /tmp/bmad155-final-targeted.log에서 행렬 담당 시험이 모두 실제 실행·통과했으며 담당 skip은 없다.
- `bash _bmad/custom/bmad-loop-verify.sh`: exit 0, 158개 파일 3850개 통과·기존 선택 시험 1개 skip. /tmp/bmad155-final-full.log에 보존했다.
- 실제 에이전트가 네 사례에서 fake CLI를 9회 직접 호출했고, 원본 호출·응답·최종 상태·한국어 보고를 직접 확인했다. 판정기의 미확인 표현 오판을 수정한 뒤 동일 원본 재판정 4/4와 관련 자기시험 5개가 통과했다. 원본 20파일 SHA-256은 모두 동일하다. 최초 판정은 /tmp/bmad155-behavior.md, 수정 근거는 /tmp/bmad155-fix-report.md에 보존했다. 판정기 자기시험을 실제 에이전트 행동 평가로 세지 않았다.
- 최종 patch diff와 migration 실행기의 트랜잭션·rollback을 직접 확인했다. [ASSUMPTION] 마지막 변경은 주석뿐이며 실행 코드를 바꾸지 않았다. frontmatter deferred는 YAML로 파싱해 하나의 목록·1개 항목임을 확인했다.

잔여 한계는 재전송 정책이 수용한 불명 발신 중복 가능성과 과거 동률 이력 선후 복구, 자연어 판정기의 표현 범위다. 실제 계정 발신과 설치본 배포는 후속 티켓 범위다. HUMAN만 수행할 외부 작업은 없어 awaiting-operator가 아니며 operator_actions도 없다. app-ref·push·tickets.py mark·티켓 done은 변경하지 않았다. 최종 티켓 완료 판정은 오케스트레이터의 독립 검증에 맡긴다.


Orca 정리와 인계:

- 자기 Run `run_0820d4ec3e76`의 구현·행동 평가·Quick 리뷰 3개 Dispatch는 모두 succeeded 정식 보고를 수락한 뒤 release했다. worker-list에서 released 3개·reclaimable 0개이며 마지막 check에 pending delivery는 null이다. 취소할 과업·미확인 워커·미확인 요청은 없다.
- 현재 task의 orca-coordination.json에 최종 단계·검증·판단·정리 결과를 checkpoint했다. 제어 셸에서 미완성으로 남은 다중행 명령은 실행 전 취소하고 restore로 소유권을 재확인한 뒤 같은 key·payload로 전달했다. 새 Run이나 중복 구현자는 만들지 않았다.
- 실제 행동 평가 원본과 hash 목록은 /tmp/bmad155-behavior-artifacts.tar.gz에도 보존했다. 시험의 격리 DB·가짜 서버·감독자 자식은 fixture가 정리했다. 보고·검증 로그는 위 임시 경로에 남긴다.
- 최종 reviewed diff와 이 계획을 함께 커밋하고 clean 상태를 확인한다. HALT checkpoint에 실제 커밋을 남긴 뒤 모든 워커·mail이 정리된 자기 전용 제어 셸만 마지막에 닫는다. 티켓 done은 오케스트레이터가 수행한다.
