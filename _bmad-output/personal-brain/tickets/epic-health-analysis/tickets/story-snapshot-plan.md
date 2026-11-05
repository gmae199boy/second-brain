---
title: '18.10 건강 현재값 조회: 판정과 입력 snapshot을 유지하며 조회·회귀 시험 시간을 줄인다'
type: 'refactor'
ticket: '10'
created: '2026-11-04'
status: dropped
baseline_revision: '0bdd03f4cc9ec170501f7cf286a49aa7573c2769'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-health-analysis/epic-health-analysis-health-query-performance-evidence.md'
  - '{project-root}/_bmad-output/personal-brain/research-performance-2026-11-04/health-query-design-report.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `brain.health_resolution_v1`(0026)은 논리 키마다 `health_observations` 전체를 계산식 identity로 다시 훑는 상관 서브쿼리 10여 개로 판정한다. `health_current_v1`은 `h join r on r.current_id=h.id`라 바깥 조건(metric·local_date 등)이 판정 쪽으로 내려가지 않아 한 키를 물어도 모든 키를 판정한다. 그래서 좁은 현재값 조회가 초 단위이고 정규화 시험(`garmin-normalize`)이 수 분 걸리며, 2초 제한의 반입 검증 snapshot도 규모가 커지면 위험하다.

**Approach:** 기준 커밋에서 재현 가능한 합성 fixture·성능 러너로 다섯 workload를 고정 측정하고, (A) SQL 재작성(단일 패스 집계·조건 전달 가능한 view, 필요 시 인덱스)과 (B) 같은 읽기 snapshot에서 후보·규칙 일괄 조회 후 공통 TS 판정을 시제품으로 비교해 동등성·실행계획·시간·쿼리 수로 하나를 채택·구현한다. 인덱스 변경 여부는 규모·선택도별 EXPLAIN (ANALYZE, BUFFERS)와 쓰기 비용으로 정한다.

## Boundaries & Constraints

**Always:**
- 공개 DB 계약 유지: `health_resolution_v1`·`health_current_v1`의 이름·열 이름·순서·타입·권한(brain_app select), 행 내용, `selected_ids/all_ids/unselected_ids` 배열 원소와 순서, reason 우선순위, authority_id/version, `health_aggregate_v1` 결과. 기존 행·저장 원문·기존 분석 행은 UPDATE/DELETE/backfill하지 않는다.
- 판정 키는 `source`·원형 account/activity/sub identity(인코딩+바이트)·metric·local_date·observed_at·time_zone이다. 논리 키 범위는 일찍 좁히되, 그 키 안의 경쟁 dataset·revision·normalization_version 후보와 미확인 계정 행은 하나도 버리지 않는다. 표시 문자열 동일성으로 원형 identity를 합치지 않는다.
- 18.2 snapshot(`packages/postgres/src/analysis-inputs.ts` reader)의 내용·순서·cutoff·ambiguity 제외 목록·권위 provenance와 한 REPEATABLE READ 트랜잭션 읽기를 유지한다. (B)를 쓰면 후보와 규칙을 같은 읽기 snapshot에서 얻고 항목별 추가 조회를 반복하지 않는다.
- Python 검증기(`extensions/garmin/src/verify_compare.py`)의 독립 기대 판정은 그대로 둔다. 시험 기대값은 기존 계약 fixture와 0026 원래 정의(참조 오라클)로 대조한다.
- 새 마이그레이션은 다음 번호(`0031_health_resolution_performance.sql`)로 추가하고 기존 마이그레이션 파일은 고치지 않는다. schema 버전 고정 시험은 18.2 선례처럼 함께 올린다.
- 측정은 소유가 명확한 전용 PG 컨테이너(이 티켓 이름 접두 `brain-1810-`, tmpfs)와 합성 자료만 쓴다. Python 통합 fixture는 `withoutHarnessFolders`로 실제 하네스 transcript 수집을 막는다. 개인 홈 절대 경로를 문서·커밋에 쓰지 않는다.

**Never:**
- 조건 필터로 경쟁 후보를 미리 제외, 날짜 필터 강제, 결과 캐시·materialized 결과 저장, 시험 assertion 축소·생략, 시험 전용 우회, 전역 timeout 증가, JIT 끄기만으로 달성.
- Python 전체 이식, 수집 빈도·수집/정규화/분석 정책 변경, 관련 없는 인덱스 전수 정비, 공용 시험 PG(54329)·다른 작업 컨테이너·전역 role 변경.
- 판정 의미 변경을 "성능 개선"으로 넣는 것. 동등성 미충족 또는 성능 기준 미달은 built가 아니다.

## I/O & Edge-Case Matrix

모든 행: 새 구현의 resolution 전 열과 current 전 열이 0026 참조 정의와 같다(전체 조회, 그리고 좁힌 조회 = 전체 판정 후 같은 키 필터).

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 명시 권위 순서 | D1 최신 100, D2 이전 90, 규칙 `[D2,D1]`; 구체성·revision 다른 규칙 여럿, wildcard metric/activity, 날짜 범위 | D2의 90, authority_id/version은 가장 구체적·최신 revision 규칙 | 규칙 배열에 후보 없음 → `dataset_unselected` |
| 복수 dataset ambiguity | 규칙 없이 dataset 2개 | `dataset_ambiguous`, current 없음, selected 빈 배열 | 18.2 excluded 목록에 남음 |
| 계정·시간대 미확인 | 같은 키에 unconfirmed 행 하나; local_date 있고 zone NULL | `account_unconfirmed` / `timezone_unconfirmed` | 다른 dataset 행이 confirmed여도 키 전체 미확인 |
| 동률 revision·버전 | 최신 시각 revision 2개; 지원 1·2·8 밖 v10만 최신 | `revision_ambiguous`(selected=최신 observed 전체) / `version_unsupported`(오래된 v8로 회귀 안 함) | 버전 선택 전 revision 수 판정 |
| 논리 값 | text UTF-8/LE/BE 같음, JSON 공백·키 순서만 다름 vs 다른 값; NULL 두 행 | 같음 → 하나(UUID 첫 대표), 다름 → `value_ambiguous`; NULL은 오류 없는 NULL 현재값 | invalid 원문은 정상 문자열과 구별 |
| 원형 identity·NUL | account/activity/sub가 `a\0b` vs 표시 `a�b`, 인코딩만 다른 같은 문자 | 별개 키 | 표시 동일로 병합 금지 |
| 날짜/instant·cutoff | local_date NULL instant 키, 날짜 범위 규칙 경계(date_from/to 당일), 18.2 `local_date<=reportDate` 경계 | 0026과 같은 매치·제외 | — |
| 재정규화·재개 | 같은 키에 v1·v8·v9(9 등록) 공존, 같은 보관 키 재입력 | 최고 지원 버전 현재, 이전 행 보존 | 재입력 trigger 동작 불변 |
| 무관 데이터 증가 | 다른 계정·날짜·지표 관측을 10배로 늘림 | 좁은 조회의 판정 대상 행수·버퍼가 늘지 않음 | 늘면 미달로 기록 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0026_health_json_comparison.sql:112-150` -- 현재 resolution 정의(keys→decisions 상관 서브쿼리 3개→selected_dataset→latest→revisions→candidates→reasons). identity 식은 `coalesce(x_encoding,'utf-8')||':'||encode(coalesce(x_raw,convert_to(x,'UTF8')),'hex')`. 참조 오라클로 이 텍스트를 시험이 읽어 별도 이름의 view로 만든다. 파일은 수정 금지.
- `packages/postgres/migrations/0025_original_text.sql:41-59,93` -- 원형 열·`health_storage_identity` unique, current = `select h.* … join resolution r on r.current_id=h.id`. `0023_health_contract.sql:18-27,80-92` -- supported_versions(1·2·8), authority_rules, `health_aggregate_v1`(current를 읽음). `0022_import_contracts.sql:3-15,58-71` -- observations 표·불변 trigger·권한.
- `packages/postgres/src/imports.ts:18-49,51-63` -- readVerification(REPEATABLE READ, `statement_timeout 2s`, `where r.source=${input.source}`)와 readHealth(필터 없는 current). 반입 검증 생산 경로: `apps/cli/src/runtime/import-verification.ts` → `extensions/garmin/src/import_verify.py` → `verify_compare.py:145-181`(독립 resolve; 수정 금지).
- `packages/postgres/src/analysis-inputs.ts:48,51` -- 18.2 reader. current와 resolution을 다시 join(판정 이중 계산), `h.account`(표시)·`h.time_zone`·metric 접두·`local_date<=reportDate` 필터, 정렬 `metric,local_date,activity_id,sub_identity,id`; excluded는 resolution `reason is not null`. 결과 동일성 유지가 조건.
- `packages/postgres/src/migrate.ts` -- schema 버전(현재 30). 버전 고정 시험: 18.2 Auto Run Result의 목록(`packages/postgres/test/{migrate,store,unavailable,work-store}.test.ts`, `apps/cli/test/{install,setup}.test.ts`, `apps/cli/python-test/{garmin-tracer,garmin-upgrade}.test.ts`)을 `git grep`으로 재확인.
- `packages/core/src/domain/health.ts`(`packages/core/test/health.test.ts`가 시험하는 순수 resolve/aggregate) -- (B) 시제품의 재사용 후보. 0026과 의미가 같은지부터 확인하고 다르면 (B)의 비용에 포함.
- 기존 계약 시험(유지, assertion 축소 금지): `packages/postgres/test/health-contract.test.ts`, `import-contracts.test.ts:118-162`, `migrate.test.ts`(0025→0026 upgrade assertion), `apps/cli/python-test/garmin-normalize.test.ts`(성능 대상 시험), `garmin-import-verify.test.ts`, `analysis-input-snapshot.test.ts`, `garmin-pass2/upgrade/batch-import/body-digest/tracer.test.ts`.
- `apps/cli/test/ext-fixture.ts`, `pg-home.ts` -- 격리 PG·홈 fixture, `withoutHarnessFolders`. `tooling/test-db/src/global-setup.ts` -- `BRAIN_TEST_DATABASE_URL`.
- `tooling/test-changed/rules.mjs` -- 새 tooling·자식 프로세스 경로를 Python/PG 규칙에 연결.
- 측정 근거: `epic-health-analysis-health-query-performance-evidence.md`(관측 2,608·판정 ~1,133·하위계획 93, 좁힌 조건으로 ~9s→0.32s 진단). 진단값을 인수 상한으로 쓰지 않는다.

## Tasks & Acceptance

**Execution:**
- [ ] `tooling/health-perf/` (새) -- 결정적 seed 합성 fixture 생성기(규모 S/M/L, 예: 관측 ~2.5k/25k/250k; 계정·날짜·지표·dataset·revision·버전 분포와 위 행렬 사례 포함)와 러너. 준비(컨테이너·migrate·적재·ANALYZE·warm-up)와 측정 구간을 분리하고 workload별 warm-up 1회 + 3회 중앙값: W1 좁은 현재값 조회(한 계정·날짜·지표 `health_current_v1`), W2 전체 readHealth, W3 readVerification(실제 store 함수, 유효 attempt 준비), W4 18.2 reader, W5 `garmin-normalize.test.ts` 파일 wall. 각각 관측·키·후보 행수, 쿼리 수, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), 인덱스 크기를 `.brain-automation/perf/<label>/`에 JSON으로 남긴다. 대상 checkout 경로를 인자로 받아 기준·변경 코드를 같은 러너·fixture로 잰다 -- 재현성.
- [ ] 기준 측정 -- 코드 변경 전 baseline(0bdd03f) 결과를 같은 러너로 기록(지휘자가 만든 기준 checkout 사용). 머신 부하(`uptime`, 다른 컨테이너 CPU)를 함께 기록.
- [ ] 비교 시제품 -- (A) SQL 재작성과 (B) 일괄 조회+TS 판정을 각각 참조 오라클 동등성·W1~W4 시간·쿼리 수·계획으로 비교하고 채택 근거를 Design Notes에 표로 남긴다. 공개 view는 어느 경우에도 남으므로 view 자체 개선은 필수다.
- [ ] `packages/postgres/migrations/0031_health_resolution_performance.sql`, `src/migrate.ts` -- 채택안 구현(`create or replace view`로 열 동일 유지; 필요 시 인덱스). 버전 고정 시험 갱신.
- [ ] `packages/postgres/src/analysis-inputs.ts`, `imports.ts` -- 채택안에 맞춰 생산 경로의 중복 판정 제거 등 개선. 결과 바이트·순서 동일.
- [ ] 인덱스 검토 -- S/M/L × 선택도(한 키·한 계정 한 달·source 전체·전체)에서 기존 인덱스/후보 인덱스의 EXPLAIN 비교(사용 인덱스·Rows Removed by Filter·shared hit/read·시간), 채택 인덱스 크기, 같은 관측 INSERT 배치(예 1k·10k, 실제 trigger 경유)와 authority 규칙 INSERT의 전후 시간·처리량. 미채택이면 근거.
- [ ] `packages/postgres/test/health-resolution-equivalence.test.ts` (새) -- 0026 정의를 참조 view로 만들어 I/O 행렬 전 사례 + 무작위 seed fixture에서 resolution·current 전 열(배열 순서 포함) 일치, 좁힌 조회 = 전체 후 필터, `health_aggregate_v1` 일치를 단언.
- [ ] `tooling/test-changed/rules.mjs`(+ 해당 시험) -- 새 경로 연결.

**Acceptance Criteria:**
- Given 같은 기준 커밋·환경·fixture, when warm-up 뒤 3회 중앙값을 비교하면, then W1과 W5는 기준의 50% 이하, W2·W3·W4는 기준 대비 +10% 이하다. 미달 구간은 원인과 함께 기록하고 built로 올리지 않는다.
- Given 무관 계정·날짜·지표를 늘린 fixture, when W1의 EXPLAIN을 보면, then 판정 대상 관측 행수·버퍼가 증가하지 않는다.
- Given 기존 계약 시험·`garmin-import-verify`·`analysis-input-snapshot`, when 실행하면, then assertion 변경 없이 통과한다(기존 알려진 결함은 기준 재현으로 구별).
- Given 마이그레이션 전후 DB, when 기존 관측·분석 행과 저장 원문을 대조하면, then 바이트까지 같다.

## Implementation Notes

- 지휘자 판단: 기준 W2·W3·W4는 timeout 등으로 중도 절단되었으므로 각 실패 시간은 해당 호출의 하한이다. 변경 후 3회 성공 중앙값이 그 하한의 110% 이하면 +10% 초과 회귀가 없다고 판정하며, 기준을 무제한으로 재측정하지 않는다.

- 미완료 측정 준비: 전용 `brain-1810-perf`·`brain-1810-test`를 생성하고 기준 스키마 30을 측정 DB에 적용했다. 기준 W5 초기 warm-up은 145.28초, 이후 3회는 140.05·140.84·142.17초로 통과했으나 캐시 경로를 격리하기 전의 예비 측정이다. 측정 전 부하와 임시 스모크 자료는 `.brain-automation/perf/`에 있다. 100행 스모크 W1 실행 계획은 57.767ms, shared hit 20,360이지만 인수용 fixture가 아니므로 성능 판정에 쓰지 않는다.

- 동일 S seed SHA-256 `df3cbfb72647b8360ef5836d61ee2dd692c6d307ead609a6037ea8df6df66003`, 관측 2,538·표시/원형을 함께 보존한 판정 키 1,274·선택 ID 1,162·버전 후보 1,169. 기준 W1은 warm-up 뒤 3회 중앙값 15,648.40ms였고, W2/W3/W4는 세 번 모두 실패해 성공 중앙값이 없다(실패 시간 중앙값 각각 6,006.31/14,033.99/6,563.82ms). W2·W4는 statement timeout, W3는 `IMPORT_VERIFICATION_INVALID`다. 각 실패 시간은 성공 시간이나 수락 기준 충족으로 취급하지 않는다.
- 0026 참조와의 PRNG·경계 동등성, seed 배치 범위와 변경 경로 규칙 직접 시험은 3파일 30시험 통과했다. 기준 실제 W4 metrics SQL의 EXPLAIN ANALYZE는 294,914.404ms·shared hit 172,230,962였고, 실제 store 호출은 기존 제한에서 실패했다. 성능 원시 JSON과 실패 로그는 `.brain-automation/perf/`에 보관한다. W5는 Python 캐시 경로와 메모리 전용 SQL 통계를 격리해 warm-up 139,968.44ms 뒤 세 번 모두 통과했고, 141,207.78·140,340.99·141,373.61ms로 중앙값 141,207.78ms다. 각 측정의 최상위 SQL은 145,149·144,112·145,178회(시험 준비 포함), 통계 축출은 0이었다. 변경 후 W5는 2단계에서 같은 설정으로 측정하며 50% 상한은 70,603.89ms다. W1 기준 50% 상한은 7,824.20ms다.

- fixture 대규모 적재 첫 시도는 행마다 얻는 트랜잭션 advisory lock 때문에 `out of shared memory`로 롤백됐다. 실제 trigger를 우회하지 않고 M/L과 무관 증가 행을 최대 1,000행씩 커밋하도록 바꿨다. S는 기존 측정과 같은 단일 트랜잭션을 유지한다. 실제 M seed는 25,038행(기본 25,000 + 경계 38), 무관 증가 스모크는 2,538→25,380행에서 W1 대상 관측 2→2로 통과했다. L도 실제 trigger를 거쳐 250,038행 및 마지막 행을 확인했다. 10배 증가 후 실행 계획은 2단계에서 확인한다. 무관 증가 구성 통과를 버퍼 불변 수락으로 간주하지 않는다.

- W5 별도 진단에서 실제 합성 `daily_metric.steps` 한 날짜 조회를 포착했다. 그 시점 관측 384·판정 키 363·해당 후보 4이며 EXPLAIN은 4,603.442ms·shared hit 1,092,841이다(`baseline/W5-explain.json`). 동시에 계측한 별도 실행이므로 W5 중앙값에 포함하지 않으며 해당 진단 시험은 종료 코드 0으로 통과했다.

- 재현 명령: `<repo>`에서 `node tooling/health-perf/run.mjs --checkout ../brain-1810-baseline --label baseline --size S --skip-w5`로 기준 W1~W4 및 계획을 수집하고, 종료 처리의 시간 구간을 수정한 최종 시간은 같은 명령에 `--skip-explain`을 더해 다시 측정했다. W5는 `node tooling/health-perf/run.mjs --checkout ../brain-1810-baseline --label baseline --w5-only`로 별도 warm-up과 3회를 실행했다. 비교는 같은 seed로 `--label prototype-a --prototype a`, `--label prototype-a-once --prototype a --analysis-once`, `--label prototype-b --prototype b`에 각각 `--size S --skip-w5`를 붙였다. 경계 검사는 `--edge-only`, 무관 계정 9배 추가는 `--unrelated-growth`를 사용한다. 종료된 실제 store 호출의 시간만 기록하고 그 후 전용 연결이 완전히 종료되는 것을 확인해 반복 간 간섭을 막았다.


### 2단계 구현·측정 결과

0031은 0026의 결과 열과 권한을 유지하며 원형 identity 집계를 사용한다. current 경로는 표시값 인덱스로 외부 후보를 찾고 해당 행의 원형 identity 전체로 판정하는 SQL 함수를 호출한다. 함수는 동일 identity의 경쟁 dataset과 미확인 행을 포함하며 표시값이 서로 달라도 별도 판정 행의 중복을 보존한다. 분석 입력은 두 조인을 유지한 문장 내 CTE로 판정을 공유하고, 검증 snapshot의 두 timeout 설정을 한 SQL로 묶었다. 참조 동등성 및 직접 PG 46시험과 Garmin 직접 26시험은 통과했다. 마지막 `pnpm test:changed -- 0bdd03f4cc9ec170501f7cf286a49aa7573c2769`도 기본 1,630·PostgreSQL 556·Python 76시험 모두 통과했다.

| workload | 기준 3회 중앙값 | 변경 3회 중앙값 | 변경 SQL 수 | 판정 |
| --- | ---: | ---: | ---: | --- |
| W1 | 15,648.40ms | 19.14ms | 1 | 기준의 0.12%, 50% 충족 |
| W2 | 성공값 없음, 실패 하한 6,006.31ms | 3,591.95ms | 1 | 지휘자 하한 기준 6,606.94ms 이하 |
| W3 | 성공값 없음, 실패 하한 14,033.99ms | 778.32ms | 18 | 지휘자 하한 기준 15,437.39ms 이하 |
| W4 | 성공값 없음, 실패 하한 6,563.82ms | 397.66ms | 14 | 지휘자 하한 기준 7,220.21ms 이하 |
| W5 | 141,207.78ms | 18,918.06ms | 62,734/63,158/63,366 | 기준의 13.40%, 50% 충족 |

모든 변경 workload는 warm-up 후 3회 성공했다. S seed SHA는 기준과 같은 `df3cbfb72647b8360ef5836d61ee2dd692c6d307ead609a6037ea8df6df66003`; W1 출력 해시는 기준과 같고 W1~W4는 1단계 A 시제품 출력과 같다. W2~W4의 실패 시간은 성공 중앙값이 아니며 지휘자가 지정한 중도 절단 하한 방식으로만 판정했다. W5는 격리된 별도 진단 실행도 통과했다.

**미달:** 10배 무관 증가 시 W1 외부 index scan 대상은 2→2행이나 전체 shared hit은 1,931→1,935로 4 증가해 엄격한 버퍼 불변을 충족하지 못한다. 함수 내부 계획은 상위 EXPLAIN에 펼쳐지지 않아 내부 판정 대상 행수의 불변도 이 자료만으로 확정할 수 없다. 추정 원인을 사실로 단정하지 않으며 이 조건 해결 전 built 전이 금지다.

재현: `pnpm build`; `node tooling/health-perf/run.mjs --checkout . --label after-final --size S --skip-w5`; 같은 러너에 `--w5-only`; `--label after-growth --size S --unrelated-growth --skip-w5`(W1 계획 수집 후 잔여 workload 중지). 인덱스 fixture는 `--size S|M|L --seed-only`, 읽기/쓰기 실측 원문은 `.brain-automation/perf/index-*.jsonl`, `write-*.jsonl`; 쓰기 시험은 트랜잭션 롤백이다. 전용 컨테이너 `brain-1810-perf`, `brain-1810-test`는 전체 티켓 종료 후 지휘자가 제거한다.

## Plan Change Log

## Review Triage Log

## Design Notes

- B 초기 시제품은 큰 JSON 정수를 JavaScript Number로 합쳐 잘못된 current를 노출했고 확장 연도 날짜 문자열의 순서도 PostgreSQL과 달랐다(`.brain-automation/perf/edge-b-initial/equivalence.json`). 후보 조회에서 기존 DB 논리값 비교·fetched_at 순위·정수 날짜 경계를 계산하도록 보완한 뒤, 최종 경계 fixture 52행에서 A와 B 모두 0026 resolution 33행·current 22행에 일치했다(`.brain-automation/perf/edge-a-once/equivalence.json`, `.brain-automation/perf/edge-b/equivalence.json`). A의 단일 문장 CTE는 중복 current ID를 포함한 분석 입력 조인 24행도 참조와 같았다. W1~W4 성능을 재측정하여 아래와 같이 A를 선택했으며 인덱스 결정은 2단계에서 한다.

### 1단계 S 시제품 비교 (warm-up 1회 + 3회 중앙값)

B 시간은 확장 연도 날짜 범위 수정 후 재측정 결과다.

| 경로 | W1 좁은 current | W2 readHealth | W3 readVerification | W4 분석 입력 | 동등성·쿼리 수 |
| --- | ---: | ---: | ---: | ---: | --- |
| 기준 0026 | 15,648.40ms | 실패 | 실패 | 실패 | W1 1 SQL, 실패 시 W2/W3/W4 각각 1/9/10 SQL |
| A SQL 집계 + 문장 내 중복 판정 제거 | 58.77ms | 67.54ms | 757.92ms | 389.01ms | S resolution 1,274·current 1,107행 일치, 각각 1/1/19/14 SQL |
| B 일괄 조회 + TS 판정 | 35.35ms | 44.28ms | 73.33ms | 56.39ms | S resolution 1,274·current 1,107행 일치, 각각 6/6/22/17 SQL |

- A의 W1은 기준의 약 0.38%다. 기준 W2~W4는 호출 자체가 실패하므로 +10% 비율은 계산할 수 없다. A와 B는 W1~W4에서 모두 성공했으며 네 workload 출력 해시가 서로 같고, W1 해시는 기준과 같다. 초기 A에서 분석 SQL의 두 뷰 판정을 그대로 둔 변형은 W4 세 번 모두 timeout이었고 W4 EXPLAIN은 62,092.999ms·shared hit 172,208,984였다. 한 문장의 CTE로 판정만 공유하고 두 조인은 모두 남긴 A 변형은 W4 EXPLAIN 425.686ms·shared hit 845,294였으며, 표시값이 다른 같은 원형 identity를 포함한 경계 조인 24행도 참조와 같았다. 이 CTE는 문장 범위에서만 존재한다.
- B가 이 S fixture에서 더 빨랐다. B의 최종 recordset SQL 실행 계획만으로는 비용이 완전하지 않아 후보·권위·지원 버전 일괄 조회의 EXPLAIN을 따로 저장했다. 후보 조회는 27.771ms·shared hit 300, 나머지는 각 0.021ms·1 hit와 0.005ms·1 hit였다. B는 세 조회와 TS 판정에 모든 후보를 가져오며, 큰 JSON 숫자와 무한 timestamp의 SQL 의미를 지키기 위해 DB 순위 계산이 추가로 필요했다. 수정 전 숫자 정밀도 불일치도 보존했다.
- **2단계 구현 경로는 A를 선택한다.** A는 B를 선택하더라도 필수인 공개 SQL 뷰 개선을 직접 제공하고, S fixture에서 네 실제 경로가 성공하며 판정 규칙을 SQL 한 곳에 둔다. B의 더 빠른 S 측정은 명시적인 장점이지만 별도 TS 판정과 전체 후보 전송을 추가한다. 이 선택은 S·경계 fixture의 근거에 한정한다. S W1 계획에서 A는 관측 2,538행을 두 차례 순차 스캔하고 B도 후보 전체를 읽으므로, 무관 데이터 10배 시 버퍼 불변을 아직 입증하지 못했고 증가 위험이 있다. 2단계에서 키 조건 전달을 개선하고 해당 조건, S/M/L 인덱스/쓰기 비용, 변경 후 W5 및 최종 회귀를 반드시 검증해야 한다. 이 단계에서 성능 수락을 확정하지 않는다.

(A)와 (B) 모두 공개 view가 남으므로, (B)를 택해도 view 경로 개선은 별도로 필요하다(티켓: "SQL 경로를 남기면 그 경로도 개선 대상"). 좁은 조회가 빨라지려면 바깥 조건이 판정의 키 생성 단계로 내려가야 한다: 예컨대 current를 판정 결과의 키 열과 동치 join으로 묶거나, 키별 상관 서브쿼리를 키 그룹 단일 집계로 바꾸는 방식. 단, 표시값이 같고 원형 identity가 다른(또는 그 반대) 비정상 행에서 결과가 달라지지 않는지 참조 오라클로 확인해야 하며, 한 쪽만 맞는 변형은 채택하지 않는다.


### 2단계 인덱스 검토

세 선택도는 관측 테이블의 한 키, 한 계정·월, 전체 읽기이며 각 셀은 기존 → 후보의 shared hit/read 및 실행 ms다. 함수 내부 전체 판정의 EXPLAIN을 대체하지 않는다. 인덱스 제거 비교는 트랜잭션 안에서 두 후보 인덱스를 drop한 뒤 rollback했다.

| 규모 | 한 키 | 계정·월 | 전체 |
| --- | --- | --- | --- |
| S 2,538 | 74/0·0.241 → 3/0·0.045 | 74/0·0.147 → 33/0·0.094 | 74/0·0.309 → 74/0·0.401 |
| M 25,038 | 736/0·2.207 → 8/0·0.071 | 736/0·1.395 → 271/0·0.575 | 736/0·2.992 → 736/0·3.667 |
| L 250,038 | 6,637/717·11.162 → 54/12·0.409 | 6,919/435·10.169 → 2,216/444·5.761 | 7,201/153·31.959 → 6,543/811·33.763 |

기존 S/M은 전부 sequential scan(한 키 제거 2,536/25,026행, 계정·월 2,488/24,538행), L 선택 조회는 parallel gather다. 후보 한 키는 S index scan, M/L bitmap heap scan, 계정·월은 bitmap heap scan이며 전체는 양쪽 모두 sequential scan이다. L의 제거 행은 병렬 하위 노드에 기록돼 상위 Gather에는 없다. 실제 seed/시험 동시 실행에 따른 캐시·부하 차이가 있어 이 단일 실행 시간은 정밀한 반복 benchmark가 아니다. S/M/L에서 표시 인덱스 크기는 163,840/360,448/2,441,216바이트, identity 인덱스는 57,344/311,296/2,506,752바이트다.

L에서 실제 trigger를 실행한 롤백 INSERT 1k/10k는 기존 925.56/9,782.14ms(1,080/1,022행/s), 후보 296.44/6,335.26ms(3,373/1,578행/s)였다. authority INSERT 1k는 기존 19.71ms(50,731행/s), 후보 25.30ms(39,532행/s)였다. 단일 실행, 순서·캐시·동시 시험의 영향을 배제하지 못하므로 후보가 쓰기를 향상한다고 결론 내리지 않는다. 두 인덱스는 좁은 접근을 위해 구현에 잠정 포함했지만 버퍼 불변 미달과 함수 내부 계획 불투명성 때문에 최종 인덱스 채택을 확정하지 않는다.

## Verification

환경: 전용 측정 PG `brain-1810-perf`(postgres:18, tmpfs, 127.0.0.1:54410), 반복 시험 PG `brain-1810-test`(127.0.0.1:54411). 기준 checkout은 Orca 최상위 워크트리 `brain-1810-baseline`(detached 0bdd03f, 형제 경로). 정리: 티켓 종료 시 두 컨테이너 제거(지휘자). 기준 checkout은 보존.

**Commands:**
- `pnpm test:changed` -- 반복 중에만. expected: 선택 시험 녹색.
- `BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54411/postgres pnpm build && pnpm exec vitest run packages/postgres/test/health-resolution-equivalence.test.ts packages/postgres/test/health-contract.test.ts packages/postgres/test/import-contracts.test.ts packages/postgres/test/migrate.test.ts` -- expected: 통과.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-import-verify.test.ts apps/cli/python-test/analysis-input-snapshot.test.ts` -- expected: 통과(import-verify 변조 감지의 18.1 기존 결함은 기준 재현 여부로 분리).
- `node tooling/health-perf/run.mjs --checkout ../brain-1810-baseline --label baseline` 및 `--checkout . --label after` -- expected: 결과 JSON과 비교표, AC 기준 충족.
- `pnpm test` 후 `pnpm test:python` -- 마무리 직전 지휘자가 순차 1회, 결과·전체 시간 기록.
- `git diff --check` -- expected: 출력 없음.

**Manual checks:**
- 공개 diff에 개인 홈 절대 경로·실데이터 없음.
- Python 검증기 diff 없음(`git diff 0bdd03f -- extensions/garmin/src/verify_compare.py` 빈 결과).
