---
title: 'setup connect codex와 doctor의 Codex 수집 항목'
type: feature
ticket: '5'
created: '2026-11-18'
status: built
baseline_revision: 'b082585ae52658ae28e429e4dfb1f68017e1f09d'
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [quick, blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Codex parser·scan은 등록됐지만 setup connect가 Codex를 거절하고 doctor는 Codex의 연결·미수집·실패·마지막 성공을 구분하지 않는다.

**Approach:** 지원하는 scan-only·명시 파일 수집을 연결 안내에 정확히 드러내고 기존 읽기 계약으로 Codex 진단을 더한다. hook/notify의 안전한 자동 공존은 입증되지 않았으므로 기존 사용자 설정을 보존한다.

## Boundaries & Constraints

**Always:** CODEX_HOME과 기본 경로의 활성·보관 루트를 사용한다. Claude 진단과 수집 결과, Codex startCwd·reconcile·fingerprint·가림 계약을 유지한다. scan-only 등록과 실제 hook 연결은 구별한다. 기존 Store 읽기 API로 얻은 값만 표시하며 필요한 최소 공통 API 변경은 근거·영향을 기록한다.

**Never:** 기존 notify/hook 또는 사용자 설정을 덮어쓰거나 실제 설정·기록을 읽고 수집하지 않는다. Store/스키마 변경·운영 계정/로그인·릴리스·배포·23.6 운영 설치로 확대하지 않는다. 런북·중앙 상태를 읽거나 수정하지 않는다. main 병합·push 금지.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 폴더 없음 | 격리 CODEX_HOME의 활성·보관 루트 없음 | connect·doctor에 미발견 상태와 실제 지원 명령 안내, hook 연결 주장 없음 | 없음과 읽기 실패를 구별 |
| 폴더 존재 | 활성 또는 보관 루트와 과거 합성 JSONL | scan-only·명시 파일 수집 지원, 미수집 수와 복구 명령 | fingerprint 비교는 기존 scan 규칙 재사용 |
| 성공·실패 | Codex 성공 transcript 내역 및 미해결 session_ingest 실패, Claude 실패 혼재 | Codex 실패 수·마지막 성공 시각, 성공 없음은 미기록; Claude 기존 진단 유지 | DB 실패는 unknown/skip/fail로 드러내며 0건 성공으로 꾸미지 않음 |
| 설정 공존 | 합성 기존 notify와 hooks 파일, config.toml | connect 반복 전후 모든 사용자 파일 바이트 동일, changed=false | 사용자 명령 실행·자동 hook 설치 없음 |
| 비정상 상태 | 파일인 루트·읽기 실패·Codex ID 충돌 | 불확실한 폴더·발견 상태를 분명히 표시 | 부분 목록으로 정상 0건을 주장하지 않음 |

</intent-contract>

## Code Map

- `apps/cli/src/commands/setup-connect.ts` — standalone Connector 기반이며 shim을 필수 검사한다. Codex scan-only 안내는 가짜 Connector를 등록하지 않고 이 경계에서 처리할 수 있다. `connectors/index.ts`는 Claude registry만 반환한다.
- `apps/cli/src/harnesses.ts` — Codex는 explicitPathParsers와 transcriptFolders에 등록됐고 hook/watch registry에는 없다. CODEX_HOME 빈 값은 기본값이다. 이 사실을 재사용하고 가짜 hook/watch 등록은 하지 않는다.
- `apps/cli/src/doctor/checks.ts`, `assembly.ts` — 런타임 파일 점검의 조립 지점. 설치자도 runtimeChecks를 쓰므로 새 환경 인자는 실제 호출처를 확인한다. Codex 실행 경로 점검(codexPathCheck)은 대화 수집 진단과 다른 기존 항목이다.
- `packages/core/src/doctor/doctor.ts` — DoctorReadStore의 listTranscriptFiles/listFailures와 transcriptChanges로 읽기 진단을 만들 수 있다. TranscriptFile.scannedAt은 성공 ingest가 기록한 시각인지 호출부를 확인하고 의미를 정확히 설명한다. 실패는 harness와 stage/targetKind로 구별하며 raw ID나 원문을 출력할 이유가 없다. 기존 합산 transcripts와 Claude 보존을 확인한다.
- `packages/codex/src/transcript-folder.ts` — 활성·보관 발견·동일 복사·상이내용 충돌·부분메타 보류·링크 제외를 이미 구현했다. 이를 다시 구현하거나 진단을 위해 실제 수집하지 않는다.
- `apps/cli/test/setup-connect.test.ts`, `doctor-run.test.ts`, `doctor-checks.test.ts`, `packages/core/test/doctor.test.ts` — 기존 fake/CLI 격리 검증 패턴. 새 Codex 중심 파일로 outer CLI JSON·텍스트·종료상태를 검증한다.
- `plugin/skills/brain-setup/SKILL.md`, `brain-status/SKILL.md`, `tooling/bootstrap/test/cli-skill-coverage.test.ts` — 공개 명령 변형과 진단 안내·커버리지 갱신. 내부 예외 추가로 공개 경로를 숨기지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] 1 `apps/cli/src/commands/setup-connect.ts`, 필요 최소 런타임 Codex 상태 helper 및 `apps/cli/test/` — Codex scan-only 연결 안내와 폴더 없음/존재/오류·기존 notify/hooks 바이트 불변·반복 동작의 CLI 시험을 작성한다. 기존 Claude Connector 계약을 유지한다.
- [x] 2 `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/checks.ts`, `assembly.ts` 및 직접 관련 시험 — Codex 폴더/지원 상태·미수집·미해결 실패·마지막 성공 진단을 연결한다. 기존 read API와 scan 비교를 재사용하고 DB/목록 실패를 정직하게 표시한다. outer doctor CLI에서 JSON과 텍스트를 확인하는 합성 시험을 작성한다.
- [x] 3 `plugin/skills/brain-setup/SKILL.md`, `plugin/skills/brain-status/SKILL.md`, `tooling/bootstrap/test/cli-skill-coverage.test.ts` 및 관련 시험 — 구현된 명령·필드·진단 가이드와 coverage를 일치시킨다. Matrix 전체를 시험에 대응시키고 build·typecheck·diff 검사를 수행한다.

- [x] 4 `packages/core/src/doctor/doctor.ts` 및 관련 Core 시험 — 목록·이력·실패 관측을 한 doctor 호출에서 공유하여 Codex 전체 읽기/hash 중복을 없앤다. 세 조회 상태를 독립 조립해 미수집 확인 불가에서도 DB 실패 수·마지막 성공을 유지하고 각각의 unknown과 오류를 숨기지 않는다. 기존 합산 진단과 Codex 진단을 같은 snapshot으로 계산한다.
- [x] 5 `packages/core/test/doctor.test.ts`, `apps/cli/test/doctor-run.test.ts` 및 직접 관련 시험 — 최신 시각이 경로순 가운데인 세 성공 이력, 실제 memoryStore 실패 기록/해결 후 1→0, 목록 실패+성공/실패 이력 혼재, 단일 listing 호출과 같은 관측 결과를 검증한다. 공개 CLI JSON·텍스트에서 폴더 없음·존재·실패·마지막 성공·DB skip을 직접 단언하며 Claude 진단 보존과 기존 정확 ID/summary 기대를 갱신한다.
- [x] 6 `apps/cli/src/commands/setup-connect.ts`, `packages/core/src/doctor/doctor.ts`, 배포 스킬·coverage·직접 관련 시험 — 공개 출력 설명에 Codex target 디렉터리와 mode/folders/guidance 의미·상태를 반영하고 오류 지원 목록에 Codex scan-only를 포함한다. 재시도 안내를 session 범위로 제한하며 Claude 포함 전체 세션 실패임을 명시한다. 실제 지원 명령만 안내한다. 정상 JSONL 개행은 변경하지 않는다.

- [x] 7 `packages/codex/src/transcript-folder.ts`, `packages/codex/test/transcript-folder.test.ts`, `packages/core/src/doctor/doctor.ts`, `packages/core/test/doctor.test.ts` — 최상위 루트 ENOTDIR 오류는 보존하고 열거 후 하위 경로 교체 ENOTDIR은 기존 경합 건너뛰기를 유지한다. Codex 오류로 전체 수가 불명이어도 정상 관측한 Claude 보존기한 경고는 유지하고 합성 경합/혼재 시험으로 증명한다.
- [x] 8 `apps/cli/src/doctor/codex-folders.ts`, `packages/core/src/doctor/doctor.ts`, 배포 스킬·직접 관련 시험 — 명령 전체를 백틱으로 표시해 기존 언어 검사 계약을 준수한다. scannedAt은 마지막 성공 수집의 기록 시각으로 안내하고 읽기 시작/완료로 단정하지 않는다. Store·시각 기록 순서는 바꾸지 않는다.
- [x] 9 `apps/cli/test/doctor-run.test.ts`, `setup-connect.test.ts`, `packages/core/test/doctor.test.ts` — 출력모드별 독립 fixture로 자동drain의 전후 상태 간섭을 제거한다. 발견 상태 JSON/텍스트·빈/미설정 CODEX_HOME의 standalone 임시HOME 기본경로·history 오류 중 실패1건 보존·OrbStack 선행실패 Codex skip을 직접 검증한다. 실제 Docker HOME은 변경하지 않는다.

**Acceptance Criteria:**
- Given Codex 루트가 없거나 존재하는 격리 환경, when 공개 setup connect codex와 doctor run을 JSON·텍스트로 실행하면, then 상태·scan-only 지원·실제 지원 복구 명령이 정확히 보이고 자동 hook 연결을 주장하지 않는다.
- Given 합성 기존 notify/hooks와 과거 미수집·성공·실패 내역, when connect를 반복하고 doctor를 실행하면, then 설정 바이트가 유지되며 Codex 미수집·실패·마지막 성공을 구별하고 Claude 기존 진단이 보존된다.
- Given 변경된 공개 CLI, when 배포 스킬 커버리지를 확인하면, then Codex 변형과 진단 가이드가 구현과 일치하고 관련 시험이 통과한다.

## Implementation Notes

계획 gate: 현재 코드와 23.3·23.4 선행 계획을 대조했다. scan-only는 지원하나 안전한 일반 hook/notify 공존은 미입증이다. 공통 doctor 진단 변화의 오보고 위험을 고려해 medium으로 올렸다. full/pinned 경로다.

## Plan Change Log

### 2026-11-19 — review2 repair
신규 하위 ENOTDIR 경합·관측된 Claude 기한 경고·자동drain fixture 간섭·기본경로 증거를 Execution7~9에 보완했다. 이전 코드는 `/tmp/brain-23-5-before-repair-2.patch`에 보존했다. KEEP: 기존16건 해결 및6건 반증, 공유 snapshot·독립 부분진단·session필터·설정불변·원자적 루트 오류/ID충돌 계약을 유지한다. intent-contract는 변경하지 않는다.

### 2026-11-18 — review 1 repair
독립 부분 진단·단일 관측 snapshot·여러 성공 이력/해결 실패·outer CLI 증거 누락을 Execution4~6으로 보완했다. 알려진 목록 오류가 다른 정상 DB 증거를 숨기거나 중복 전체 파일 읽기로 진단이 갈리는 상태를 피한다. 원래 구현은 `/tmp/brain-23-5-before-repair.patch`에 보존했다.
KEEP: scan-only·자동hook 미설치·설정무변경, CODEX_HOME·기본경로·두 루트, ENOTDIR·오류 불확실성, 원문 ID 비노출, 기존 scan 비교·Store API·scannedAt 의미, Claude 결과/등록과 정상 fixture 개행을 유지한다.

## Review Triage Log

### 2026-11-19 — Review pass3
- verdicts: 신규1 findings — high0 medium1 low0 false0 maybe-false0. 기존27 resolved/7 carried 유지.
- `[medium] [patch]` E4 새 부분관측 기한경고가 오래된 Codex에도 Claude30일 정책을 설명한다. 새 오류분기의 후보만 Claude로 제한하고 오류Claude+정상Codex 반대 시험을 추가한다. 기존 정상Claude 경고·unknown 전체합계는 유지한다. 공개 표면/API 추가 없는 단순 조건 정정이다.

### 2026-11-19 — Review pass2
- verdicts: 신규12 findings — high0 medium11 low0 false1 maybe-false0; 기존16 resolved/6 carried

| ID | 판정 | 경로 | 근거·처분 |
|---|---|---|---|
| Q3 | medium | patch | 검사기는 백틱 없는 queue drain 등 연속 라틴어를 산문으로 판정한다. 두 명령 안내 전체를 백틱으로 감싼다. |
| E2 | medium | patch | Q3와 같은 원인·수정. 언어 허용목록을 넓혀 우회하지 않는다. |
| E3 | medium | bad_plan | 공용 missing에서 ENOTDIR 제거가 열거 뒤 하위 폴더→파일 경합까지 전체 오류로 바꾼다. 루트 진입과 하위 경합을 구분하고 합성 시험을 추가한다. |
| R2-V1 | medium | patch | doctor 폴더 존재 시험이 scan-only만 검사한다. JSON·텍스트의 발견 문구를 직접 단언한다. |
| R2-V2 | medium | bad_plan | 비어 있거나 없는 CODEX_HOME fallback이 모두 미검증이다. 외부 실행 없는 standalone 자식 CLI에 임시 HOME을 주고 기본 .codex/archived_sessions와 target을 검증한다. 정상 Docker HOME을 바꾸는 통합 probe는 하지 않는다. |
| R2-V3 | medium | patch | history 오류와 정상 실패1건 동시 조건을 직접 단언한다. 실제 memoryStore 실패 기록을 사용한다. |
| R2-V4 | medium | patch | 기존 OrbStack 중지 fixture에서 Codex skip 사유를 직접 단언한다. |
| R2-B1 | false | reject | 루트 자체의 ENOTDIR은 의도한 전체 목록 오류다. TranscriptFolder는 전체 files 성공 또는 오류의 원자적 계약이고 부분목록 경고 채널이 없다. 실패한 루트의 ID 충돌 여부를 모른 채 반대 루트만 성공 처리하면 scan/locate의 유일 ID 판단을 깨뜨린다. 이번 범위는 오류를 숨기지 않는 진단이고 모든 오류에서 정상 일부를 수집하는 새 계약을 요구하지 않는다. 원문 경로 오류도 기존 drain 오류 계약이며 새 민감 원문을 출력하는 변경을 추가하지 않는다. 하위 경합 회귀 E3은 별도 수용한다. |
| R2-B2 | medium | bad_plan | 부분 건수 확인불가와 관측된 Claude 보존기한 경고는 독립이다. 전체 확인불가를 유지하면서 정상 관측의 기한 경고를 보존한다. 고정시계·오래된 Claude+Codex오류 혼재 시험을 추가한다. |
| R2-B3 | medium | patch | Codex validatedRead는 scannedAt 전 실행되므로 읽기 시작 표현이 틀리다. Store 계약은 보존하고 화면·스킬·시험은 마지막 성공 수집의 기록 시각으로 표현한다. |
| R2-I1 | medium | patch | Q3/E2와 동일. |
| R2-I2 | medium | bad_plan | 실제 성공 doctor 뒤 자동 drain이 fingerprint history를 기록한다. 출력모드마다 별도 fixture로 미수집1 상태를 만들고 검증한다. drain 정책을 끄는 제품 변경은 하지 않는다. |


### 2026-11-18 — Review pass 1
- verdicts: 22 findings — high 0, medium 16, low 0, false 6, maybe-false 0

| ID | 판정 | 경로 | 근거·처분 |
|---|---|---|---|
| Q1 | medium | patch | 무필터 failures retry는 모든 대상·확장까지 재등록한다. session 범위를 명시하고 Claude 포함 한계도 안내한다. |
| Q2 | medium | bad_plan | folder.list 실패의 조기 반환이 정상 DB 내역 조회를 막는다. Execution4에서 독립 부분 진단을 구성한다. |
| E1 | false | reject | 원본 196행 끝 바이트는 32,39,92,110,39,41,59로 따옴표 사이 역슬래시 하나+n이다. JS '\n'은 정상 개행이며 리터럴 역슬래시+n을 만드는 '\\n'이 아니다. 215/216행도 동일하다. 개행 변경은 하지 않는다. |
| V1 | medium | patch | 기존 CLI 전체 ID 목록과 summary가 새 skip/ok 두 항목을 누락한다. 목록 비교를 보존하며 갱신한다. |
| V2 | medium | bad_plan | 이력 한 건으로 max 비교 방향·첫/끝 선택 회귀를 잡지 못한다. Execution5에 세 이력·가운데 최신 검증을 추가한다. |
| V3 | medium | bad_plan | 고정 listFailures 대체가 includeResolved 변화를 무시한다. 실제 memoryStore 기록/해결로 1→0 검증을 추가한다. |
| B1 | medium | patch | V1과 동일하며 text summary도 통과/skip 증가를 반영한다. |
| B2 | medium | bad_plan | 합산·Codex check가 각각 list해 전체 readFile/hash 두 번 및 서로 다른 관측값 가능. Execution4에 호출별 단일 snapshot 공유를 추가한다. |
| B3 | medium | bad_plan | Q2와 동일. 목록/이력/실패를 독립 조회해 확인 가능한 값을 유지한다. |
| B4 | medium | patch | Q1과 동일. 현재 공개 session 필터만 안내하며 Codex 전용 필터를 발명하지 않는다. |
| B5 | false | reject | options.folders는 등록된 수집 capability 목록이다. Codex가 없는 사용자 정의 Core 조립에는 check 미노출이 타당하며 공개 CLI는 Codex를 항상 등록한다. 비활성 공개 설정은 이번 변경에 없다. 도달불가 방어 분기 자체로 사용자 결함은 성립하지 않는다. |
| B6 | medium | patch | 공개 output은 target을 설정 파일로만 설명하며 새 Codex 필드를 누락한다. CommandSpec 설명과 필드 의미를 맞춘다. |
| B7 | medium | patch | Codex는 빈 registry에도 지원하지만 known()은 registry만 열거한다. scan-only 지원도 오류 가이드에 반영한다. |
| I1 | false | reject | 폴더·지원 안내는 명세가 선택한 scan-only 해석이며 설치/DB 준비 완료를 주장하지 않는다. |
| I2 | false | reject | 원문은 루트별 개별 출력 계약을 요구하지 않는다. 어느 루트 존재/오류를 합친 상태로도 선택한 지원 상태 계약을 만족한다. |
| I3 | medium | bad_plan | doctor 폴더 없음 JSON·텍스트 직접 assertion이 없다. Execution5에 outer CLI 검증을 추가한다. |
| I4 | medium | bad_plan | 실패·마지막시각을 코어만 확인해 outer AC에 공백. Execution5에 합성 PG 내역→CLI JSON/텍스트를 추가한다. |
| I5 | medium | bad_plan | Q2와 같은 독립 부분 진단 공백. |
| I6 | false | reject | Claude 오류에서 불완전 부분 합계를 확인불가로 바꾸는 것은 완전한 미수집 수를 요구하는 공통 진단 보완이며 Claude 저장결과/기존 진단항목을 지우지 않는다. Claude 별도 결과 보존 assertion은 Execution5에서 보강한다. |
| I7 | medium | patch | B6과 같은 CommandSpec 출력 설명 누락. |
| I8 | medium | patch | V1/B1과 같은 stale 목록 assertion. |
| I9 | false | reject | 개발 중 시험 미실행은 사용자 규칙이고 보고도 통과를 주장하지 않았다. 최종 관련 시험/coverage gate가 남아 있는 상태이지 결함이 아니다. |


## Verification

개발·리뷰 수정 중 시험 실행 금지, `pnpm build`, `pnpm typecheck`, `git diff --check`만. 마지막 구현·리뷰 수정 후 새/수정 시험 파일과 직접 관련 기존 setup-connect·doctor-run·doctor-checks·core doctor·cli-skill-coverage·codex-registration 시험을 파일 지정 `pnpm exec vitest run <files> --reporter=verbose --maxWorkers=1`로 실행한다. 실제 변경에 따라 직접 관련 파일을 확정하고 Matrix/AC와 통과 사례를 매핑한다. 전체 pnpm test/test:python/test:changed는 실행하지 않으며 중앙 통합 전체 회귀에 위임한다.

무거운 검증은 자기 소유 공용 `~/.brain-operations/test-lock` mkdir/marker 대조 해제로 직렬화하며 점유 시 폴링·타잠금 삭제 금지다. 정상 HOME·Docker context를 보존하면서 Brain/Claude/Codex/XDG/fake launchctl을 격리한다. PG가 필요하면 run/file 라벨·tmpfs·랜덤 loopback·정확 ID·ownerPID/출생시각 manifest와 소유 정리를 남긴다. 운영54320/공유54329 사용 금지. 명령·기준SHA·종료코드·원시로그·사례 결과를 `.brain-automation/tickets/23.5/validation/`에 저장한다.

## Auto Run Result

상태 built — 사용자 인수 전이며 main 병합·push는 하지 않는다.

Codex scan-only 연결 상태와 활성·보관 폴더 present/missing/unknown을 안내하고 기존 notify/hooks·설정은 쓰지 않는다. doctor는 기존 scan 비교로 Codex 미수집·미해결 session_ingest 실패·마지막 성공 수집의 기록 시각을 표시한다. 같은 관측을 공유하며 목록/DB 일부 오류 중 확인 가능한 값을 보존한다. 기존 Claude 진단·기한 경고와 Codex 하위경합·ID충돌 원자성을 유지하고 공개 CommandSpec·스킬·coverage를 맞췄다. Store·스키마·실제 운영설정/기록·계정·배포는 변경하지 않았다.

변경 파일: CLI assembly·setup-connect·doctor/checks 및 신규 codex-folders helper, Codex transcript-folder, Core doctor, 각각 직접 관련 시험, brain-setup/brain-status 배포 스킬과 coverage 시험이다.

리뷰 총35건: medium28건 해결·false7건 근거 기각·defer0. 원문과 항목별 판정은 `.brain-automation/tickets/23.5/review-{quick,blind,edge,verification,intent}.md`, `review-2-*.md`, `review-3-*.md`, `review-4-edge.md`, `triage-{1,2,3}.md`에 보존했다. 마지막 E4 후속은 resolved·새지적0이며 기존27 resolved/7 carried를 유지한다. 마지막 pass patch high0/medium0, followup_review_recommended=false. 정상 JS개행·capability 노출·합산상태·scan-only 한계·시험유예·원자적 루트오류 지적은 개별 반증을 남겼다.

검증: 마지막 구현 수정 후 build/typecheck/diff 검사 각각 종료0. 중간 TS2339 두 건은 fixture 환경 타입 지정으로 수정 후 typecheck 종료0이며 최초 실패 로그도 보존했다. 최종9파일 Vitest 1회 211/211 통과·실패0·skip0·종료0. JSON·텍스트 공개 경로·기본HOME·설정 바이트·성공/실패/미수집·경합/충돌·Claude 기한 보존·coverage의 Matrix/AC 대응은 `.brain-automation/tickets/23.5/terra-validation-report.md`와 `validation/results.json`에 있다. 시험 재실행은 하지 않았다.

소유 test-lock·정상HOME/OrbStack context·합성 격리환경·전용PG 랜덤loopback/tmpfs/run-file labels를 사용했다. 정확ID·PID/시작시각 manifest와 컨테이너 제거0/부재inspect1·잠금해제0·fixture부재·소유프로세스부재·자체4ledger completed/resources0를 확인했다. ps 최초 sandbox거부는 로그 보존 후 권한확장 재확인으로 해결했다. 자원 증거는 `validation/manifest.txt`, `container-inspect.json`, `cleanup.log`, `post-cleanup-retry.log`다.

잔여 한계: 안전한 일반 hook/notify 공존은 미입증이므로 자동연결하지 않는다. 진단의 시각은 기록된 성공 수집 scannedAt이고 실제 읽기 시작/완료 시각을 보장하지 않는다. 한 루트의 오류/상이내용 ID충돌은 부분성공 대신 전체 목록오류로 표시한다. 과거 Orca runtime_timeout 차단은 재개 때 실제 자기Run Task7개/종료상태를 대조해 미수락을 확인한 뒤 새 Sol6.2/medium 후속리뷰로 복구했다. 전체 pnpm test → pnpm test:python 및 test:changed는 미실행이며 중앙 통합 전체회귀가 필수다. 23.6 운영 설치·실제기록 수집은 범위 밖이다.

최종화: 티켓 관련15파일만 커밋하고 자기 브랜치를 일반 push한 뒤 원격SHA를 확인한다. 실제 commit/remoteSHA·최종 전달 결과는 `.brain-automation/tickets/23.5/ticket-result.md`와 자기 worker.json에 남긴다.
