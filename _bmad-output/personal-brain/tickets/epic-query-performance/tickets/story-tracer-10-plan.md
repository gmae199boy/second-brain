---
title: 'Tracer: 반입 정리 조회가 완료 이력 10만 건에서도 같은 결과를 기준의 절반 이하 시간에 낸다'
type: 'feature'
ticket: '1'
created: '2026-11-06'
status: 'built'
baseline_revision: '6ad59955f6fc93a275441c16ee7116ae3f961460'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/research-performance-2026-11-04/sql/report.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** daemon의 `listImportCleanups` anti-join은 완료 이력 10만·미정리 100건에서 약 1.14초가 걸린다(sql report 후보 4: 내부 `file_requests` 스캔이 후보마다 반복, 2,170,238 hit blocks). 데이터가 쌓일수록 반입 정리 round가 그대로 느려지며, 2~5 성능 티켓이 다시 쓸 측정 틀도 없다.

**Approach:** 저장소에 재사용 가능한 측정 러너(`tooling/query-perf/`)를 만들고, 전용 PG·결정적 합성 fixture에서 기준 커밋과 변경 코드의 실제 store 함수를 같은 조건으로 잰다. 쿼리 변경과 후보 인덱스(`(source, locator)`, `request_id WHERE cleaned_at IS NULL`)를 비교해 채택한 인덱스만 새 forward migration `0039`로 더한다.

## Boundaries & Constraints

**Always:** 결과(정리 대상 id 목록·순서·limit 500)와 공유 locator 차단 의미를 그대로 지킨다. 측정은 warm-up 1회 뒤 3회 wall 중앙값, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, 결과 sha256 비교로 하고 기준·변경을 같은 전용 PG·fixture·호스트 조건에서 잰다. 측정 전 호스트 부하(load average·병렬 시험)를 기록한다. 채택 인덱스의 크기와 같은 쓰기 배치 전후 시간을 이 plan에 남긴다. 전용 컨테이너(`brain-221-perf` 127.0.0.1:54221, `brain-221-test` 127.0.0.1:54222)만 쓰고 끝나면 제거 증거를 남긴다.

**Never:** 적용된 migration(0001~0038) 수정, 결과 캐시·assertion 축소·시험 전용 우회, `import-safety.test.ts`의 공유 locator 시험 수정, 다른 성능 후보(snapshot·검색·첨부·UUID·채널·`listUnhandedImports`) 수정, 운영 DB·공용 54329·다른 티켓 컨테이너 접근, 증거에 개인 홈 절대 경로 기록.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 미정리 후보 | 완료 이력 N, 미정리 100(locator 고유) | 그 100개 id를 request_id 순으로 반환, 기준과 hash 동일 | 없음 |
| 유휴 | 완료 이력 N, 모두 cleaned | 빈 목록, 변경 중앙값 ≤ 기준 중앙값 × 1.10 | 없음 |
| 공유 locator 차단 | 미정리 100이 한 locator 공유, 그중 하나 결과 미완료(file_id null) | 빈 목록; `cleanupImport`는 `cleaned:false`, remove 미호출 | remove 호출 시 러너 실패 |
| 500 초과 | 미정리 501 | 앞 500개만 | 없음 |

</intent-contract>

## Code Map

- `packages/postgres/src/imports.ts:14-18` -- `listImportCleanups` NOT EXISTS anti-join(첫째). `:27` `cleanupImport`의 pending 조회(둘째, 같은 source/locator 조건). 채택 결과가 인덱스만이면 SQL을 바꾸지 않는다.
- `packages/postgres/migrations/0022_import_contracts.sql:16-29` -- `file_requests`(PK id, unique(source,request_key)만 있음), `file_request_results`(PK request_id). `0027_analysis_artifacts.sql:48-82` -- `file_import_cleanup`, 결과 INSERT 시 정리 대상 큐 trigger, `file_requests` INSERT 시 같은 source/locator를 찾는 `guard_import_locator` trigger(쓰기 배치에 인덱스 영향).
- `packages/postgres/src/migrate.ts:7` -- `CORE_SCHEMA_VERSION = 38` → 39. 버전 38 기대 시험: `packages/postgres/test/{migrate,extensions,extension-quiesce,install-orbstack,install-legacy,schedule-occurrences,store,work-store}.test.ts`, `apps/cli/test/{install,schedule-migration-tick,setup}.test.ts`.
- `packages/postgres/test/fixture.ts` -- `database()`가 `prepareDatabase`+`runMigrations` 사용. 러너는 checkout의 `packages/postgres/dist/index.js`에서 같은 함수와 `postgresStore`를 불러 실제 store 표면을 잰다.
- `packages/postgres/test/import-safety.test.ts:17` -- 공유 locator 차단 시험. 수정 금지, 통과만 확인.
- `~/github/second-brain/.brain-automation/performance-deep/sql/bench.mjs:36-71` -- 조사 fixture(`session_replication_role=replica`, md5 uuid, cleaned/pending/shared 변형)와 후보 인덱스 비교 선례. 참고만 하고 복사 경로를 저장소에 남기지 않는다.
- `vitest.config.ts`, `tsconfig.test.json` -- `tooling/*/test`는 자동으로 vitest project·typecheck 대상.

## Tasks & Acceptance

**Execution:**
- [x] `tooling/query-perf/` (`run.mjs`; `src/*.mjs`; `README.md`; 측정 checkout의 `pg` 사용) -- 러너: `--checkout <dir>`의 built postgres dist로 전용 DB를 만들고(`--database-url` 관리자 URL, 조건마다 새 database) 결정적 fixture(N=1천/1만/10만 완료 이력, 고정 timestamp, md5 uuid; 조건 idle·pending100·shared100)를 넣은 뒤 `store.imports.listImportCleanups()`와 shared 조건의 `cleanupImport`(remove는 호출되면 실패)를 warm-up+3회 측정한다. pg `Client.prototype.query` 기록으로 실제 SQL을 잡아 별도 연결에서 EXPLAIN한다. 쓰기 배치(N=10만에서 `files` 준비 뒤 `file_requests` 1,000 + `file_request_results` 1,000 INSERT, trigger 활성, 매회 ROLLBACK) 시간과 인덱스 크기(`pg_relation_size`)를 잰다. `--candidate`(none/locator/open/both, fixture 뒤 DDL)와 `--query-variant`(original/rewritten, SQL 직접 실행)로 후보를 비교한다. JSON 결과에는 checkout의 git SHA·호스트 metadata·load average를 쓰고 경로는 쓰지 않는다. `compare` 하위 명령은 두 결과의 hash 동일·중앙값 비율·판정을 출력한다 -- 2~5가 재사용할 측정 틀.
- [x] `tooling/query-perf/test/*.test.ts` -- 중앙값·hash·비교 판정·인자 파싱 순수 함수 단위 시험 -- PG 없이 도는 러너 회귀.
- [x] `packages/postgres/migrations/0039_import_cleanup_indexes.sql`, `packages/postgres/src/migrate.ts`, 버전 38 기대 시험들 -- 측정으로 채택한 인덱스만 생성, 버전 39로 갱신. 기본 예상은 두 인덱스·SQL 무변경이며 측정이 다르면 Plan Change Log에 근거를 남긴다.
- [x] `packages/postgres/test/import-cleanup-indexes.test.ts` -- 채택 인덱스 존재와 matrix(미정리 반환·cleaned 제외·공유 locator 차단·500 limit·순서) 결과 시험.
- [x] 이 plan `## Design Notes` -- 측정 표(조건별 기준/변경 중앙값·hash·EXPLAIN 요약·호스트 부하), 채택/미채택 근거, 인덱스 크기, 쓰기 배치 전후.

**Acceptance Criteria:**
- Given 기준 커밋 `6ad5995`와 변경 checkout을 같은 전용 PG·fixture로 잴 때, when `compare`를 실행하면, then 모든 조건의 결과 hash가 같고 N=10만·미정리 100 중앙값이 기준의 50% 이하이며 유휴 조건 중앙값이 기준 × 1.10 이하다.
- Given 변경 코드, when 공유 locator 차단 시험과 새 인덱스 시험을 실행하면, then 수정 없이 통과한다.
- Given 채택 인덱스, when plan을 읽으면, then 각 인덱스 크기와 쓰기 배치 전후 중앙값, 미채택 후보 근거가 있다.

## Implementation Notes

- 2026-11-06 T1·T2(Terra): `tooling/query-perf/` 러너. 측정 대상 checkout의 `packages/postgres`에서 `pg`를 `createRequire`로 불러 그 store의 SQL을 캡처한다(러너 자체 의존성·lockfile 변경 없음). 기준 export는 git 저장소가 아니므로 `.query-perf-revision`으로 SHA를 기록한다. T1의 `test:changed` 중단으로 시험 fixture 컨테이너 3개가 남았고 첫 삭제 시도는 권한 분류기에 거부돼 보존했다. Codex 복구 중 원래 생성 로그·정확 ID/fixture label·활성 클라이언트 0을 새로 대조한 뒤 승인된 소유 합성 자원 정리를 다시 요청해 종료 0으로 삭제했다. `t1-owned-fixture-cleanup.log`와 `t1-owned-fixture-after.txt`(0행)를 `.brain-automation/logs/`에 보존한다. 다른 티켓의 자원은 정리하지 않았다.
- 2026-11-06 후보 비교(지휘자, 기준 `6ad5995` export, N=10만, 전용 `brain-221-perf`, fixture 뒤 `analyze`, 로그 `.brain-automation/logs/20261106T034018Z-cand/`, 측정 중 load 3.1~16.4/12 CPU — 다른 티켓 시험과 겹친 탐색 측정). wall 중앙값 ms:

  | 후보 | idle | pending100 | shared100 | shared cleanupImport | 쓰기 배치 |
  |---|---:|---:|---:|---:|---:|
  | 없음·원문 SQL | 2.322 | 16.352 | 27.358 | 8.111 | 4311.2 |
  | 없음·재작성 SQL | 2.430 | 16.448 | 16.312 | 6.156 | 6753.3 |
  | locator만 | 4.282 | 6.008 | 9.288 | 2.949 | 46.2 |
  | open만 | 1.280 | 23.680 | 24.582 | 9.682 | 6729.7 |
  | 둘 다·원문 SQL | 0.535 | 0.952 | 4.743 | 0.890 | 47.2 |
  | 둘 다·재작성 SQL | 0.552 | 0.846 | 4.380 | 1.146 | 41.5 |

  모든 후보에서 조건별 결과 hash가 같다(idle·shared `4f53cda1…` 0행, pending `de3c07b1…` 100행). 결정: **두 인덱스 채택, SQL 무변경**. locator만은 idle이 나빠지고 open만은 pending이 나빠진다. 재작성 SQL은 두 인덱스 위에서 차이가 잡음 수준이라 의미 변경 위험을 감수할 근거가 없다. 인덱스 크기(N=10만): `(source, locator)` 4,997,120 B, 부분 인덱스 16,384 B(미정리 100행). 쓰기 배치가 4.3초에서 47ms로 줄어든 것은 `guard_import_locator` trigger의 같은 source/locator 조회가 행마다 전체를 훑던 비용이 사라졌기 때문이다.
  조사 보고서의 1,139ms(nested loop, 2,170,238 hit)와 달리 기준이 16ms(hash anti join, 4,814 hit)인 것은 러너가 fixture 뒤 `analyze`로 통계를 갱신하기 때문으로 본다. 최종 판정은 같은 러너·조건의 기준 대 변경 비교로 한다.

## Plan Change Log

- T2에서 러너 자체 package.json/pg 의존성을 제거했다. 측정 대상 checkout의 pg Client와 실제 store가 같은 모듈 인스턴스를 사용해야 SQL 캡처가 정확하므로 createRequire로 그 checkout의 pg를 읽는다. lockfile은 기준 내용으로 복원했다. Execution 목록도 실제 파일 구성에 맞췄으며 수락조건은 바꾸지 않았다.

## Review Triage Log

### 2026-11-06 — Review pass (r1, diff `diff-r1.patch` 66KB, Sol 리뷰어 4명: blind-hunter `ctx_ef0d5dfc4c3b`, edge-case-hunter `ctx_ac0468785d5b`, verification-gap `ctx_804429cf3b17`, intent-alignment `ctx_99437d6f479d`; 원문 `.brain-automation/reports/review-r1-*.md`)
- verdicts: 26 findings — high 0, medium 14, low 11, false 1, maybe-false 0 (intent-alignment 차이 관찰 8건 포함, 그중 3건은 기술 관찰이라 reject)
- findings:
  - blind-hunter
    - `[medium]` `[patch]` 0039 적용 checkout에서 `--candidate`가 같은 정의 인덱스를 중복 생성, `none`이 인덱스 없음이 아님 — 기존 동등 인덱스가 있으면 거부, 인덱스 정의 기록, README 명시(T4).
    - `[medium]` `[patch]` compare 필수 조건이 10만/pending100뿐 — 9행 완전성 요구(T4).
    - `[medium]` `[patch]` 입력 필드 검증·중복 키 없음 — hash/rowCount/median/samples 검증·중복 거부(T4).
    - `[medium]` `[patch]` EXPLAIN 요약만 보존 — 두 SQL 전체 plan JSON 저장(T4).
    - `[medium]` `[patch]` 기대 결과를 독립 계산하지 않음 — 생성 규칙의 id 목록과 순서까지 대조(T4).
    - `[medium]` `[patch]` shared100 cleanupImport가 실패 요청 자신을 대상으로 함 — file_id 있는 형제 요청으로 호출(T4).
    - `[low]` `[patch]` dist/migration 신원 미기록(stale build) — dist·migrations 내용 지문 기록(T4, 아래와 같은 원인).
    - `[low]` `[patch]` untracked 파일이 diffSha256에 빠짐 — 같은 지문으로 해결(T4).
    - `[low]` `[patch]` 정리 finally 직렬 — 단계별 독립 정리·오류 보존(T4). 직접 수정이라 low여도 반영.
  - verification-gap
    - `[medium]` `[patch]` idle·shared 누락 입력을 pass로 기대하는 시험 — 완전 fixture·누락 시 false 시험(T4, compare 완전성과 같은 원인).
  - edge-case-hunter
    - `[low]` `[reject]` locator가 B-tree 항목 한도(~2.7KB)를 넘으면 INSERT/migration 실패 — 런타임(`apps/cli/src/runtime/import-staging.ts:10`)은 locator를 실제 파일 경로로 열고 macOS 경로 한도는 1024바이트라 그런 요청은 원래 읽을 수 없다. 일상 사용에서 만나기 어렵고 해결은 인덱스 설계 변경이라 기각.
    - `[medium]` `[patch]` compare 조건 누락 pass — 위 완전성 patch와 같은 원인.
    - `[medium]` `[patch]` hash·rowCount 누락 동등 — 위 입력 검증과 같은 원인.
    - `[low]` `[patch]` 중복 size/condition 덮어쓰기 — 위 입력 검증과 같은 원인.
    - `[medium]` `[patch]` 후보 인덱스 중복 생성 — 위 후보 거부와 같은 원인.
    - `[low]` `[patch]` `select version()`이 try 밖 — 정리 patch와 같은 원인.
    - `[low]` `[patch]` store.close/client.end 실패 시 DB drop 생략 — 정리 patch와 같은 원인.
    - `[false]` `[reject]` 계획의 `package.json`·pg 의존성 미제공 — T2에서 측정 대상 checkout의 pg를 써야 SQL 캡처가 맞으므로 의도적으로 제거했고 Implementation Notes에 근거가 있다. 해결이 plan 수정뿐이라 규칙상 기각.
  - intent-alignment
    - `[low]` `[reject]` 유휴 ≤1.10 허용은 원문 "나빠지지 않고"보다 느슨 — 계획 작성 시점(측정 전)에 3회 중앙값 잡음 근거로 정했고, 측정은 그대로 이 기준으로 판정한다. 기준을 낮추지 않는다.
    - `[medium]` `[patch]` 쿼리 재작성 후보가 둘째 anti-join(pending 조회)에 없음 — rewritten 모드에 pending 재작성 측정 추가(T4).
    - `[medium]` `[patch]` compare가 행렬 전체 수행을 보증하지 않음 — 완전성 patch와 같은 원인.
    - `[medium]` `[patch]` `candidate:none` 의미가 checkout 상태에 의존 — 후보 거부 patch와 같은 원인.
    - `[medium]` `[patch]` EXPLAIN 구조 미보존 — 전체 plan 저장 patch와 같은 원인.
    - `[low]` `[reject]` 공유 locator는 국소 검증 — 기술 관찰. 기존 `import-safety.test.ts`는 변경하지 않았고 개발 종료 뒤 전체 회귀에서 실행한다.
    - `[low]` `[reject]` plan·측정 JSON이 diff에 없음 — 기술 관찰. 리뷰 규칙상 plan은 diff에서 뺐고 측정 증거는 plan과 `.brain-automation/logs/`에 있다.
    - `[low]` `[reject]` 러너의 `analyze` 때문에 조사 보고서 수치와 다름 — 기술 관찰. 수락 기준은 같은 러너·조건의 기준 대 변경 상대 비교이며 차이 원인은 Implementation Notes에 기록했다.
- 수정: T4(`ctx_8c798e8a81f1`)로 patch 10묶음 반영. 검토 중 T4의 후보 충돌 검사가 `--candidate none`까지 거부해 변경 checkout 측정이 불가능한 결함을 지휘자가 찾아 T5(`ctx_7c4f0f29a706`)로 고쳤다. build·typecheck·diff-check 0, 1천 스모크(양 checkout, 후보 both·rewritten, 중복 후보 거부) 확인, 로그 `.brain-automation/logs/20261106T041847Z-verify2/`.

### 2026-11-06 — Review pass (r2 후속, diff `diff-r2.patch` 74KB, Sol 리뷰어 4명: blind-hunter `ctx_8347163b6270`, edge-case-hunter `ctx_98ff8af01a4f`, verification-gap `ctx_9f706b1e6ac8`, intent-alignment `ctx_e2317091153d`; 원문 `.brain-automation/reports/review-r2-*.md`)
- verdicts: 23 findings — high 0, medium 7, low 15, false 1, maybe-false 0 (carried 4 포함)
- findings:
  - blind-hunter
    - `[low]` `[patch]` README 첫 예제가 0039 checkout에 `--candidate both` — 기준/변경/compare/후보 탐색 예제로 분리(T6).
    - `[low]` `[patch]` compare가 저장된 medianMs를 신뢰 — 표본에서 재계산·불일치 거부(T6).
    - `[medium]` `[patch]` compare가 shared100의 cleanup 차단 기록을 요구하지 않음 — cleanup 필수·`cleaned:false` 기록(T6).
    - `[false]` `[reject]` 쓰기 배치가 `file_import_cleanup`에 전혀 쓰지 않아 부분 인덱스 비용이 빠진다 — 결과 INSERT의 `queue_import_cleanup` trigger(`0027_analysis_artifacts.sql:57`)가 같은 배치 안에서 정리 행을 넣으므로 부분 인덱스 삽입 비용이 포함된다. `cleaned_at` 전환 비용은 원문이 정한 "file_requests·결과 INSERT" 배치 밖이다.
    - `[medium]` `[patch]` original(store 경로)과 rewritten(직접 Client)의 호출 범위가 다르다 — rewritten 모드에서 original SQL도 같은 직접 Client로 측정(T6). 재작성 미채택 결론은 rewritten에 유리한 비교에서도 이득이 잡음 수준이라 유지된다.
    - `[low]` `[patch]` 산출물 지문에 core dist·의존성·러너가 없다 — core dist·lockfile·러너 지문 추가(T6).
    - `[low]` `[reject]` SIGINT/SIGTERM 시 임시 DB 정리 없음 — 전용 서버의 `qp_` 접두 DB만 남고, 대응은 신호 처리 분기를 더하는 일이라 일상 사용에서 만날 일이 드문 low로 기각. 지휘자 측정은 끝날 때마다 잔존 `qp_` DB 0건을 확인한다.
    - `[medium]` `[patch]` compare가 시나리오·후보·쿼리 모드·출처를 검사하지 않음 — 일치 요구·출처 병기(T6).
    - `[medium]` `[patch]` 공유 차단 시험이 "결과 행 있음+file_id null"뿐 — 결과 행 없음·다른 source·해제 경로 시험 추가(T6).
  - verification-gap
    - `[medium]` `[patch]` pending 0.51·idle 1.11 초과 사례 미검증 — 표 기반 시험(T6).
    - `[medium]` `[patch]` Git 미추적 파일 지문 미검증 — 임시 git 저장소 시험(T6).
    - `[medium]` `[patch]` `artifactFingerprint` 미검증 — 임시 트리 시험(T6).
  - edge-case-hunter
    - `[low]` `[reject]` carried — 긴 locator B-tree 한도(r1과 같은 위치·주장).
    - `[low]` `[patch]` Client 연결 제한 없음 — `connectionTimeoutMillis` 설정(T6).
    - `[low]` `[reject]` carried — package.json 미제공(r1 false와 같음; 해결이 plan 수정뿐).
  - intent-alignment
    - `[low]` `[patch]` rewritten 호출 범위 차이 — 위 직접 Client 측정 patch와 같은 원인.
    - `[low]` `[reject]` carried — 유휴 ≤1.10 허용.
    - `[low]` `[patch]` "anti-join 두 개"를 조사 보고서처럼 `listUnhandedImports`+`listImportCleanups`로 읽을 여지 — 원문은 "미정리 anti-join"이라 정리 쪽 두 질의 해석을 유지하되, 두 읽기를 모두 덮도록 `listUnhandedImports`를 참고 측정(hash 동일 요구, 임계값 없음)으로 추가(T6). SQL은 바꾸지 않는다.
    - `[low]` `[reject]` cleanup 시간은 참고값 — 원문의 절반 조건은 10만·미정리 100 목록 조회에 걸린다. 결과 동등성과 차단은 필수로 검사한다.
    - `[low]` `[patch]` compare가 기준 쌍 관계를 인증하지 않음 — 출처 검증 patch와 같은 원인.
    - `[low]` `[reject]` 쓰기 타이머가 COMMIT 제외·크기는 배치 전 — 같은 배치를 매회 ROLLBACK해 기준·변경을 같은 상태에서 비교하는 설계이며, 원문은 같은 배치의 전후 시간을 요구한다.
    - `[low]` `[reject]` 2~5 재사용은 안내 수준 — 기술 관찰. 원문은 이 티켓이 틀을 만들고 2~5가 다시 쓴다고 정한다.
    - `[low]` `[reject]` carried — plan·측정 증거가 diff에 없음.

## Design Notes

### 확정 슬롯 측정 — 2026-11-06

중앙 `msg_883f150f342a`가 확보한 04:33~04:36 UTC 슬롯에서 기준 04:33:29.339~04:34:21.744, 변경 04:34:39.369~04:34:49.642로 모두 종료했다. 중앙 `msg_baac185bc99c`가 종료·슬롯 반환을 수신했다. 17.4·21.10의 heavy 작업 보류를 확인한 뒤 측정했다. 12 CPU, Node v24.17.0, PostgreSQL 18.6/aarch64. 1분 load는 기준 4.23→3.03, 변경 2.50→2.74였다. 로그 `.brain-automation/logs/20261106-slot-0433/`에 원시 JSON, 양쪽 EXPLAIN 전문·환경/산출물 지문·세 표본, compare JSON/종료 코드, UTC 경계와 프로세스 기록을 보존한다. 이전 탐색 측정은 아래 실패·제외 이력으로 보존하며 이 표와 섞지 않는다.

| 이력 수 | 조건 | 기준 중앙값 ms | 변경 중앙값 ms | 변경/기준 | 결과 hash(양쪽 동일, 앞 12자리) | EXPLAIN 실행 ms(기준→변경) | hit blocks(기준→변경) |
|---|---|---:|---:|---:|---|---:|---:|
| 1,000 | idle | 0.359083 | 0.335333 | 0.933859 | `4f53cda18c2b` | 0.034→0.008 | 7→1 |
| 1,000 | pending100 | 0.534292 | 0.674542 | 1.262497 | `9b9fce34c544` | 0.274→0.235 | 76→71 |
| 1,000 | shared100 | 0.487875 | 0.504750 | 1.034589 | `4f53cda18c2b` | 0.241→0.255 | 81→76 |
| 10,000 | idle | 0.522500 | 0.355916 | 0.681179 | `4f53cda18c2b` | 0.200→0.008 | 64→1 |
| 10,000 | pending100 | 2.238292 | 1.208667 | 0.539995 | `8d59a8c0f0aa` | 2.234→0.879 | 739→898 |
| 10,000 | shared100 | 2.119250 | 3.581459 | 1.689965 | `4f53cda18c2b` | 2.248→3.538 | 743→18400 |
| 100,000 | idle | 2.464542 | 0.371500 | 0.150738 | `4f53cda18c2b` | 2.141→0.012 | 637→1 |
| 100,000 | pending100 | 17.177916 | 0.778916 | 0.045344 | `de3c07b12711` | 19.677→0.765 | 4814→1203 |
| 100,000 | shared100 | 16.028333 | 4.835958 | 0.301713 | `4f53cda18c2b` | 18.903→4.460 | 4816→31003 |

`compare` 종료 0 / `pass: true`: 정리 대상 id·순서·행 수와 미인계 조회 hash가 9조건 모두 동일하다. 10만 pending100은 0.045344배로 ≤0.5를 충족하고, 유휴는 0.933859/0.681179/0.150738배로 모두 ≤1.10을 충족한다. shared100의 세 조건 모두 `cleaned:false`, `removeCalled:false`를 확인했다. 1천 pending/shared 및 1만 shared의 wall 시간 증가도 위 표에 그대로 기록한다. 이 조건에는 별도 시간 임계값을 두지 않았다. 미인계 조회는 변경하지 않았으며 참고 시간 비율은 compare JSON에 보존한다.

| 10만 이력 조건 | 같은 INSERT 배치 기준 ms | 변경 ms | 변경/기준 |
|---|---:|---:|---:|
| idle | 4195.029 | 40.925 | 0.009756 |
| pending100 | 4114.321 | 42.587 | 0.010351 |
| shared100 | 4569.728 | 40.281 | 0.008815 |

채택 인덱스 크기(확정 측정의 10만 pending100, 쓰기 배치 전):
- `brain.file_import_cleanup_open_idx`: 16,384 bytes.
- `brain.file_requests_source_locator_idx`: 8,757,248 bytes.

후보 탐색 때는 fixture 뒤 인덱스를 생성했으나 확정 변경 측정은 migration으로 먼저 생성한 인덱스에 fixture를 삽입한다. 따라서 locator 인덱스 크기를 탐색 때의 4,997,120 bytes와 혼동하지 않는다. 실제 제품 SQL은 그대로이고 새 forward migration `0039_import_cleanup_indexes.sql`만 두 인덱스를 추가한다. PG 계획은 미정리 부분 인덱스로 후보를 먼저 좁히고 source/locator 인덱스로 공유 위치를 찾는다. 결과 원문은 JSON으로 검증했으며 해시 표의 생략 부분도 원시 JSON에 있다.


유휴 허용 10%는 3회 중앙값의 실행 간 잡음 때문이다. 쿼리 재작성 후보(`not exists (... where not exists (r.file_id is not null))`)는 results PK 덕에 의미상 동등하지만, 인덱스만으로 기준을 충족하면 의미 변경 위험 때문에 채택하지 않는다. 측정 결과는 구현 후 이 절에 표로 채운다.

## Verification

- T6 `pnpm build`, `pnpm typecheck`, `git diff --check`: 각각 종료 0. `.brain-automation/logs/20261106-t6-f1/{build-final,typecheck-final,diff-check-final}.log`.
- T2 `pnpm test:changed`: 당시 1파일·6시험 통과. 이후 개발 중 시험 금지 정책(`msg_78f6a6d3eb68`)에 따라 T3~T6은 시험 작성·컴파일만 수행했고, 아래 최종 회귀에서 실제 실행했다.
- 확정 성능: `.brain-automation/logs/20261106-slot-0433/`의 기준/변경/compare 모두 종료 0. 9조건 hash/순서·공유 차단·미인계 hash 모두 동일. 위 Design Notes의 표와 실제 중앙 확보 슬롯 경계를 따른다.
- 복구 최초 측정 `.brain-automation/logs/20261106-recovered-final/`: 양쪽 실행 0, compare 1. 1천 idle 0.340750→0.535875ms(1.572634배)로 실패. 10만 pending은 18.526708→0.818542ms이고 hash·안전성은 모두 일치했다. 이 실패를 통과로 바꾸지 않았다. 역순 반복 `20261106-recovered-reverse/`는 compare 0이나 변경 load2.6 대 기준 도중 load23.8/다른 heavy 시험 때문에 확정 비교에서 제외했다. 원문·원시 표본을 보존했다.
- 최종 전체 회귀는 전용 54222에서 `pnpm test`→`pnpm test:python` 순차 각 1회 실행했다. `.brain-automation/logs/20261106-final-regression/`의 명령·UTC·로그·종료 코드·fixture 이벤트를 보존했다.
  - `pnpm test`: 종료 1, 189파일 중188통과·1실패,4301통과·2실패·기존skip1,338.16초. 실패는 기존 `apps/cli/test/ext-install-resume.test.ts:315,350`: spawn후 고정300ms 뒤 SIGINT 자식 종료코드 null !=1. 호스트1분load62.12/12CPU 관측. 새 인덱스 시험·기존 공유 locator 시험을 포함한 다른188파일은 통과했다.
  - `pnpm test:python`: 종료0,15파일·66시험 통과,755.41초. 기본 suite의 skip1은 기존 bootstrap Python보존 조건부 시험이며 이 단계에서 BRAIN_PYTHON_UPDATE_TEST=1로 실제 실행·통과했다.
- 실패 재검증: 중앙 `msg_49a1af1393a6` 지시로 `VITEST_MAX_WORKERS=2 BRAIN_TEST_DATABASE_URL=<전용54222> pnpm test:changed -- origin/main`을 실행했다. 04:54:21~05:09:41 UTC, 시작load7.84/종료10.70, ref `49c23630dc9f520d805a15d830d41cc81f7dfdb6`, 종료0. `.brain-automation/logs/20261106-limited-reverify/`에 실제 선정·명령·부하·경계·전체 로그·종료코드·fixture 요약을 보존했다. 중복 suite는 별도로 띄우지 않았다.
  - 기본 --changed:97파일·1990시험 통과,기존조건부skip1,383.10초.
  - migration 규칙 PG전체:40파일·649시험 통과,131.31초.
  - 경로규칙 Python전체:15파일·66시험 통과,399.81초. 위 조건부 시험도 다시 실제 통과했다.
- 최초 두 취소 실패의 처분: 동일 `vitest list --changed origin/main --filesOnly --json`의 `selected-files.json`으로 ext-install-resume.test.ts가 97파일에 포함됨을 확인했다. 제품/시험 코드·단언·300ms를 바꾸지 않고 제한 worker에서 모두 통과했다. `bin.ts`의 import/dynamic discovery 뒤 `ext-install.ts:7-12`에서 신호 처리기를 등록하지만 시험은 준비 이벤트 없이300ms에 SIGINT를 보낸다. 최초 null종료는 준비 전 신호와 일치하나 정밀 계측하지 않아 정확한 원인을 확정하지 않는다. 실행 병렬 수를 낮춘 환경에서 비재현/검증 통과로 처분하고 최초 실패와 부하 민감성은 잔여 위험으로 유지한다. 남은 재현 기능 결함이나 미실행 필수 시험은 없다.
- T6 추가 경로 스모크: 기준 export `--sizes 1000 --candidate both --query-variant rewritten`, 종료0. 세 조건 동일 Client 원문/재작성 목록 hash 동일, shared pending 존재 여부 동일, cleaned:false/removeCalled:false. `.brain-automation/logs/20261106-t6-rewritten-smoke/`. 이 시간은 기능 확인이며 확정 성능 표에 넣지 않았다.
- 자원: 전체 회귀 fixture172개·재검증193개가 각각 모두 removed 이벤트로 끝났고 미삭제0. 일시 remove-failed 각5건도 후속 removed를 대조했다. T1 중단 fixture3개도 원래 생성 로그/label/활성client0의 새 근거 뒤 정확ID 삭제·부재 확인했다. 전용 perf/test tmpfs 두 컨테이너는 모든 검증 뒤 ticket22.1 label·활성client0을 확인하고 삭제·부재 확인했다. qp_ DB0, 과거 중단의 시험 DB5개는 전용 test클러스터와 함께 제거했다. `.brain-automation/logs/{t1-owned-fixture-*,final-owned-pg-*}` 및 각 suite의 pg-resources.jsonl/resource-summary.json.
- 시험 전에 깨끗했던 tracked `extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc` 생성 산출물만 원복했다. 제품·시험 소스는 T6 이후 변경하지 않았다. 최종 YAML 파싱·diff 검사·경로 정책 검사를 수행했다.

## Auto Run Result

- 결과: **built**. 새 forward migration0039의 두 인덱스와 재사용 가능한 성능 러너를 구현했다. 실제 제품 조회 SQL은 유지했고, 확정 슬롯에서10만 pending100은17.177916→0.778916ms(0.045344배), idle은 세 크기 모두 개선됐다. 모든 수락조건의 결과·공유 차단·크기/쓰기 비용·시험 증거는 위에 있다.
- 변경 파일: migration0039(인덱스2개), migrate.ts(schema39), 버전 기대 시험11파일, 새 import-cleanup-indexes.test.ts(인덱스/정렬/500제한/공유 차단과 해제), tooling/query-perf의 CLI·core/revision/시나리오·순수 시험·README, 이 plan. 과거 migration·imports.ts·기존 import-safety.test.ts·lockfile·플러그인 ref/version은 변경하지 않았다.
- 리뷰: 독립 Sol/medium4명×2pass. r1 26건(high0/medium14/low11/false1), r2후속23건(high0/medium7/low15/false1). 각 finding의 patch/기각과 근거는 Review Triage Log에 모두 보존했다. T4/T5/T6으로 채택 patch를 반영했고, r2는 후속pass high0으로 수렴했다. 후속 독립 리뷰 권고false; deferred는 빈 단일 목록이다. r1의 패치10묶음, r2의 patch행14건(중간7·낮음7, 중복 근거 포함)을 반영했다.
- 기각 근거: 긴 locator B-tree 키/강제 종료 신호 처리의 드문 개발 경로, 이미 정한 idle10% 허용의 반복 관찰, 측정 checkout의 pg를 쓰려고 package.json을 제거한 설계, 중복·기술 관찰은 원문 행별 사유에 따랐다. 쓰기 배치의 부분 인덱스 비용 누락은 trigger가 같은 배치에 정리 행을 INSERT하므로 false다. 어떤 필수 수락조건도 defer로 숨기지 않았다.
- 잔여 위험: 300ms 고정 대기의 기존 취소 시험은 높은 부하에서 신호 처리기 준비 경합에 민감할 수 있다. 이번 제한 worker 검증은 통과했으나 최초 실패의 정확한 시간 원인은 계측하지 않았다. sub-ms wall3표본의 실행 간 잡음도 최초 실패와 함께 보존했다. 긴 locator 인덱스 키와 강제 SIGKILL 시 러너 DB 정리 누락의 리뷰 기각 위험은 그대로다.
- 운영 조치/권고: 현재 티켓의 필수 작업과 소유 합성 자원 정리는 완료했다. 향후 별도 시험 안정화에서 두 취소 시험이 readiness 근거를 기다리도록 개선할지 판단하는 권고를 남긴다(이번 티켓에서는 미실행, 제품/단언 변경 없음). 중앙은 브랜치 결과 수락·main 통합/push·후속 항목 모음 반영을 수행한다. 워크트리·로컬 브랜치·원문 실행 증거는 보존한다.
