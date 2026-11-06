---
title: '큰 세션 snapshot의 지문·동시성 보존 성능 개선'
type: 'feature'
ticket: '2'
created: '2026-11-06'
status: 'built'
baseline_revision: 'b581a90abc6956364d394e5b19aac8e90cb32609'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/_bmad-output/personal-brain/research-performance-2026-11-04/sql/report.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 10만 메시지·102.4MB 세션은 두 snapshot에서 전체 JSON·순수 TS SHA 비용을 반복하고 그중 한 번은 반입과 같은 잠금 아래 수행한다. 조사상 약3.65초와 잠금1.86초지만 현재 baseline의 확정 수치는 새로 측정해야 한다.

**Approach:** 기존 바이트 계약의 정렬·설정 안정화를 공유하면서 JSON 토큰을 증분 전달하고 postgres 경계에서 native SHA를 사용한다. 같은 실제 store API를 전용 합성 DB에서 기준/변경 각각 측정해 두 transaction과 잠금 체류의 절반 목표 및 결과 동등성을 검증한다.

## Boundaries & Constraints

**Always:** 지문 문자열·stale 판정·redaction 재생성·원문 복원·claim fencing/expiry/rollback·동시 반입 안전성을 유지한다. schema39 및 migration0001~0039 바이트를 유지한다. core는 Node/DOM 없는 기존 컴파일 경계를 지킨다. 최초 snapshot의 repeatable read와 commit의 advisory/row lock 아래 재읽기 및 최종 expiry 검사는 유지한다. 측정 warm-up1회+원시3회/중앙값, 같은 fixture와 환경, 독립 기대값·SQL EXPLAIN·시각/부하/병렬 프로세스·RSS/CPU·산출물 지문을 보존한다.

**Never:** 캐시·재검증 제거·단언 축소·시험 전용 제품 우회, 검색/첨부/설치/기존 반입 정리 최적화, 중앙 state/main 변경·병합·push, 운영/다른 티켓 자원·실대화/계정 접근, 개인 홈 절대경로 문서화. 개발/리뷰 수정 중 시험·eval·성능실험 실행 금지, 컴파일만. 마지막 개발·필요 후속 리뷰 이후 성능 증거 및 최종 순차 전체 회귀를 수행한다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 지문 바이트 | 빈/역순/동시각 메시지·중첩 설정·정수키·Unicode/NUL/짝없는 surrogate·긴 본문 | 원래 전체 JSON+기존 SHA oracle와 같은 sha256 문자열, 입력 불변 | 기존 Date/설정 오류 유지 |
| 정상 확정 | 같은 snapshot, 유효 claim, 기존/변경 chunk | 기존 행 ID 유지·교체·삭제 의미 및 최종 chunk 동일 | 기존 DB 실패 분류 |
| stale | 첫 읽기 후 ingest/redaction/config 변경 | committed false, 잘못된 chunk 쓰기 없음, redaction 재생성 가능 | 기존 CONVERSATION_STALE |
| claim 경쟁 | owner 교체·잠금 대기 만료·쓰기 중 만료 | 거부 또는 전체 rollback | committed false |
| 동시 반입 | 같은 세션의 경쟁 ingest와 snapshot 확정, 명시 barrier | 독립 기대 행 수/지문/조각 일치, 누락·중복 없음 | claim 갱신 시 기존 거부 |
| 큰 세션 | 10만×1024 byte 원문 | 기준과 지문·조각·stale 동일, 두 transaction 각각 및 잠금 체류 중앙값 ≤0.5배 | 미달은 완료 불가 |

</intent-contract>

## Code Map

- `packages/core/src/recall/conversation-fingerprint.ts`: 복사 정렬(Date ms/id JS 비교), 재귀 stable(config), 전체 JSON+contentHash. `packages/core/src/index.ts`가 재수출. 기본 함수/fake 계약을 보존하며 공유 직렬화 조각 경계를 제공한다. `domain/sha256.ts`는 변경하지 않는다.
- `packages/postgres/src/conversation-index.ts`: snapshot config 검증·messages/body_raw 복원·두 transaction. native sink는 adapter 내부에 둔다. DB 정렬과 JS ms/id 정렬이 같다고 가정하지 않는다. 재읽기/잠금을 삭제하지 않는다.
- `packages/core/test/conversation-fingerprint.test.ts`, `packages/postgres/test/conversation-index.test.ts`, `session-concurrency.test.ts`: 기존 Unicode/stale/redaction/claim/rollback 증거와 추가 독립 oracle/barrier 시험.
- `tooling/query-perf/{run.mjs,src/core.mjs,src/import-cleanup.mjs,src/revision.mjs,test/core.test.ts,README.md}`: 22.1 러너/fixture 준비/비교/산출물 지문을 재사용한다. 새 `src/session-snapshot.mjs`와 `test/session-snapshot.test.ts`를 만들고 scenario별 분기한다. 기존 import-cleanup 판정을 보존한다. checkout의 실제 built API/pg를 사용하고 전용 cluster만 쓴다.
- `tooling/test-changed/rules.mjs`: JS 러너 경로의 선택 공백이 있으면 해당 규칙만 추가한다. 22.1 계획의 성능/회귀/부하 실패 이력은 보존하고 새 결과와 혼동하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] T1 `packages/core/src/recall/conversation-fingerprint.ts`, `packages/postgres/src/conversation-index.ts`, `packages/core/test/conversation-fingerprint.test.ts` — 공유 증분 JSON 직렬화 경계와 postgres native SHA를 구현하고 원형 독립 oracle/고정 벡터를 작성한다. core 기본 호출은 순수하고 같은 결과이며 stable 설정 열거·메시지 정렬·토큰 UTF8 경계를 보존한다.
- [x] T2 `packages/postgres/test/conversation-index.test.ts` 또는 새 전용 snapshot 경쟁 시험 — matrix의 실제 store·동시 반입·redaction·claim 경합을 명시 barrier와 독립 예상 행수/지문/조각으로 검증한다. 기존 시험 단언은 유지한다.
- [x] T3 `tooling/query-perf/src/session-snapshot.mjs`, `run.mjs`, `src/core.mjs`, `src/revision.mjs` — 새 snapshot 시나리오로 실제 read/commit API, 전체 config/messages/chunks/stale 결과, 독립 기대값, warmup+3회, 정확한 provenance/EXPLAIN/transaction·hash·직렬화·재읽기·잠금 구간을 기록한다. 기준 checkout과 변경 checkout에서 같은 러너/fixture를 사용한다. 시간 분해용 계측은 제품 결과와 분리하고 제품에 시험 전용 hook을 넣지 않는다.
- [x] T4 `tooling/query-perf/test/session-snapshot.test.ts`, `test/core.test.ts`, `README.md`, 필요시 `tooling/test-changed/rules.mjs` — 비교기의 결과 누락/불일치·중앙값 조작·fixture/provenance 불일치·각0.5 초과 거부를 시험 코드로 작성하고 재현/자원 준비/정리 절차를 문서화한다.
- [x] T5 이 계획 및 `.brain-automation/` 실행 증거 — 독립4렌즈 Sol/medium·채택수정·필요후속 뒤 확정 성능을 수집한다. 전용 PG `brain-222-perf`/`brain-222-test`, 고유 role/home/venv/산출물만 사용한다. baseline archive/build도 소유 임시 경로에 둔다. 전체 회귀는 VITEST_MAX_WORKERS=2로 pnpm test → pnpm test:python 순차 각1회, 실패 처분/관련 재검증 및 자원 정확ID 삭제·부재를 기록한다. built·범위 commit·branch push·원격SHA 확인 후 중앙에 보고한다.

**Acceptance Criteria:**
- Given 같은 100MB/10만 메시지 fixture와 baseline/변경 built API, when warmup 뒤3회 측정·compare, then 두 transaction 각각과 advisory 잠금 체류 중앙값은 기준의0.5 이하이고 지문·조각·stale 결과는 독립 oracle 및 서로와 일치한다.
- Given 같은 세션에 동시 ingest/redaction/claim 경합, when 실제 API의 snapshot과 확정을 barrier로 교차, then 독립 계산한 최종 메시지 수/지문/조각과 같고 stale/만료는 쓰기 없이 거부되며 기존 대화 수집 시험이 통과한다.
- Given 모든 마지막 구현·리뷰 수정 완료, when 전용환경 worker2의 pnpm test 및 pnpm test:python을 순차 실행, then 필수 시험이 실제 선정·통과하고 실패는 원인별 처분·재검증되며 소유자원 정리 증거와 독립 리뷰가 완결된다.

## Implementation Notes

- T1: 원형 JSON 토큰을 공유하는 generator와 postgres native SHA를 구현했다. 지휘자가 3파일 diff를 확인했다. 잠금/재읽기/expiry 수정 없음. 독립 원형 oracle·고정 벡터 시험 코드는 작성됐고 실행은 유예다. 구현자 보고 `.brain-automation/reports/t1.md`: build/typecheck/diffcheck 각0. 실제 성능은 아직 미측정이다.

- T2: 명시 snapshot gate 뒤 같은 batch의 두 연결 반입 또는 redaction을 수행하고 stale 거부 뒤 재생성을 확인하는 시험 및 설정 변경 시험을 작성했다. 지휘자가 diff의 독립 원형 JSON/Node SHA·예상 행수·직접 조각 기대값을 확인했다. 기존 claim 시험은 유지됐다. `.brain-automation/reports/t2.md`, 컴파일 종료코드 `.brain-automation/logs/t2/` 각0. 시험은 미실행이므로 matrix 실행 감사는 최종 회귀에서 수행한다.

- T3: 실제 read/commit API warmup+3회, 독립 원형 지문·메시지·5천 chunk oracle, stale 거부, query 추적 transaction/잠금 및 별도 대기·EXPLAIN·진단 CPU 단계와 provenance 코드를 작성했다. 지휘자가 전체 새 러너와 연결 diff를 확인했다. 별도 hash/직렬화 진단은 transaction 내부 수치로 주장하지 않는다. `.brain-automation/reports/t3.md`, compile/syntax/diff 각0. 러너 미실행으로 fixture/실측 판정은 최종 검증 전 미확정이다.

- T4: 비교기/CLI/core untracked provenance 시험, 필수 fixture/환경/해시 검증 및 재현 문서를 작성했다. 지휘자가 시험·비교기·README diff를 확인했다. `.brain-automation/reports/t4.md`: build/typecheck/syntax/diff 각0. 시험/성능 실행은 계속 유예이며 실제 실행 전 독립4렌즈 리뷰를 수행한다.

- R1 채택 수정(T6): provenance Git/archive·lock 검증, 결정적90/70 tracing 시험, 실제 pg_locks probe 대기 확인, 초기/변경 쓰기3표본·독립 hash, 소켓오류/정리 자원 상태 및 mktemp 문서를 보완했다. 지휘자가 변경 코드와 시험을 확인했다. `.brain-automation/reports/t6-r1-fixes.md`, build/typecheck/syntax/diff 각0. 실행은 아직 유예이며 새 측정·정리 경로를 후속4렌즈로 확인한다.

- R2 채택 수정(T7, 새 Terra): 무간섭 판정 표본과 별도 advisory 진단을 분리하고 raw SQL120초 제한·최초연결 공통정리·CLI정제·store code/message·프로젝트setup·대기 표본/실패복원/warmup 시험을 보완했다. 지휘자가 소스와 시험 diff를 확인했다. 최초 typecheck1은 setup 상대경로 수정 뒤 최종 build/typecheck/diff/syntax 각0. `.brain-automation/reports/t7-r2-fixes.md`, 실행 유예 유지.

- T8: F1의 snapshot 누적 참조를 제거했다. 지휘자가 callback의 read 블록과 반환/수집 경로를 확인했으며 시간·span만 남고 oracle/warmup/순서 유지다. `.brain-automation/reports/t8-retention.md`, build/typecheck/diff/syntax 각0. 이 직접 수정의 별도 전체 리뷰 권고false; 개발·리뷰 수정을 마치고 최종 검증으로 전환한다.

- T9 최종 순차 전체 회귀 최초실행: pnpm test 종료1(196파일/4412시험,54실패/1skip), 이어 test:python 종료1(16파일/69시험,8실패). `.brain-automation/reports/t9-final-regression.md`. 새 러너 stale fixture의 immutable UPDATE1건과 격리 HOME/TMPDIR/인증 환경 실패를 구분 조사한다. 전용cluster 정확ID 삭제·fixture179/179 removed 보고. 제품/시험소스는 수정하지 않았으며 실패 후 수정·관련 재검증으로 이어간다.

- T10: 불변 UPDATE 실패를 허용 INSERT로 최소 수정하고 추가후 snapshot의 독립 staleFingerprint·전체 메시지를 검증한다. 제품/trigger/migration 변경없음. 62실패 개별JSON 분류, 격리HOME orb Stopped/default 대 정상Running/orbstack, fixture 기대 관리자password postgres와의 차이, repo내 TMPDIR의 ancestor판정 근거 확인. 미확정doctor 실패는 재검증에서 판정한다.`.brain-automation/reports/t10-regression-repair.md`, 컴파일 각0, 시험 미실행.

- T11: worker2 changed는154파일 중 hook만 실패(3282통과/7실패/1skip), Python hook8실패. 최초62중47통과·hook15잔존. 핵심6파일140시험은 JSON reporter로 전부 통과. 전용cluster/fixture122개 모두 정리. `.brain-automation/reports/t11-revalidation.md`와 audit 원문 보존.
- 중앙17.1 수락 알림에 따라 정상merge `26159cf69e36afaebafaf8488f2486e4d84b0727`로 원격main `4d0ec474627b9ca3e6b440b6b565757ddd72a9d8`를 티켓브랜치에 통합했다. 부모baseline 및main, 충돌0/수동소스수정0. schema39/migration/plugin 불변. snapshot 변경 미커밋분은 보존됐다. 공유Store/export 문서검색 추가는 관련 최소검증으로 확인한다. 중앙main/state변경없음.

- T12: 실제 OrbStack 소켓2개만 소유HOME에 연결해 제한PATH Running을 확인하고 일반hook4통과/3실패/1skip, Pythonhook5통과/3실패. 17.1+snapshot관련10파일198시험 및 Garmin preflight1 통과. 최초hook15중9해결/6잔존(승격재시도 context오류 및 후속plugin/DB_LOCKED). build/typecheck0, schema39/과거migration/plugin불변. 전용DB/fixture4개삭제·compose프로젝트현재부재 확인, 과거compose정확ID는 reporter증거누락 한계로 보존. `.brain-automation/reports/t12-hook-main.md`.

- T13: 소유DOCKER_CONFIG의 실제context/socket 연결은 확인했으나 Compose plugin 미준비로 최초설치가 실패해 일반7/Python8 실패. 후속 plugin 연결로 실제compose v5.5.0 사전확인, 미재실행. 원문실패를보존하고 다음두파일검증만시행한다. `.brain-automation/reports/t13-hook.md`. 제품/시험변경0, 소유컨테이너정확ID event삭제확인.

- T14: 제한/비제한PATH·두preload경로에서 실제orb/context/engine/Compose를 모두 사전확인한뒤 일반hook7/Pythonhook8 통과(각종료0, 일반의Python전용1skip은Python에서실제통과). 최초잔여6건각pass. 이로써 T9 최초62실패는 T11의47+T12/T14hook15로 재검증완료. 과거실패원인정밀인과는단정하지않고환경정정뒤통과로처분한다. 전용PG와Compose2정확ID create~destroy/부재확인, T12과거ID유실한계보존. `.brain-automation/reports/t14-hook.md`.

## Plan Change Log

## Review Triage Log

### T7 표적 확인
- R2 채택14행 해결을 Sol/medium이 정적으로 확인했다. 보고 `.brain-automation/reports/t7-targeted-review.md`.
- F1 `[medium]` `[patch]`: samples가 r.result.snapshot을 다음 측정까지 보관한다. 실제 read10만행 객체가 누적되어 GC/RSS 표본에 영향을 주므로 oracle 검증 뒤 시간·span 메타데이터만 반환하도록 최소 수정한다. 제품계약 새결함0, 실행검증은 미실행이다.


# R2 finding별 처분

보고 순서 VG → EC → IA → BH. 총19행: medium14, low2, false3. 미실행 자체는 결함이 아니며 필수 검증은 유지한다.

- VG1 [medium][patch] traced query reject 뒤 원래 prototype/callback 복원 시험 부재(preverified). 실패 전달/원본동일/callback 호출을 단언하는 시험을 추가한다.
- EC1 [medium][patch] admin.connect가 try 밖이다. 최초 연결부터 공통 정리/resources/정제 경로로 보낸다. 실제 접속 거부 시험 작성.
- EC2 [medium][patch] raw PG의 connection timeout은 SQL 대기 제한이 아니다. admin/observer/probe에 유한한 충분한 query_timeout을 적용하고 성능 표본의 제품 API timeout은 분리·명시한다. 로컬 PG 장애가 검증을 영구 정지시키지 않도록 한다.
- EC3 [low][reject] CREATE 성공 응답 유실 때 created 미확정. 전용 disposable 클러스터의 희귀 transport 경로이며 새 관리연결/소유권 재조회 분기를 추가하는 복잡성은 이번 일상 개발 경로의 효과보다 크다. DB명은 이미 오류 resources에 보존되므로 마지막 전용 클러스터 정확ID 정리에서 제거한다. 최종 보고에 불확정 생성 위험을 보존한다.
- EC4 [medium][patch] query-perf 단독 실행의 globalSetup 부재. 기존 프로젝트 패턴으로 등록하고 공용 cluster 사용은 피한다.
- IA1 [false][reject] 최초/변경 쓰기의 자동0.5 문턱 없음은 원문 verify의 두 snapshot txn 요구를 넘는 해석이다. 쓰기 수치와 비율을 별도 공개해 전체 handler 개선으로 일반화하지 않는다.
- IA2 [false][reject] 별도 JSON/hash 진단과 실제 txn 내부 직접 분해의 차이는 R1 carried. 러너/README가 이를 명시한다. 최종 증거는 실제 txn/잠금/SQL span과 별도 원인 진단으로 한정한다.
- IA3 [false][reject] 대형 경쟁/가리기 전체 성능 미측정은 R1 carried. 원문 경쟁 fixture 크기 강제 없음, 소형 실제 API 안전성 시험과 대형 실제 snapshot 성능을 구분한다.
- IA4 [medium][patch] 최초 연결 실패 공통 정리 누락. EC1 같은 수정.
- IA5 [medium][patch] 새 DB 시험 독립 실행 준비 누락. EC4 같은 수정.
- IA6 [medium][patch] probe 관측 장벽의 시간이 제품 판정 표본에 가산됨. BH1 같은 수정으로 대기 진단 반복과 무간섭 확정 표본을 분리한다.
- BH1 [medium][patch] 관측 장벽으로 commit/lock 수치 왜곡. 판정용 warmup+3회는 probe/observer 장벽 없이 수집하고, 실제 대기는 별도 진단3회 및 오버헤드/시각을 기록한다. 비교기는 진단과 판정 필드를 구별한다.
- BH2 [medium][patch] 단독 DB 프로젝트 setup 누락. EC4와 동일.
- BH3 [medium][patch] ok:false의 code/message를 일반 mismatch가 덮음. 반환 실패와 독립 oracle 불일치를 분리하고 정제된 오류 code/message를 보존하는 시험 작성.
- BH4 [medium][patch] 초기 admin 실패 정리 우회. EC1과 동일.
- BH5 [medium][patch] 동적 import/초기실패가 개인 경로 정제를 우회. 공통 CLI 정제 및 실패 시험을 추가한다.
- BH6 [low][reject] 생성 응답 유실 상태는 EC3와 동일. 고유 DB명 보존/전용 클러스터 최종 제거로 위험을 제한하며 recovery 분기는 추가하지 않는다.
- BH7 [medium][patch] 비교기가 advisoryWait raw3/중앙값을 검사하지 않음. 별도 대기 진단3표본을 필수 검사한다.
- BH8 [medium][patch] warmup 제외 시험이 길이만 단언. 식별 가능한 반복별 시간/값으로 첫 값 제외·뒤3개 순서를 단언한다.

패치의 독립 root는 초기오류·정제/시험준비/무간섭계측/오류원인/검증시험이다. 새 public 제품 surface나 제품 source 변경은 없다. R2는 후속pass이고 patched high0이므로 추가 전체4렌즈 권고false. 다만 변경한 측정 경계의 정확성을 Sol/medium 한 명이 표적 확인한 뒤 실행으로 전환한다. deferred는 없고 기각 low2의 이유와 위험을 보존한다.


# R1 finding별 처분

보고 순서 verification-gap → intent-alignment → edge-case-hunter → blind-hunter. 총14행(high0 medium11 low0 false3 maybe-false0), 중복도 각각 보존. 시험/성능 아직 미실행.

- VG1 [medium][patch] 실제 transaction/lock 측정 산출의 시험 부재. preverified. 결정적 시계로 BEGIN완료10/lock완료30/COMMIT시작80/완료100일 때90/70을 단언하고 warmup 제외/추적 실패 정리도 관측한다.
- IA1 [false][reject] 내부 비용 직접분해와 별도 진단의 차이는 숨겨진 구현 결함이 아니다. 실제 SQL/txn/잠금과 별도 직렬화/hash 진단을 명시했다. 최종 보고도 이 경계를 유지하고 대형 전체 handler 개선으로 주장하지 않는다.
- IA2 [medium][patch] 초기 생성/변경 확정이 표본 밖. BH3와 같은 측정 범위 보완으로 별도 조건과 독립 기대결과/3표본을 추가한다. 기존 unchanged 판정은 유지하며 추가 쓰기 표본을 섞지 않는다.
- IA3 [false][reject] 대형 성능 fixture와 소형 경쟁 fixture의 분리는 명세가 경쟁 규모를 지정하지 않고 T2가 독립 최종 행수/지문/조각을 검증하므로 위반이 아니다. 대형 경쟁 성능으로 일반화하지 않는다.
- IA4 [false][reject] 실제 통과 증거 없음은 개발 뒤 실행하도록 한 사용자 지시에 맞는 현재 단계다. 완료 전 확정 성능/전체 회귀 필수는 그대로 남는다.
- EC1 [medium][patch] pg Client error 리스너가 없어 idle socket error가 정리 경로를 건너뛸 수 있다. 소유 연결들의 오류를 보존하고 정상 정리로 전달한다. 오류 주입 시험을 작성한다.
- EC2 [medium][patch] DB 삭제 실패 문맥에 생성 name이 없다. URL/암호 없이 생성/삭제 상태와 정확 DB 이름을 보존하도록 직접 보완한다.
- BH1 [medium][patch] compareSnapshot이 dirty/diffSha256을 검사하지 않는다. Git boolean+hex와 archive null쌍을 검증하고 누락/오조합 시험을 작성한다.
- BH2 [medium][patch] lockSha256 미검증으로 의존성 차이 비교 가능. 형식/동등성을 요구하고 반환 provenance에 artifact/lock 지문을 보존한다.
- BH3 [medium][patch] 초기/변경 쓰기 표본 부재. IA2와 중복이며 같은 보완을 적용한다.
- BH4 [medium][patch] probe waitMs 양수만으로 실제 동일 advisory 경합을 증명 못함. backend PID/pg_locks의 대기 상태 또는 결정적 획득-해제 동기화를 증거로 남기고 미확인 대기는 성공으로 기록하지 않는다.
- BH5 [medium][patch] run의 warmup/추적/정리 실행 검증 부재. VG1의 결정적 tracing 시험과 소형 실제 격리 DB의 runner smoke 검증 코드를 작성한다. 큰 확정 성능과 구분하며 개발 중 실행하지 않는다.
- BH6 [medium][patch] README 고정 mkdir-p/archive 경로가 이전 산출물 혼합 가능. mktemp-d와 고유 결과 경로로 직접 교정한다.
- BH7 [medium][patch] 잔여 DB명 누락. EC2와 같은 실제 결함이며 같은 수정·검증으로 해결한다.

집계: medium11/false3. 후속 독립 리뷰는 실제 대기/시간 산출·정리 실패·새 쓰기 조건의 검증 위험을 대상으로 필요하다.


## Design Notes

Node native SHA는 postgres 경계에만 둔다. 메시지별 완성 JSON 토큰을 update하면 전체 JSON과 같은 바이트를 해시하면서 거대한 전체 문자열/숫자 배열을 피할 수 있다. stable(config)는 기존 Object.fromEntries/JSON 열거 규칙을 보존한다. core 기본 함수와 native sink는 같은 직렬화 계약을 공유하되 oracle는 원형 일괄 구현을 독립 보존한다. chunk Map 최적화/재읽기 제거/잠금 축소는 초기 구현에 포함하지 않는다. 최종 성능이 미달하면 근거를 보존하고 안전성 검토·계획 조정을 거친 후 추가 개발한다.

## Verification

- 개발 중: `pnpm build`, `pnpm typecheck`, `git diff --check`만, 시험/성능 실행 금지.
- 최종 성능: `node tooling/query-perf/run.mjs session-snapshot --checkout <baseline-or-current> --database-url <owned-perf-url> --out <local-result>` 두 번 순차 후 `node tooling/query-perf/run.mjs compare <baseline-result> <changed-result>`; 전체 fixture/3표본/각0.5 및 등가성 통과. 준비/측정/EXPLAIN/cleanup 구간을 분리한다.
- 모든 개발·필요 후속 리뷰 뒤 `VITEST_MAX_WORKERS=2 BRAIN_TEST_DATABASE_URL=<owned-test-url> pnpm test` → 동일 환경 `pnpm test:python`, 순차 종료0. core 지문·postgres snapshot/경쟁/ingest 기존 시험과 query-perf 시험의 실제 선정·실행 로그를 확인한다.
- 회귀 실패 수정 후 `VITEST_MAX_WORKERS=2 BRAIN_TEST_DATABASE_URL=<owned-test-url> pnpm test:changed -- b581a90abc6956364d394e5b19aac8e90cb32609` 및 관련 시험, 실패별 처분을 기록한다.
- 과거 migration 바이트/schema39·비범위 변경 없음·개인경로 없음·원격 branch SHA/clean 상태 및 소유자원 부재 확인.


## 최종 성능·실행 감사

2026-11-06 기준 원문 entry2/부모 epic·연구 후보2 및 모든 구현/리뷰/실행 보고를 전체 읽어 대조했다. baseline `b581a90abc6956364d394e5b19aac8e90cb32609`, 17.1 통합 HEAD `26159cf69e36afaebafaf8488f2486e4d84b0727`와 T10 이후 제품·러너 소스에서 검증했다. 이후 변경은 이 계획과 로컬 최종 보고뿐이다.

### 확정 성능

동일 현재 runner·lockfile·PG18.6 전용 cluster·Node24.17 및 동일 `NODE_OPTIONS=--max-old-space-size=8192`. 기준 archive와 current의 node_modules/dist는 독립이다. 100000행×1024byte/동시각20개/5000chunks, 각 warmup1+원시3회. 중앙21.11/17.5 heavy보류 확인창07:38:56~07:58:56UTC 안에서 baseline명령07:43:39~07:45:00, current07:45:00~07:45:47, compare07:45:47에 각종료0. 양쪽 표본은 무간섭 transaction 추적이며 별도probe진단과 분리했다. 완료즉시중앙에창반환했다.

| 구간 | baseline 원시3 / 중앙값 ms | current 원시3 / 중앙값 ms | 비율 |
|---|---|---|---|
| read transaction | 1679.976,1820.913,1672.042 / 1679.976 | 323.915,312.315,321.717 / 321.717 | 0.191501 |
| commit transaction | 2064.267,1848.292,1976.947 / 1976.947 | 507.788,554.005,534.647 / 534.647 | 0.270441 |
| advisory 잠금 체류 | 2063.670,1844.995,1976.327 / 1976.327 | 507.315,553.484,534.112 / 534.112 | 0.270255 |
| 초기 조각 쓰기(별도) | 7243.100,7300.693,7256.864 / 7256.864 | 5831.404,5923.045,5891.380 / 5891.380 | 0.811836 |
| 교체 쓰기(별도) | 1877.463,1844.325,1848.589 / 1848.589 | 532.313,475.089,519.510 / 519.510 | 0.281030 |

비교기 equal/pass 모두true. 전체 메시지·config·chunks/변경chunks hash 동일, 독립oracle 일치. 지문 `sha256:88666105e93f1241a7e9fa02d43b02788cd4a74391e4b41af6c308d5ee8fb5d0`; 새메시지추가 stale 지문 `sha256:1109a8ce1fe3fcb1e7bd846cf2f006e8628d26f9ba53e1f1bd240b5a126d8be8`와 거부 결과도 동일. 경쟁fixture는 별도 실제API시험에서 독립최종행수/지문/조각을 검증했다. 초기쓰기0.5 개선이나 전체ingest/handler성능개선으로 일반화하지 않는다.

별도 실제 advisory대기 진단 3/3 관측, 중앙값1831.035→524.990ms. 별도 전체JSON직렬화104.249→93.670ms, nativeSHA44.030→42.069ms, core순수지문1714.370→1635.730ms. 이는 실제 transaction 내부의 직접 hash/직렬화 분해가 아니라 독립 원인진단이다. SQL재읽기span과 EXPLAIN은 실제API의원문에서 수집했다. 두 계획은 messages_session_occurred_idx Index Scan+Incremental Sort, 각각100000행·14394hitblocks, 서버실행48.645→56.014ms로 SQL계획 개선을 채택한 것이 아니다. native증분hash가 큰 비용인 순수TS전체UTF8/SHA를 postgres경계에서 대체한다는 근거와 전체transaction개선으로 채택했다. snapshot 재읽기/잠금안재검증/claim만료는 유지했다.

baseline/current load1분평균1.78→2.36 / 2.36→2.20. 시작끝프로세스순간표본에vitest/pnpm/tsc없음과 중앙동료보류확인을 보존하되 모든순간 무부하를증명하지는 않는다. CPU user/system21344761/2947872→5607689/707433, maxRssKiB원시6092912→4784560은 러너생애(양쪽의순수core진단포함) 값이며 제품snapshot단독메모리절감률로 주장하지 않는다.

원시/명령/종료/시각/load/process/EXPLAIN/cleanup: `.brain-automation/logs/t16-performance/`, 전문 `.brain-automation/reports/t16-performance.md`. baseline/current artifact `ed5fdb65b7c6acf393aa61aa12832005604c093f6d2ae277fe7dad9eb3741453` / `b02da7e17b64b9a0ad0cc192672d318ead198182b54a76b43cdc20594bdce5ba`; lock `8a660ec5b6eeaab862cd7a9b76c8e1cf1d3ea6125f630f86726718ea18e37fac`, 동일runner `c544c8f08a2917758389b13c3e1f6e8fec3808bdb994a595a6b86f0fd7bdde38`. current dirty소스diff `dc7277e408b9adb1d97de11cbd45b2b79ed611924edeedd71b4c2ebcd83ec038`. 기준archive/원문증거보존.

### 전체 회귀와 실패별 처분

개발·리뷰수정중시험미실행, 컴파일만수행. 마지막수정후 T9에서 worker2로 전체 `pnpm test`→`pnpm test:python`을 순차각1회 실행했다. 최초는 각각종료1:4412시험중4357pass/54fail/1skip, Python69중61pass/8fail. 전체회귀가처음부터통과했다고하지 않는다. 최초62실패·원문·분류는 T9/T10에보존했고 후속관련재검증으로 모두통과했다.

- T11 `pnpm test:changed -- b581a90abc6956364d394e5b19aac8e90cb32609`: TS154선정파일·3282pass/7hookfail/1skip, 종료1로내부Python단계미실행. 최초실패파일16개모두포함, hook외최초47건pass. 실패원인은 runner의불변UPDATE를허용INSERT로고친1건과 repo바깥TMPDIR·격리OrbStack/Docker설정·합성PG관리암호를정정한환경이다. 과거미확정doctor실패의정밀인과는후속pass만으로단정하지않는다.
- 불명확matrix만 JSON reporter로실행: core지문2/core세션수집82/postgresconversation-index23/session-concurrency1/query-perf순수29/소형DB3 =140시험전부pass, 종료0. 원형지문Unicode/NUL/고립surrogate/정렬·설정, stale/가리기재생성/claim owner·expiry·rollback/경쟁행수·독립지문·조각 및 러너시간·정리오류가실제실행됐다.
- 17.1정상merge뒤build/typecheck0, 통합최소10파일198pass 및 PythonGarminpreflight1pass. schema39/0001~0039migration/plugin/ref/version불변, 공유Store/root export/fake/doctor 및 generator import는컴파일·원문대조했다.
- T12 hook일반4/Python5pass,6잔존; T13 Composeplugin준비누락으로첫설치실패를추가보존. T14는소유Docker context/Unixendpoint·실제OrbStack소켓·Composeplugin을준비하고 제한/비제한PATH·두preload실제child에서4개prerequisite확인뒤 일반hook7pass/1Python전용skip와 Pythonhook8pass, 각각종료0. 일반skip은Python에서실제통과. 상태위조·차단해제·단언완화·소스패치없음.
- 지휘자가T11원문선정/통과와T14개별JSON이름을결합해최초62건전부pass인 `.brain-automation/tickets/22.2/final-failure-audit.json`을만들어대조했다. 회귀수정후더넓은전체suite/이미통과한실측을중복하지않았다. 보고 T9/T10/T11/T12/T13/T14및각logs에실패/명령/종료/UTC/부하/선정/자원증거보존.

### 자원·리뷰·matrix 최종 감사

T9전용PG·fixture179, T11전용PG·fixture122, T12전용PG·fixture4의생성/removed및현재부재증거를대조했다. T13전용PG는실패후정확ID삭제event, T14전용PG와Compose2정확ID create/start/stop/die/destroy·부재확인. T12과거ComposeID는reporter누락으로복구불가하여현재project/volume부재만증명한다. 그역사증거한계는숨기지않는다. T16의qp_DB2개각created/deleted=true,최종qp0/activeclient0,전용PG `ddeaada2a6ee4fb7220b868e9050e29e96bfeb2667d7d20e5fab934cbbf5011d` 소유label확인후정확ID삭제·inspect부재·destroy확인. 운영/타티켓자원변경없음. 워크트리·로컬branch·세션·기준archive·실행증거보존.

독립Sol/medium4렌즈×2회와표적확인1회 완료. R1 14행(medium11/false3), R2 19행(medium14/low기각2/false3), 표적F1 medium1 patch. 중복도행별처분보존. high0. 최초R1은후속권고true로R2수행; R2후속pass high0이라전체4렌즈추가권고false, 새측정경계는표적확인했고그F1을직접최소수정/컴파일/실제matrix·대형실측으로검증했다. T10러너실행결함도수정후소형DB·대형실측에서통과. deferred단일빈목록유지. 미충족AC를기각/defer로숨긴항목없음.

I/O matrix6행모두감사: 지문바이트/core2,정상확정·stale·claim경쟁/postgres23,동시반입/session-concurrency1+신규barrier시험,대형성능/T16두API·별도probe·독립oracle로실제pass. 원문테스트이름/상태는matrix.json에보존. schema/과거migration/릴리스불변이며본티켓의제품변경은snapshot직렬화·hash뿐이다.

## Auto Run Result

- 결과: **built**(사용자인수done아님). 큰세션의같은지문·조각·stale·가리기재생성·동시반입안전성을유지하면서두snapshot transaction및잠금체류가각각기준0.191501/0.270441/0.270255배다. 측정/검증/리뷰필수조건을완료했다. commit·branchpush·원격정확SHA/clean은로컬최종보고에기록한다.
- 변경: core의공유JSON토큰generator, postgres의native증분SHA, core독립oracle·postgres경쟁시험, query-perf snapshot러너·비교/provenance·CLI·소형DB/시간/오류시험·globalSetup·재현README,이계획. 기존migration/SQL/claim/잠금/재읽기·domainSHA·릴리스는수정하지않았다. 수락main17.1은정상merge로보존했다.
- 채택/기각: R1/R2/표적행별triage대로patch를반영. 기각false는별도진단/초기수집전체/경쟁규모를더넓게일반화하지않는측정경계및의도상해석, low2는전용disposable클러스터의희귀CREATE응답유실복구분기비용이다. 실제DB명보존·최종전용cluster제거로위험제한. high0, unresolved0, deferred0, 후속독립리뷰권고false.
- 잔여위험: 3표본은운영분포/p95증거가아님. SQL계획·전체ingest/handler·큰세션경쟁성능개선을주장하지않고JSON/hash진단은내부직접계측아님. 프로세스순간표본한계, RSS생애값, 희귀CREATE응답유실시created미확정과T12과거ComposeID유실한계보존. 환경실패의과거세부인과를단정하지않음. 필수미완료는없다.
- 운영인계/권고: 제품운영변경필요없음, 실제계정·실대화·운영DB사용없음. 측정재현시소유Dockercontext/Composeplugin·OrbStacksocket/TMPDIR·PG암호를실제child환경에서확인하는권고는이번검증에적용했다. 별도제품개선/필수운영조치는없다. 중앙은최종보고수락·main통합/push·후속모음판단을맡으며본지휘자는중앙main/state를수정하지않는다.
