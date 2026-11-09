---
title: 'bootstrap hook 시험 중복 제거 (19.6)'
type: 'refactor'
ticket: '6'
created: '2026-11-09'
status: 'built'
baseline_revision: 'cb8391173aead346abb5177d87212d999ce30bd8'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/.brain-automation/tickets/19.6/independent-spec.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 기본 Vitest와 Python suite가 같은 hook 파일을 중복 실행한다. Python 전용 보존 case는 앞선 설치·갱신 case가 만든 home/bin/DB에 의존한다.

**Approach:** hook 파일 전체를 Python suite 단독 소유로 두고 기본 suite에서 제외한다. 변경 선택 규칙과 실제 list/run 경로 검증으로 빠짐과 중복을 막는다.

## Boundaries & Constraints

**Always:** 기존 hook case 이름·합집합, 실제 container·설치·갱신·Python 보존 단언·timeout·조건부 skip·순서를 유지한다. Python flag=1, beforeAll snapshot과 공유 home/bin/DB, 19.5의 기본4slot·lease·장부·정확 ID 복구·kernel lockf hook lane·garmin-report 전용 shard allowlist를 유지한다. 합성 입력·전용 checkout 외 TMP/HOME·PG만 사용한다. 개발/리뷰 수정 중 시험/list/재현/PG/성능 실행 금지, 컴파일 확인만. 마지막 실질 수정과 독립 확인 뒤 전체 TS→Python 각1회 순차 실행한다.

**Never:** 제품/Drive/migration/plugin·DB template19.1·기록19.8·broad rule축소19.9를 바꾸거나 다른 checkout/중앙 main/state를 수정하지 않는다. 단언 축소·mock 대체·전체 suite 반복 측정·공용54329·운영DB·실계정·가짜 Orb status·전역context 변경을 하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 두 suite | 기본과 Python config | hook은 Python에만 속하며 기존 합집합의 각 case 1회 | 선택 누락/중복은 실패 |
| 독립 hook | Python flag=1, hook만 선택 | 설치부터 Python 보존까지 원래 순서·공유 fixture로 통과 | 기존 실패/skip 의미 유지 |
| 변경 선택 | hook·fixture·bootstrap src 변경 | 실제 소유 Python suite가 list/run에 포함됨 | 인접 무관 변경 선택 유지 |

</intent-contract>

## Code Map

- `vitest.config.ts`: test/ 보유 package별 project 자동 생성, bootstrap include가 hook을 포함한다. 해당 project에서 hook만 exclude하고 다른 기본 시험은 유지한다.
- `apps/cli/python-test/vitest.config.ts`: CLI Python + hook include, flag=1, Python global setup. 현재 hook 소유를 유지한다.
- `tooling/bootstrap/test/hook.test.ts`: 두 beforeAll이 lock과 snapshot을 준비하고 같은 describe의 앞선 설치 case가 뒤 보존 case의 전제를 만든다. 본문/순서 불변.
- `tooling/bootstrap/test/hook-resources.ts`: exact Compose 자원/port 충돌 회피. 읽기 전용.
- `tooling/test-changed/rules.mjs`: bootstrap prefix는 Python 전체, hook hardcode는 Python 파일 목록. 넓은 규칙은 유지하되 소유 config 변경도 놓치지 않게 한다.
- `tooling/test-changed/run.mjs`: 실제 Vitest list 뒤 기본 changed 실행, Python은 slots runner 전체/--files. 기록 기능을 추가하지 않는다.
- `tooling/test-db/test/test-changed.test.ts`: 분류 단언과 실제 list subprocess 검증 패턴이 있다. 실행 가능한 회귀 코드를 추가한다.
- `tooling/test-db/src/python-slots.ts`, `slots/*`, Python global setup: 19.5 계약은 그대로. 과거 source8f553a3의21job54case 성능비율은 이번 증거로 재사용하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] 1 `vitest.config.ts`, 필요 시 Python config -- 기본에서 hook만 제외해 Python 단독 소유 확정.
- [x] 2 `tooling/test-changed/rules.mjs`, 필요한 `run.mjs` 연결 -- hook/fixture/src/config 변경 시 소유 suite 선택 보존.
- [x] 3 `tooling/test-db/test/test-changed.test.ts` 및 필요 전용 선택 시험 -- config별 hook 소유·case 합집합/원본문 보존·경로분류·실제 list/run 선택 회귀 코드 작성. 개발 중 실행 금지.
- [x] 4 지휘자 -- 독립 Sol 리뷰·수정·후속 확인 뒤 전용 검증 환경 preflight·대상 측정 준비, 중앙 유한 측정창 요청, 전체 순차 회귀·실패별 처분·범위 commit/push·중앙 결과 보고.

**Acceptance Criteria:**
- Given 기준 두 config와 hook 이름 집합, when 변경 후 두 config 목록과 실제 실행을 비교, then 기존 합집합이 동일하며 각 hook case는 Python에서 정확히1회 실행되고 flag전용 case가 보존된다.
- Given hook만 선택한 독립 환경, when 실제 Python config 실행, then beforeAll/설치/갱신/보존 전부 원래 단언과 timeout으로 통과한다.
- Given hook/fixture/src/config 변경, when 분류 및 실제 list/run 선택 검증, then Python 소유 hook이 누락되지 않고 기본에는 중복되지 않는다.
- Given 고정 기준/변경 source와 같은 합성 환경, when hook 대상만 warmup1+표본3 전후 비교, then 유효 결과 동등성과 중앙값 비용을 보고한다. 전체 suite 시간은 최종 필수 각1회에서 기록한다.

## Implementation Notes

- 최종 구현 범위는 `vitest.config.ts`, `tooling/test-changed/rules.mjs`, `tooling/test-db/test/test-changed.test.ts`와 이 계획이다. Python config·원 hook·fixture·runner·migration·제품·plugin은 불변이다.
- 구현 Task2의 첫 typecheck는 선언/환경객체 타입으로 실패했으나 같은 Task에서 교정해 exit0, Task3도 typecheck/diff-check exit0. 개발 중 시험/list/PG는 실행하지 않았다.

- Terra Task1은 Execution1~3 구현과 build/typecheck/diff-check exit0을 보고했다. 시험/list는 미실행. 원 hook 파일은 baseline과 동일 SHA-256 `9406229c4f6087c27dd133918c14403b2dc095de5f04ef6ac5bcde6f7614a871`.

## Plan Change Log

## Review Triage Log

### 2026-11-09 — 최종 증거 감사

- Sol `ctx_226e6411c082`: 16명령/60원시hash/12소유ID/이름·상태/동등성/통계/고정지문/창내종료 정합. verdicts:2 findings — low2, high0/medium0/false0/maybe-false0.
- `[low]` `[patch]` FE-1 계획 warmup합계 반올림 — 실제 rows와 audit의before143.754757458/after74.177856041을소수3자리143.755/74.178로교정했다. 표본중앙값/성능결론불변.
- `[low]` `[patch]` FE-2 반환전송정확시각/본문의독립증거 — 전송성공영수증과자기Run수신함의중앙ack원문/생성UTC00:56:22를별도보존했다. 종료40초이내중앙수신·peer해제는입증하며정확sentUTC는영수증미기록이라는범위를명시했다. 중앙inbox는조회·소비하지않았다.
- Sol `ctx_1ee4abb049b4`의 `review-final-doc-resolution.md`에서 FE-1/FE-2 모두resolved, 새오류0. 추가시험/측정/코드수정없음. 후속리뷰 권고false.

### 2026-11-09 — Review pass r3 resolution

- R2-1 resolved, 새 발견0. Sol `ctx_a34a9549d67b`은 성공/실패/timeout/JSON 예외의 finally정리와 원 hook/environment 불변을 확인했다. 구현·리뷰 수정 종료. 실제 검증을 시작한다.

### 2026-11-09 — Review pass r2 resolution

- VG1/IA-I1·ECH1·C1 모두 resolved. 새 finding1건: `[low]` `[patch]` R2-1 hook 동적수집에서 environment import의 임시폴더3개가 afterAll 미실행으로 남는다. 수집 부모가 전용 TMPDIR/TMP/TEMP를 소유하고 finally로 정확 경로를 제거하도록 직접 교정한다. 원 hook과 environment는 불변. 마지막 교정 뒤 독립 확인을 수행한다.

### 2026-11-09 — Review pass r1

- verdicts: 7 findings — high 0, medium 3, low 1, false 3, maybe-false 0. 원문 4렌즈 6행과 지휘자 추가1행을 각각 판정했다.
- `[medium]` `[patch]` VG1 shell fixture 개행 — TS `\\n`이 실제 LF가 아닌 문자로 쓰여 shebang/body와 로그 단언이 깨진다. 실제 개행과 printf escape를 교정한다.
- `[medium]` `[patch]` IA-I1 같은 shell 결함 — VG1과 동일 원인, 같은 수정으로 해결한다.
- `[false]` `[reject]` IA-I2 실제 실행 증거 미포함 — 현재 개발 단계이며 마지막 수정·독립 확인 뒤 Verification에서 실제 선택/실행/비교를 수행하도록 이미 계획돼 있다. 모의 dispatch 시험은 단위 회귀 표면이며 최종 수락 증거를 대체하지 않는다.
- `[false]` `[reject]` BH1 현재 list의 DB setup 부작용 — 설치 Vitest `index.DpLw24bj.js:20943`은 기본 staticParse가 false가 아니면 parseSpecifications로 분기해 collectTests/globalSetup을 호출하지 않는다. 지적한21251은 동적 수집 경로다. 다만 ECH1 교정으로 동적 수집이 필요하므로 hook 필터와 비소유 더미URL을 제공해 부작용을 예방한다.
- `[false]` `[reject]` BH2 flag 제거해도 이름 단언 통과 — 현 static 수집은 skipIf를 무조건 skip해 결과에서 제거하므로 정상 config에서도 이미7개라 통과하지 않는다. ECH1 교정에서 flag 유무에 따른 실제 활성 이름 차이도 확인한다.
- `[medium]` `[patch]` ECH1 static skipIf 수집 — 설치 Vitest cac의 staticParse default true와 AST의 skipIf→skip, formatter의 skipped 제외로 Python8개 단언이 실패한다. 기본 filesOnly/hook필터, Python hook 한정 동적 수집과 더미 비소유URL로 교정한다.
- `[low]` `[patch]` 지휘자 C1 원본 파일 전체 해시 영구 고정 — 후속 정상 hook 수정마다 독립 선택 시험이 실패한다. baseline 해시 비교는 이번 실행 증거로 보존하고 영구 회귀에서는 소유·case 활성·이름 집합을 검증한다.
- 독립 후속 확인: ECH1/VG1 교정 뒤 Sol resolution으로 마지막 실질 수정과 부작용 예방을 확인한다. 시험 실행은 그 뒤다.

## Verification

- 개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만. 필요한 의존성 다운로드는 처음부터 require_escalated.
- 독립 리뷰 수렴 후 중앙에 source/명령/횟수/예상시간/준비 영수증을 보내 유한 측정창을 받는다. 기준 cb839117과 변경 source에서 hook 대상 기본+Python 명령 묶음을 각 warmup1+3표본, 동일 격리 환경으로 비교한다. 기본의 변경후 hook 선택0은 목록으로 증명하고 Python 실행을 단독 실행 증거로 쓴다. hook 이름·본문 해시와 reporter case 이름/결과 비교를 남긴다.
- `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 순차 각1회, UTC/source/exit/log/각 suite 시간·정확자원 부재 증거를 보존. 실패 수정 뒤 관련 시험·`pnpm test:changed -- cb8391173aead346abb5177d87212d999ce30bd8`만 재검증한다.
- Docker context/Compose·제한 PATH genuine orb status·postgres 암호 전제·checkout 외 TMP/HOME/venv를 preflight. 사용자 데이터/credentials는 읽거나 복사하지 않는다.

## Verification Results — 2026-11-09

- 원baseline `cb8391173aead346abb5177d87212d999ce30bd8`/schema43. 구현 diff SHA256 `931913dca1702d35b0c0fb619dc68301f0baac5c0e47f31824cd798a0019d8ac`. 최종 source 코드 변경은 없으며 아래 계획 결과 기록은 측정 snapshot을 소급 변경하지 않는다.
- 최초 `VITEST_MAX_WORKERS=2 pnpm test`: build/typecheck 성공 뒤 Orca 재시작으로 **interrupted / exit unknown / 전체 미완료**. 초기 검증환경의 DOCKER_HOST가 제품 probe의 명시 override 거부와 충돌했다. private Docker config의 실제 orbstack context로 교정했고 전역 context는 불변이다. 종료 상세 summary가 없어 모든 초기 실패 원인을 하나로 단정하지 않는다.
- 중앙 `msg_b8e56c1a7f31` 승인 복구: 실제 project+file manifest236개, 설치 Vitest의 suite-finished→onTestModuleEnd와 afterAll/파일fixture cleanup 경계를 Sol이 감사해 원file완료203개를 인정했다. 실패12+미확인21의 **33파일 전체**를 동일config/worker2에서 보완, **542pass / exit0 / 279.7545초**. 최종 장부는 누락0/미해결0. 최초TS를 전체exit0이나 결합source 전체일괄pass로 소급하지 않는다.
- 최초 `pnpm test:python`: **exit0 / 16파일 / 선택고유76case pass / 233.0309초**. hook은8pass, 보존case의 reporter passed와 START/PASS 표식을 확인했다. Garmin report shard raw skip210은 각 선택case 외14case의 필터 제외이며 선택15case는 각각1회 통과했다. 전체Python을 반복하지 않았다.
- 부모 HOME/TMP는 checkout 밖 전용영역이다. 기존19.5 runner는 자식 TMPDIR를 ignored `.brain-test-runs/<run>/<fileId>`로 바꾼다. 중앙 `msg_9eb2db6cc6ef`가 이번 기능회귀의 명시편차를 수락했다. 자식도 외부TMP만 썼다고 쓰지 않는다. scratch/raw는 gitignored이며 hook snapshot의 git-ls-files 집합에서 제외됨을 확인했다. 원시를 정리하지 않았다.
- 새 선택 회귀8개가 실제 config의 hook 소유0/8활성case와 run.mjs dispatch를 검증해 통과했다. 실제 전체Python 경로의 hook8case, 기본 manifest의 hook0, 원본문 hash동등성을 함께 보존했다.
- 원시(로컬): `.brain-automation/tickets/19.6/verify/ts-final-ledger.json`, `final-ts.log/json`, `ts-related-selection.json`, `ts-related-33.json`, `ts-related-33-vitest.json`, `final-python.json`, `hook-functional-evidence.json`. Python run `.brain-test-runs/c033c847d254df3e2395250d/` 및동명장부. 독립 `review-ts-recovery.md`, `review-premeasure-audit.md`.
- 자원: 최초TS created194/원시removed192+재시작잔존2정확ID회수, 관련TS55정리, Python slot4정리의 합집합253개 부재. 별도회귀cluster1개도 정확ID/이름/label로 제거·부재 확인했다. Docker 부재문구 대소문자 감사 오류는 정확ID 재조회와 정규화 검사로 교정했으며 실행 실패나 자원 잔존으로 숨기지 않았다.

### Hook 전후 대상 측정

- 중앙 승인 `msg_a855dbfbd303`: UTC00:40~01:20/KST09:40~10:20 최대40분. 실제 **00:41:15.322651~00:55:42.386529 UTC / 867.0613초 / exit0**. 고정driver의2370초보다 남은시간 기준2294.6773초 외부상한과 종료예약30초를 적용해 실제만료 안 종료했다. 종료 관측 직후 창 반환 호출을 수행했고 전송성공 영수증 `msg_17bbe1530bd6`를 보존했다. 자기 Run 수신함 원문에서 중앙 확인 `msg_05817f574cc8`의 생성시각 **00:56:22 UTC**와 peer 보류해제 완료 본문을 보완했다. 따라서 종료 뒤40초 이내 중앙 수신·해제를 독립 확인할 수 있다. 전송영수증 자체에는 sent UTC가 없어 정확 전송시각을 별도로 재구성했다고 주장하지 않는다.
- 고정 before snapshot `94b5b84ee683f5a6cc060018f299dddb571568b3` tree `0335596ddd55beeed88375f7b01df86a6dc94f37`; after `8da69d1dd29deb147f07196838f3a700aa77f8f3` tree `ec6ec96f4323f4c9a32e0dbc88e8fe0f6f614639`. 실제 실행 전후 HEAD/tree/clean 일치. baseline archive와 구현+그때의계획을 동결한 측정용 사본이며 최종 보고문서 바이트까지 같은source라고 확대하지 않는다.
- driver SHA256 `5b115e59861c11d4f4b30af7454c300164b8b2454e6efef5f12a4140d00279d3`, env SHA256 `775d0f9aca2e181dfa7cea7af690c82245db162f4484e92f32e402e8a21d4f71`. source별 node_modules/build, 호출별 외부TMP, 공유 전용HOME/uv cache, source별 warmup1 뒤3표본. 비소유loopback1 URL은 global setup 소유회피용이고 실제hook은 자기home의Compose PG를 쓴다. 실제orb status 한인자만 genuineCLI로 위임하며 가짜응답/전역context변경은 없다.
- 명령은 각사본에서 `pnpm exec vitest run tooling/bootstrap/test/hook.test.ts [--config apps/cli/python-test/vitest.config.ts] --passWithNoTests --reporter=default --reporter=json --outputFile=<전용원시JSON>`. before/after각warmup1+3, trial마다기본→Python순차 **16명령**, 실제hook12회. 전체suite반복/추가표본/재시도 없음. 16명령 전부exit0이며 각호출 직후 정확이름·상태를 감사했다.

| 대상 묶음 | warmup 합계초 (제외) | 표본1초 | 표본2초 | 표본3초 | 중앙값초 |
|---|---:|---:|---:|---:|---:|
| before 기본+Python | 143.755 | 142.145 | 141.903 | 142.966 | 142.145 |
| after 기본+Python | 74.178 | 74.257 | 73.694 | 74.083 | 74.083 |

- 비율 **0.52117995**, **47.8820% 단축**. warmup을 제외한각trial기본+Python합산wall의3표본중앙값이다. 이전19.5의고정source21job54case/4slot비율이나이번전체Python233초를성능표본으로재사용하지 않았다. 전체회귀나미래source의성능보장이아니다.
- before는기본7pass+보존1skip, Python8pass로합집합8/실행15개였다. after는기본hook0/Python8pass로합집합8을유지하고 각case정확1회 실행했다. 원hook본문SHA256 `9406229c4f6087c27dd133918c14403b2dc095de5f04ef6ac5bcde6f7614a871` 동일. 실제container/설치/갱신/보존단언·timeout·skip은유지됐다.
- 측정12hook의정확container ID12개, project/container/network/volume/home부재 및각port bind가능을감사했다. 원시16reporter/명령로그/metadata와hook자원로그의SHA256은 `verify/measure-v1/audit.json`에전부보존했다. 원시·사본·브랜치·워크트리·세션은보존한다.

## Operator Actions

- 추가 운영자 조치는 없다. 사용자 인수는 남으며 done으로 올리지 않는다. 중앙은 정확 source와 영향 감사를 마친 뒤 main 반영을 담당한다.

## Auto Run Result

- 상태: **built**(사용자 인수 전, done 아님). 최종 독립 증거 감사와 LOW문서/증거 교정의 후속 독립 확인까지 완료했다. 범위 commit/push·원격SHA·clean 확인 증거는 지휘자의 로컬 최종 보고 `.brain-automation/tickets/19.6/final-report.md`에 보존한다. 중앙 main/state는 변경하지 않는다. 필수 회귀의 중단 이력·제한보완·실제Python통과 및 hook 전후측정·자원부재를 위에 구별해 기록했다.
- 구현리뷰 r1~r3 수렴, 측정driver 준비리뷰 MD전항목resolved, 회귀복구/premeasure 독립감사정합. 마지막 성능 원시 감사도 정합이며 FE-1/FE-2를 위 처분으로 보완했다.
- deferred는 단일 빈 목록이다. 미충족수락조건을defer로숨기지않는다. 잔여한계는 최초TS정상exit미확인(승인된manifest제한보완), 이번Python의기존runner TMP계약, 고정source/host조건에한정한성능수치다.
