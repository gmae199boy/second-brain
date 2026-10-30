---
title: 'Python 없는 기본 Brain과 갱신 보존'
type: 'feature'
ticket: '8'
created: '2026-10-30'
status: done
baseline_revision: '19fc2d66a7c4ca36af5a57432c6ca58c03336871'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

확장이 없는 기본 Brain의 설치·bootstrap·hook 수집·doctor가 Python·uv를 탐색하거나 실행하지 않는다는 증거를 만든다. 플러그인 app-ref 갱신은 설치된 확장 환경·설정·DDL·데이터·상태를 보존하고 core 실행기로 확장 마이그레이션의 새 번호만 적용한다.

## Boundaries & Constraints

- 기본 suite는 Node·격리 PostgreSQL만 요구한다. Python·uv를 설치하거나 탐색하는 시험을 기본 suite에 넣지 않는다. 제한 PATH와 runner spy로 제품의 탐색·실행 0회를 확인하고 확장 폴더 부재도 검사한다. 빌드 도구 자체의 호출과 제품 호출을 구분한다.
- 설치 확장은 `<home>/extensions/<name>/`에 남는다. bootstrap 갱신 때 패키지 재설치·Python 환경 재생성·설정 덮어쓰기를 하지 않는다. manifest와 기존 core 마이그레이션 실행기를 사용한다. 기존 번호 DDL을 수정하지 않는다.
- Node testext와 선택 Python pyfixture만 사용하고 실제 Garmin·계정·운영 홈은 건드리지 않는다. 기존 snapshot·비밀 보호와 확장 권한을 보존한다. 마이그레이션 실패를 성공으로 보고하지 않는다.
- 소스·시험 편집은 구현 워커 한 명이 맡는다. 계획 상태·티켓·커밋은 지휘자 소유다. 워커는 한국어 전체 보고를 임시 파일에 쓰고 커밋·티켓 완료·추가 워커 실행을 하지 않는다. 원격 push와 plugin/app-ref 변경은 범위 밖이다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 기본 설치·수집 | 확장 없는 격리 홈, Python·uv 실행 불가 PATH | setup·bootstrap·hook·doctor 성공, 탐색·실행 0회, extensions 부재 | 오류를 숨기지 않음 |
| Node 갱신 | testext 설치·설정·데이터, 바뀐 app-ref | 파일 해시·설정·기존 DDL·행·ext status 동일 | 기존 실패 출력 계약 유지 |
| 새 DDL | 설치 확장의 새 연속 번호 | 갱신 때 새 번호만 1회 적용, 재실행은 무변경 | 실패 시 갱신 성공 금지 |
| Python 갱신 | 선택 pyfixture 설치 홈 | 환경·설정·데이터·상태 보존, uv sync 재실행 없음 | 선택 진입점에서만 실행 |

</intent-contract>

## Code Map

- `tooling/bootstrap/src/bootstrap.ts` — deps.run과 실제 git/build/setup 경로를 제공한다. `tooling/bootstrap/test/bootstrap.test.ts`의 runner 기록 및 `test/hook.test.ts`의 임시 bare 저장소·app-ref 전환·실제 설치·Stop·doctor 기반을 재사용한다.
- `apps/cli/src/install/postgres.ts` — prepareDatabase 뒤 core runMigrations만 호출한다. 설치된 확장의 갱신 DDL 확인을 연결할 경계다. `install/flow.ts`의 실패·완료 보고를 유지한다.
- `apps/cli/src/runtime/extensions.ts` — 패키지 resolve/place/rollback과 관리 DB URL·core migrator 조립을 제공한다. 기본 조립은 extensions 폴더나 Python을 만들지 않는다. 설치된 폴더와 manifest에서 갱신 DDL을 읽되 Python 준비나 패키지 교체를 호출하지 않는다.
- `packages/postgres/src/migrate.ts` 및 마이그레이션 API — 소유자별 적용 이력·연속 번호·잠금·실패 처리를 재사용한다. 실제 파일명은 패키지 exports로 확인한다.
- `apps/cli/test/ext-fixture.ts`, `test/fixtures/extensions/testext/` — 격리 홈·DB·실제 CLI·ledger 기반이다. fixture 설정·확장 schema 데이터로 보존을 관찰한다.
- `apps/cli/python-test/install.test.ts`, `python-test/vitest.config.ts` — 13.3의 별도 `pnpm test:python` 진입점이다. frozen 환경·patch·배포 fixture 판정 시험을 유지하고 갱신 보존을 더한다.
- `vitest.config.ts`, `package.json` — 기본은 test/**/*.test.ts만 발견한다. 선택 Python 시험의 분리를 유지한다.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/install/postgres.ts`, `apps/cli/src/runtime/extensions.ts`와 필요한 인접 모듈 — 설치된 확장 갱신 마이그레이션 확인을 core 실행기에 연결한다. 기본 실행은 Python·uv를 찾거나 확장 폴더를 만들지 않게 유지한다.
- [x] `tooling/bootstrap/test/bootstrap.test.ts`, `test/hook.test.ts` 및 필요 시 `apps/cli/test/` — 제한 PATH·runner 감시로 기본 전체 경로를 검증하고 testext의 실제 app-ref 갱신 전후 파일 해시·설정·DDL·데이터·상태 및 새 DDL 1회 적용·실패를 검증한다.
- [x] `apps/cli/python-test/install.test.ts` 및 재사용 가능한 시험 helper — 선택 Python 설치 뒤 실제 bootstrap 갱신의 보존을 확인한다.
- [x] `README.md` — 기본·선택 시험 명령, 전제 조건과 정리 방법을 적는다.

**Acceptance Criteria:**
- Given Python·uv가 차단된 PATH와 runner 감시 및 확장 없는 격리 홈, when 기본 시험의 setup → bootstrap → hook 수집 → doctor를 실행하면, then 모두 성공하고 제품의 Python·uv 탐색·실행 기록은 0건이며 extensions 폴더가 없다.
- Given testext 설치·설정·확장 데이터가 있는 격리 홈, when 바뀐 app-ref의 bootstrap을 실행하면, then 확장 파일 해시·설정·기존 DDL·데이터 행 수와 ext status가 갱신 전과 같다.
- Given 기존 확장에 새 연속 마이그레이션이 존재하면, when bootstrap 갱신과 반복 실행을 수행하면, then 기존 번호는 다시 실행하지 않고 새 번호만 한 번 적용하며 실패한 DDL은 설치 성공으로 보고하지 않는다.
- Given uv와 pin Python이 준비된 별도 선택 진입점, when pyfixture를 설치하고 bootstrap을 갱신하면, then 환경·설정·확장 데이터·상태가 남으며 기본 suite에는 Python 전제 조건이 생기지 않는다.

## Implementation Notes

- 선행 13.3의 별도 Python 진입점·잠금·정확한 patch·snapshot 보호·rollback 계약을 이어받는다. 작업 시작 때 트리는 깨끗했고 git 메타데이터 갱신이 성공했다. 현재 설치 갱신 경로에는 확장 DDL 재확인이 없다.
- 별도 research-* 폴더에서 이 티켓의 codebase 문서를 찾지 못했다. 현재 소스와 선행 계획을 직접 대조했다.

- 구현자 Orca Task `task_ef67a25299e1` / Dispatch `ctx_11007fb5a3f5`가 소스와 시험을 작성했다. 최초 보고의 탐색 감시·전체 해시 증거 부족을 지휘자가 확인해 같은 활성 Dispatch에서 보완했다.
- 설치 갱신은 registry의 설치 목록만 읽는다. 미등록 폴더와 중단된 staging은 무시하고, 설치 manifest·마이그레이션 디렉터리를 검증한 뒤 core 실행기를 부른다. 기존 환경 준비·패키지 교체는 호출하지 않는다.
- 선택 Python 갱신 시험은 중복 bootstrap harness를 만들지 않고 `tooling/bootstrap/test/hook.test.ts`의 opt-in 사례를 `apps/cli/python-test/vitest.config.ts`에서 함께 발견하도록 구현했다. 기존 pyfixture 설치·공유 판정 시험은 유지했다.
- 실제 제품 Node 프로세스에는 허용 목록 PATH와 child_process·주요 fs API spy를 적용한다. pnpm 의존성 설치·빌드는 별도 원래 PATH로 실행한다. 셸 builtin은 감시 대상이 아니므로 `plugin/bin/session-start.sh`와 `brain.sh`도 직접 읽어 Node만 탐색하고 Python·uv 탐색이 없음을 확인했다.
- 지휘자가 baseline 이후 staged diff 전체를 읽었다. 새 번호 적용·반복 무변경·잘못된 DDL 실패·재시도 복구, Node 및 Python 트리 해시·설정·상태·DB 데이터 보존을 시험으로 관찰한다.

## Plan Change Log

## Review Triage Log

### 2026-10-30 — Review pass

- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 갱신 경로의 manifest·SQL leaf 링크 검사가 빠졌다 — 기존 checkTree는 링크를 거부하지만 새 함수는 디렉터리만 검사했고 runMigrations의 readFile은 SQL 링크를 따른다. 로컬 파일 교체로 패키지 밖 DDL이 실행되는 실제 경로다. manifest와 실행 SQL을 lstat로 일반 파일 검사하도록 직접 수정했고, 실제 외부 링크의 거부·외부 DDL 미실행·완료 기록 불변 회귀 시험이 통과했다.
  - `[low]` `[patch]` 확장 DDL 적용 결과가 설치 보고에서 빠졌다 — extensions.applied를 버려 flow.ts의 로그가 실제 DDL 적용 후에도 0건이라고 했다. 실제 DB 변경 자체는 성공하므로 보고 오류로 분류했다. core·확장 적용 목록을 합치고 실제 bootstrap 로그의 “적용 1건” 회귀 시험이 통과했다.
- 두 항목 모두 공개 API나 새로운 상태를 추가하지 않는 직접 교정이다. 리뷰 보류·기각은 0건이며 후속 리뷰 권고 계산은 medium patch 1건·low patch 1건으로 false다. 독립 quick 리뷰 Dispatch `ctx_667e6b99e70c`의 보고를 수락하고 release했다.

## Verification

- `pnpm test` — 빌드·타입·기본 전체 suite 성공. 새 기본 시험 이름과 상세 명령은 구현 후 기록한다. Docker/OrbStack과 Node·pnpm이 필요하며 Python은 불필요하다.
- `pnpm test:python` — uv와 pyfixture의 .python-version에 맞는 로컬 Python·격리 PG가 필요하다. 기존 설치·공유 판정 및 새 갱신 보존 시험이 모두 성공한다.
- `git diff --check` — 공백 오류가 없다. 시험 helper가 격리 홈·DB·임시 저장소를 정리한다.

### 실행 명령과 관찰값

- `pnpm test`: 지휘자 독립 실행에서 빌드·타입 검사, 130개 파일·3507건 통과, 선택 Python 갱신 1건 건너뜀.
- `pnpm exec vitest run tooling/bootstrap/test/bootstrap.test.ts tooling/bootstrap/test/hook.test.ts`: 기본 경계의 상세 명령이다. 기본 전체 실행에도 포함된다.
- 기본 시험 이름은 “bootstrap에서 Python이나 uv를 탐색하거나 실행하지 않는다”, “설치된 확장을 갱신할 때 보존하고 새 마이그레이션만 적용한다”이며 기존 최초 설치·Stop 수집/doctor 사례에 확장 없는 상태·프로세스 기록 검사를 더했다.
- 선택 시험 이름은 “실제 bootstrap 갱신에서 Python 확장 전체를 보존한다”이며 `pnpm test:python`으로만 활성화한다.

- `pnpm test:python`: 지휘자 독립 실행에서 2개 파일·8건 통과. matrix의 Python 보존도 실행됐다. 배포 tarball의 원본 TS 부재로 sourcemap 경고가 있으나 판정과 실제 갱신은 통과했다.
- `git diff --check`: 통과. matrix 네 행은 기본 설치/Stop·doctor, Node 갱신 및 새 DDL·반복·실패/복구, 선택 Python 갱신 사례로 모두 실행·통과했다.

### 리뷰 수정 후 최종 검증

- `pnpm test`: 빌드·타입 검사와 130개 파일·3507건 통과, 선택 Python 갱신 1건 건너뜀.
- `pnpm test:python`: 2개 파일·8건 통과. 정상 frozen 설치·공유 fixture 판정·uv 부재 및 실제 bootstrap 갱신 보존을 확인했다.
- `git diff --check`: 통과. 네 matrix 행과 링크 거부·외부 SQL 미실행·새 DDL 1건 보고를 최종 suite에서 모두 재실행했다.

## Auto Run Result

Status: built

- Python·uv가 없는 허용 목록 PATH와 제품 프로세스/파일 접근 spy로 실제 bootstrap 설치·hook 수집·doctor의 탐색/실행 0건 및 확장 폴더 부재를 확인했다.
- 플러그인 app-ref 전환 뒤 설치 확장의 전체 파일 트리·설정·DB 데이터·상태가 유지된다. registry에 설치된 확장만 core 실행기로 재확인하며 새 연속 DDL만 적용한다. 반복 실행은 무변경이고 실패 시 완료 기록을 갱신하지 않는다.
- 선택 Python 시험은 frozen 환경과 공유 fixture 판정을 유지하면서 실제 bootstrap 갱신의 전체 환경 보존 및 uv 재실행 0건을 확인한다.
- 리뷰 결과는 2건이며 medium patch 1건(파일 링크 경계), low patch 1건(실제 적용 건수)을 수정했다. 보류 0건, 기각 0건, 미해결 지적 0건이다. `followup_review_recommended: false`다.
- 최종 검증은 `pnpm test`의 빌드·타입 검사와 130개 파일·3507건, `pnpm test:python`의 2개 파일·8건, `git diff --check`가 모두 통과했다. 기본 실행에서 선택 Python 1건은 의도대로 건너뛰고 선택 실행에서 통과했다.
- 감시는 Node의 child_process·주요 fs API를 대상으로 한다. 셸 builtin은 소스 직접 검사로 보완했다. 배포 tarball의 원본 TS 부재에 따른 sourcemap 경고는 기존 제한이며 실행 결과는 통과했다.
- 사람만 수행할 외부 작업은 없어 `awaiting-operator` 대상이 아니다. 티켓을 done으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 최종 티켓 판정은 오케스트레이터 소유이며 원격 push는 하지 않는다.

### 변경 파일

- `README.md` — 기본·선택 시험의 전제와 격리 자원 정리를 설명한다.
- `_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-python-brain-python-plan.md` — 계획·검증·리뷰 분류·최종 결과를 기록한다.
- `apps/cli/python-test/vitest.config.ts` — 실제 bootstrap의 Python 갱신 사례를 선택 진입점에서 활성화한다.
- `apps/cli/src/install/postgres.ts` — 등록된 확장 DDL 재확인과 실제 적용 목록을 설치 결과에 연결한다.
- `apps/cli/src/runtime/extensions.ts` — 설치 manifest와 DDL 경로·파일 경계를 검증한다.
- `apps/cli/test/postgres-setup.test.ts` — registry 조회를 설치 mock 계약에 반영한다.
- `tooling/bootstrap/test/bootstrap.test.ts` — bootstrap runner의 Python·uv 호출 부재를 검증한다.
- `tooling/bootstrap/test/fixtures/process-spy.cjs` — 제품 Node의 명령 실행·파일 탐색 감시를 제공한다.
- `tooling/bootstrap/test/hook.test.ts` — 실제 설치·수집·doctor 비의존과 Node/Python 갱신 보존·새 DDL·실패·링크 거부·적용 보고를 검증한다.

### Orca 정리

- Run `run_dd01b9ebdbf6`의 구현 Task `task_ef67a25299e1`과 리뷰 Task `task_a105edf62b00`의 succeeded 보고 및 전체 보고 파일을 수락했다. 두 Dispatch는 모두 released이며 transcript archive가 captured다.
- 마지막 inbox ack 결과 count 0이며 worker-list에서 released 2개를 확인했다. 남은 활성·reclaimable 워커와 미확인 상태는 없다.
- reclaimable 전용 조회도 0개다. 모든 워커와 mail을 정리한 뒤 전용 제어 셸을 닫았으며 closed 영수증을 확인했다.
