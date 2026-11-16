---
title: '확장 카탈로그와 이름 설치'
type: feature
ticket: '11'
created: '2026-11-16'
status: built
baseline_revision: '15f84d042c1bd0cebf433f1b6e7c7c899ce64eff'
route: full
route_source: pinned
risk: high
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Garmin 새 설치의 공식 로그인 adapter와 manifest auth 선언이 없다.
    evidence: |-
      기존 Garmin manifest에 auth가 없고 ext-login.ts는 auth 부재를 EXTENSION_INVALID로 거부한다. legacy standalone CLI도 비활성화되어 있다. 중앙 msg_853014176e39는 이번 범위에서 제외하고 별도 13.12 planned 후속 작업으로 보존하도록 결정했다. 기존 토큰이 있는 설치의 connected·login skipped는 인증이 불필요하다는 뜻이 아니라 재인증이 불필요한 현재 상태다.
    location: >-
      plugins/garmin/package/manifest.json; apps/cli/src/commands/ext-login.ts
    severity: medium
operator_actions:
  - >-
      13.12에서 Garmin 새 설치의 공식 로그인 경로를 구현·검증한다. 13.11은 인증 미지원·미완료를 숨기지 않으며 기존 토큰을 시험에 사용하지 않는다.

---

<intent-contract>

## Intent

**Problem:** 사용자는 설치 가능한 확장과 패키지 경로를 알 수 없고 core 스킬은 이름을 요구한다. 이름 설치는 Garmin의 검증된 외부 패키지 설치 경로에 연결되지 않는다.

**Approach:** core 앱에 포함된 패키지 manifest를 검증해 카탈로그를 제공하고 이름 설치를 기존 패키지 설치와 합친다. CLI와 에이전트는 같은 목록·이름·설치 결과를 사용한다.

## Boundaries & Constraints

**Always:** manifest·digest 검증, 설치 잠금·재개·교체 journal 보존. 기존 `ext list` 배열 계약을 보존하고 별도 공개 `ext catalog`로 설치 가능한 항목과 설치 여부를 제공한다. testext는 기본 홈과 다른 실제 홈 및 명시적 시험 harness에서만 노출한다. 선택 전 설치하지 않는다. 시험 코드는 작성하되 개발·리뷰 수정 중 실행 금지, 컴파일 확인만. 최종 수정 뒤 관련 파일만 시험한다.

**Never:** 운영 설치본·daemon·DB 변경, main 병합·push, app-ref·plugin version 변경, 새 marketplace, 임의 경로 이름 결합, 로그인 성공 추정, 비밀 출력, 홈 절대경로 기록. 13.10 실제 세션 확인을 이번 티켓 완료로 대체하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| 목록 | core bundled manifest와 빈/설치 registry | `ext catalog --json`의 data 배열에 name/version/description/login_required/installed, meta.count. Garmin 포함, testext 숨김. 읽기로 Python 실행·설치하지 않음 | 손상·digest 불일치는 EXTENSION_INVALID, 부분 성공 없음 |
| 이름 설치 | 유효 catalog 이름 또는 알 수 없는 이름 | 이름을 고정 후보와 대조하고 새 snapshot을 기존 prepared 설치 경로로 전달 | unknown은 EXTENSION_NOT_FOUND, 이름+package 동시 입력 기존 거부 유지 |
| 재개·교체 | 실패 journal/완료 설치/교체 대기와 같은 패키지 | --package와 같은 단계 재개·동일 버전 digest·교체 해제·관측·잠금 계약 | 불일치·취소는 기존 고정 코드 |
| 시험 fixture | 격리 홈과 SECOND_BRAIN_TEST_EXTENSIONS | harness의 fixture만 목록·이름 설치에 사용, 기존 구형 fixture resolver 유지 | 기본 홈·동일 실제 홈 우회 노출 금지 |
| 에이전트 | 이름 없는 요청/사용자 선택/이름 있는 요청 | 목록 제시→선택 대기→status→동일 이름 install→로그인 안내·재개·재조회 보고 | 실패·미완료를 완료로 보고하지 않음 |

</intent-contract>

## Code Map

- `apps/cli/src/runtime/extensions.ts`: testExtensionsFolder 실제 홈 격리, packages.resolve, 기존 runtime 조립. `install/installed.ts` appRootPath로 앱 root를 찾는다.
- `apps/cli/src/runtime/extension-package.ts`: prepareExtensionPackage의 파일 집합·symlink·digest 검사와 cleanup 재사용. `extension-transition.ts`의 journal·owner는 유지.
- `packages/core/src/extensions/install.ts`: ExtensionPackages 및 installExtension의 prepared 흐름. 이름을 단순 resolve로 연결하면 교체 재개가 빠지므로 공통 prepared 경로로 연결한다.
- `packages/core/src/brain.ts`, CLI commands/index 및 ext-list/install/guide-schema: SDK 1:1와 schema. ext list는 그대로 유지.
- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json`, 배포 fixtures: 선택적 설명·로그인 메타데이터를 엄격 검증. Garmin은 auth가 없으므로 auth 존재만으로 login_required를 추론하지 않는다.
- `plugins/garmin/package/manifest.json`, `extensions/garmin/manifest.json`: 원본/배포 동기화·digest 도구를 따른다. 기존 로그인 절차를 조사해 사실대로 안내하고 auth 자체를 무관하게 재설계하지 않는다.
- core `plugin/skills/brain-install`, Garmin `plugins/garmin/skills/brain-garmin-install`, `tooling/bootstrap/test` coverage와 install skill 시험, `tooling/skill-coverage/internal.json`.

## Tasks & Acceptance

**Execution:**
- [x] 1. Manifest와 runtime 카탈로그 경계: 선택적 description/login_required 메타데이터·schema·fixtures, Garmin 메타데이터·필요한 패키지 버전/digest 동기화, 고정 bundled 후보·검증 snapshot·격리 harness 조회를 구현하고 단위 시험을 작성한다.
- [x] 2. SDK·CLI·이름 설치 경계: catalog SDK/CommandSpec/JSON schema와 installed 결합, 이름의 prepared 설치 연결, 기존 package·fixture·재개·교체 유지. CLI·core의 목록/unknown/digest/취소/재개·교체 회귀 시험을 작성한다.
- [x] 3. 사용자 진입점: core 스킬의 목록→선택, Garmin 스킬과 shell의 이름 설치, npx README, guide·CLI/스킬 coverage 및 internal 사유 갱신과 관련 시험을 작성한다.

**Acceptance Criteria:**
- Given core 앱과 빈 격리 홈, When 공개 카탈로그를 조회하면, Then manifest 기반 이름·버전·설명·로그인 필요·미설치 여부가 보이고 설치 뒤 installed만 실제 registry로 반영된다. testext는 일반 목록에 없다.
- Given 선택한 Garmin 이름, When `brain ext install garmin`을 실행하면, Then 패키지 경로 없이 기존 검증·설치·재개·교체 경로를 사용하며 unknown은 고정 코드로 실패한다.
- Given 공개 guide schema와 JSON 출력, When catalog 계약을 확인하면, Then 정확한 필드와 고정 오류가 공개되고 기존 list 및 --package 계약이 유지된다.
- Given npx로 설치한 core 사용자 또는 이름 없는 에이전트 요청, When README 또는 배포 스킬을 따르면, Then 같은 catalog·선택·이름 설치를 사용하고 사용자 비밀을 요청하지 않으며 실제 상태로 미완료를 구분한다.
- Given 13.11 완료, When 티켓 상태를 조회하면, Then 13.10은 13.11을 기다리며 실제 새 에이전트 세션 증거가 없으면 blocked로 남는다.

## Implementation Notes

- Execution 1: 선택적 manifest description/login_required·공유 fixtures·검증 snapshot 카탈로그 runtime·격리 catalog/testext 시험을 작성했다. Garmin 패키지 메타데이터 변경의 동일 버전 digest 충돌을 피하려고 확장 버전을 1.2.14로 올리고 공식 package builder로 동기화했다. plugin version/app-ref는 변경하지 않았다. build/typecheck/diff check 종료 0, 시험 미실행. 상세 보고 `.brain-automation/ext-catalog-impl-1.md`.

- Execution 2: catalog SDK·CommandSpec·guide outputSchema와 registry installed 결합, 이름을 prepareCatalog snapshot→기존 prepared 설치에 연결했다. legacy fixture 보존을 위해 testext 카탈로그는 격리 홈·SECOND_BRAIN_TEST_EXTENSIONS와 추가 SECOND_BRAIN_TEST_CATALOG=1에서만 켠다. catalog 동사를 예약하고 TS/Python 공유 codec 및 회귀 시험을 보강했다. build/typecheck/diff check 최종 종료 0, 시험 미실행. 보고 `.brain-automation/ext-catalog-impl-2.md`.

- Execution 3: core 스킬의 카탈로그→선택 대기, Garmin 이름 진입점·README·coverage·선택 행동 판정기 시험을 작성했다. build/typecheck/diff check 종료 0, 시험 미실행. 구현자는 기존 공식 인증 경로 부재를 failed로 보고했으며 중앙 msg_853014176e39가 인증 adapter를 별도 후속 13.12로 결정해 범위를 해결했다. 이번 변경은 미지원/인증 미완료를 그대로 보고한다. 보고 `.brain-automation/ext-catalog-impl-3.md`.

## Plan Change Log

## Review Triage Log


### 2026-11-16 — Review pass 1

- verdicts: 16 findings — high 0, medium 14, low 2, false 0, maybe-false 0
- findings (전문 보고 순서, 중복도 개별 판정):
  - `[medium]` `[patch]` BH-1 임시 fixture의 /var·/tmp symlink 경로 — package worker는 루트부터 O_NOFOLLOW를 쓰며 기존 package 시험은 realpath를 쓴다. 새 두 시험의 fixture 경로만 정규화한다.
  - `[medium]` `[patch]` BH-2 연결 실패를 인증 미완료로 오보고 — DB 연결 검사 실패로 인증을 증명할 수 없다. Garmin 스킬 문장을 분리하고 기존 connected/login skipped를 보존한다.
  - `[medium]` `[patch]` BH-3 description U+FEFF의 TS/Python 판정 불일치 — TS trim과 Python regex 공백 집합 차이가 실제 공유 계약을 깨뜨린다. 명시 공백 집합과 공유 fixture로 일치시킨다.
  - `[medium]` `[patch]` BH-4 거절 응답을 선택으로 인정 — selected 정규식은 이름 언급만 검사한다. 고정 fixture의 정확한 긍정 응답·거절/질문/보류 부정 시험을 사용한다.
  - `[low]` `[patch]` BH-5 다섯 필드 안내 평가 누락 — shown은 이름만 검사하며 정상 transcript도 정보를 생략한다. 고정 출력 항목과 각 정보 누락 부정 시험을 보강한다.
  - `[low]` `[patch]` BH-6 choose_wait의 다음 선택 요청 검증 누락 — 최종 보고가 단순 확인이어도 통과한다. 대기·선택 요청 보고를 직접 검사한다.
  - `[medium]` `[patch]` BH-7 catalog 미지원·조회 실패·빈 목록 fixture 없음 — 스킬은 이 상태에서 중단하도록 하지만 fake가 항상 성공이다. 고정 실패/빈 응답과 임의 설치 거부 시험을 추가한다.
  - `[medium]` `[patch]` BH-8 metadata만 빠진 유효 digest package 시험 누락 — 일반 manifest에서 선택 필드이므로 catalog 별도 요구를 독립 검증해야 한다. 각 필드만 제거한 뒤 digest를 재생성해 목록·이름 설치 거부를 검사한다.
  - `[medium]` `[patch]` BH-9 registry 읽기 실패 전파 시험 누락 — catalog 정상/registry 실패 분기를 직접 검증하지 않는다. DB_UNAVAILABLE 전파 단언을 추가한다.
  - `[medium]` `[patch]` BH-10 두 번째 후보 선택과 설치 대상 연결 시험 누락 — 기존 fake는 testext 하나뿐이다. 복수 후보에서 두 번째 선택·정확한 이름 status/install 및 첫 항목 거부를 검사한다.
  - `[medium]` `[patch]` EC-1 비인증 연결 실패의 인증 미완료 단정 — BH-2와 같은 문장·반례를 확인했다. 같은 수정으로 해결한다.
  - `[medium]` `[patch]` EC-2 선택 거절 인정 — BH-4와 같은 selected 분기다. 같은 수정으로 해결한다.
  - `[medium]` `[patch]` VG-1 사용자 선택 행 생략 부정 시험 누락 — pre-verified gap을 수락한다. 정상 호출·상태를 유지하고 선택 행만 제거해 실패를 단언한다.
  - `[medium]` `[patch]` VG-2 거절 인정 — selected 식에서 긍정 응답인지 검사하지 않는다. BH-4와 같은 수정으로 해결한다.
  - `[medium]` `[patch]` IA-1 인증 기능 미지원과 현재 인증 상태 혼동 — brain-login은 현재 조회 없이 Garmin을 미완료로 단정하고 Garmin install도 연결 실패를 인증 실패로 보고한다. 두 스킬 모두 현재 상태 근거와 기능 지원을 구분한다.
  - `[medium]` `[patch]` IA-2 선택 거절을 동의로 인정 — evaluator 동등성 위반이며 CLI 동의 버그라는 뜻은 아니다. BH-4와 같은 수정으로 해결한다.
- 기존 Garmin auth 부재 자체는 중앙 결정으로 13.12에 보존한 pre-existing deferred이며 이번 16개 수정 항목과 구분한다. internal.json은 새 내부 전용 예외가 없어 변경하지 않은 것이 계약에 맞고 공개 catalog coverage 시험이 이를 증명한다.

- 수정 1: BH-1/3/8/9의 fixture realpath·명시 공백 집합·유효 digest metadata 누락 및 registry 오류 전파 시험을 구현했다. build/typecheck/diff check 종료 0, 시험 미실행. 보고 `.brain-automation/ext-catalog-fix-1.md`.

- 수정 2: BH-2/4/5/6/7/10·EC-1/2·VG-1/2·IA-1/2의 스킬 상태 분리·긍정 선택·누락/거절·복수 선택·오류 중단 판정 및 자기시험을 보강했다. build/typecheck/diff check 종료 0, 시험 미실행. 보고 `.brain-automation/ext-catalog-fix-2.md`.

### 2026-11-16 — Follow-up review pass 2

- 앞선 16건 중 15건은 정적 해결, BH-3은 부분 해결. 새 finding 1건 — high 0, medium 1, low 0, false 0, maybe-false 0.
- `[medium]` `[patch]` F-1 description 끝 LF에서 Python schema의 `$`가 마지막 LF 직전을 끝으로 인정 — TS decoder의 제어문자 검사는 거부한다. 스키마 끝 조건을 실제 문자열 끝으로 고정하고 LF·CRLF 공유 fixture를 추가한다. U+FEFF 등 앞선 공백 집합 수정은 유지한다.
- 후속 전문 `.brain-automation/ext-catalog-followup-review.md`. 최종 시험은 이 수정과 재확인이 끝날 때까지 미실행이다.

### 2026-11-16 — Final follow-up review pass 3

- 새 finding 0건. F-1과 앞선 16건은 정적으로 해결됐으며 새 결함 없음. 전문 `.brain-automation/ext-catalog-final-review.md`.
- F-1 수정은 description 엄격 끝 조건과 LF/CRLF invalid fixture만 바꿨고 이전 15건 수정·공백 집합을 유지했다. build/typecheck/diff check 종료 0. 이후 직접 관련 시험을 실행한다.

## Design Notes

- 독립 조사 보고 `.brain-automation/ext-catalog-research.md`와 현재 소스 대조에 근거한다. 목록의 기존 소비자를 보존하기 위해 별도 `ext catalog`를 선택했다.
- npx `--with`는 이번에 추가하지 않는다. 설치기는 core promotion·lock·hook 무대화와 완료 기록을 책임지며 확장의 실패·로그인 대기·부분 성공 종료 계약이 없다. core 설치 후 이름 설치 두 명령으로 목표를 충족한다.
- 요청된 tools/ticket-tree-rules.md는 없다. 중앙은 2026-11-16 메시지 msg_257e1838d569에서 잘못된 경로임을 확인하고 tickets.py --help·현행 template/board·기존 형식으로 진행하도록 정정했다. 영구 id 11을 10 앞에 배치하고 plan status를 원천으로 사용한다.
- 로그인 메타데이터는 사용자 인증 필요 여부이며 현재 인증 상태가 아니다. Garmin은 기존 공식 로그인 진입점 부재를 스킬에 정확히 알린다. 중앙 결정으로 adapter 구현은 13.12의 planned 후속 작업이다.

## Verification

- 개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행. 의존성 다운로드 명령은 require_escalated. 시험은 마지막 구현·리뷰 수정 뒤 관련 파일을 명시하여 한 번 실행한다.
- 최종 `pnpm exec vitest run`에 신규 catalog 시험, 수정 manifest/CLI/guide/core 시험, 기존 ext-package·ext-install·ext-install-resume·extension-transition·ext-fixture-isolation 시험 및 변경한 스킬 coverage/설치 plugin 시험을 파일 단위로 지정한다. 확정 목록·명령·종료 코드는 구현 보고 후 기록한다. Python schema decoder를 바꾸면 직접 관련 pytest 파일만 지정한다.
- PG 시험은 기존 ext-fixture의 독립 container·합성 홈을 사용한다. 운영 자원은 사용하지 않고 소유 자원만 docker rm -v로 정리한다. 전체 회귀는 중앙 통합 단계에 이관한다.
- `python3.14 _bmad/method/scripts/tickets.py status _bmad-output/personal-brain/tickets/epic-extensions`의 problems/drift 및 13.10 의존성을 확인한다.


### 최종 파일 단위 검증 명령

- TS: `pnpm exec vitest run packages/core/test/extensions.test.ts apps/cli/test/extension-catalog.test.ts apps/cli/test/ext-catalog-cli.test.ts apps/cli/test/ext-package.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/ext-install-resume.test.ts apps/cli/test/extension-transition.test.ts apps/cli/test/ext-fixture-isolation.test.ts apps/cli/test/guide.test.ts tooling/bootstrap/test/cli-skill-coverage.test.ts tooling/bootstrap/test/install-skill.test.ts tooling/bootstrap/test/install-eval.test.ts tooling/bootstrap/test/garmin-plugin.test.ts tooling/bootstrap/test/extension-plugin.test.ts`
- Python 배포 fixture·설치 회귀: `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/install.test.ts`
- 실행 환경은 `BRAIN_TEST_DATABASE_URL=postgres://unused:unused@127.0.0.1:1/postgres`를 지정해 공용 compose/운영 DB 접근을 막고, extHome의 소유 독립 fixture를 사용한다. `BRAIN_TEST_RUN_ID=ext-catalog-20261116`, 자원 로그 `/tmp/ext-catalog-pg-resources.jsonl`. 기존 slot lease는 사용하지 않는다.


## Auto Run Result

Status: built. 카탈로그·이름 설치·배포 스킬의 공통 경로 구현과 독립 리뷰·수정·후속 리뷰 및 직접 관련 최종 시험을 완료했다. 실제 새 세션 증거인 13.10은 blocked 유지, 기존 Garmin 인증 진입점 결함은 13.12 backlog로 보존했다.

- 구현: `brain ext catalog`와 SDK `brain.ext.catalog()`은 manifest·digest를 검증하고 다섯 필드와 설치 여부를 반환한다. 이름 install은 기존 prepared package의 호환성·잠금·재개·교체를 공유한다. 기존 list와 --package는 유지한다. 기본 목록은 Garmin이며 시험 testext는 실제 홈 격리·환경 플래그로 제한한다.
- 변경 파일: CLI command/index/bin·runtime catalog/extensions, core brain/install/status/manifest·schema/공유 fixtures·회귀 시험, Garmin 원본·배포 manifest/digest(확장 1.2.14), core install/login·Garmin install 스킬·shell, README·스킬 coverage와 선택 판정기·시험, 13.11 티켓/계획·13.10 의존/수락조건·13.12 후속 티켓이다. plugin app-ref와 plugin version은 변경하지 않았다.
- 리뷰: 최초 4렌즈 16건(중간 14·낮음 2)을 모두 수정했다. 중복 원인도 각 지적을 개별 기록했다. 첫 후속은 15건 해결·BH-3 부분 해결로 F-1 한 건을 추가했고, 마지막 후속은 F-1 해결·새 finding 0건이다. 기각 0건. 기존 인증 adapter 부재는 중앙의 명시 결정에 따라 deferred 1건과 operator_actions·13.12에 보존했다.
- 후속 리뷰 권고: false. 두 차례 독립 후속에서 모든 수정 반례를 닫았고 최종 시험도 통과했다. 아직 검증하지 않은 것은 이번 범위에서 분리한 13.10 실제 세션 및 13.12 인증 adapter다.
- 최종 TS 파일 단위 명령: 위 Verification의 14개 파일, 종료 0·14 files passed·309 tests passed(`/tmp/ext-catalog-ts-tests.log`).
- 최종 Python 파일 단위 명령: 위 Verification의 install.test.ts, 종료 0·1 file passed·6 tests passed(`/tmp/ext-catalog-python-tests.log`). 실제 pyfixture 설치, 배포 core의 TS/Python 공유 fixture 동등 판정, Python 환경 보존·재개 회귀를 포함한다. sourcemap 누락·jsonschema 버전 접근 deprecation 경고가 있었으나 실패는 없다.
- 마지막 수정의 `pnpm build`, `pnpm typecheck`, `git diff --check`는 각각 종료 0이다. 개발 중 시험은 실행하지 않았고 최종 수정·리뷰 종료 뒤만 위 관련 파일을 실행했다. 전체 `pnpm test`, `pnpm test:python`, `pnpm test:changed`, 실제 에이전트 eval은 실행하지 않았다. 전체 회귀는 중앙 통합 단계에 이관한다.
- 격리 자원: TS fixture 82개와 Python fixture 6개가 자원 로그상 생성·삭제 쌍으로 일치한다. 두 전용 run label의 `docker ps -aq --no-trunc --filter label=...` 결과는 모두 빈 출력·종료 0이다. 운영 홈·DB·daemon·계정·토큰은 사용하지 않았다. 명령 로그와 자원 영수증은 자기 작업 공간 보고에서 참조한다.
- 카탈로그 login_required는 사용자 인증 필요 메타데이터이며 현재 로그인 상태가 아니다. 기존 토큰으로 connected·login skipped 상태를 훼손하거나 인증 미완료로 단정하지 않는 것을 독립 리뷰에서 확인했다.
- `tooling/skill-coverage/internal.json`은 내부 전용 신규 명령이 없어 변경하지 않았다. 새 공개 catalog는 core 스킬 본문으로 덮으며 coverage 시험이 내부 예외가 아님을 검증했다.
