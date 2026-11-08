---
title: '19.11 Garmin core 달력 경계 전송 회귀 복구'
type: bugfix
ticket: 11
created: '2026-11-08'
status: built
baseline_revision: d594aebd4cbf6c5f7e6057762db44059080edf91
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      최초 전체 Python의 artifacts locator 직렬화 사례가 third import에서 실패했으나 허용된 관측 재검증 1회는 통과해 원인은 미확정이다.
    evidence: |-
      최초 final-python-raw.log에 garmin-artifacts.test.ts:374의 비정상 종료를 보존했다. 같은 시험 지문·정확 case·실제 import·기존 단언·timeout을 유지한 artifacts-single-diagnostic은 exit0였다. 중앙 msg_5c1dfa8519b4가 이 후속 실행 결과를 채택했으며 제품 결함을 확정하지 않는다. NODE_OPTIONS 관측기는 원함수에 그대로 위임하지만 전후 동기 로그가 타이밍을 바꿀 수 있다. 최초 실패 stderr는 reporter에서 유실됐고 성공 stderr는 execFileSync가 반환하지 않는다. 원인 해결·최초 전체 통과·비계측 반복 안정성을 주장하지 않는다. 재발 시 같은 case의 실패 stdout/stderr/exit를 안전 보존한다. 추가 반복은 금지됐다.
    location: >-
      apps/cli/python-test/garmin-artifacts.test.ts:374
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** database·exit 복구 시험은 실행일+2일의 보고일에 항상 사진 1장을 기대한다. 인접 수면값이 주간 버킷을 가르면 실제 전체 기간 그래프가 추가되어 이 기대가 깨질 수 있다.

**Approach:** 실제 수집·그래프·파일·채널 경로를 유지하며 보고 당시 조건과 인접 주간 경계를 결정적인 합성 입력으로 검증한다. 그래프 명세와 정확한 전송·바이트·재시도를 연결해 시험 전제 오류와 제품 결함을 구분한다.

## Boundaries & Constraints

**Always:** 개발·리뷰 수정 중 시험 실행 금지, 컴파일 확인만. 마지막 독립 후속 리뷰 뒤 전체 TS → Python 순차 각1회. 전용 DB·role·home·venv·가짜 HTTP·시계만 사용. 오류·증거는 durable `.brain-automation/`에 보존. 한국어 보고, 홈 절대 경로 금지.

**Never:** 생산 코드 변경은 구체 원인·최소 범위를 중앙에 먼저 질문한다. 19.5 runner/slot/config, tooling/test-db, tooling/test-changed, Python config, garmin-report 파일 수정 금지. 과거 migration1..41 및 승인 main의0042/core42·plugin0.1.23/ref598497c 불변. 전송 메서드 느슨한 허용·timeout 증가·실제 그래프 mock·중앙 state/main 변경 금지.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 보고 당시 | 수집 중단 database/exit, 보고일 2026-11-10, 직전 일·월 수면값 | 30일·전체 수면 그래프의 정확한 목록, 묶음 전송과 실제 bytes | 문서 500→200, 성공 항목 재전송 없음 |
| 월요일 경계 | 보고일 2026-11-09, 직전 두 날짜 수면값·당일 정규화 행의 운동/근력0 관측 | 50/57/58 정확한 그래프 목록, 3장 묶음과 실제 bytes | 같은 문서 재시도 계약 |
| 같은 주 경계 | 보고일 2026-11-11, 직전 두 날짜 수면값·당일 정규화 행 | 50 정확한 그래프 목록, 단일 사진과 실제 bytes | 같은 문서 재시도 계약 |
| 기존 채널 경계 | 단일·묶음 입력 | channels-bundle 기존 시험의 정확한 메서드·바이트·재개 단언 유지 | 연결 단절 뒤 성공 항목 생략 |

</intent-contract>

## Current Acceptance — 실행 반증과 중앙 변경 반영

위 intent-contract는 최초 계획을 보존한 역사 기록이다. 이후 전체 실행과 중앙 추가 배정으로 확정한 현재 기대가 우선한다.

| 보고일 | 정확한 graph manifest (번호 접두사) | 전송 |
|---|---|---|
| 2026-11-09 | 50-sleep-30d, 57-workouts-all, 58-strength-all | 3장 묶음 |
| 2026-11-10 | 50-sleep-30d, 54-sleep-all, 57-workouts-all, 58-strength-all | 4장 묶음 |
| 2026-11-11 | 50-sleep-30d | 단일 사진 |

모두 실제 PNG 생성·등록·파일·HTTP bytes 및 문서 500→200 재시도를 검증한다. 중앙이 추가한 native 범위는 가림 표시와 DB 원본 ID를 분리하며, 현행 통합 schema는42다. 최초 schema41 증거는 그대로 보존한다.


## Code Map

- `apps/cli/python-test/garmin-core.test.ts` — 유일한 소스 편집 대상. Date.now+2일, 실제 시계 기반 queue 가속 SQL, 수집 Python 날짜 seam, 수동 regenerate 날짜, lifecycle 실제 시계를 함께 살핀다.
- `extensions/garmin/src/garmin_pipeline/charts.py` — 읽기 전용. `_read_chart_data`는 최소 관측일부터 보고일까지 `_bucket`한다. 주간 버킷은 월요일 경계이며 `_all_trend`는 값 있는 버킷 >=2일 때만 생성한다. `_daily_trend`의 최소 관측수와 실제 graph names를 확인한다.
- `extensions/garmin/src/report_publish.py` — 읽기 전용. day manifest graph content가 실제 등록·채널 입력 원천이다.
- `extensions/garmin/src/report_channel.py` — 읽기 전용. 01..49·50..99 그룹을 각 10장씩 나누므로 50/54 두 그래프는 하나의 앨범이다.
- `extensions/garmin/src/report_runtime.py`, `scheduled_date.py` — 읽기 전용. 예약 실행 날짜는 occurrence envelope, 수동 regenerate는 Python dates.today를 사용한다. disposable 설치 사본의 시험 seam으로 달력을 일관되게 고정한다.
- `apps/cli/test/channels-bundle.test.ts` — 기존 단일/묶음 bytes와 재시도 coverage 재사용, 수정하지 않는다.
- `.brain-automation/tickets/19.11/evidence/` — 원문 보존 완료. 원문 실행은 cb5214293d3169977a6e006940b41da52a305dc8 + 미커밋19.5이며 clean 기준 재현으로 단정하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] T1 `apps/cli/python-test/garmin-core.test.ts` — 보고 당시와 인접 경계를 명시한 결정적 시나리오로 database·exit 복구를 검증한다. fake clock·SQL next_attempt_at·disposable Python today·manual regenerate·실제 lifecycle 시계를 일관되게 다루고 시험 이름에 날짜를 드러낸다.
- [x] T2 `apps/cli/python-test/garmin-core.test.ts` — 정확한 그래프 이름/개수·등록 bytes와 fake HTTP의 사진/묶음/문서 bytes·호출순서·500→200·완료 후 중복0을 검증한다. 실제 그래프/파일/전송과 attempt fence 단언을 유지한다. T1과 같은 Task로 구현한다.

**Acceptance Criteria:**
- Given 보고 당시와 인접 날짜·두 중단 방식, When 기존 격리 fixture에서 전체 회복을 실행하면, Then 예상 그래프 명세·전송 형태·bytes·문서 재시도가 정확하며 실행일에 의존하지 않는다.
- Given 기존 단일/묶음 채널 시험, When 최종 전체 TS → Python을 실행하면, Then 기존 bytes·재개 시험 및 수정 core 모든 사례가 실행·통과한다.
- Given 보존된 실패 원문과 깨끗한 원본 기준, When 최종 검증 경계에서 같은 날짜·환경의 관련 시험을 별도 archive로 대조하면, Then runner 변경 없는 기준 귀속과 수정 결과를 출처·지문으로 구별한다. 현재 날짜 성공으로 과거 실패를 부정하지 않는다.

## Implementation Notes

- T1 기대 보완: 11-09는 50/57/58(묶음), 11-10은 50/54/57/58(묶음), 11-11은50(단일). 현재 수집으로 생기는 당일 day_summary와 기존 관측행을 포함한 주간 집계를 명세 근거로 삼는다. 최초 계획의 수면만 계산한 단일 기대는 불완전했으며 전체 실행 실패를 보존한다.

- 추가 Execution T3(최초 전체 순차 회귀 종료 뒤): `apps/cli/python-test/garmin-native.test.ts`의 success/failure 표시 ID 재사용을 fixture DB의 생성 전후·kind/target·요청 상관조건으로 원본 ID를 확인하도록 교정한다. 후보 0/복수는 실패. 기존 dispatcher idGen seam으로 카드가림 적중 합성 ID를 주입하고 현재 출력가림 기대를 정확히 검사한다. case·timeout·중단재개·SQLite oracle 단언 유지. 구현 중 시험 금지·compile만, 독립 Sol 후속 뒤 native 및 실제 영향 시험 재검증.

- Terra 구현 보고: `.brain-automation/tickets/19.11/implementation-1.md`. 주간 경계 원인을 소스에서 확인하고 3일×2중단 6사례와 실제 등록·전송 bytes를 작성했다. build/typecheck/diff-check 종료0, 시험 미실행.

## Plan Change Log

- 2026-11-08 중앙 최신 통합 지시(msg_45f89c6dfbd7): 원본 baseline과 schema41 역사 증거를 고정하고 승인된 main f1185a89db0d173200c953edfdb1ac80d6829322를 자기 브랜치에 정상 병합했다. 통합 HEAD f64d69925230b84bdc1b2777eed07cdff527055e. 현행 schema42/0042는 중앙8.3 소유로 그대로 수용하며 0001..41·plugin은 불변이다. 자기 추가 source diff는 core/native뿐이다. 과거 intent-contract의 41 불변 표현은 역사 기준이고 현재 실행 기대는 중앙 최신42 지시가 우선한다.

- 2026-11-08 최초 전체 회귀의 core 4실패를 근거로 기대 목록을 교정한다. `_read_daily`는 수면만 있는 기존 행과 수집으로 생긴 당일 행에도 운동시간·세션·근력볼륨의 관측값0을 생성한다. 11-09에는 과거 주+당일 월요일, 11-10에는 일요일+당주라 57/58 전체 그래프가 추가된다. 11-11은 모두 같은 주다. 기존 수면 graph·실제bytes·각 전송 분기·문서500 retry를 KEEP하고 정확한 전체 manifest를 명시한다. 제품 변경 없음.

- 2026-11-08 중앙 추가 배정(msg_73b2d020500f): 8.3 완결 회귀에서 별도 native UUID 가림이 확인돼 소유 범위를 core+native 시험으로 확장했다. 최초 전체 TS→Python 종료 뒤 native 시험만 수정하고 제품가림/공통 fixture/runner는 보존한다. 원본 intent-contract는 유지하며 추가 중앙 명세 `.brain-automation/tickets/19.11/native-scope-central-decision.md`를 따른다. 최초 전체 회귀 반복 없이 수정의 관련 시험만 검증한다.

## Review Triage Log

### 2026-11-08 — 승인 main42 통합 독립 확인
- review-4-integration.md가 dispatcher ID 주입·출력가림·Drive 미연결 경로와 schema42 fixture를 추적해 신규 확정 finding0으로 확인했다. 승인main의 migration/plugin 관련144파일과 자체 두 시험 지문이 동일하다.
- 현재merge HEAD f64d69925230b84bdc1b2777eed07cdff527055e + 자체시험지문에서 core/native10case exit0, CLI dispatcher88case exit0. integration-validation.json에 source SHA-256·명령·시각·exit·로그를 보존했다. 최초전체회귀·성능·artifacts를 반복하지 않았다.

### 2026-11-08 — 최초 회귀 교정 및 중앙 추가 범위 후속
- 최초 core4실패는 수면만 계산한 계획 가설의 불완전함이며 day_summary 당일0관측의 정확한 graph 목록으로 교정했다. review-3-followup.md가 4실패별 해결을 다시 추적했고 native의 success/failure 원본ID 분리·결정적 출력가림도 개별 확인했다. 신규 확정 finding0.
- 관련 core/native2파일10case exit0. 원본 d594aeb archive에 보고일만11-10으로 주입한 대조는 기존 sendPhoto 단언2실패 exit1이다. 원문 실패와 원본 출처·입력 seam·지문을 baseline-provenance.json에 구별한다.
- 중앙 msg_5c1dfa8519b4: artifacts 기능결함을 확정하지 않고 최초 실패 원문·관측제한을 deferred로 보존하며 허용1회 관련통과를 후속 gate결과로 채택한다. 추가반복금지. 최초TS hook7은 private HOME 실제OrbStack 런타임 연결부재였으며 연결복원후 전체Python hook8이 통과했다. 동일7case+Python전용조건1case 합집합과 config env BRAIN_PYTHON_UPDATE_TEST=1을 연결한다.

### 2026-11-08 — Independent follow-up
- 채택 수정 5개와 중복 edge finding 각각 해결 확인. 신규 확정 finding 0건. `.brain-automation/tickets/19.11/review-2-followup.md`에서 시계 선점 조건·multipart 참조·요약·scope 문서·bundle 본문을 개별 추적했다. 실행 검증은 다음 최종 회귀 단계다.

### 2026-11-08 — Review pass 1
- verdicts: 6 findings — high 2, medium 4, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` Blind-1 수동 재생성 시계 불일치 — extensions/run.ts가 실제 nextAttemptAt을 쓰고 daemon은 합성 시계이므로 고정일 이후 선점 불가. 생성 직후 소유 작업만 보정하도록 수정 배정.
  - `[medium]` `[patch]` Blind-2 media attach 연결 미단언 — 현재 multipart 파서는 파일명만 보존한다. 요청 필드와 media 참조를 함께 검증하도록 수정 배정.
  - `[medium]` `[patch]` Blind-3 요약·수신 대상 미단언 — 정확한 첨부 bytes 외 메시지 의미를 보강하도록 수정 배정.
  - `[medium]` `[patch]` Blind-4 bundle 내용 독립 기대 부재 — DB 원문과 HTTP 동등성만으로 scope 누락은 잡지 못하므로 fixture 원문과 그래프 참조 단언 배정.
  - `[medium]` `[patch]` Blind-5 개별 scope 문서 운반 미단언 — 기존 bytes 루프를 네 scope 문서로 직접 확장하도록 수정 배정.
  - `[high]` `[patch]` Edge-1 수동 재생성 시계 불일치 — Blind-1과 같은 원인으로 함께 수정 배정. high 두 finding은 단일 수정 entry다.
- Verification-gap: 발견 0건. Intent-alignment: 확정 위반 0건, 실행 증거 미확인은 최종 검증에서 해결한다. 사진 실패의 별도 반복은 기존 채널 bundle 재개 coverage로 연결하고 본 통합 시험은 양 사진 분기 성공 뒤 문서 500 재시도를 검증한다.

## Verification

- 개발 중: `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행. 의존성 준비는 require_escalated 사용.
- 마지막 구현·독립 후속 뒤: `VITEST_MAX_WORKERS=2 pnpm test` → `VITEST_MAX_WORKERS=2 pnpm test:python` 순차 각1회. 실패 원문·환경·exit 보존, 수정 뒤 `pnpm test:changed -- d594aebd4cbf6c5f7e6057762db44059080edf91` 및 관련 시험으로만 재검증.
- 최종 경계의 원본 대조는 독립 archive에서 동일 보고 날짜를 disposable 입력으로 주입해 관련 core 시험을 실행하고 provenance를 명시한다. 중앙·다른 티켓 자원은 변경하지 않는다.

## Auto Run Result

- 구현: core의 2026-11-09/10/11 × database/exit6사례가 실제 3장/4장묶음·1장사진의 graph manifest, 네scope 문서와bundle, 등록/로컬/HTTP의 정확bytes, 요약/수신자/media참조와 문서500→200 재시도를 검증한다. 합성시계·수동재생성·실제lifecycle 시계를 일관되게 다룬다.
- 추가 중앙범위: native4사례는 가림적중 합성UUID를 실제dispatcher idGen seam으로 주입하고 자기DB의 생성전후·kind/target·요청ID 단일일치로 원본을 찾는다. 성공/실패 출력표시는 가림계약대로 검증하고 SQL/재개는 원본ID만 사용한다. 실제감독자·Python·SQLite oracle·case/timeout을 유지했다.
- 자체변경: apps/cli/python-test/garmin-core.test.ts, apps/cli/python-test/garmin-native.test.ts, 이계획. 제품/가림/그래프/공통fixture/runner/config/plugin/migration 자체변경없음. 중앙승인main42는 자기브랜치에 정상merge했다.
- 독립검토: 최초4렌즈와 후속review2/3, 통합review4 완료. 최초6finding(중복1포함)은5수정으로 교정·개별해결확인했다. 기각finding없음. 최초수면중심가설의 불완전함은 전체회귀가 반증했고 실제0관측근거로 교정·독립확인했다. followup_review_recommended=false, 남은필수실질수정없음.
- 최초전체: VITEST_MAX_WORKERS=2 pnpm test(exit1,218파일중217통과/4673pass/7fail/1기존조건skip,549.94초) → pnpm test:python(exit1,16파일중14통과/68pass/5fail,436.39초) 순차각1회. 전체통과로보고하지않는다. TS hook7은초기private HOME OrbStack연결문제이며 실제runtime연결복원뒤Python hook동일7+전용조건1=8case 통과로처분했다. Pythoncore4는교정후관련검증으로해결, artifacts1은아래중앙처분이다.
- 후속관련: schema41수정core/native10case exit0; 원본d594aeb archive의 날짜만11-10주입한기존기대2case exit1(sendPhoto1기대/0관찰); artifacts동일case관측1회 exit0(1pass/9filter-skip). 각각related-validation.json/baseline-provenance.json/원문로그로 출처구별.
- 현재schema42: build/typecheck/diff-check 통과, core/native10case exit0(162.72초), CLIdispatcher88case exit0(16.77초). source는merge HEAD+파일지문이며 최종범위commit은같은시험바이트를담는다. 전체반복없음.
- 잔여위험: artifacts최초third import실패의원인은미확정이다. 중앙msg_5c1dfa8519b4가 허용1회재검증성공을후속gate로채택했다. 관측기는원함수위임이지만전후동기로그로타이밍이변할수있다. 최초실패stderr유실·성공stderr미반환을보존하며 원인해결/최초전체통과/비계측반복안정성을주장하지않는다. 재발시같은case의실패stdout/stderr/exit를안전보존할것을권고한다. 단일deferred항목에기록했고필수미충족AC를이관하지않았다.
- operator_actions: 당장필요한운영자조치없음. 실제계정/건강값/발신/운영DB미사용. 중앙의최종수락·main병합/push는별도이며본지휘자는수행하지않는다.
- 증거: .brain-automation/tickets/19.11/ 아래spec/evidence/manifest/로그/리뷰/영수증을보존한다. 자원정리와원격SHA최종확인은최종보고에기록한다. 워크트리·브랜치·세션을보존한다.

- 최종 소유 자원 정리: `.brain-automation/tickets/19.11/owned-resource-cleanup.json`에서 254개 소유 container ID의 부재와 전용 임시 home/archive 제거를 확인했다. durable baseline tar·입력 patch·원문·리뷰·영수증은 보존했다.


### 중앙 수락 문서 정합 교정 (2026-11-08)

최초 계획의 core41 고정 문구와 11-09/11 묶음 행은 뒤의 실제 main42 통합 및 R3 관측0 교정과 모순돼 현재 계약에 맞춰 정리했다. 11-09는50/57/58, 11-10은50/54/57/58, 11-11은50이다. 제품/시험/검증 산출물 변경 없이 문서만 교정했으며 최초 원문과 반증·후속 리뷰·실행 이력은 로컬 archive와 위 기록에 보존한다.
