---
title: '22.6 Refactor sweep: 잔여 정리 항목 감사'
type: 'refactor'
ticket: 6
created: '2026-11-08'
status: 'built'
baseline_revision: 'e8a80b18451b43a14157cf673f40c28531b7dbb9'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
operator_actions: []
---

<intent-contract>

## Intent

**Problem:** entry6는 선행22.1~5의 계획·리뷰에서 남긴 작은 정리를 착수 때 확정하고 처리하도록 요구한다. 이미 해결된 항목과 새 기능·운영 후속을 구별하지 않으면 불필요한 변경이나 과거 실패 은폐가 생긴다.

**Approach:** 원문 리뷰·공개 계획·중앙 follow-ups를 현 코드와 대조한 scope ledger를 남긴다. 실질 정리 대상이 없으면 억지 코드 변경 없이 독립 감사와 필요한 전체 회귀로 닫는다.

## Boundaries & Constraints

**Always:** 결과 행·순서·오류·원본 바이트·SQL/timed 의미·임계·schema42와 migration1~42를 보존한다. 이전 실패·raw 손실·전승 한계는 남긴다. 첫 Execution은 정적 조사만, 개발 중 시험 금지·compile만, 마지막 구현·독립 후속 뒤 전체 TS→Python 순차 각1회다. 첫 heavy 배정 전 중앙 통보와 명시 측정창을 준수한다.

**Never:** 새 성능 기능·광범위 공통화·과거 raw 대체·성능 통과까지 반복·중앙 state/main 변경·main 병합/push를 하지 않는다. 8.4 추출기/Carry/Store·PG/lock과19.5 test-db/Pythonconfig/slot/hooklane/측정driver를 편집하지 않는다. plugin0.1.23/ref598497c를 바꾸지 않는다.

</intent-contract>

## Code Map

- `story-tracer-10-plan.md`, `story-snapshot-10-stale-plan.md`, `story-10-plan.md`, `story-1-sql-plan.md`, `story-uuid-uuid-plan.md`: 같은 디렉터리의22.1~5 전체 계획과 처분 이력.
- `tooling/query-perf/src/` 및 `test/`: 5시나리오 fixture/oracle/비교·실패 gate. 제품 경로는 `packages/postgres/src/imports.ts`, `attachments.ts`, `conversation-index.ts`, `recall.ts`와 core 지문/검색이다. 편집하지 않는다.
- `.brain-automation/tickets/22.6/execution1-static-complete-report.md`: 원문85개 인벤토리와 현 코드 대조. `static-evidence/review-inventory.txt`, `git-blob-comparison.txt`는 로컬 상세 근거다.
- 중앙 `~/github/second-brain/.brain-automation/tickets/22.1`~`22.5/worktree-checkpoint-archive`는 읽기 전용 원문, 중앙 `automation/follow-ups.md`는 읽기 전용 후속 목록이다.

## Scope ledger — 착수 고정

| 후보·근거 | 현 코드와 처분 | 후속·한계 |
|---|---|---|
| 22.1 plan101~185: candidate/조건/출처/shared/unhanded | import-cleanup51~82 및 독립 t6 확인으로 이미 해결 | 동일 서버 출처 자동 인증은 비교 계약 확장으로 제외 |
| 22.1 plan110/139/255~266: 긴locator·강제종료·300ms취소 | 현 인덱스와 취소 경로 확인, 범위외 | 인덱스·자원복구 의미 변경, hooklane 안정화는 별도 판단 |
| 22.2 plan105~150/208~218: 객체 참조·stale oracle | session-snapshot111~121/150~159에서 이미 해결 | CREATE 응답 유실 자동복구는 자원소유 의미 변경으로 제외 |
| 22.3 plan133~258/317~348: locale/fixture/Unicode/cleanup | protocol/compare 및 T39/T52/T73에서 이미 해결 | 통계·후보제한·허용오차·초기복구 API는 새 기능/측정 의미라 제외 |
| 22.4 plan108~132: existing/missing 초과·UUID/ownership/201청크 | attachments.test64~68 및 confirm-5로 이미 해결 | 편집 없음 |
| 22.4 plan113/118/180: 동일cluster 인증·준비대기 | PG/lock/측정계약 변경이라 제외 | T6 1.1720배/T8 1.50575배 최초 실패·원인 미확정 보존 |
| 22.5 plan88~111/157: Bitmap/실패raw 거부 | file-location-compare7~55에서 이미 해결 | 비정규 입력 스캔은 원래 의미; CREATE 유실 한계 유지 |
| 릴리스·환경·공통run/rules/Store/export | 비소유/별도 운영 및 새 계약이라 제외 | 구체 충돌이 생길 때 중앙 조율; 현재 편집 없음 |

**포함 결정:** 위 후보별 처분·소스 지문·성능 전승 한계를 공개 감사 문서로 남기는 문서 정리만 채택한다. 제품/측정/fixture 코드 정리는0건이다. 후보를 못 찾았다는 이유로 새 개선을 만들지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] E1 `.brain-automation/tickets/22.6/` — 원문 계획5개·리뷰85개·follow-ups와 현 코드의 정적 조사 및 지문 대조. 첫 부분 failed와 보완 succeeded를 구별한다.
- [x] E2 `story-refactor-sweep-audit.md` — 위 ledger의 근거·읽은 원문 범위·정리0건 이유·지문 전승 범위·제외 후속을 공개 가능한 감사 문서로 정리한다. 원시/비밀/개인홈 절대경로를 넣지 않는다.
- [x] E3 이 계획/로컬 보고 — 독립4렌즈와 필요 후속, 최종 회귀·자원 정리·범위commit/branchpush/중앙보고의 실제 증거를 기록한다.

**Acceptance Criteria:**
- Given 선행 계획·원문 리뷰·follow-ups, when 후보를 현 코드와 대조하면 then 모든 ledger 항목에 포함/이미해결/범위외 근거와 남은 위험이 공개 문서에 있다.
- Given 코드 정리0건 결정, when baseline과 최종diff를 비교하면 then 제품·SQL·runner·fixture·migration·plugin 바이트는 그대로이며 독립 영향 검토가 이를 확인한다.
- Given 과거 수락 실측, when 전승을 보고하면 then 명시 소스 범위와22.3 schema41→42/cleanup·raw6손실 한계를 유지하고 현재42의 새 timed 통과를 주장하지 않는다.
- Given 최종 문서·독립 후속 완료, when 전용 합성 환경에서 TS→Python 전체를 순차 실행하면 then 실제 exit/최초실패 처분/관련 재검증과 runner 시험 포함 여부가 남고 필수 미충족을 built로 숨기지 않는다.

## Implementation Notes

E1 최초 Task는 합본 출력 잘림으로 failed, 후속 Task에서100행 이하 재독으로 보완했다. 지문 수집의 zsh path 변수 실패도 원문에 보존했다. 첫 실행에서 heavy/PG/시험은 없었다.

## Plan Change Log

2026-11-08 R1: B1/B2의 수락 근거 연결·공통 의존 영향 분류가 빠져 E2를 보완한다. 코드 변경은 없으므로 되돌릴 제품 코드는 없다. E2에는 다섯 시나리오별 과거 수락 실행·현재 소스 전승·이번 관련 러너 시험의 역할을 연결한 표와 run/core/revision/fixture/compare 의존 차이 분류를 포함한다. KEEP: 코드 정리0건, 과거 실패와 schema41→42·raw 손실·새 timed 미주장 경계를 유지한다. B3는 T6 승인 전 측정과 T10 승인 비교 구별을 공개 감사에 직접 보존한다.

## Review Triage Log

### 2026-11-08 — Review pass 1
- verdicts: 3 findings — high 0, medium 2, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` B1 runner 수락 증거 연결 누락 — entry6와 중앙명세는 관련 러너 시험+과거 실측 전승을 구별하도록 하지만 감사는 시나리오별 조합을 제시하지 않았다. E2의 연결 표를 추가한다. 현재 미완료 회귀 자체가 결함이라는 뜻은 아니다.
  - `[medium]` `[bad_plan]` B2 공통 의존 차이 영향 분류 누락 — a39224888a1ca2413df5758dbd9f6f5871e6e3fb→baseline diff에 core/run의 신규 import·dispatch가 존재한다. 개별 파일 blob만으로 관련 helper 의미 보존을 설명하지 못하므로 E2를 보완한다.
  - `[low]` `[patch]` B3 T6 승인 전 측정 출처 한계 누락 — 22.4 원본 계획82/167행이 승인 전임을 명시하지만 새 감사에는 없다. T10과 구별·소급 승인 금지를 직접 기록한다.
- verification-gap 0건, edge-case-hunter 0건, intent-alignment 확인 이탈0건. 각 전문은 로컬 review1-<lens>.md에 보존했다. 모든 렌즈가 보고한 뒤 triage했다.

## Verification

- `git diff --check` 및 baseline 대비 명시 경로 blob/차이 확인.
- 개발 중 시험을 실행하지 않는다. build/typecheck가 필요하면 중앙 통보·창 확인 후에만 실행한다.
- 마지막 구현·독립 후속 뒤 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 격리 PG/role/HOME/venv/TMPDIR/가짜HTTP에서 순차 각1회. 두 명령 모두 build한다.
- query-perf7개 시험(core/session-snapshot/session-snapshot-db/common-search/common-search-db/attachments/file-locations)과 제품 기존 시험의 실제 포함을 로그로 확인한다. 실패 교정 뒤 관련 시험/test:changed만 재검증한다.
- 중앙 W3:2026-11-08 07:44:32~07:59:32 UTC(16:44:32~16:59:32 KST) 신규heavy만 보류, 조기반환/만료 자동해제, 자동연장 없음.

### 2026-11-08 — 항목별 독립 후속

B1/B2/B3는 Sol medium 후속에서 각각 actual resolved로 확인됐다. 다섯 dependency diff와 함수 SHA를 Git 객체로 재현해5/5 동일 확인, 새 반증·추가수정 요구0건이다. 상세 원문은 로컬 `followup1-report.md`다. 최종 실질 문서 수정 뒤 전체 회귀를 순차 실행했다.

## Auto Run Result

- 산출물은 이 계획과 `story-refactor-sweep-audit.md` 두 문서다. 제품·SQL·runner·fixture·시험·migration·plugin 변경0건이다. scope ledger의 이미 해결/범위외 처분과 제외 후속은 감사에 남겼다.
- 독립4렌즈: blind-hunter 3건(medium2/low1), 나머지 각0건. 공통 근거계획2건 보완과 출처문구1건 반영 후 독립 항목별 actual resolved. rejected0/deferred0. 기존 제외 운영·계약 위험은 감사의 후보처분/역사 절에 유지한다. 추가 제품 수정 위험이 없고 후속 반증이 없어 추가 코드리뷰 권고false다.
- 최초 전체 `VITEST_MAX_WORKERS=2 pnpm test`:08:11:17~08:20:27UTC exit1, 4851통과/7실패/1skip. `VITEST_MAX_WORKERS=2 pnpm test:python`:08:20:27~08:27:12UTC exit1,65통과/8실패. 두 명령 내부 build 완료, 전체 재실행0회.
- 최초 실패는 bootstrap hook 한 파일이다. 로컬 status wrapper가 제한PATH에서 mktemp/env를 못 찾아 exit127임을 재현했다. 도구 절대경로 교정 후 실제 orb status 한인자만 자식HOME한정 위임해 실제 Running/exit0, 무인자/추가인자/start는exit2. 모든 최초 호출의 인과를 직접관측했다는 주장은 하지 않는다.
- 실패 교정 관련 재검증: `VITEST_MAX_WORKERS=2 pnpm exec vitest run --project bootstrap tooling/bootstrap/test/hook.test.ts`08:32:35~08:33:42UTC exit0(7통과/1skip), 이어 `VITEST_MAX_WORKERS=2 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts tooling/bootstrap/test/hook.test.ts`08:33:42~08:34:52UTC exit0(8통과). 최초7/8개 각각의 결과 대응은 로컬 regression-recheck-report에 보존했다. 최초 전체exit1을 성공으로 바꾸지 않는다.
- 최초 TS에서 query-perf7개 모두 통과:core20/session-snapshot29/session-snapshot-db3/common-search53/common-search-db15/attachments26/file-locations14. import-cleanup-indexes1/import-safety1/conversation-index23/session-concurrency1/recall-performance-contract7/attachment-extraction45/file-location-uuid3/conversation-fingerprint2/conversation-search1도 실제 선정·통과했다. 이를 감사의 시나리오별 전승표와 독립 영향확인에 연결하며 현재42 새 timed 통과는 주장하지 않는다.
- 격리: 소유PG·role·HOME·venv·TMPDIR·DOCKER_CONFIG와 합성fixture/가짜HTTP를 사용했다. 최초PG ID b464066e7b117598e06d2ae858e3140c879038aa2589f9cf2c4f23e51567, 재검증PG ID efb4813ee920d8e3695421eed202a4701649f66f295593508bd47d09cc12b6d7은 정확ID 제거 및 부재 확인했다. 최초fixture255생성/255제거/잔존0, 별도Compose컨테이너·volume/network와 임시root 부재 확인도 로컬 보고에 있다. 내부role은cluster와 함께 제거됐으며 별도role목록은 미수집이다.
- 승인거절0. 실제서비스 시작·전역context변경·상태dir링크·credential복사0. status위임은 완전한 사용자HOME 접근차단 증거가 아니며 실제wrapper/해시/PATH/호출별stdout/stderr/exit는 gitignored regression과 regression-recheck에 보존했다.
- 원래전체/관련시험로그·소유자원·초기부분실패·정적원문85개 인벤토리·지문·ready영수증은 `.brain-automation/tickets/22.6/`에 보존한다. 운영배포·CREATE응답유실·긴locator·취소readiness·22.3raw6손실은 해결로 바꾸지 않는다. 운영후속은 감사에 근거/위험과 함께 남았으며 현재제품변경이 설치ref에 반영됐다는 주장은 하지 않는다.
- built는 사용자인수done이나 에픽closure가 아니다. 중앙이 최종수락·main병합/push·에픽전이를 맡는다. 범위commit/branchpush·원격SHA·최종clean·중앙전송은 지휘자 최종 제출 단계에서 확인한다.


### 최종 독립 증거 확인 및 제출 경계

Sol medium 최종 증거 확인은 최초전체/실패대응/관련재검증/query-perf·제품선정/wrapper50호출/정확ID정리/Git바이트의 각 항목을 final resolved로 판정했다. 필수 unresolved·추가실행 요구0건이며 로컬 `final-evidence-report.md`에 전문을 보존한다. 전체조회 목록 원문은 임시root와 함께 제거돼 durable 이벤트·조회exit·교집합까지 보존되며, 개별role목록과 최초각호출 인과는 미확정이라는 한계를 추가 보존한다.

최초 Terra ready 영수증은 ownRun run_7002d231ef38 / task_00257a283af2 / ctx_b433ca544285이며 full worker-show에서 depth1을 확인했다. 원본 baseline과 모든 최종시험 source는 schema42다. 중앙이8.4에 배정한 schema43 최소호환4파일은 수정·통합하지 않았으며 미수락0043을 현재 증거에 포함하지 않는다. 수락 뒤 통합 필요성은 중앙이 실제 영향으로 판단한다.

2026-11-08 한국어 계획·감사·최종증거 전문을 재독했다. E3의 검증·독립확인은 완료했으며 commit/branchpush/원격SHA/clean/중앙송신의 실제 영수증은 로컬 최종보고와 worker 체크포인트가 원천이다. 감사의 미실행 문장은 착수 감사 작성시점이며 최신 실행결과는 이 Auto Run Result다.
