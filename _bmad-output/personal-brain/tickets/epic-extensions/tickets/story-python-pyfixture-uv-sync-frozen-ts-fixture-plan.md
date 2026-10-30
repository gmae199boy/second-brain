---
title: 'Python 확장 frozen 설치와 pyfixture 공유 판정'
type: 'feature'
ticket: '3'
created: '2026-10-30'
status: done
baseline_revision: 891d85d3369274a1f7a9895487261f8218b9a147
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: '검토 필요: [ASSUMPTION] pyfixture의 patch pin은 로컬 사용 가능한 3.12.13이며 Python 자동 다운로드 없이 설치한다.'
---

<intent-contract>

## Intent

Python 확장을 패키지의 잠금 파일로 설치하고 실제 patch 버전을 확인한다. 시험 전용 pyfixture가 실제 CLI 설치·연결 확인을 통과하고 core 배포 ABI v1·manifest v1 fixture마다 TS와 같은 판정을 내게 한다.

## Boundaries & Constraints

- 설치 위치는 `<home>/extensions/<name>/`다. `uv sync --frozen --no-dev`를 그 위치에서 실행하고 `.venv` 인터프리터의 실제 patch를 `.python-version`과 비교한다. 잠금 파일을 재생성하지 않는다.
- manifest 명령의 `runtime`은 기존 `node` 또는 새 `python`이다. 하나라도 Python이면 환경 준비가 필요하다. 연결 확인·work·auth 모두 runtime에 맞는 실행 파일을 고른다. Node는 `process.execPath`, Python은 해당 설치의 `.venv/bin/python`이다.
- `[ASSUMPTION]` pyfixture pin은 조사에서 다운로드 없이 발견한 3.12.13이다. 로컬 Python을 사용하고 uv의 자동 Python 다운로드는 끈다. 가정은 코드 주석에도 남긴다.
- Python 의존 파일이 없거나 pin이 정확한 `major.minor.patch`/3.12 이상이 아니면 `EXTENSION_PYTHON_PIN_INVALID`; uv 부재는 `EXTENSION_UV_NOT_FOUND`; pin을 제공할 로컬 Python 부재는 `EXTENSION_PYTHON_NOT_FOUND`; sync 실패는 `EXTENSION_PYTHON_SYNC_FAILED`; 생성 환경 patch 불일치는 `EXTENSION_PYTHON_VERSION_MISMATCH`다. 공개 메시지는 값 없는 한국어 고정 문구다.
- 환경 단계는 마이그레이션·연결보다 먼저 수행한다. 실패는 registry의 별도 Python 환경 단계 사실로 기록하며 미설치를 설치 성공이나 연결 실패로 꾸미지 않는다. 기존 설치·연결 사실은 보존한다. 응답과 `ext status`는 registry를 재조회한다. DB 기록 실패는 DB 오류로 반환한다.
- 패키지 교체의 기존 백업·tokenstore 보존을 재사용하고 환경 실패·마이그레이션 실패 시 이전 설치를 복원한다. 절대 경로가 들어가는 `.venv`를 만든 뒤 다른 경로로 옮기지 않는다. 임의 셸·패키지 경로 사용자 옵션을 추가하지 않는다.
- core는 Python 코드를 import하지 않는다. DB URL·snapshot은 기존 ABI env와 13.2 보호 모드를 유지한다. uv/Python의 원문 출력·부모 비밀 환경은 공개 상태나 로그로 복사하지 않는다. pyfixture는 DB에 쓰지 않는다.
- Python·uv 조회/실행은 Python 확장 설치 때만 한다. 기본 `pnpm test`는 Python 없이 실행 가능해야 한다. pyfixture는 기본 홈이 아닌 시험 resolver로만 설치한다.
- 실제 Garmin·옛 lock 재현성·확장 role(13.4)·전체 단계 재개(13.5)·운영 배포는 범위 밖이다. 티켓 done 판정은 오케스트레이터 소유다. 원격 push는 하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 정상 설치 | 격리 홈·DB, uv와 pin Python 존재 | frozen 환경·정확한 patch·connected, 단계 성공 재조회 | 없음 |
| uv 부재 | PATH에 uv 없음 | Python 단계 실패 기록, DDL·연결 실행 없음 | EXTENSION_UV_NOT_FOUND |
| Python 부재 | uv 존재, pin Python 없음 | 다운로드 없이 단계 실패 | EXTENSION_PYTHON_NOT_FOUND |
| 잘못된 패키지 | 파일 누락·부정확한 pin | 단계 실패, 연결 없음 | EXTENSION_PYTHON_PIN_INVALID |
| sync 실패 | 잠금 불량 또는 실행 실패 | 단계 실패, 이전 설치·tokenstore 보존 | EXTENSION_PYTHON_SYNC_FAILED |
| patch 불일치 | 생성 Python 버전이 pin과 다름 | 단계 실패, 연결 없음 | EXTENSION_PYTHON_VERSION_MISMATCH |
| Node 설치 | Python 없는 환경·testext | 기존 설치·connected, Python/uv 호출 0회 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/install.ts` — 현재 place→migrate→record→check 순서다. Python 준비 port와 단계 기록을 삽입한다. snapshot·runExtensionCheck 보호를 재사용한다.
- `apps/cli/src/runtime/extensions.ts` — checkTree·staging·백업·tokenstore 보존·시험 resolver를 재사용한다. 현재 launcher가 모든 명령을 Node로 덮어쓰고 migrator가 백업을 확정하므로 환경 준비/실패 복구와 실행 선택을 연결해야 한다.
- `apps/cli/src/daemon/supervisor.ts` — 설치 manifest의 work/auth도 Node 고정이다. 기존 비동기 snapshot 준비·소유권 검사를 유지한다.
- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json` — runtime을 확장하고 공유 fixture와 Python 의미 검사도 맞춘다.
- `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/extension-store.ts`, `packages/postgres/src/extensions.ts` — 기존 registry는 성공 설치 행만 있다. 별도 환경 단계 port·사실과 PG/fake 계약을 더한다.
- `packages/postgres/migrations/0012_extension_work_kinds.sql` — 현재 마지막 번호다. 새 0013을 쓰고 기존 migration은 고치지 않는다.
- `apps/cli/src/commands/ext-status.ts`, `ext-install.ts`, `ext-list.ts`, `packages/core/src/codes.ts` — 재조회 단계 출력과 오류 등록 경계다.
- `apps/cli/test/ext-fixture.ts` — 실제 CLI·격리 PG/home·resolver·cleanup 기반이다. `vitest.config.ts`는 test/**/*.test.ts만 기본 발견한다.
- `packages/core/fixtures/process-abi/v1/`, `fixtures/extensions/v1/`, `schemas/`, `packages/core/test/process-abi.test.ts` — env/events/runs/snapshot·manifest 판정과 core tarball 포함 검사를 재사용한다. runs는 schema만으로 판정할 수 없어 Python 의미 판정도 필요하다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/extensions/manifest.ts`, 배포 manifest schema·fixture·`check-manifests.py`: Python runtime과 동일 판정 사례를 추가한다.
- [x] `packages/core/src/ports/store.ts`, fake·계약·`packages/postgres/src/extensions.ts`, `migrations/0013_extension_python_environment.sql`, migration 고정 목록 시험: 미설치 상태에서도 환경 단계 성공/실패·코드·시각을 기록/조회한다.
- [x] `packages/core/src/extensions/install.ts`, `apps/cli/src/runtime/extensions.ts`, 새 `apps/cli/src/runtime/extension-python.ts`, `apps/cli/src/daemon/supervisor.ts`: 환경 준비·rollback·runtime 실행 선택을 구현한다. 기존 Node와 진단 보호를 보존한다.
- [x] `packages/core/src/codes.ts`, `apps/cli/src/commands/ext-status.ts`와 관련 출력: 단계 사실·코드를 출력한다.
- [x] `apps/cli/test/fixtures/extensions/pyfixture/`: manifest·pyproject.toml·uv.lock·.python-version·연결 명령·공유 fixture 판정기를 만든다. jsonschema는 lock에 고정하고 DB 쓰기 없이 ABI result를 낸다.
- [x] `apps/cli/test/extension-python.test.ts`, core 확장·store 시험: matrix의 모든 실패와 Node 비의존·재설치 복원을 fake 실행기로 검증한다.
- [x] `apps/cli/python-test/`, `package.json`, 관련 README: `pnpm test:python` 별도 진입점으로 실제 CLI 설치와 core tarball 배포 fixture의 파일별 TS/Python 판정을 비교한다. 기본 자동 발견에서 제외한다.

**Acceptance Criteria:**
- Given 격리 홈·PG·uv·pin Python, when `pnpm test:python`을 실행하면, then 실제 `brain ext install pyfixture`가 exit 0, 설치 `.venv` patch가 pin과 같고 `ext status`의 연결은 `connected`이며 Python 단계는 성공이다.
- Given core 패키지 배포본의 manifest와 ABI env/events/runs/snapshot fixture, when 같은 선택 진입점에서 TS와 설치된 Python의 jsonschema 및 의미 검증을 비교하면, then 파일마다 사례 이름·개수·판정이 모두 같다.
- Given PATH에서 uv를 제거한 격리 CLI 환경, when `brain ext install pyfixture`를 실행하면, then 정해진 코드로 실패하고 status 재조회에서 Python 단계 실패를 보이며 migration·연결 성공을 주장하지 않는다.
- Given matrix의 실패 입력과 기존 설치, when 기본 Node 단위/통합 시험을 실행하면, then 각 고정 코드·복구·진단 보호가 관찰되고 모든 matrix 시험이 통과한다.
- Given Python·uv를 실행할 수 없는 기본 시험 환경, when `pnpm test`를 실행하면, then Python 선택 시험을 부르지 않고 전체 기본 시험이 통과한다.

## Implementation Notes

- 변경 전 작업 트리가 깨끗하며 `git add --refresh -- .`가 성공했다. 별도 research-* 폴더는 없다.
- 선행 13.2 plan의 snapshot·진단 보호·tokenstore 보존 계약을 이어받는다. 옛 연구의 Node-only 조사와 현재 설치 코드를 직접 대조했다.
- 읽기 전용 조사 세션 `01a18b55-8ebd-7ee1-8bb5-eb9af0fcaa05`가 uv 0.13.1 및 로컬 Python 3.12.13·3.14.8을 확인했다. 시스템 Python 3.9.6은 쓰지 않는다.

- 구현 세션 `01a18b57-7a6b-7080-ab2f-6e6b1b4cf144`가 소스·시험을 작성했다. 구현 완료 보고 후 오케스트레이터가 staged diff 전체를 직접 읽고 독립 검증했다.
- 선택 Python 진입점은 `pnpm test:python`이며 정상 frozen 설치·patch·connected와 uv 부재 실패 기록, core tarball의 manifest/ABI env·event·run·snapshot 112건 판정을 비교한다. 격리 홈·DB·임시 tarball을 정리한다.
- 환경 실패는 별도 registry 표에 기록한다. 기존 설치의 연결 사실과 tokenstore를 보존하며 실패한 환경을 설치 성공으로 세지 않는다.

## Plan Change Log

## Review Triage Log

### 2026-10-30 — Review pass

- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 독립 quick 리뷰 세션 `01a18b61-c91f-78b3-ab0b-e40d78ec750a`는 diff와 주변 코드를 읽고 확인된 결함이 없다고 보고했다. 수정·보류·기각할 리뷰 지적은 없다.
- 별도 자체 점검의 설명문 교정: 가정 주석의 `[ASSUMPTION]` 표시 및 새 시험 설명의 한국어 표기를 구현 세션에 요청했다. 동작 변경이 없는 직접 교정이며 독립 리뷰 지적 집계에는 포함하지 않는다.

## Verification

- `pnpm build`, `pnpm typecheck`: 빌드·타입 검사 통과.
- `pnpm exec vitest run packages/core/test/extensions.test.ts packages/core/test/process-abi.test.ts apps/cli/test/extension-python.test.ts apps/cli/test/ext-install.test.ts packages/postgres/test/extensions.test.ts`: 변경 경계와 matrix 통과.
- `pnpm test:python`: 실제 frozen 설치·patch·connected·uv 부재 registry·core 배포 fixture 동등 판정 통과. 사전 조건은 uv·Python 3.12.13·시험 PG·잠금 의존성 다운로드 가능성이다. 진입점이 격리 홈·DB를 정리한다.
- `pnpm test`: Python 선택 진입점을 부르지 않으며 전체 기본 suite 통과.
- `git diff --check`: 공백 오류 없음. 새 문서·보고·주석은 한국어이며 절대 홈 경로를 남기지 않는다.

### 최종 실행 증거

- 설명문 교정 후 오케스트레이터가 `pnpm test`를 다시 실행했다. 빌드·타입 검사와 기본 130개 파일·3505건이 통과했다.
- 계획의 변경 경계 명령은 5개 파일·132건 통과, `pnpm test:python`은 1개 파일·2건 통과, `git diff --check`도 통과했다.
- 별도 검증에서 PATH 앞의 `python`·`python3`·`uv`를 항상 exit 97로 실패시키고 기본 `pnpm test`를 실행해 3505건이 통과했다. 시험 도구 실행 중 Python 탐색 4회가 실패했으나 기본 suite는 Python 없이 완료됐다. 제품의 Node 설치는 Python 준비 호출을 거부하는 시험으로 별도 확인했다.
- matrix 대조: 정상 설치는 선택 Python 첫 시험, uv 부재는 선택 Python 둘째 시험 및 기본 어댑터 시험, Python 부재·sync 실패·patch 불일치는 기본 어댑터 parameterized 시험, 파일 누락·불완전 pin은 어댑터 첫 시험, 모든 오류의 기존 설치/tokenstore 복원은 `ext-install.test.ts`의 5개 사례, Node 불요구는 core 확장 시험이 덮으며 모두 실행·통과했다.
- tarball의 manifest 11건·ABI env 21건·event 31건·run 42건·snapshot 7건, 합계 112건의 이름·개수·판정이 TS와 Python에서 일치했다.
- 배포 tarball에는 원본 TS가 없어 Vitest 소스맵 경고가 나지만, 배포된 JS와 schema·fixture를 직접 읽는 시험은 통과했다.

## Auto Run Result

Status: built

- Python 확장을 `uv sync --frozen --no-dev`로 설치하고 `.venv`의 정확한 patch를 검사한다. 연결 확인·work·auth가 manifest runtime의 인터프리터를 사용한다.
- Python 환경 단계는 설치·연결 사실과 별도로 registry에 기록한다. uv/Python 부재·pin 불량·sync 실패·patch 불일치가 고정 코드로 남고, 실패한 교체는 기존 패키지와 tokenstore를 복원한다.
- 시험 전용 pyfixture와 `pnpm test:python`을 추가했다. 기본 suite는 Python 없이 통과하고, 선택 시험은 실제 설치·연결과 core 배포 fixture 112건의 언어 간 판정 일치를 확인했다.
- 독립 quick 리뷰 0건: 리뷰 patch 0건(high 0, medium 0, low 0), 리뷰 보류 0건, 기각 0건이다. 별도 자체 점검의 가정 표시와 한국어 설명문만 직접 교정했다. `followup_review_recommended: false`다.
- 최종 검증: 빌드·타입 검사, 기본 3505건, 변경 경계 132건, Python 통합 2건 및 공백 검사가 통과했다.
- 남은 제약은 로컬 pin Python과 uv가 있어야 선택 설치를 실행할 수 있다는 점, 시험 tarball의 소스맵 경고다. patch pin·자동 다운로드 금지 가정 1건은 frontmatter `deferred`에 명시했다. 실제 Garmin 잠금 검증·권한·전체 단계 재개는 후속 티켓 범위다.
- 사람만 수행 가능한 외부 작업은 없어 `awaiting-operator` 대상이 아니다. 티켓을 done으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 검토한 변경과 계획을 커밋하고 원격 push는 하지 않는다.

### 변경 파일

- [README.md](../../../../../README.md) — Python 오류 코드와 선택 시험 명령을 안내한다.
- [_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-python-pyfixture-uv-sync-frozen-ts-fixture-plan.md](story-python-pyfixture-uv-sync-frozen-ts-fixture-plan.md) — 계획·검증·리뷰 분류와 실행 결과를 기록한다.
- [apps/cli/python-test/install.test.ts](../../../../../apps/cli/python-test/install.test.ts) — 실제 Python 설치·uv 부재와 배포 fixture 동등 판정을 검증한다.
- [apps/cli/python-test/vitest.config.ts](../../../../../apps/cli/python-test/vitest.config.ts) — 실제 Python 설치·uv 부재와 배포 fixture 동등 판정을 검증한다.
- [apps/cli/src/commands/ext-install.ts](../../../../../apps/cli/src/commands/ext-install.ts) — registry를 재조회한 Python 환경 단계와 기존 설치 사실을 출력한다.
- [apps/cli/src/commands/ext-list.ts](../../../../../apps/cli/src/commands/ext-list.ts) — registry를 재조회한 Python 환경 단계와 기존 설치 사실을 출력한다.
- [apps/cli/src/commands/ext-status.ts](../../../../../apps/cli/src/commands/ext-status.ts) — registry를 재조회한 Python 환경 단계와 기존 설치 사실을 출력한다.
- [apps/cli/src/daemon/supervisor.ts](../../../../../apps/cli/src/daemon/supervisor.ts) — manifest에 맞춰 Python 작업·인증 인터프리터를 선택한다.
- [apps/cli/src/doctor/store.ts](../../../../../apps/cli/src/doctor/store.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [apps/cli/src/runtime/extension-python.ts](../../../../../apps/cli/src/runtime/extension-python.ts) — frozen 환경 준비·patch 검증·복구와 런타임 실행을 조립한다.
- [apps/cli/src/runtime/extensions.ts](../../../../../apps/cli/src/runtime/extensions.ts) — frozen 환경 준비·patch 검증·복구와 런타임 실행을 조립한다.
- [apps/cli/test/daemon-run.test.ts](../../../../../apps/cli/test/daemon-run.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [apps/cli/test/dispatch.test.ts](../../../../../apps/cli/test/dispatch.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [apps/cli/test/ext-install.test.ts](../../../../../apps/cli/test/ext-install.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [apps/cli/test/extension-python.test.ts](../../../../../apps/cli/test/extension-python.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [apps/cli/test/fixtures/extensions/pyfixture/.python-version](../../../../../apps/cli/test/fixtures/extensions/pyfixture/.python-version) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/check.py](../../../../../apps/cli/test/fixtures/extensions/pyfixture/check.py) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/judge.py](../../../../../apps/cli/test/fixtures/extensions/pyfixture/judge.py) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/manifest.json](../../../../../apps/cli/test/fixtures/extensions/pyfixture/manifest.json) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/migrations/0001_pyfixture.sql](../../../../../apps/cli/test/fixtures/extensions/pyfixture/migrations/0001_pyfixture.sql) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/pyproject.toml](../../../../../apps/cli/test/fixtures/extensions/pyfixture/pyproject.toml) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/fixtures/extensions/pyfixture/uv.lock](../../../../../apps/cli/test/fixtures/extensions/pyfixture/uv.lock) — 잠금 의존성·patch pin·ABI 연결 확인·공유 판정을 제공한다.
- [apps/cli/test/install.test.ts](../../../../../apps/cli/test/install.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [apps/cli/test/setup.test.ts](../../../../../apps/cli/test/setup.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [package.json](../../../../../package.json) — 독립 Python 시험 진입점을 등록한다.
- [packages/core/fixtures/extensions/v1/check-manifests.py](../../../../../packages/core/fixtures/extensions/v1/check-manifests.py) — 공유 manifest 계약에서 Python 실행을 허용하고 판정을 맞춘다.
- [packages/core/fixtures/extensions/v1/manifests.json](../../../../../packages/core/fixtures/extensions/v1/manifests.json) — 공유 manifest 계약에서 Python 실행을 허용하고 판정을 맞춘다.
- [packages/core/schemas/extensions/v1/manifest.schema.json](../../../../../packages/core/schemas/extensions/v1/manifest.schema.json) — 공유 manifest 계약에서 Python 실행을 허용하고 판정을 맞춘다.
- [packages/core/src/codes.ts](../../../../../packages/core/src/codes.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/extensions/install.ts](../../../../../packages/core/src/extensions/install.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/extensions/manifest.ts](../../../../../packages/core/src/extensions/manifest.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/extensions/status.ts](../../../../../packages/core/src/extensions/status.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/index.ts](../../../../../packages/core/src/index.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/ports/store.ts](../../../../../packages/core/src/ports/store.ts) — Python 환경 설치·상태·오류의 core 계약과 조립을 맞춘다.
- [packages/core/src/testing/contracts/extension-store.ts](../../../../../packages/core/src/testing/contracts/extension-store.ts) — 환경 단계 저장·조회의 fake와 공통 계약을 추가한다.
- [packages/core/src/testing/fakes/store.ts](../../../../../packages/core/src/testing/fakes/store.ts) — 환경 단계 저장·조회의 fake와 공통 계약을 추가한다.
- [packages/core/test/codes.test.ts](../../../../../packages/core/test/codes.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/core/test/extensions.test.ts](../../../../../packages/core/test/extensions.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/migrations/0013_extension_python_environment.sql](../../../../../packages/postgres/migrations/0013_extension_python_environment.sql) — Python 환경 단계의 독립 기록 표를 추가한다.
- [packages/postgres/src/extensions.ts](../../../../../packages/postgres/src/extensions.ts) — Python 환경 단계의 PostgreSQL 저장·조회를 구현한다.
- [packages/postgres/src/migrate.ts](../../../../../packages/postgres/src/migrate.ts) — core schema 버전을 13으로 올린다.
- [packages/postgres/test/cli.test.ts](../../../../../packages/postgres/test/cli.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/test/migrate.test.ts](../../../../../packages/postgres/test/migrate.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/test/schema.test.ts](../../../../../packages/postgres/test/schema.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/test/store.test.ts](../../../../../packages/postgres/test/store.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/test/unavailable.test.ts](../../../../../packages/postgres/test/unavailable.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
- [packages/postgres/test/work-store.test.ts](../../../../../packages/postgres/test/work-store.test.ts) — 변경된 환경·registry·마이그레이션 계약과 실패 복구를 검증한다.
