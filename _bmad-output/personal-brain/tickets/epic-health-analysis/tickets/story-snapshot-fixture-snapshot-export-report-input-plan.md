---
title: '입력 snapshot: 같은 합성 fixture에서 새 snapshot export가 옛 report-input과 파일·값·선행 선택까지 같다'
type: 'feature'
ticket: '2'
created: '2026-11-04'
status: 'built'
baseline_revision: 'ffa88142b2a2a39abf205286a115a4ff543ae89c'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/_bmad-output/personal-brain/tickets/epic-health-analysis/tickets/story-tracer-snapshot-day-core-fake-analyses-plan.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 18.1의 `analysis_snapshots.content`는 시험이 넣은 합성 바이트다. 옛 Garmin `report_input.build`/`build_period`가 SQLite에서 만들던 입력 폴더(raw day·activity export, body, labels, profile, manifest, 이전 평가, 기간별 `scope/day_values/evaluations/previous`)를 core 계약 표 위에서 만들 길이 없고, 네 scope가 같은 입력을 본다는 보장도 없다(E18-1).

**Approach:** 수집(`garmin.collect*`)·`garmin.artifacts` 성공 결과를 받아 짧은 읽기 하나로 원천 행을 모으고, 트랜잭션 밖에서 FileStore(digest·이전 리포트)와 profile을 읽어 snapshot 바이트(manifest + 고정 파일 목록 + 고정 선행 후보)를 만든 뒤 `brain.analysis_snapshots`에 한 번 쓴다. 순수 export 함수가 그 바이트에서 scope별 옛 폴더 모양 파일 목록을 재현한다. 옛 reader를 archive에서 꺼내 같은 합성 fixture로 돌리는 비교 시험과, ambiguity·여러 dataset·같은 snapshot id 공유를 보는 새 계약 시험으로 입증한다.

## Boundaries & Constraints

**Always:**
- 옛 의미를 그대로 옮긴다(근거 `garmin-source/src/garmin_pipeline/report_input.py`): day raw는 report_date−30일~report_date, 오늘 `user_summary`·`body_battery` 제외, 오늘 `stress_data`의 `stressValuesArray`·`bodyBatteryValuesArray`와 `heart_rates`의 `heartRateValues`는 `[ts,...]` 중 `ts < cutoff`만, 잘못된 raw JSON·endpoint 이름·activity id는 같은 notes 문구로 제외, 식별자 scrub(`SCRUB_PARTS` 대소문자 무시 부분문자열, 중첩 dict/list), missing 목록, 운동은 `start_ms < cutoff`를 회복 경계 `_workout_starts_ms`로·`start_ms + duration_s*1000 < cutoff`만 activities에, `window_from <= start < cutoff`만 `workouts`, manifest 키·notes 순서·문구, body `measured_on <= report_date`·검증 실패 note, 선행 선택 규칙(day: 정확히 어제 day·7d와 어제 본문, 7d: 창 안 모든 day, 30d: 끝 날짜 이하 최근 7d 다섯, all: 월별 마지막 30d, previous: 같은 scope의 끝 날짜 미만 최신 하나), all 월별 집계(행 있는 날만, 0 채움 없음).
- 원천 대응: cutoff·local_date·timezone·snapshot_id는 collect 결과 요약(`work_attempts.result_summary`), window 시작은 같은 계정 전날 collect 결과의 cutoff(없으면 전날 현지 11:00, 옛 `collect_time` 기본), collect `status`는 결과 요약, `finished_at`은 그 attempt의 종료 시각(현지 분), `detail`은 `""`. raw는 `garmin.raw_records`(계정 필터, key의 `day/`·`activity/` 접두사를 떼어 옛 폴더 모양). day_values의 day_summary·workout·exercise_log 열은 `brain.health_current_v1`의 같은 이름 catalog 지표를 mapping `factor`로 되돌려 pivot하고(열 순서는 archive 최종 SQLite `PRAGMA table_info` 순서, 행은 그 날짜/운동/종목에 현재 행이 하나라도 있을 때만, 없는 열은 null), 운동 경계는 `activity.start_ms`·`activity.duration_s`. 평가는 `brain.analyses`(legacy 칸 `summary/judgments/evidence/next_checks/report_md`, core는 `output_json`).
- digest는 `garmin.artifacts` 결과의 `request_id` → 완료된 file request의 file_id → FileStore 바이트를 그대로 `digest.json`으로 넣고 sha256을 manifest에 둔다. 다시 계산하지 않는다.
- DB 읽기는 REPEATABLE READ read-only 트랜잭션 하나, FileStore·profile 읽기와 바이트 생성은 그 밖, 쓰기는 `analysis_snapshots` insert 하나. 같은 (collect 결과, artifacts 결과)로 다시 만들면 같은 snapshot을 돌려준다.
- 새 계약: ambiguity(`health_resolution_v1.reason` not null) 행은 day_values·운동 경계에 들어가지 않고 manifest `excluded`에 `(metric, local_date, activity_id, sub_identity, reason, ids)`로 남는다. authority 규칙으로 고른 dataset만 쓰고 쓴 규칙 id·revision과 current 행 id 목록을 manifest에 둔다.
- 합성 데이터만, 개인 홈 절대 경로 금지, 모델 호출 없음.

**Never:** 네 scope 실행·의존 그래프·same-graph 결과 등록(18.3), 모델 adapter·export 가리기 확장·진단 정책(18.4), 결과 묶음(18.6), 예약·자동 투입(18.7), 실계정·실건강데이터·실모델, digest 재계산, `analyses` 행 변경, 옛 평가 덮기, 운영 예약 변경, `plugin/app-ref` 변경, 새 보안·보존 정책.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 비교 | 같은 합성 raw·run·activity·day_summary·workout·exercise_log·body·profile·evaluation, 같은 clock·Asia/Seoul·cutoff | day 폴더와 `period/{7d,30d,all}` 파일 목록·JSON 값·배열 순서·notes·NULL·누락·선행 선택이 옛 reader와 같다(임시 경로만 제거) | 없음 |
| cutoff 경계 | 샘플 ts = cutoff−1, cutoff, cutoff+1; 운동 종료 = cutoff−1, cutoff | cutoff−1만 남고, 종료=cutoff 운동은 activities에서 빠지되 시작은 `_workout_starts_ms`에 남는다 | 없음 |
| 미완료 운동·짧은 이력·월 경계 | 진행 중 운동, 이력 3일, 월을 넘는 30d/all 창 | 옛과 같은 workouts·history_days·months·actual_days | 없음 |
| 잘못된 raw·body·중첩 식별자 | 깨진 JSON, `../x` endpoint, 비숫자 activity id, 스키마 위반 body, 리스트 안 `userProfilePK` | 옛과 같은 notes와 제외, scrub 결과 | 없음 |
| ambiguity·여러 dataset(새 계약) | 같은 지표·날짜에 두 dataset 값, 규칙 없음 / 규칙 있음 | 규칙 없음: 값 제외·`excluded`에 `dataset_ambiguous`; 규칙 있음: 규칙 dataset 값, 규칙 id 기록 | 없음 |
| 같은 snapshot | snapshot 하나로 day·7d·30d·all export | 네 export가 같은 snapshot id·manifest·고정 선행 후보를 읽는다 | 없음 |
| 선행 결과 없음 | collect 또는 artifacts 결과가 성공이 아님·`cutoff_ms` 없음·digest 파일 미완료 | snapshot을 만들지 않음 | `ANALYSIS_SNAPSHOT_INPUT_INVALID`(비재시도) |

</intent-contract>

## Code Map

- `garmin-source.tar.gz`(`_bmad-output/personal-brain/prep-garmin-absorption/inputs/`) 안 `garmin-source/src/garmin_pipeline/report_input.py`(540행), `report.py:843`(digest.json 쓰기), `body.py:348 read_sidecar`·`schemas/body.schema.json`, `store/migrations/*.sql`(day_summary·workout·exercise_log·evaluation·run·activity·raw_response DDL), `tests/test_report_input.py`(경계 fixture 출발점: `:31` 필터·식별자, `:127` subminute, `:158` 미완료, `:224` 월 집계, `:335` 어제 평가). 옛 reader 동작의 정본. 읽기만.
- `extensions/garmin/scripts/legacy_normalize_oracle.py:70-90` -- archive를 임시 폴더에 풀어 `PYTHONPATH`로 옛 코드를 자식 프로세스로 돌리는 선례. 옛 reader는 `body.py`가 늦게 `jsonschema`를 import하므로 `uv run --offline --no-project --python 3.14 --with jsonschema==4.26.0 python …`로 돌린다(이 호스트 uv 캐시에서 동작 확인).
- `packages/postgres/migrations/0023_health_contract.sql`, `0026_health_json_comparison.sql:112` -- `health_catalog_v1`(day_summary.*·workout.*·exercise_log.*·activity.* 지표, `mappings[].factor`: moderate_min/vigorous_min 60, weight_kg·max_kg·volume_kg 1000), `health_resolution_v1`(reason·current_id·selected/unselected·authority_id/version), `health_current_v1`. 읽기만.
- `packages/postgres/migrations/0029_core_analyses.sql`, `packages/postgres/src/analyses.ts`, `packages/core/src/ports/analysis.ts`, `packages/core/src/analysis/{day,export,index}.ts` -- 18.1 snapshot 표·`AnalysisStore`·`enqueueDayAnalysis`. snapshot 행 모양은 그대로 쓰고 tracer 경로는 바꾸지 않는다.
- `packages/postgres/migrations/0027_analysis_artifacts.sql:2-16` -- legacy analyses 텍스트 칸. `0028_file_request_metadata.sql:13,22` -- `work_attempts.result_summary`. `0022_import_contracts.sql:30` -- `file_request_results_public_v1`.
- `extensions/garmin/src/collect.py:58` -- collect 결과 요약 `{status,cutoff_ms,local_date,normalized,normalize_failed,timezone,snapshot_id}`. `extensions/garmin/src/runtime_artifacts.py:118-140` -- artifacts 결과 `{status,request_id,revision,graphs_*}`, digest·그래프 file request metadata(`kind`,`collect_result_id`,`role`,`name`). `extensions/garmin/src/artifact_inputs.py` -- 16.5가 같은 필터를 collect snapshot에 적용한 참고 구현.
- `extensions/garmin/migrations/0001_tracer.sql:4-8`, `0003_raw_v2.sql` -- `garmin.raw_records`(brain_app select). `0007_collect_runs.sql`(`collect_targets`), `0010_runtime_body.sql`(`body_measurements.sidecar`)는 brain_app이 못 읽는다.
- `extensions/garmin/src/labels/exercise_types_ko.json` -- archive와 바이트 동일 확인. core 리소스로 복사.
- `apps/cli/python-test/garmin-body-digest.test.ts`, `apps/cli/test/ext-fixture.ts` -- garmin 확장 설치된 격리 PG·홈 fixture와 superuser로 garmin 표에 합성 행을 넣는 선례. `packages/postgres/test/health-contract.test.ts` -- health_observations 합성 행 삽입 선례.
- `tooling/test-changed/rules.mjs` -- 새 Python 통합 시험과 자식 프로세스 오라클 경로 연결 자리.

## Tasks & Acceptance

**Execution:**
- [ ] `extensions/garmin/migrations/0012_analysis_reads.sql`(+manifest migration 목록) -- 읽기 전용 view `garmin.body_records(account, measured_on, sidecar)`, `garmin.collect_target_accounts(target_kind, target_id, account)`, brain_app select grant. -- core가 body와 계정을 계약 경로로 읽게 한다.
- [ ] `packages/core/resources/health-analysis/v1/{labels/exercise_types_ko.json,schemas/body.schema.json}` -- archive 바이트 그대로(sha256 Implementation Notes에 기록).
- [ ] `packages/core/src/analysis/input/{sources.ts,scrub.ts,legacy-shape.ts,predecessors.ts,snapshot.ts,export.ts,index.ts}` -- 순수 함수: 원천 행(DTO) → snapshot 문서(manifest: 버전 `analysis-input/1`, report_date·timezone·cutoff_ms(UTC)·workout window·collect/artifacts 결과 id·catalog 1·normalization 버전·current 행 id·authority 규칙 id/revision·excluded·digest/graph/body/profile/labels 참조·고정 선행 후보) 와 결정적 JSON 바이트; `exportScopeInput(snapshotBytes, scope, sameGraph: AnalysisRecord[] = [])` → `{path, bytes}[]` 옛 폴더 모양(day: `manifest.json, days/**, activities/**, body/**, labels/**, profile.md, previous_report.md?, previous_evaluations/*, digest.json`; 기간: `period/<scope>/{scope,day_values,evaluations,previous}.json`). JSON은 `indent 2`·`ensure_ascii=False`·끝 줄바꿈. AVG는 SQLite와 같은 합(Kahan-Babuska-Neumaier)으로 계산.
- [ ] `packages/core/src/analysis/input/create.ts` + `ports/analysis.ts` -- `createAnalysisInputSnapshot(deps, {collectWorkId, artifactsWorkId, bundleId})`: store 짧은 읽기 → FileStore 읽기(digest, 어제 core 리포트) → profile(`analysis.profile_path`) 읽기 → 바이트 → `createAnalysisSnapshot`. 같은 입력 재호출은 기존 snapshot id 반환. port `readAnalysisInputSources`, `findAnalysisSnapshotByInputs`.
- [ ] `packages/postgres/src/analysis-inputs.ts`(+`store.ts` 조립) -- 위 port 구현(REPEATABLE READ READ ONLY 한 트랜잭션). 확장 미설치·schema 없음은 `ANALYSIS_SNAPSHOT_INPUT_INVALID`.
- [ ] `packages/postgres/migrations/0030_analysis_snapshot_inputs.sql`, `src/migrate.ts`(30)·버전 고정 시험 -- `analysis_snapshots`에 `collect_work_id, artifacts_work_id` nullable 칸과 둘 다 있을 때 partial UNIQUE. 18.1 tracer 행(둘 다 NULL)은 그대로.
- [ ] `packages/core/src/settings/index.ts`, `packages/core/src/codes.ts`+guide -- `analysis.profile_path`(`~/` 경로, 기본 없음; 없거나 못 읽으면 옛 note), `ANALYSIS_SNAPSHOT_INPUT_INVALID`(비재시도).
- [ ] `apps/cli/test/fixtures/legacy-report-input-oracle.py` -- archive를 새 임시 폴더에 풀고 같은 합성 fixture JSON으로 옛 SQLite DB·data_dir(body, profile, reports)를 만든 뒤 `report_input.build(cfg, date, started_at=cutoff)`와 해당 시점 evaluation 상태로 `build_period`를 돌려 `{relative path: text}`를 stdout JSON으로 낸다.
- [ ] `apps/cli/test/fixtures/analysis-input-fixture.json` + `apps/cli/python-test/analysis-input-snapshot.test.ts` -- 같은 fixture를 garmin 확장 설치된 격리 PG에 넣고(raw_payloads, collect_targets, body_measurements, health_observations, authority 규칙, legacy·core analyses, collect·artifacts work/attempt result, digest file) 새 snapshot·export 결과를 오라클과 비교. 시험 이름: `analysis input snapshot matches legacy report-input` (경계 fixture별 case), `analysis input snapshot new contract`(ambiguity·여러 dataset·같은 snapshot id·입력 무효·재호출 같은 id). fixture env는 `withoutHarnessFolders`.
- [ ] `packages/core/test/analysis-input.test.ts` -- 순수 함수 단위 시험: 손으로 계산한 cutoff·선행 선택 기대값(오라클과 독립), same-graph 결과 합류(7d가 오늘 day, 30d가 오늘 7d, all이 오늘 30d를 옛 DB 선저장과 같게 고름), 허용 집계.
- [ ] `tooling/test-changed/rules.mjs`(+rules 시험) -- `packages/core/src/analysis/input/`, `apps/cli/test/fixtures/legacy-report-input-oracle.py`, `apps/cli/test/fixtures/analysis-input-fixture.json`, `packages/core/resources/health-analysis/` 변경이 새 Python 통합 시험을 고르게 한다.

**Acceptance Criteria:**
- Given 같은 합성 fixture와 clock·시간대·cutoff, when `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/analysis-input-snapshot.test.ts`를 돌리면, then 각 경계 case에서 옛 reader 트리와 새 export 트리의 파일 목록·파싱한 JSON 값·배열 순서·notes·null·missing·선행 선택이 같고, 유일한 의도 차이(아래 Design Notes 1)는 명시 단언으로 확인된다.
- Given artifacts digest 파일 바이트, when snapshot을 만들면, then export의 `digest.json` 바이트 sha256이 그 파일과 같고 digest 계산 코드는 호출되지 않는다.
- Given 한 snapshot, when 네 scope를 export하면, then 모두 같은 snapshot id와 manifest를 읽고 DB를 다시 읽지 않는다.
- Given ambiguity·두 dataset fixture, when snapshot을 만들면, then ambiguity 값은 어떤 export 파일에도 없고 manifest `excluded`에 있으며, 규칙이 있는 지표는 규칙 dataset 값과 규칙 id가 남는다.

## Implementation Notes

- Garmin 읽기 view와 core snapshot 입력 식별 열 및 부분 유니크 인덱스를 추가했다. body view는 dataset을 통해 account를 연결하며 식별 불가능한 account는 그대로 null이다.
- archive에서 원본 리소스를 복사했다: labels SHA-256 `2ba81d36beac2fa4ecee76183f20eed4477cd42180a1b2a44b06cd383c5ad999`, body schema SHA-256 `8608b5d9b6120715561239a76cfc6bf4af026cd82738e66b0474808fcf9b26df`.
- 같은 계정의 여러 dataset이 같은 날 body sidecar를 담을 수 있으므로 두 Garmin view에 dataset을 노출한다. 수집 target의 account·dataset에 해당하는 body만 사용하고 그 dataset을 manifest에 기록한다. 16.5 body runtime이 `collect_store.dataset_for(account)`로 선택한 단일 dataset에서 읽고 쓰며 그 dataset의 측정일이 기본키라는 근거에 따른 지휘자 결정이다.

- 이전 평가 범위는 지휘자 결정에 따라 Garmin legacy 전체와 같은 account의 새 입력 snapshot에서 나온 core 행으로 정했다. 옛 evaluation에는 계정이 없어 이전 dataset을 제한하면 이전 분석을 잃고, tracer snapshot은 실제 수집 입력이 아니므로 제외한다. 새 manifest에 account를 기록한다.

- 입력 DTO·scrub·선행 선택·pivot·snapshot·scope export와 생성 use case, PostgreSQL 읽기 adapter를 추가했다. 원천 조회는 repeatable read read only 트랜잭션에서 끝내고 digest·profile·이전 core 리포트 읽기는 트랜잭션 밖에서 수행한다.
- `analysis.profile_path`와 오류 코드, archive 오라클·합성 fixture·격리 통합 시험·순수 함수 시험 및 changed-test 선택 규칙을 추가했다. JSON 파일과 digest는 snapshot에 base64로 고정하고 동일 입력 쌍에는 기존 snapshot을 반환한다.

- 리뷰 1회차에서 exercise_log 복합 식별자를 원본 인코딩으로 복원하고 해석 불가 행을 제외했다.
- SQLite BINARY 순서와 보정 SUM을 사용하며 NULL 관측을 그대로 보존하도록 비교 fixture를 확장했다.
- 정상 noop 수집, cutoff 기준 전날 선택, 파일 읽기 실패 재시도와 현지 11시 fallback을 반영하고 경계 시험을 추가했다.
- 선행 평가의 동률·기간 선택과 어제 core 리포트 파일을 옛 reader와 같은 합성 fixture에서 검증했다.

- 리뷰 2회차에서 digest FileStore 실패를 그대로 전파해 일시 장애 뒤 재호출할 수 있게 했다.
- drinks_json은 반입 원문을 우선하고 원문이 없으면 Python 기본 JSON 구분자를 재현한다.
- body와 raw의 안전 정수 범위 밖 JSON 정수 토큰을 보존하고 body 측정 키는 own property로 검증한다.
- 이전 평가의 생성 시각은 실제 시각으로 비교하고 activity ambiguity 및 입력 쌍 동시 삽입을 검증했다.
- factor 60·1000, 여러 달 운동과 NULL을 공유 fixture에 추가해 옛 reader와 비교했다.

## Plan Change Log

## Review Triage Log

### 2026-11-04 — Review pass
- verdicts: 19 findings — high 3, medium 11, low 2, false 3, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap 1) 어제 core 리포트 파일 본문이 day export `previous_report.md`로 전달되는지 시험 없음 — 비교 fixture에 어제 core day + report 파일(digest와 다른 바이트) 추가, 본문 단언 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (verification-gap 2) 전날 collect 없을 때 현지 11:00 fallback 미검증 — Asia/Seoul fallback case 추가 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (verification-gap 3) 30d 최근 7d 다섯 제한 미검증 — 7d 후보 여섯 이상을 옛 reader 비교 fixture와 단위 시험에 추가 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[high]` `[patch]` (edge 1) exercise_log `sub_identity`는 실제 생산자(normalize_store.py:64,108, batch_import.py canonical/encoded)에서 인코딩된 복합 PK인데 종목명으로 그대로 내보냄 — 두 번째 원소 디코드, 해석 불가 행 제외, 삽입기가 실제 인코딩 키 사용하도록 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[high]` `[patch]` (edge 2) 정상 `noop` collect(collect.py:133-139)를 거부 — success/noop 허용과 noop case — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (edge 3) `localeCompare` 정렬이 SQLite BINARY와 다름 — 코드포인트 비교 함수와 대소문자 종목 fixture — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[high]` `[patch]` (blind 1) noop 거부 — edge 2와 같은 근본 원인, 같은 수정.
  - `[false]` `[reject]` (blind 2) 같은 계정 여러 dataset raw가 같은 경로를 덮음 — `garmin.raw_payloads`의 `unique nulls not distinct (account, scope, original_key, endpoint)`(0001_tracer.sql)로 계정당 key·endpoint 행은 dataset을 넘어 하나뿐이고 raw_records v1은 그 표의 투영이다.
  - `[medium]` `[patch]` (blind 3) localeCompare — edge 3과 같은 근본 원인.
  - `[medium]` `[patch]` (blind 4) 월별 SUM을 평균×개수로 계산해 SQLite SUM과 반올림 차이 — 보정 합 직접 반환 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (blind 5) 전날 collect를 finished_at으로 선택(옛 started_at, 새 cutoff_ms) — cutoff_ms desc — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (blind 6) 어제 core 리포트 읽기 실패를 무시하고 snapshot을 영구 저장 — 실패 반환 — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[low]` `[reject]` (blind 7) 선택되지 않을 오래된 legacy 행의 잘못된 JSON이 전체 생성을 막음 — legacy 칸은 옛 파이프라인이 json.dumps로 쓴 값을 바이트 그대로 반입한 것이라 일상 사용에서 만나기 어렵고, 수정은 후보 선택을 DB 단계로 옮기는 분기 추가라 직접 수정이 아니다.
  - `[low]` `[reject]` (blind 8) cutoff_ms=1e100 같은 범위 밖 유한값 — collect.py가 정수 epoch ms만 내고 artifacts도 int를 요구한다(runtime_artifacts.py:79); 일상 사용에서 도달하지 않고 수정은 검증 분기 추가다.
  - `[medium]` `[patch]` (blind 9) 시험 삽입기가 NULL을 0으로 바꾸고 명시적 NULL 관측이 없음 — NULL 보존·혼합 fixture — 구현자 수정 반영, 지휘자 재실행: 단위 10·통합 11 통과.
  - `[medium]` `[patch]` (blind 10) 동률 규칙·30d 다섯·previous 엄격 이전 날짜 단위 시험 부재 — case 추가 — 구현자 수정 반영(verification-gap 3과 일부 겹침), 지휘자 재실행: 단위 10·통합 11 통과.
  - `[false]` `[reject]` (intent A) 네 월별 지표 null 처리가 엄격한 값 동등성과 다름 — 결함 주장이 아닌 기술이며, 계획 Design Notes 1이 티켓 "허용 집계만"과 0023 ASSUMPTION을 근거로 채택하고 시험이 명시 단언한다. 원문 내부 긴장은 결과 보고의 잔여 판단 항목으로 남긴다.
  - `[false]` `[reject]` (intent B) 네 scope 실제 그래프 소비는 시험하지 않음 — 명세가 "scope 실행은 18.3 몫"으로 구별하고 18.2는 같은 snapshot 바이트·id를 네 export가 읽는 계약을 구현한다.
  - `[medium]` `[patch]` (intent C) 옛 reader 비교 fixture가 선행 후보 경쟁(7d 여섯, 같은 월 30d 여럿, previous 여럿)을 포함하지 않음 — 공유 fixture 확장 — 구현자 수정 반영(verification-gap 3과 함께), 지휘자 재실행: 단위 10·통합 11 통과.

### 2026-11-04 — Review pass (후속 2회차)
- verdicts: 13 findings — high 0, medium 9, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` (verification-gap 1) 동률 시험이 revision과 created_at 우선순위를 구별하지 못함 — 높은 revision이 더 이른 경쟁 case 추가. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (edge 1) digest FileStore 일시 실패를 비재시도 입력 오류로 변환(create.ts:15-16, codes.ts retryable false) — 원래 실패 반환·재호출 case. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (edge 2) drinks_json을 compact JSON으로 재직렬화해 옛 TEXT(`json.dumps` 기본 구분자, digest.py:1298)와 문자열이 다름 — value_json_raw 원문 우선, 없으면 Python 기본 직렬화. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 1) digest 실패 변환 — edge 1과 같은 원인. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 2) body `value_mtime_ns`(1e18 규모, body_runtime의 st_mtime_ns)가 JS Number로 반올림 — Node 24 reviver context.source로 큰 정수 토큰 보존(raw 경로 포함). 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 3) drinks_json 재직렬화 — edge 2와 같은 원인. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[low]` `[reject]` (blind 4) TEXT 지표의 NUL 원문(value_text_raw) 무시 — NUL이 든 운동 종류·범주 문자열은 일상 데이터에서 만나기 어렵고, 수정은 인코딩별 복원 분기 추가라 직접 수정이 아니다.
  - `[low]` `[patch]` (blind 5) body 키 검사 `k in limits`가 상속 키 허용 — `Object.hasOwn` 직접 수정. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[low]` `[patch]` (blind 6) createdAt 문자열 형식 혼재(DB `::text` vs ISO) 비교 — ISO UTC 정규화 직접 수정. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 7) activity.start_ms/duration_s ambiguity가 운동 경계에서 빠지는지 시험 없음 — case 추가. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[low]` `[patch]` (blind 8) createInputSnapshot 동시 insert 수렴 경로 미시험 — store 동시 호출 case 추가(시험만, 직접). 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 9) factor 60·1000 및 소수 kg 경로가 비교 fixture에 없음 — fixture 추가. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.
  - `[medium]` `[patch]` (blind 10) 월별 workout·exercise 그룹 경계가 비교 fixture에 없음 — 여러 달 운동·종목 fixture 추가. 구현자 수정 반영, 지휘자 재실행: 단위 12·통합 15 통과.

## Design Notes

1. 허용 집계(채택 가정, 근거: 티켓 "허용 집계만", 0023의 `[ASSUMPTION] legacy_unspecified는 집계하지 않는다`): all 월별 평균은 catalog `aggregations`에 `mean`이 있는 열만 계산하고 `hrv_avg, spo2_avg, spo2_min, resp_avg`는 키를 유지하되 `null`이다. 옛 reader는 평균을 냈으므로 비교 시험은 이 네 키만 "옛: 숫자 또는 null, 새: null"로 따로 단언하고 나머지는 그대로 비교한다. 월별 `MAX(max_kg)`는 관측값 선택이라 단위를 섞지 않으므로 옛 그대로 둔다. `COUNT`·`SUM(duration_s)`·`SUM(volume_kg)`는 허용.
2. 선행 선택: snapshot은 만들 때의 analyses에서 규칙별 후보(어제 day·7d·본문, 7d 창의 day, 끝 날짜 이하 7d 최근 다섯, 월별 마지막 30d, scope별 previous)를 내용과 id째 고정한다. 같은 그래프의 앞 scope 결과는 18.3이 `sameGraph`로 넘기고, export는 고정 후보 ∪ sameGraph에 옛 규칙을 적용한다(후보 집합이 옛 선택의 상위집합이라 결과가 같다). 같은 (report_date, scope)에 행이 여럿이면 core > legacy, revision 큰 것, created_at 늦은 것, id 순(채택 가정; 옛은 PK로 하나).
3. 평가 JSON: legacy `judgments/evidence/next_checks`는 JSON 텍스트를 파싱, core는 `output_json`의 같은 키. 어제 본문은 legacy `report_md` 또는 core `analysis_files` 파일 바이트.
4. body: `garmin.body_records` sidecar를 옛 `read_sidecar` 규칙(schema v1, `measured_on` 일치)으로 검증하고 실패는 옛 note. profile은 바이트를 snapshot에 넣고 sha256을 참조로 둔다(core 파일 등록은 하지 않음, 채택 가정). 그래프는 같은 collect 결과의 완료된 graph file request id·role·name만 manifest 참조.
5. snapshot 내용 바이트는 키 정렬 JSON(UTF-8)이며 파일 바이트는 base64. export는 바이트에서만 만든다(scope 사이 DB 재읽기 없음).

## Verification

**Commands:**
- `pnpm test:changed` -- 반복 중에만. expected: 선택된 시험 녹색.
- `pnpm build && pnpm exec vitest run packages/core/test/analysis-input.test.ts` -- expected: 통과.
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/analysis-input-snapshot.test.ts` -- 사전 조건: 격리 시험 PG(`BRAIN_TEST_DATABASE_URL`), `extensions/garmin/.venv`(`uv sync --frozen`), uv 캐시의 jsonschema 4.26.0. 관찰: AC 전부. 정리: fixture가 시험 DB·임시 홈·archive 임시 폴더 삭제. expected: 통과.
- `pnpm test` 후 `pnpm test:python` -- 마무리 직전 순차 1회(지휘자). expected: 전부 통과 또는 기존 결함만(근거와 함께 분리).
- `git diff --check` -- expected: 출력 없음.

**Manual checks:**
- 공개 diff에 개인 홈 절대 경로·실데이터 없음(`git diff origin/main | grep -n '/Users/'` 빈 결과).
- cutoff·선행 선택 기대값을 reader 작성과 별도로 손으로 계산한 단위 시험이 있는지(에픽 F5-2).

## Auto Run Result

상태: built (2026-11-04). 사용자 인수 전이므로 done이 아니다.

**구현 요약:** 성공한 Garmin collect(`success`·`noop`)와 artifacts 결과를 받아 REPEATABLE READ READ ONLY 트랜잭션 하나로 raw·현재 건강 행·ambiguity 제외·body·analyses·digest/graph 참조를 읽고, 트랜잭션 밖에서 digest·어제 core 리포트·profile을 읽어 불변 snapshot 바이트(manifest `analysis-input/1` + 옛 폴더 파일 + 고정 선행 후보)를 `brain.analysis_snapshots`에 한 번 쓴다. 같은 (collect, artifacts) 쌍은 같은 snapshot으로 수렴한다. 순수 `exportScopeInput(snapshot, scope, sameGraph)`가 옛 `report_input.build`/`build_period`와 같은 day 폴더와 `period/{7d,30d,all}` 파일을 만든다. digest는 artifacts 파일 바이트를 그대로 쓰고 다시 계산하지 않는다.

**변경 파일:**
- `extensions/garmin/migrations/0012_analysis_reads.sql` — brain_app용 읽기 view `garmin.body_records`, `garmin.collect_target_accounts`(dataset 포함).
- `packages/postgres/migrations/0030_analysis_snapshot_inputs.sql`, `packages/postgres/src/{analysis-inputs,migrate,store}.ts` — 입력 쌍 칸·부분 UNIQUE, PG 원천 reader, schema 30.
- `packages/core/src/analysis/input/{sources,scrub,legacy-shape,predecessors,snapshot,export,create,index}.ts`, `packages/core/src/{analysis/index,ports/analysis,settings/index,codes}.ts`, `README.md` — 순수 snapshot/export·선행 선택·생성 use case·port, `analysis.profile_path`, `ANALYSIS_SNAPSHOT_INPUT_INVALID`.
- `packages/core/resources/health-analysis/v1/{labels/exercise_types_ko.json,schemas/body.schema.json}` — archive 바이트 그대로.
- `apps/cli/test/fixtures/{legacy-report-input-oracle.py,analysis-input-fixture.json}`, `apps/cli/python-test/analysis-input-snapshot.test.ts`, `packages/core/test/analysis-input.test.ts` — archive 옛 reader 오라클, 공유 합성 fixture, 비교·새 계약·단위 시험.
- `tooling/test-changed/{rules.mjs,rules.d.mts,run.mjs}`, `tooling/test-db/test/test-changed.test.ts` — 새 경로를 통합 시험에 연결.
- 버전·목록 고정 시험: `packages/postgres/test/{migrate,store,unavailable,work-store}.test.ts`, `apps/cli/test/{install,setup}.test.ts`, `apps/cli/python-test/{garmin-tracer,garmin-upgrade}.test.ts`, `packages/core/test/{codes,settings}.test.ts`.

**채택 가정(근거는 Design Notes·Implementation Notes):** all 월별 평균에서 catalog가 mean을 허용하지 않는 `hrv_avg, spo2_avg, spo2_min, resp_avg`는 null(티켓 "허용 집계만", 0023 ASSUMPTION) — 비교 시험은 이 네 키만 명시 단언한다. body는 collect target의 dataset 하나만, 선행 후보는 legacy Garmin 전체와 같은 account의 실제 입력 snapshot에서 나온 core 행만(tracer 제외), 같은 날짜·scope 다수 행은 core > legacy > revision > created_at > id, profile은 snapshot 바이트로 고정(core 파일 등록 안 함), 그래프는 manifest 참조만.

**리뷰 결과:** 1회차(4 lens) 19건 — patch 14(high 3: exercise 복합키 디코드, noop 수집 거부 2건 동일 원인), reject 5(false 3, low 2). 후속 2회차(3 lens) 13건 — patch 12(high 0), reject 1(low). 거절 사유는 Review Triage Log 각 행. defer: 없음(새 deferred 없음).

**후속 리뷰 권고:** false. 1회차 high 패치에 대해 후속 리뷰를 실제로 수행했고, 후속 2회차에서 high 0건으로 수렴했다(medium 9·low 3 patch는 회차 규칙상 추가 리뷰 근거가 아니다).

**검증(지휘자 실행, 권한 확장, 지휘자 소유 tmpfs 격리 PG):**
- 직접: `pnpm exec vitest run packages/core/test/analysis-input.test.ts` 12 통과; `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/analysis-input-snapshot.test.ts` 15 통과; `git diff --check` 통과.
- 반복 `pnpm test:changed`(최종): 기본 3213/3213, Postgres 전체 536/536, Python 75/76 — 실패 1은 `garmin-import-verify` 변조 감지(18.1 deferred 기존 결함, 같은 `undefined` TypeError).
- 마무리 `pnpm test`: 178 파일 3985 통과·1 skip, exit 0.
- 마무리 `pnpm test:python`: 19 파일 중 18 통과, 75/76 — 실패 1은 `garmin-batch-import`의 "NUL 계정과 원문·legacy·건강 TEXT를 UTF-16be에서 복원" (`EXTENSION_INVALID`). 같은 파일 단독 재실행 2회 모두 5/5 통과, 앞선 `test:changed` 실행에서는 UTF-16le 변형이 같은 식으로 한 번 실패했다. 이번 변경은 해당 반입 경로를 바꾸지 않았고(garmin view 2개 추가만), 기준 커밋 재현은 확인하지 않았다 — 간헐 실패로 잔여 위험에 남긴다. 이번 실행에서 import-verify는 통과했다.
- I/O 행렬 7행: 통합 시험 `matches trees, cutoff, incomplete workouts, short history, month boundary and invalid raw/body`(1~4행), `excludes ambiguous datasets and records authority`·`excludes ambiguous activity.start_ms/duration_s ...`(5행), `keeps one snapshot across four exports`·`returns the same snapshot on re-entry ...`·`converges concurrent snapshot inserts on the same id`(6행), `rejects unsuccessful or incomplete predecessors`·`reports missing Garmin read contract`(7행)이 마무리 실행에서 통과.
- 공개 diff에 개인 홈 절대 경로·실데이터 없음.

**잔여 위험:**
- `garmin-batch-import` UTF-16 NUL 복원 시험의 전체 실행 중 간헐 실패(위). 기준 커밋 재현 여부 미확인.
- 네 scope 실행이 실제로 같은 snapshot을 소비하는 연결과 `sameGraph` 전달은 18.3, 모델 입력 가리기(export 코덱)는 18.4 몫이다. 18.1 tracer worker는 아직 기존 `export.json` 경로를 쓴다.
- TEXT 지표의 NUL 원문(`value_text_raw`) 복원은 하지 않는다(2회차 low reject).
- 오라클은 uv 캐시의 `jsonschema==4.26.0`과 `extensions/garmin/.venv`를 사전 조건으로 한다.

**운영 조치:** 없음. 실계정·실건강데이터·실모델·예약 변경을 하지 않았다.
