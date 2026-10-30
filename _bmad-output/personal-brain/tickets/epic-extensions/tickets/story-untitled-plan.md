---
title: '확장 설치 단계 보고와 재개'
type: 'feature'
ticket: '5'
created: '2026-10-30'
status: blocked
baseline_revision: 6727c764c1bfd4db0fd7b76532be90c2d2be05ea
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
blocked_at: "2026-10-30"
blocked_reason: "implementer unavailable: 같은 Task에서 구현 워커 두 번이 실제 failed로 보고했다. 첫 시도는 소스 변경 없이 종료했고 재시도는 최초 마이그레이션 실패의 패키지 보존만 구현했다. 단계 journal·재개·인증·예약·취소·인수 시험은 미완료다."
---

<intent-contract>

## Intent

`ext install`이 실제로 끝난 단계와 재개 위치를 registry에 보존하고, 같은 설치를 다시 실행하면 완료 단계를 건너뛰게 한다. 실패·취소·로그인 미완료·연결 실패·예약 미준비를 구분하여 사용자가 자동 실행 여부를 잘못 믿지 않게 한다. 모든 단계 보고와 응답은 저장된 사실을 재조회해 만든다.

## Boundaries & Constraints

- 단계는 패키지·환경·마이그레이션·role·설정·로그인·연결 확인·예약 등록이다. 기존 provisioning은 DDL에 필요한 schema를 만들므로 실제 role 준비는 DDL보다 먼저 수행해도 되지만, 각 단계의 실제 성공·실패를 따로 기록한다. Node 환경·auth 없는 로그인·기본 예약 없는 예약은 실제 적용 대상 부재를 명시하며 가짜 실행 성공을 만들지 않는다.
- 설치 전 실패도 기록할 수 있는 registry journal을 둔다. 각 단계의 상태·고정 코드·시각, 현재 결과·실패 단계와 마지막 실패, 인증 일감 및 예약 식별자를 보존한다. 결과는 `installed`, `failed`, `cancelled`, `login_required`, `connection_failed`, `scheduler_unavailable`다. 기존 설치·활성 의도·연결 사실과 현재 설치 시도의 결과를 분리한다. 성공한 이전 단계는 뒤 단계 실패로 지워지지 않는다.
- 동일 패키지 재실행은 패키지·환경·DDL·role·완료 auth·예약을 반복하지 않는다. 버전만 같아도 소스 내용이 바뀐 패키지를 영원히 건너뛰지 않도록 안정적인 패키지 식별과 설치본 존재를 확인한다. 이미 완료된 설치도 재조회로 보고한다. 실패 단계와 그 뒤 미완료 단계만 재개한다. 프로세스 간 설치 경합은 기존 PG 잠금 등으로 직렬화하며 이중 배치와 서로의 단계 덮어쓰기를 막는다.
- 최초 설치의 마이그레이션 실패는 배치·환경을 보존해 수정 후 재개한다. 이미 적용한 SQL은 공통 실행기의 owner·번호·checksum 이력으로 건너뛴다. 실패한 SQL을 고칠 수 있지만 이미 적용한 SQL은 바꾸지 않는다. 기존 설치 교체의 환경·DDL 실패는 13.3의 이전 패키지·tokenstore 복원 계약을 보존하고, 복원한 패키지와 다른 시도의 패키지·환경 완료 표식을 재사용하지 않는다. 부분 DDL 성공을 되돌렸다고 주장하지 않는다.
- 로그인은 manifest.auth의 supervised 일감을 기존 데몬에 넣고 결과를 읽는다. CLI가 별도 supervisor incarnation을 시작하지 않는다. ABI 성공만 로그인 단계 성공으로 본다. 사용자 조치가 필요한 명시적인 인증 코드와 미완료 일감은 `login_required`로 남기고 연결·예약으로 넘어가지 않는다. 재실행은 기존 활성 auth를 재사용하며, 종료된 미완료 auth만 다시 시도한다. 비밀번호·MFA·자식 원문 진단은 기록하지 않는다.
- 예약은 12.9의 `addDaily`/동일 SDK 경로를 쓴다. 기능 부재 또는 데몬 감독자 미준비는 `scheduler_unavailable`이며 예약 성공을 쓰지 않는다. 데몬 lock·heartbeat와 구별되는 감독자 준비 근거를 확인한다. 일부 예약 뒤 실패해도 기존 예약을 키·실제 설정으로 재조회하여 중복 없이 이어간다. 다른 설정의 충돌을 성공으로 꾸미지 않는다.
- 취소는 SDK AbortSignal과 실제 CLI SIGINT/SIGTERM 경로에서 처리한다. 단계 사이에는 이미 성공한 단계를 보존하고 멈춘다. 실행 중 자식은 기존 그룹 정리·reap 또는 데몬 취소 경로를 사용한다. 취소 요청을 자식 종료 확정으로 꾸미지 않는다. 취소 후 재실행할 수 있어야 한다.
- testext 가짜 로그인은 기존 시험 resolver와 같은 기본 홈 제외·realpath 비교 및 명시 환경 변수 조건에서만 활성화한다. 일반 사용자 옵션이나 testext 일반 출하는 추가하지 않는다. 실제 Garmin·실계정·Python 기본 의존·LaunchAgent 추가는 범위 밖이다.
- 13.2의 단계별 snapshot·진단 보호와 13.4의 확장 전용 DB URL·0600·공개 v1 view의 세 열·자기 행 ACL을 유지한다. 새 journal에 비밀·raw 오류를 넣거나 확장 role의 core 권한을 넓히지 않는다. 적용된 migration은 수정하지 않는다. 티켓 상태와 커밋은 지휘자/엔진 소유이며 워커는 커밋·done·tickets.py mark를 실행하지 않는다. 원격 push는 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 정상 반복 | 격리 홈·PG·준비된 감독자·완료 로그인 | 두 설치 결과 installed, 각 단계 사실 재조회, DDL·환경·role·예약 각 1회 | 없음 |
| DDL 실패·재개 | 최초 설치의 뒤 SQL에 오류를 넣고 고침 | 앞 단계 및 앞 SQL 보존, 패키지·환경 건너뛰고 재개 | failed와 migration 단계·코드 |
| 환경 실패·교체 복원 | 기존 설치에 잘못된 Python 교체 | 이전 패키지·tokenstore 보존, 새 시도의 환경 미완료 | 기존 Python 고정 코드 |
| 중간 취소 | 단계 사이 또는 실행 중 signal | 성공 단계 보존, 후속 미완료, 자식 정리 확인 후 재개 | cancelled |
| 로그인 미완료 | auth가 사용자 조치 코드를 반환 | auth 감독 실행 사실과 login_required, 연결·예약 미완료; 완료 뒤 재개 | login_required |
| 연결 실패 | 로그인 성공 뒤 연결 ABI 실패 | 로그인 보존, 연결 실패, 예약 미완료 | connection_failed |
| 예약 미준비 | SDK 없음 또는 데몬 없음·감독자 비활성/실패 | 예약 완료 없음, 재준비 뒤 재개 | scheduler_unavailable |
| 부분 예약·충돌 | 일부 등록 후 실패 또는 같은 키 재시도 | 기존 정확한 예약 재사용, 다른 설정 충돌은 실패 | failed와 schedule 단계·코드 |
| 기록·경합 | registry 쓰기 실패·동시 설치 | 거짓 성공 없음, DB 오류 전달, 동시 중복 없음 | DB 오류 또는 재개 가능한 미완료 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/install.ts`, `status.ts`, `check.ts`: 현재 place→선택 Python→migrator→registry→snapshot→직접 연결 helper다. 전체 journal·취소·auth·예약 연결은 없다. 보호된 ABI verdict와 기존 snapshot을 재사용한다.
- `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/extension-store.ts`, `packages/postgres/src/extensions.ts`: 설치 행과 별도 Python 환경 표만 있다. 설치 전 journal과 단계/인증/예약 조회·쓰기 및 fake/PG 공통 계약을 추가한다.
- `packages/postgres/migrations/0015_extension_status_public.sql`, `src/migrate.ts`: 현재 core 마지막 번호 15다. 다음 migration을 추가하고 기존 공개 v1 계약은 보존한다.
- `apps/cli/src/runtime/extensions.ts`: 시험 resolver, symlink 거부, staging·백업·tokenstore, 관리 URL과 role provision, DDL 실행을 조립한다. 현재 migrator가 무조건 rollback하므로 최초 실패 재개와 기존 교체 복원을 구분해야 한다. 메모리 pending Map만으로 프로세스 경합을 막지 못한다.
- `packages/postgres/src/migrate.ts`, `extension-provision.ts`: 파일별 DDL commit·checksum 검증 및 role 신원/권한 감사를 재사용한다. 확장 migration의 from/to를 core 버전과 혼동하지 않는다.
- `apps/cli/src/daemon/supervisor.ts`, `packages/core/src/queue/supervisor.ts`: enabled registry의 work/auth를 매 polling에 발견하고 보호 snapshot·확장 URL·그룹 정리·attempt 확정을 처리한다. `store.addWork`, `getWork`, `requestWorkCancel` 등 기존 port로 auth를 연결한다.
- `apps/cli/src/daemon/liveness.ts`, `heartbeat.ts`, `run.ts`: heartbeat는 supervisor와 독립이며 준비 증명이 아니다. 별도 readiness를 현재 데몬 신원·생존과 결합해 확인한다.
- `packages/core/src/queue/schedules.ts`, `packages/postgres/src/schedules.ts`: addDaily와 daily target unique를 재사용한다. 최대 200개 list에 의존한 충돌 판정은 피하고 실제 예약 키/ID를 조회한다.
- `packages/core/src/brain.ts`, `apps/cli/src/assembly.ts`, `commands/ext-install.ts`, `ext-status.ts`, `ext-list.ts`, `dispatch.ts`, `bin.ts`: SDK·취소·출력 조립 경계다. 실패에도 재조회한 단계 정보가 중앙 출력 코덱을 통해 전달되어야 한다.
- `apps/cli/test/ext-fixture.ts`, `ext-install.test.ts`, `supervisor-fixture.ts`, `packages/core/test/extensions.test.ts`, `packages/postgres/test/extensions.test.ts`: 격리 PG/home·실제 CLI·role 정리·fake launcher 기반을 확장한다. Python 선택 시험은 `apps/cli/python-test/`에 남긴다.

## Tasks & Acceptance

**실행:**
- [ ] 위 core/store/fake/PG 경로와 새 `migrations/0016_extension_install_progress.sql`에서 단계 journal·조회 계약과 일관성·경합 방지를 구현한다.
- [ ] `packages/core/src/extensions/install.ts`, `apps/cli/src/runtime/extensions.ts`에서 완료 단계 재개·초기 실패 보존·교체 복원·결과 재조회를 구현한다.
- [ ] `apps/cli/src/daemon/supervisor.ts`, `daemon/run.ts`, `runtime/extensions.ts`, `packages/core/src/brain.ts`, `queue/schedules.ts`, `apps/cli/src/bin.ts`에서 auth 감독 경로·daemon readiness·예약 SDK·취소 signal을 연결하고 격리 testext 로그인 harness를 추가한다.
- [ ] `packages/core/src/brain.ts`, `codes.ts`, `apps/cli/src/commands/ext-install.ts`, `ext-status.ts`, `ext-list.ts`, `README.md`에서 SDK·명령 출력·오류 코드와 안내를 갱신한다. 소스·시험만 편집하며 계획 본문은 구현 노트를 append하는 범위로 제한한다.
- [ ] core 단위·PG 계약 및 `apps/cli/test/ext-install-resume.test.ts` 실제 CLI 시험으로 matrix 전부를 검증하고 기존 회귀를 유지한다.

**인수 조건:**
- Given 격리 home/PG와 실패를 넣은 testext SQL, when 실제 CLI 설치 후 SQL을 고쳐 다시 실행하면, then 첫 응답과 status가 같은 registry 단계 사실을 보이며 실패 단계·코드를 구분하고 앞 단계·앞 SQL·환경을 반복하지 않는다.
- Given 실제 데몬 감독자와 시험 로그인 harness, when 미완료·완료 순서로 CLI를 실행하면, then login_required 동안 연결·예약이 미완료이고 완료 뒤 installed가 되며 두 번째 정상 실행에도 auth·DDL·예약이 중복되지 않는다.
- Given CLI 취소·연결 실패·예약 SDK 부재·데몬 부재·감독자 비활성/실패, when 해당 실제 또는 주입 가능한 외부 경계 시험을 실행하면, then 각각 지정 결과와 registry 사실이 일치하고 미완료 단계를 성공으로 보고하지 않는다.
- Given 기존 Node/Python·권한·비밀 보호 시험, when 기본 및 선택 Python 검증을 실행하면, then 기존 복원·snapshot·확장 신원·공개 view 계약이 유지된다.

### 자동 재개 실행 순서 (2026-10-31)

2026-10-31 사용자 위임에 따라 구현 미완료를 사람 판단으로 넘기지 않는다. `<intent-contract>`와 모든 수락 조건은 유지하고, 아래 실행 단위마다 같은 활성 구현 Dispatch의 `phase-ready` 보고·검증·checkpoint 뒤 다음 단계를 지시한다. 최초 배정은 1번만 구체적으로 구현하도록 지시한다. 이전 두 failed의 범위는 일부 구현이며 기술적으로 계속할 수 없는 근거가 없었다.

1. 설치 journal의 저장·조회: 다음 core migration, Store port, fake/PG 구현·공통 계약 시험. registry의 기존 사실·공개 v1 ACL을 보존하고 비밀을 저장하지 않는다. 해당 계약 시험으로 단계를 검증한다.
2. 완료 단계 재개·패키지 보존·프로세스 경합: journal을 실제 install/runtime에 연결하고 DDL checksum 및 기존 교체 복원과 일관성을 보인다. 기존 stash `de3641a`의 두 파일은 참고 증거로 읽되 전체 stash를 적용하지 않으며 필요 변경만 현재 코드와 대조해 구현한다.
3. 인증 감독: 기존 데몬의 supervised auth를 재사용하고 testext 격리 harness로 login_required → 완료·재실행 중복 방지를 실제 시험한다.
4. 예약 준비·멱등성과 취소: 실제 감독자 readiness, 기존 예약 SDK, AbortSignal·CLI signal 및 재실행 결과를 연결·시험한다.
5. SDK·CLI 출력·문서와 전체 인수: 저장된 상태 재조회 출력, 모든 matrix 행·기본 회귀·선택 Python 검증을 마친다. 모든 단계가 충족된 뒤 implementation-ready → 지휘자 Verify·리뷰 → finalize 절차를 따른다. 미검증 항목을 done으로 보고하지 않는다.

## Implementation Notes

- route는 workflow가 지정한 full이며 단계별 DB·프로세스·CLI 경계를 함께 검증해야 하므로 유지한다. 시작 시 작업 트리는 깨끗하고 git metadata refresh가 성공했다. 선행 13.3·13.4 계획과 현재 코드를 대조했다. 별도 최상위 research-* 폴더는 없다. 읽기 전용 Orca 조사 결과를 Code Map에 반영했다.

- 최초 구현 Dispatch `ctx_154d2e2d45b5`는 소스·시험 변경 없이 실제 구현 미완료를 failed로 보고했다. transcript와 보고서에 capacity·사용량 한도 오류는 없으며 실패 1회로 집계한다. 같은 Task·같은 모델의 재시도 `ctx_0c482fc2018d`를 시작했다.

## Plan Change Log

## Review Triage Log

## Verification

- `pnpm build`, `pnpm typecheck`: 빌드·타입 검사 성공.
- `pnpm exec vitest run packages/core/test/extensions.test.ts packages/postgres/test/extensions.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/ext-install-resume.test.ts apps/cli/test/daemon-supervisor.test.ts packages/postgres/test/extension-permissions.test.ts`: matrix와 기존 보호 경계 통과. 격리 DB·home·role은 기존 harness로 생성·정리한다.
- `pnpm test:python`: uv와 pin Python이 있는 환경에서 실제 frozen 설치·fixture 판정·환경 실패 보존 회귀 통과. 기본 suite에는 Python을 요구하지 않는다.
- `pnpm test`: 전체 기본 suite 통과.
- `git diff --check`: 공백 오류 없음. 각 matrix 행의 실제 시험 이름·실행 결과를 최종 기록한다.

## Auto Run Result

Status: blocked

Blocking condition: implementer unavailable

- 같은 Orca Task `task_04e65c602417`의 구현 시도 `ctx_154d2e2d45b5`와 재시도 `ctx_0c482fc2018d`가 모두 outcome failed로 정식 보고했다. requested/effective 모델은 모두 `codex gpt-6.1-terra / medium`이다. capacity·사용량 한도·대기 시간 초과로 추정한 실패가 아니라 구현자 자신의 실제 미완료 보고다.
- `_bmad/custom/bmad-orca-workers.md`와 workflow persistent facts가 정한 두 번 연속 실제 구현 실패 HALT 규칙을 적용했다. 이 HALT 안에서만 `tickets.py mark 13.5 blocked`를 실행했다. 티켓을 done으로 표시하지 않았다.
- 확정된 full 계획과 읽기 전용 조사 결과를 남겼다. 소스 부분 변경은 `apps/cli/src/runtime/extensions.ts`의 최초 마이그레이션 실패 시 패키지 보존이며, `apps/cli/test/ext-install.test.ts`가 이를 관찰한다. 지휘자는 두 파일의 diff를 직접 확인했다.
- 단계 journal·완료 단계 재개·인증 감독 연결·예약 준비 및 중복 방지·취소·출력·인수 시험은 미완료다. 계획의 체크 항목은 완료 처리하지 않았다. 부분 변경은 검토용 작업 트리에 보존하며 커밋·원격 push는 하지 않았다.
- 구현 워커는 `pnpm build`, `pnpm typecheck`, 실제 CLI 시험 20건 통과를 보고했다. 지휘자의 독립 검증·전체 시험·matrix audit·독립 리뷰는 실행하지 않았으므로 티켓 충족의 근거로 세지 않는다.
- 저장소 밖에서 사람만 수행해야 하는 작업은 확인되지 않았다. 외부 운영자 작업이 아닌 구현 실패이므로 `awaiting-operator`와 `operator_actions`는 적용하지 않는다.
- 정리 대상은 이 Run의 읽기 전용 조사 1건과 구현 2건이다. 조사와 첫 구현은 이미 release했으며 재시도의 정식 실패 보고를 수락했다. 마지막 워커 release와 inbox·reclaimable 확인 결과를 아래에 덧붙인다.

- 최종 Orca 정리: Run `run_519430071204`의 세 Dispatch가 모두 released이며 reclaimable 0건, inbox 0건이다. 미확인 워커와 남은 활성 과업은 없다. 전용 제어 셸만 마지막에 닫는다. `git diff --check`는 통과했다.
