---
title: '확장 설치 단계 보고와 재개'
type: 'feature'
ticket: '5'
created: '2026-10-30'
status: done
baseline_revision: 9f16a22732d0dae8fd2f503c9bbe6885fae5994e
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
deferred: []
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
- [x] 위 core/store/fake/PG 경로와 새 `migrations/0016_extension_install_progress.sql`에서 단계 journal·조회 계약과 일관성·경합 방지를 구현한다.
- [x] `packages/core/src/extensions/install.ts`, `apps/cli/src/runtime/extensions.ts`에서 완료 단계 재개·초기 실패 보존·교체 복원·결과 재조회를 구현한다.
- [x] `apps/cli/src/daemon/supervisor.ts`, `daemon/run.ts`, `runtime/extensions.ts`, `packages/core/src/brain.ts`, `queue/schedules.ts`, `apps/cli/src/bin.ts`에서 auth 감독 경로·daemon readiness·예약 SDK·취소 signal을 연결하고 격리 testext 로그인 harness를 추가한다.
- [x] `packages/core/src/brain.ts`, `codes.ts`, `apps/cli/src/commands/ext-install.ts`, `ext-status.ts`, `ext-list.ts`, `README.md`에서 SDK·명령 출력·오류 코드와 안내를 갱신한다. 소스·시험만 편집하며 계획 본문은 구현 노트를 append하는 범위로 제한한다.
- [x] core 단위·PG 계약 및 `apps/cli/test/ext-install-resume.test.ts` 실제 CLI 시험으로 matrix 전부를 검증하고 기존 회귀를 유지한다.

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

- 현 generation의 1단계는 Orca Dispatch `ctx_50569eaf2cdc`가 구현했다. journal migration·revision 비교 갱신·공통 계약과 공개 v1 권한 보존 diff를 지휘자가 확인했다. `pnpm exec vitest run packages/core/test/contracts.test.ts packages/postgres/test/extensions.test.ts packages/postgres/test/extension-permissions.test.ts` 독립 실행은 3 파일 297개 통과했다. 전체 인수와 나머지 단계는 아직 미완료다.

- 2단계 재개·복원·경합 diff 및 실제 CLI 순차 검증 24개를 확인했다. 기본 병렬 실행의 전역 역할 충돌은 3단계에서 고유 시험 확장 이름으로 해결했다. 3단계 인증 감독·활성 일감 재사용·비밀 진단 보호 diff를 확인했고 기본 병렬 CLI/core 독립 검증 3 파일 85개가 통과했다.

- 리뷰 후 재구현은 같은 구현 Dispatch에서 진행했다. 자동 승인 심사가 미커밋 소스의 직접 복원을 거절하여 경로 한정 일반 stash로 먼저 보존하고 기준 상태를 확인했다. 보존 SHA는 `0d6b566c5aa69b862b4838402c2e8093127f3a15`이며, staged-only 정리 실패 때 생성된 `29ae9fc7a4a7fd3b99eec0ea09788a07cc11a990`도 삭제하지 않았다. 이후 KEEP 구조를 재사용했다. 사전 실패·Python 식별 보완은 독립 5개와 선택 Python 10개, 잠금·auth 취소 보완은 독립 84개가 통과했다.

## Plan Change Log

### 2026-10-31 — 리뷰 후 재구현 1

네 finding은 모두 이번 변경이 만든 실제 결함이며 기존 intent-contract의 성공 사실 보존·안정적인 패키지 식별·취소와 데몬 자식 정리 요구로 해결할 수 있다. 작은 patch만으로 닫기에는 잠금·인증의 취소 전달과 관찰 시험이 빠졌으므로 `bad_plan`으로 분류하고 실행 항목을 다음과 같이 보완한다. 시도한 소스 diff는 `/tmp/brain135-kept-code.patch`에 보존한 뒤 구현자가 소스·시험 변경을 되돌리고 아래 계약으로 재구현한다.

- KEEP: journal migration·revision 비교·비밀 진단 차단·기존 공개 v1 ACL, 패키지 배치·환경·role·DDL 재개와 교체/tokenstore 복원, 기존 데몬 auth·예약 SDK·준비 증거, 중앙 출력 codec·문서, 실제 CLI/PG/Python 인수 시험과 기본 회귀를 보존한다. 이들 검증된 구조를 재사용하되 아래 알려진 잘못된 상태를 복구하지 않는다.
- `packages/core/src/extensions/install.ts` 및 CLI 재개 시험: 패키지 resolve/manifest/tree 사전 검사 실패에서도 기존 digest·완료 단계·authWorkId·scheduleIds를 보존하고 새 실패 사실만 기록한다. 사전 실패를 고친 뒤 최초 DDL 보정과 로그인 재개가 앞 단계를 반복하지 않는지 실제 CLI로 확인한다.
- `apps/cli/src/runtime/extensions.ts` 및 선택 Python 재개 시험: 런타임 생성 Python bytecode/cache를 안정적인 패키지 식별에서 분리한다. Python auth/check가 실제 로컬 모듈을 import한 뒤 반복 설치해도 환경·인증을 다시 실행하지 않고 installed까지 도달하는지 검증한다. 실제 소스 변경은 계속 식별해야 한다.
- `packages/postgres/src/extension-install-lock.ts`, runtime/core 취소 전달 및 실제 CLI 시험: 다른 프로세스가 잠금을 보유한 상태에서도 취소한 대기 CLI가 소유자의 잠금 해제를 기다리지 않고 종료해야 한다. 보유 중인 다른 설치의 journal·단계 사실을 덮어쓰지 않는다. 취소 전 새 자식을 시작하지 않으며 후속 재시도는 정상 진행한다.
- `packages/core/src/extensions/install.ts` 및 SDK/실제 데몬 취소 시험: auth 조회·등록·저장 직후 취소를 관찰하고 기존 requestWorkCancel 경로를 연결한다. 인증 자식/시도가 종료됐다는 근거 전에는 cancelled 완료로 기록하지 않는다. 취소 결과·성공 단계 보존·후속 재시도와 정상 로그인 재사용을 검증한다.

재구현 실행 단위는 (1) 사전 실패·Python 식별 보존과 해당 시험, (2) 잠금·auth 취소와 해당 시험, (3) 전체 matrix·기본/Python 검증으로 한다. 각 단계 phase-ready를 확인하고 같은 활성 Dispatch에서 계속한다. intent-contract는 변경하지 않는다.

## Review Triage Log

### 2026-10-31 — Review pass 1

- verdicts: 4 findings — high 3, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 사전 검사 실패가 기존 journal을 유실한다 — install.ts의 전체 snapshot 교체와 digest 비교를 확인했다. 기존 성공 단계·식별자 보존 및 사전 실패 후 실제 재개 시험을 실행 항목에 추가했다.
  - `[high]` `[bad_plan]` Python 캐시가 패키지 변경으로 판정되어 auth 완료를 잃을 수 있다 — 패키지 해시가 __pycache__를 포함하고 Python 실행은 캐시를 만들 수 있다. 런타임 생성물 분리 및 실제 모듈 import 후 반복 설치 시험을 추가했다.
  - `[medium]` `[bad_plan]` 설치 잠금 대기 중 signal을 처리하지 못한다 — 무제한 pg_advisory_lock에는 취소 전달이 없고 CLI는 기본 signal 종료를 가로챈다. 잠금 소유자의 작업을 보존하는 대기 취소와 실제 CLI 시험을 추가했다.
  - `[high]` `[bad_plan]` auth 조회·등록·저장 중 취소가 login_required로 남고 자식이 계속 돈다 — auth 반환이 afterLogin 취소 관찰보다 앞서고 requestWorkCancel 연결이 없다. 기존 데몬 취소·종료 확인과 경계 시험을 추가했다.

### 2026-10-31 — Review pass 2

- verdicts: 2 findings — high 1, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` 완료 설치의 조기 반환이 실제 예약 삭제·설정 변경을 감추고 옛 ID를 보고한다 — 지원되는 removeSchedule과 ensureDaily 경로를 확인했다. 기존 예약 검증을 건너뛰는 조기 반환을 제거하고 실제 ID·충돌을 재조회하는 직접 수정했다. 실제 CLI 예약 삭제·재등록과 설정 변경 충돌 시험이 통과했다.
  - `[medium]` `[patch]` 자격 증명 확인 실패가 journal에 설치 성공으로 남는다 — secureCredentials 예외 catch가 기록 없이 반환하고 외부 DB URL이면 해당 분기에 도달한다. 기존 configuration 실패 기록 경로를 호출하도록 직접 수정했다. 실제 CLI 자격 증명 실패·status 일치·복구 후 연결 중복 방지 시험이 통과했다.

## Verification

- `pnpm build`, `pnpm typecheck`: 빌드·타입 검사 성공.
- `pnpm exec vitest run packages/core/test/extensions.test.ts packages/postgres/test/extensions.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/ext-install-resume.test.ts apps/cli/test/daemon-supervisor.test.ts packages/postgres/test/extension-permissions.test.ts`: matrix와 기존 보호 경계 통과. 격리 DB·home·role은 기존 harness로 생성·정리한다.
- `pnpm test:python`: uv와 pin Python이 있는 환경에서 실제 frozen 설치·fixture 판정·환경 실패 보존 회귀 통과. 기본 suite에는 Python을 요구하지 않는다.
- `pnpm test`: 전체 기본 suite 통과.
- `git diff --check`: 공백 오류 없음. 각 matrix 행의 실제 시험 이름·실행 결과를 최종 기록한다.

### 현 generation의 독립 검증

- `pnpm build`, `pnpm typecheck`: 통과.
- 계획의 core/PG/CLI/감독자/권한 명령에 `--reporter verbose`를 더한 실행: 6 파일 104개 통과.
- `pnpm test:python`: 2 파일 9개 통과.
- `pnpm test`: 141 파일 3645개 통과, 기존 선택 시험 1개 건너뜀.
- matrix 대조: 정상 반복·로그인·예약은 `기존 데몬이 인증 미완료를 감독하고 완료 뒤 재개하며 활성 일감을 재사용한다`; 최초 DDL 실패·Python 환경 보존은 실제 CLI와 선택 Python 재개 시험; 기존 교체 복원은 `restores the previous package and registry facts when a reinstall migration fails` 및 Python 실패 5종; 취소는 SDK 사전·실행 중 시험과 SIGINT/SIGTERM 두 case; 연결 실패는 `reruns the connection check on reinstall and preserves the original installation time`; 예약 부재·감독자 장애·부분 등록은 readiness·충돌 시험; 기록 실패·동시성은 journal 쓰기 실패와 동시 CLI 시험이 각각 통과했다.

### 리뷰 후 재구현의 독립 검증

- `pnpm build`, `pnpm typecheck`: 통과. 전체 diff와 보존 시도 대비 448줄 보완 diff를 직접 확인했다.
- 계획의 matrix 명령에 `--reporter verbose`를 더한 실행: 6 파일 113개 통과. 사전 실패 보존·실제 데몬 auth 취소·잠금 대기 취소가 추가로 실행됐다.
- `pnpm test:python`: 2 파일 10개 통과. 실제 Python cache 생성 뒤 재개 및 실제 소스 변경 식별을 포함한다.
- `pnpm test`: 최종 141 파일 3660개 통과, 기존 선택 시험 1개 건너뜀. 직전 실행은 기존 OrbStack 초기 setup 시험 1개 실패였고, 코드 변경 없이 해당 파일 16개 단독 통과 후 전체 재실행이 통과했다.
- 리뷰 1의 네 지적은 재구현으로 해결했다. 사전 실패가 기존 지문·단계·식별자를 보존하고, Python cache는 지문에서 제외하며 실제 소스 변경은 구분한다. 잠금 대기는 취소 가능하고 소유자 journal은 유지한다. auth 취소는 기존 데몬 취소와 종료 확정·미확정 구분 및 재시도로 확인했다.

### 최종 patch 이후의 독립 검증

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 통과.
- matrix 명령의 verbose 실행: 6 파일 114개 통과. 실제 예약 삭제·재등록·설정 충돌과 자격 증명 실패·복구도 실행됐다.
- `pnpm test:python`: 2 파일 10개 통과.
- `pnpm test`: 141 파일 3661개 통과, 기존 선택 시험 1개 건너뜀.
- 최종 로그: `/tmp/brain135-build-final.log`, `/tmp/brain135-typecheck-final.log`, `/tmp/brain135-matrix-final.log`, `/tmp/brain135-python-final.log`, `/tmp/brain135-full-final.log`. 전체 diff는 `/tmp/brain135-final.diff`로 검토했다.

## Auto Run Result

Status: built

설치 전 journal과 각 단계의 실제 결과, 안정적인 패키지 식별·완료 단계 재개, 실패 후 복원과 동시 설치 잠금, 기존 데몬 로그인·준비 증거·예약 SDK, SDK/CLI 취소와 자식 종료 확인, 성공·실패의 저장 상태 재조회 출력을 구현했다. 실제 Garmin·실계정은 호출하지 않았다.

리뷰는 quick 두 번을 수행했다. 첫 pass 4건(high 3, medium 1)은 계획의 실행 항목을 보강하고 보존 stash 후 같은 구현자가 재구현해 해결했다. 두 번째 pass의 2건(high 1, medium 1)은 기존 예약 조회·configuration 실패 기록을 이용한 직접 patch와 실제 CLI 회귀 시험으로 해결했다. defer와 reject는 0건이다.

이번 pass의 patch는 high 1, medium 1이므로 `followup_review_recommended: true`다. 마지막 patch 뒤 독립 재리뷰는 하지 않았으며, 예약이 외부에서 삭제·변경되는 동안 실제 예약 ID·설정을 재조회하는 동시성 경계가 후속 검토 대상이다. 최종 독립 시험은 위와 같이 모두 통과했다. 배포 패키지의 sourcemap 원본 부재 경고는 Python suite 성공에 영향을 주지 않았다. 앞선 일시적 기존 PG 설치/정리 시험 실패와 재실행 결과도 검증 기록에 남겼다.

사람만 저장소 밖에서 수행해야 하는 인수 작업은 없다. `awaiting-operator`와 `operator_actions`는 적용하지 않는다. 티켓 파일과 `tickets.toml`을 변경하거나 `tickets.py mark`를 실행하지 않았으며 done을 표시하지 않는다. 오케스트레이터가 자체 검증 후 티켓 완료를 결정한다. 원격 push는 하지 않는다.

### 변경 파일

- `README.md` — 설치 재개 안내와 오류 코드를 문서화했다.
- `_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-untitled-plan.md` — 단계별 계획·검증·리뷰 triage와 최종 실행 결과를 기록했다.
- `apps/cli/python-test/install.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/src/commands/ext-install.ts` — 설치 signal과 성공·실패·목록의 단계 출력을 조립했다.
- `apps/cli/src/commands/ext-list.ts` — 설치 signal과 성공·실패·목록의 단계 출력을 조립했다.
- `apps/cli/src/commands/ext-status.ts` — 설치 signal과 성공·실패·목록의 단계 출력을 조립했다.
- `apps/cli/src/daemon/supervisor.ts` — 감독자의 실제 준비 상태를 갱신하고 실패·종료 때 해제한다.
- `apps/cli/src/dispatch.ts` — 실패 data와 단계 텍스트도 중앙 출력·마스킹 경로로 전달한다.
- `apps/cli/src/doctor/store.ts` — 설정 실패 저장소에 추가 port의 실패 응답을 제공한다.
- `apps/cli/src/runtime/extension-python.ts` — 패키지 식별·배치·복원·Python·자식 그룹·감독자 준비 port를 조립했다.
- `apps/cli/src/runtime/extensions.ts` — 패키지 식별·배치·복원·Python·자식 그룹·감독자 준비 port를 조립했다.
- `apps/cli/src/runtime/process-group.ts` — 패키지 식별·배치·복원·Python·자식 그룹·감독자 준비 port를 조립했다.
- `apps/cli/test/dispatch.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/test/ext-fixture.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/test/ext-install-resume.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/test/ext-install.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/test/install.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `apps/cli/test/setup.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/core/src/brain.ts` — SDK AbortSignal과 예약 시간대 조회를 연결했다.
- `packages/core/src/codes.ts` — 로그인·예약·취소·미확정 오류 코드를 등록했다.
- `packages/core/src/envelope.ts` — 실패 data와 단계 텍스트도 중앙 출력·마스킹 경로로 전달한다.
- `packages/core/src/extensions/check.ts` — 단계 상태·검증·연결 자식 취소와 상태 재조회를 제공한다.
- `packages/core/src/extensions/install-progress.ts` — 단계 상태·검증·연결 자식 취소와 상태 재조회를 제공한다.
- `packages/core/src/extensions/install.ts` — 단계 journal·재개·인증·예약·취소와 실패 재조회를 연결했다.
- `packages/core/src/extensions/status.ts` — 단계 상태·검증·연결 자식 취소와 상태 재조회를 제공한다.
- `packages/core/src/index.ts` — 새 타입·검증·잠금·프로세스 정리 port를 내보낸다.
- `packages/core/src/output/codecs.ts` — 실패 data와 단계 텍스트도 중앙 출력·마스킹 경로로 전달한다.
- `packages/core/src/ports/process.ts` — journal·일감·예약 조회와 프로세스 cwd 계약을 추가했다.
- `packages/core/src/ports/store.ts` — journal·일감·예약 조회와 프로세스 cwd 계약을 추가했다.
- `packages/core/src/queue/schedules.ts` — 실제 예약 고유 키·설정을 재조회해 멱등 등록한다.
- `packages/core/src/queue/supervisor.ts` — 감독자의 실제 준비 상태를 갱신하고 실패·종료 때 해제한다.
- `packages/core/src/testing/contracts/extension-store.ts` — fake/PG의 journal·정확한 일감/예약 조회 공통 계약을 검증한다.
- `packages/core/src/testing/contracts/schedule-store.ts` — fake/PG의 journal·정확한 일감/예약 조회 공통 계약을 검증한다.
- `packages/core/src/testing/contracts/work-store.ts` — fake/PG의 journal·정확한 일감/예약 조회 공통 계약을 검증한다.
- `packages/core/src/testing/fakes/store.ts` — journal revision 비교와 조회 port를 메모리 저장소에 구현했다.
- `packages/core/test/codes.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/core/test/envelope.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/core/test/extensions.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/migrations/0016_extension_install_progress.sql` — 설치 전 journal과 명시적 ACL을 추가했다.
- `packages/postgres/src/extension-install-lock.ts` — 프로세스 간 세션 잠금과 대기 취소를 구현했다.
- `packages/postgres/src/extensions.ts` — journal 저장·조회·revision 비교 쓰기를 추가했다.
- `packages/postgres/src/index.ts` — 새 타입·검증·잠금·프로세스 정리 port를 내보낸다.
- `packages/postgres/src/migrate.ts` — core schema 버전을 16으로 갱신했다.
- `packages/postgres/src/schedules.ts` — 실제 예약 고유 키·설정을 재조회해 멱등 등록한다.
- `packages/postgres/src/work.ts` — ID로 인증 일감과 마지막 시도를 정확히 조회한다.
- `packages/postgres/test/cli.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/extension-permissions.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/migrate.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/schema.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/store.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/unavailable.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `packages/postgres/test/work-store.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.
- `tooling/bootstrap/test/hook.test.ts` — 실제 CLI/PG/Python 인수·회귀와 schema·코드 기대값을 검증한다.

### Orca 정리와 인계

Run `run_599f6af2718b`의 구현 Dispatch `ctx_50569eaf2cdc`와 리뷰 Dispatch `ctx_2236c5679560`, `ctx_2299d09eb98c`가 모두 succeeded로 정식 완료했고 보고서를 확인한 뒤 release했다. 해당 Run의 활성·reclaimable 워커와 미처리 mail은 0건이다. 미확인 워커나 남은 과업은 없다. 전용 제어 셸은 커밋·마지막 checkpoint 뒤 마지막에 닫는다. 보존 stash 두 건은 삭제하지 않았다.

검토한 소스·시험·계획을 한 커밋으로 기록하며 작업 트리 청결을 확인한다. 티켓의 done 표시와 오케스트레이터 검증은 남겨 둔다.
