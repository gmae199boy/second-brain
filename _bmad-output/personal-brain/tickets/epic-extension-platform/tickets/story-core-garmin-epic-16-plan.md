---
title: '20.6 정리: 옛 core Garmin 경로와 epic 16 확장 코드 제거, 공용 계약 보존'
type: 'refactor'
ticket: '6'
created: '2026-11-05'
status: 'built'
baseline_revision: 'bd2744df645af4f39ebee501b880861e60063a35'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/garmin-extension-redesign-disposition.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Garmin 확장 갱신이 manifest에서 빠진 옛 기본 예약(garmin.collect 등)을 brain.schedules에서 지우는지 확인되지 않았다.
    evidence: |-
      packages/postgres/src/extensions.ts:103은 extension_work_kinds를 교체하지만 schedules 정리는 찾지 못했다. 옛 Garmin 예약이 있는 설치본을 갱신해 예약 행과 발화 결과를 보면 확정된다. 예약 멱등 키·사용자 변경 보존은 20.3, 이 Mac 설치본 전환·확인은 21.7 범위다.
    location: >-
      packages/core/src/extensions/install.ts:272
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** core가 Garmin을 흡수해 만든 옛 경로(core 건강 계약, 18.1·18.2 core 분석, `garmin.*` 읽기 view, epic 14 importer의 core 건강·분석 쓰기, epic 16 확장 코드)가 남아 있어 "core는 확장을 모른다"(spine 확장 원칙, AD-30·32·35)와 충돌하고 새 Garmin 이식(21.2~)과 헷갈린다.

**Approach:** 코드·시험·등록부·test-changed 규칙에서 옛 경로를 지우고, core 새 forward migration `0031` 하나와 Garmin 확장 forward migration `0013` 하나로 표·view·함수·권한을 명시적으로 drop한다. 공용 계약(대화 수집, files·FileStore, `file_requests`, 채널 원문 보존·legacy 채널 이력, 확장 설치·스케줄러)은 그대로 두고, 업그레이드 전후 건수·내용 해시 비교 시험으로 증명한다.

## Boundaries & Constraints

**Always:**
- 적용된 migration 파일(core 0001~0030, garmin 0001~0012)은 한 바이트도 바꾸지 않는다(AD-31, 실행기 checksum).
- drop은 객체 이름을 하나씩 적는다. 스키마 통째 drop·무차별 `CASCADE` 금지. `CASCADE`를 쓰는 곳은 시험이 `pg_depend`로 그 dependent가 모두 제거 목록 안임을 확인해야 한다.
- 보존 목록(아래 Design Notes "보존 목록")의 표·열·함수·trigger·권한은 0031/0013 뒤에도 같은 정의·같은 행이다. plpgsql 본문에서 `brain.analyses`를 이름으로 참조하는 공용 함수(`brain.guard_import_attempt`, `brain.reconcile_import_target`)는 drop하지 말고 `create or replace`로 analyses 분기만 뺀다.
- `extension-provision.ts`는 건강·analyses·analysis_artifacts·authority·catalog grant와 그 허용 목록만 빼고, `file_requests`·`file_request_results_public_v1`·채널 요청·legacy 채널(원문 `_raw/_encoding`·`dataset_label` 열 포함) grant는 v31 새 설치에서도 그대로 준다. 지금 legacy 채널 원문·label 열 grant는 `health_observations` 열 존재를 조건으로 걸려 있으므로 조건을 채널 표 자기 열 존재로 바꿔야 한다.
- 시험은 기존 하네스(`tooling/test-db`의 throwaway `brain_test_<random>` DB, 임시 Brain 홈)와 합성 데이터만 쓴다. 실제 하네스 transcript 수집은 `withoutHarnessFolders`로 막는다.
- 반복 검증은 `pnpm test:changed`(+해당 파일 직접 시험)만. 전체 `pnpm test`·`pnpm test:python`은 지휘자가 커밋 직전 순차 1회.
- 유지할 계약을 증명하는 시험은 지우지 않는다. 지우는 시험은 제거 대상 계약만 증명하던 것이어야 하고, 공용 단언이 섞인 시험은 공용 단언을 남기도록 고친다.

**Never:**
- 새 Garmin native 프로그램 이식, 확장 명령·사용자 키·cron·플러그인(20.1~20.4, 21.2~21.7 몫).
- 이 Mac 설치본(schema 27)·운영 DB·다른 작업의 컨테이너(`brain-1810-*` 등)·role·예약 변경, 실자료 삭제.
- `work_items`·`failures`·대화 수집 표의 행 삭제·수정(옛 `health_analysis` 이력 행도 그대로 둔다).
- 전역 스킬 수정, BMAD setup/update, 옛 bmad-loop helper, `--no-verify`, 개인 홈 절대 경로 기록.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 기존 v30 업그레이드 | v30 DB에 합성 대화 수집·files·file_requests(+handoff/result/cleanup)·채널 요청/시도/원문·legacy 채널 이력(원문 열 포함)·합성 건강/분석 행, 확장 role 하나 | 0031 적용 후 보존 표의 건수·정렬 행 해시가 전과 같고 제거 객체는 `to_regclass/to_regprocedure`가 null | 실패 시 migration 트랜잭션이 롤백되어 v30 그대로 |
| 새 설치 | 빈 DB | core 0001~0031이 끝까지 적용, `CORE_SCHEMA_VERSION`=31, Garmin 확장 설치 시 0001~0013 적용 | — |
| 업그레이드 뒤 provision | v31, 기존·새 확장 role | file/channel/legacy 원문 열 INSERT grant 존재, 건강·analyses grant·허용 목록 없음, 초과 권한 검사 통과 | 초과 권한이면 기존처럼 거부 |
| 업그레이드 뒤 공용 동작 | v31 | 확장 role의 `file_requests` INSERT·attempt fence·재조정(중복 같은 행 무시, 다른 행 충돌)·legacy 채널 INSERT가 v30과 같이 동작 | 오래된 attempt는 `BRS01`로 거부 |
| Garmin 확장 갱신 | garmin 0012까지 설치된 DB | 0013이 core 노출 view·epic 16 전용 표를 drop하고 epic 14 보존 표의 행은 그대로 | — |

</intent-contract>

## Code Map

core 제거 대상(참조 근거는 baseline에서 `git grep`):
- `packages/postgres/migrations/0022~0030` -- 읽기 전용 근거. 건강: `health_observations`·`health_current_v1`(0022), `health_catalog_v1`·`health_supported_versions`·`health_authority_rules`·`validate_health_observation`·`health_resolution_v1`·`health_aggregate_v1`(0023), authority 정책·trigger(0024), `reconcile_import_authority`·`health_storage_identity`(0025), `health_json_comparison`·`health_text_comparison`(0026). 분석: `analyses`(0022, 열 0027·0029), `analysis_artifacts`·`reconcile_analysis_artifact`·`guard_analysis_dataset`(0027), `analysis_snapshots`·`analysis_files`(0029), `analysis_snapshots_inputs_unique`(0030).
- `packages/postgres/src/migrate.ts:7` -- `CORE_SCHEMA_VERSION` 30→31.
- `packages/postgres/src/{analyses.ts,analysis-inputs.ts,imports.ts}` -- core 분석 store·18.2 reader(`garmin.*` JOIN)·importer core 쓰기/읽기(`readHealth`·`readAnalyses`). 남은 공용 메서드가 있으면 그것만 남긴다.
- `packages/postgres/src/extension-provision.ts:32~50,79~102` -- grant·허용 목록 정리(Boundaries 참조).
- `packages/core/src/analysis/**`, `packages/core/src/ports/analysis.ts`, `packages/core/src/ports/import-store.ts`(건강·분석 부분), `packages/core/src/domain/health.ts`(건강 계약일 때; DB 상태 점검 `HealthStore`/`StoreHealth`는 무관하므로 유지), `packages/core/src/domain/work-item.ts:164`(`health_analysis`), `packages/core/src/index.ts:306~310`, `packages/core/resources/health-analysis/**`, `packages/core/schemas/health/**`, `packages/core/schemas/imports/**`·`extensions/v1/README.md`의 건강 부분.
- `apps/cli/src/workers/health-analysis.ts`, `apps/cli/src/daemon/supervisor.ts:28~29,106~112`, `apps/cli/src/runtime/import-verification.ts`, `apps/cli/src/runtime/model-codex.ts`(남은 소비자가 없을 때만) -- 18.1 worker·launch·core 반입 검증 runtime.
- 시험: `apps/cli/test/{health-analysis-tracer,health-analysis-fixture,import-verification,model-codex}.test.ts` 등 제거 계약 전용, `apps/cli/python-test/analysis-input-snapshot.test.ts`, `packages/postgres/test/{analyses,health-contract}.test.ts`; 공용 단언이 섞인 `import-contracts`·`extension-permissions`·`migrate`·`schema`·`import-*`·`followup-results` 시험은 건강·분석 단언만 빼고 남긴다. `migrate.test.ts`의 applied 목록·`to: 30`은 31로.
- `tooling/test-changed/rules.mjs` (`analysisTracer`·`analysisInput` 분류)와 그 소비자 `tooling/test-changed/run.mjs`·시험 -- 제거. 새 실행 경로가 생기면 규칙 추가.
- README·코드 표(`readme-codes.test.ts`가 대조) -- 지운 오류 코드·명령 정리.

Garmin 확장(`extensions/garmin`):
- epic 16 모듈 제거: `auth, garmin_session, collect*, normalize*, digest, labels(+labels/), garmin_dates, body, body_runtime, charts, artifact_inputs, runtime_artifacts, runtime_files, collect_notice`, `scripts/legacy_normalize_oracle.py`, 해당 `tests/check_*`·fixture, `apps/cli/python-test/garmin-{auth,collect,collect-resume,collect-notice,normalize,body-digest,charts,pass2,history-start,review-boundaries}.test.ts`(각 파일이 epic 16 전용인지 확인 후).
- epic 14 보존·수정: `capture_manifest, contract, reader, raw_codec, metadata_codec, preflight, import_preflight, import, batch_import, import_verify, verify_source, verify_compare, artifacts, reports, role_probe, check` -- capture·읽기 전용 reader·hash·checkpoint·`preserved_rows`·raw_payloads·file_requests 발행·legacy 채널 이력 반입·verify 틀은 남기고, `health_observations`·`health_catalog_v1`·`health_authority_rules`·`brain.analyses`·`analysis_artifacts` 쓰기·읽기·비교만 뺀다. `health.py`·`analyses.py`·`analysis_codec.py`·`tracer_import.py`는 남는 소비자가 없으면 제거.
- `extensions/garmin/manifest.json` -- epic 16 일감·예약·설정·인증 단계 제거, 남은 import 일감의 public_report는 실제 출력과 맞춘다. 확장 갱신 경로가 version을 요구하면 version을 올린다.
- `extensions/garmin/migrations/0013_*.sql`(새) -- Design Notes 참조.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0031_remove_core_garmin.sql` -- 제거 목록 객체를 의존 역순으로 명시 drop, `guard_import_attempt`·`reconcile_import_target` create or replace(analyses 분기 제거, file_requests 동작 동일) -- AD-32·35
- [x] `packages/postgres/src/*`, `packages/core/**`, `apps/cli/src/**` -- Code Map의 core 제거·정리, 빌드·타입 통과 -- E20-5
- [x] `packages/postgres/src/extension-provision.ts` -- grant 정리, legacy 채널 열 grant 조건 교체 -- 공용 grant 보존
- [x] `extensions/garmin/**` -- epic 16 제거, epic 14 core 쓰기 제거, manifest 정리, `0013` 작성 -- AD-30
- [x] `extensions/garmin/fixtures/legacy/`(새) -- `apps/cli/test/fixtures/legacy-report-input-oracle.py`·`analysis-input-fixture.json`(18.2 oracle), 남은 소비자가 없으면 `fake-codex.mjs`(18.1), 21.3이 쓸 epic 16 정규화 oracle/fixture를 `git mv`로 옮기고 README에 출처 commit·용도(21.2~21.4 회귀 기준, 현재 어떤 시험도 실행하지 않음)를 적는다 -- 21.2~21.4 재사용
- [x] `packages/postgres/test/core-garmin-cleanup.test.ts`(새) -- I/O Matrix 1·3·4행: v30까지 적용(0001~0030만 담은 임시 core 폴더) → 합성 seed → 보존 표별 `count(*)`·`md5(string_agg(row_to_json(t)::text, ',' order by <pk>))` 수집 → 0031 → 같은 값 비교, 제거 객체 부재, 공용 trigger·fence·재조정 동작, provision grant 확인 -- 수락 증거
- [x] 기존 시험 정리(Code Map), `apps/cli/python-test/garmin-upgrade.test.ts` 또는 남은 Garmin 통합 시험에 garmin 0012→0013 업그레이드·새 설치 0001~0013 적용과 epic 14 보존 표 행 유지 단언 -- I/O Matrix 2·5행
- [x] `tooling/test-changed/rules.mjs`·`run.mjs`·그 시험 -- 지운 분류 제거, 새 경로 규칙 점검
- [x] 이 계획 `## Implementation Notes` -- 지운/남긴 파일·객체 목록, 판단 근거, 옮긴 fixture 위치 기록

**Acceptance Criteria:**
- Given baseline 이후 변경, when 아래 Verification의 삭제 검색을 돌리면, then 허용 위치(보존 migration 0001~0030·garmin 0001~0012, 새 `0031`·`0013`, `core-garmin-cleanup` 시험, `extensions/garmin/fixtures/legacy/`, 문서) 밖에서 8개 이름이 0건이다.
- Given v30 합성 DB, when core가 31로 업그레이드되면, then 대화 수집 표·files·file_requests 계열·채널 요청/시도/원문·legacy 채널 이력의 건수와 행 해시가 전후 동일하고 제거 객체는 없다.
- Given 빈 DB, when 새 설치와 Garmin 확장 설치를 하면, then core 31·garmin 13까지 오류 없이 적용된다.
- Given v31, when 확장을 provision하면, then file/channel/legacy 원문 열 grant는 있고 건강·analyses grant는 없다.
- Given 정리 완료, when `pnpm test`·`pnpm test:python`을 순차 실행하면, then 둘 다 통과한다.

## Implementation Notes

- 구현 미완료: 0031과 provision 변경 초안은 검증 전이므로 실행 경로 밖 `.brain-automation/drafts/`에만 보관했다. legacy 채널 원문·label grant가 건강 표 열 존재에 조건부인 것을 확인했고, 각 채널 표의 열 존재에 연결해야 한다. 적용된 migration과 기존 코드는 보존했다. 삭제·fixture 이동·시험 수정은 아직 하지 않았다.
- 삭제 검색은 259행이며 결과는 `.brain-automation/reports/impl-1-search.txt`에 보관했다. `pg_depend` 실측 및 upgrade 보존 검증은 아직 수행하지 못했다.

- 후속 core 구현: 0031은 건강 view·표·검증/비교 함수와 분석 표·함수를 명시적으로 역순 삭제하고 공용 `guard_import_attempt`, `reconcile_import_target`은 파일 요청 분기만 남겨 교체한다. `original_utf8`, 채널 reconciliation, 파일 cleanup·locator fence·RLS·원문 grant는 유지한다. schema version은 31이다.
- throwaway v30 DB에서 `pg_depend`와 `pg_get_functiondef`를 조회했다. `analysis_files`/`analysis_artifacts`의 FK가 `analyses`를, `analyses`가 `analysis_snapshots`를 참조하고 건강 view의 규칙이 건강 표와 권위 표를 참조한다. 함수 본문 조회에서는 건강·분석 참조가 `reconcile_import_authority`, `health_aggregate_v1`, `validate_health_observation`, `reconcile_import_target`, 비교 함수 및 `reconcile_analysis_artifact`에 있었다. `guard_import_attempt`는 table 이름 조건으로 분석을 분기하므로 이름 문자열도 별도로 확인했다. 전체 결과는 로컬 `.brain-automation/reports/core-dependency-data.json`이다.
- 제거한 core 경로는 `analysis/`, 분석/건강 port·domain, Postgres 분석 store·입력 reader, 건강/분석/raw import reader, health worker·model runtime·import-verification runtime, 전용 자원·시험·오류 코드·설정이다. 파일 반입·채널 및 StoreHealth는 보존했다. manifest가 이전 `verification_snapshot`을 요구하면 누락된 snapshot으로 실행하지 않고 설정 오류로 거부한다. Garmin 후속 작업에서 새 verify 흐름을 연결해야 한다.
- `extensions/garmin/fixtures/legacy/`에 18.1 fake Codex와 18.2 입력 oracle·fixture를 이동하고 출처와 비실행 용도를 기록했다. 기존 분석 전용 시험만 삭제하고 혼합 `import-contracts`·`extension-permissions`에서 파일·채널·권한 단언은 유지했다. 옛 migration 자체를 검증하던 건강·분석 전용 upgrade 시험 3개는 허용 위치 `core-garmin-cleanup.test.ts`로 옮겨 해당 과거 버전까지만 적용해 계속 검증한다.
- v30 합성 업그레이드 시험은 모든 보존 표의 행 수·기본키 순서 JSON 해시와 파일/채널 trigger·정책·공용 함수 정의를 비교하고 기존 및 신규 역할 grant, 파일 요청 재조정·충돌·오래된 시도, legacy 원문 INSERT, 제거 객체 부재를 확인한다. 기존 `health_analysis` 이력 행도 보존한다. supervisor는 등록된 launch와 protected launch 종류만 claim하므로 제거된 kind의 이력은 claim하지 않는다.
- 삭제 검색의 core 경로 잔여는 0건이다. Garmin 확장과 그 Python 시험의 147행은 다음 Task 범위이며 전체 결과는 `.brain-automation/reports/impl-2-search.txt`에 보관했다.

- `pnpm test:changed` Python 단계는 공용 시험 컨테이너의 기존 `brain_ext_garmin` 역할이 다른 `brain_test_*` DB를 가리켜 설치 role 단계에서 실패했다(51개 실패). 역할·DB 소유권이 불명확해 변경하지 않았으며 다음 단계에서 시험 환경 복구 후 Garmin 검증을 다시 해야 한다.

- Garmin 후속 작업 중간 결과: 전용 DB에서 이전 설치의 역할 준비는 통과했고 옛 `check_health_contract.py`가 삭제된 catalog를 읽어 실패했다(1개 실패, 5개 선택 제외). 공용 DB의 역할은 변경하지 않았다. 전용 DB에서 동시에 실행한 시험이 만든 역할 충돌은 활성 연결 부재를 확인한 뒤 해당 전용 역할·DB만 정리했다.
- 0013은 core-facing 네 view와 brain_app schema usage, epic 16 수집·정규화·body 표 및 건강 provenance 두 표를 이름별로 삭제한다. dataset·batch·raw·mapping·checkpoint·preserved·legacy conversation·artifact/input/relation 장부와 attempt 함수는 보존한다. v12→13 합성 업그레이드에서 보존 표 건수·해시와 새 설치를 확인했다.
- 수집·인증·정규화·body·차트 모듈과 전용 Python 시험을 제거했고 정규화 oracle과 입력·기대 fixture는 `extensions/garmin/fixtures/legacy/`에 보관했다. 18.1·18.2 fixture와 함께 현재 시험에서 실행하지 않는다. `artifact_publish.py`는 파일 요청과 inventory를 유지하면서 core 분석 행·관계 쓰기를 제거한다. v12 inventory에 남은 분석 식별자는 보존만 한다.
- core 검증 snapshot이 없으므로 Garmin verify는 자기 schema의 보존 행·원문·checkpoint·mapping·inventory 및 공용 파일 요청 결과 view만 읽는다. core legacy 행과 파일 실제 바이트는 확장 역할이 읽을 수 없어 직접 검증하지 않으며 private report에 그 범위를 명시한다. 기존 검증의 공용 단언은 아래 지휘자 결정에 따라 core 시험으로 보존한다. 변경된 반입 fingerprint는 importer version 3으로 명시하며 옛 checkpoint를 임의로 같은 입력으로 인정하지 않고 충돌 처리한다.

- 지휘자 결정(2026-11-05): 축소 verify가 의도이며 core 검증 snapshot runtime은 다시 만들지 않는다. 확장 권한으로 원본과 `garmin.preserved_rows`·`raw_payloads`·checkpoint 및 `file_request_results_public_v1`의 상태/file_id를 비교한다. 완전한 반입 검증은 21.2가 새 반입 일감에서 다시 세운다. 공용 파일 크기·SHA-256 불일치 거부는 `apps/cli/test/import-staging.test.ts`의 `크기/해시 불일치면 FileStore에 쓰지 않는다`, legacy 원문·label grant 및 중복 동일/상이/오래된 시도 재조정은 `packages/postgres/test/core-garmin-cleanup.test.ts`에서 검증하며 `apps/cli/test/channels-legacy.test.ts`는 공용 조회를 확인한다. 세 파일 직접 실행 10개 시험 통과.

- 축소 verify의 수정된 시험은 원본 변경·symlink 교체, 보존값·mapping·raw·checkpoint·공개 파일 결과 변조를 확인한다. 옛 `garmin-tracer` 테스트의 파일 key 충돌 및 원문 codec 계약은 새 codec·locator 시험과 `garmin-artifacts.test.ts`의 파일 등록·hash·재실행 시험으로 보존했다. 과거 단언의 검토 사본은 로컬 `.brain-automation/drafts/`에 남겼다. `garmin-import-verify.test.ts`는 위 공용 core 시험으로 옮긴 검증을 제외하고 축소 경로를 검증한다.
- 삭제 검색은 `apps/cli/python-test/garmin-upgrade.test.ts`의 `raw_records`·`raw_records_v2` 부재 단언 두 줄만 남는다. 이는 0012→0013과 신규 설치에서 view 제거를 증명하므로 유지한다. 새 Python 경로는 기존 `extensions/` test-changed 규칙이 포함한다.

- 최종 전용 DB 직렬 `pnpm test:changed`는 기본 단계 3,169개 통과·1개 실패다. 기존 채널 재시작 시험의 청구 token 해제 대기가 실패했고 해당 시험 단독 재실행은 통과했으나 전체 검증은 미완료다. Garmin 직접 시험 22개와 이후 verify 3개, 공용 core 계약 10개는 통과했다.

- 리뷰 수정: 축소 verify는 core 실제 파일·legacy 채널 행 비교만 제외하며 확장 소유 계약은 유지한다. capture artifact·evaluation에서 file mapping을 기대하고 공개 완료/file_id를 확인하며, legacy mapping·conversation, artifact/input inventory·관계와 metadata 원문, artifact 원본 해시를 대조한다. mapping 누락·발행 전 중단·동일 크기 원본 변경·schema columns/keys 변조 등 통합 시험을 보강했다.
- 제거된 `verification_snapshot` 선언은 manifest codec과 JSON Schema가 설치 단계에서 거부하며 supervisor의 실행 시점 거부 분기는 삭제했다. v30→31 시험은 transcript·attachment·FileStore 위치·대화 chunk·extraction·failure 등 실제 행을 seed하고 필수 표의 비어 있음을 금지하며 나머지 빈 표는 명시적으로 예외 처리한다. 제거 계약 자체만 검증하던 v22→23·v25→26·v28→29 세 시험을 삭제하고 파일·채널 공용 단언은 v30→31 시험에 유지했다.
- Garmin 0012→0013 시험은 mapping·checkpoint·conflict·schema·legacy conversation 및 원문 metadata와 비어 있지 않은 artifact/input/relation inventory를 추가해 각 보존 표가 한 행 이상임을 확인한다. Python cache ignore 규칙을 추가했고 기존 추적 `.pyc`는 변경하지 않았다.
- 해당 파일 직접 시험: core migration/manifest 2개 파일 80개 통과, Garmin verify/artifact/upgrade 3개 파일 15개 통과, 관계 호환성 보강 뒤 verify/artifact 재실행 2개 파일 13개 통과, supervisor 1개 파일 5개 통과. 중간 재실행에서 공용 출력의 UUID 마스킹으로 경로를 찾지 못한 1건은 단독 재시험 및 두 파일 재실행에서 통과했다. 지휘자의 지시대로 전체 시험은 실행하지 않았다.

- 2차 리뷰 수정: legacy 기대 키를 notification·delivery로 제한하고 현재 배치의 중복 target 및 추가 mapping을 검출한다. raw payload는 원래 인코딩과 바이트까지 비교하며, 추가 source schema와 부모가 없어야 할 행의 run_id도 검출한다. 예상 밖 artifact_file mapping, 이들 변조, v12의 non-null analysis_id와 기존 relation 재사용 및 새 역할의 파일·채널 INSERT 권한을 관련 통합 시험으로 확인했다.
- 검증: 대상 core 1개 시험, Garmin 2개 파일 13개 시험 통과. 첫 Garmin 실행은 비교 함수 이름이 지역 변수에 가려져 3개 실패했고 이름 수정 후 재실행에서 모두 통과했다. 기존 추적 Python 캐시 파일은 작업 시작 시점에 변경 상태여서 건드리지 않았다.


- 리뷰 수정 추가 검증: artifact_file 중복 대상 및 현재 배치의 예상 밖 매핑도 실패 처리하고 중복 변조 시험을 추가했다. 최종 관련 Garmin 2개 파일 13개 시험과 중복 사례를 포함한 verify 1개 파일 3개 시험이 통과했다.

## Plan Change Log

## Review Triage Log

### 2026-11-05 — Review pass
- verdicts: 18 findings — high 0, medium 14, low 3, false 0, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind 1) verify 기대 파일 집합이 현재 `artifact_file` mapping에서 만들어져 mapping 삭제가 통과 — G1(확장 소유 verify 과축소). baseline `verify_compare.py`의 확장 소유 검사 복원을 fix-1로 지시.
  - `[medium]` `[patch]` (blind 2) legacy mapping·`legacy_conversations` 대조 없음 — G1. fix-1.
  - `[medium]` `[patch]` (blind 3) artifact/input inventory·relation 미대조 — G1. fix-1.
  - `[low]` `[reject]` (blind 4) importer VERSION 3이 옛 checkpoint를 `checkpoint_mismatch`로 막음 — 변환 계약이 바뀌어 옛 checkpoint를 완료로 신뢰하지 않는 것은 의도된 큰 소리 실패이고, 운영 DB에 Garmin 반입 checkpoint가 없다(14.8 blocked, 처분표 전제). 반입기는 21.2가 대체한다.
  - `[medium]` `[patch]` (blind 5) manifest decoder는 `verification_snapshot`을 허용하고 supervisor만 실행 시 거부 — G2. decoder 단계 거부·시험을 fix-1로 지시.
  - `[medium]` `[patch]` (blind 6) `__pycache__/*.pyc`가 diff에 포함 — 지휘자의 `git add -N .`이 만든 index 항목. 지휘자가 index에서 빼고 추적된 baseline pyc를 복원, `.gitignore` 규칙 추가를 fix-1로 지시.
  - `[low]` `[reject]` (blind 7) 0031 실패 시 롤백 시험 없음 — 파일별 트랜잭션은 이 diff가 바꾸지 않은 공통 실행기(AD-31) 동작이고 0031에 특수 경로가 없다. 별도 guard·시험 추가는 복잡도 대비 이득이 낮다.
  - `[medium]` `[patch]` (blind 8) core v30 seed에 failures·첨부·파일 위치·chunk 행이 없어 빈 표 비교 — G4. 행 seed와 비어 있지 않음 단언을 fix-1로 지시.
  - `[medium]` `[patch]` (blind 9) garmin v12 seed가 4개 표에만 있음 — G5. fix-1.
  - `[maybe-false]` `[defer]` (blind 10) 확장 갱신이 manifest에서 빠진 Garmin 예약(`garmin.collect` 등)을 지우지 않을 수 있음 — `packages/postgres/src/extensions.ts:103`은 work kind를 교체하지만 `brain.schedules` 정리는 확인하지 못함. 예약 회계·멱등 키 재설계는 20.3, 이 Mac 설치본 전환은 21.7 범위. deferred에 기록.
  - `[medium]` `[patch]` (edge 1) publish 전 중단 capture가 `files=true` — G1. fix-1.
  - `[medium]` `[patch]` (edge 2) 같은 크기 artifact 바이트 변조가 `source_unchanged=true` — baseline verify는 `artifacts.read_relative`로 다시 읽어 해시했다. G1. fix-1.
  - `[medium]` `[patch]` (vgap 1) `source_schemas` 열·키 변조 시험 없음 — 시험 추가를 fix-1로 지시.
  - `[medium]` `[patch]` (vgap 2) `verification_snapshot` 거부 분기 실행 시험 없음 — G2. fix-1.
  - `[medium]` `[patch]` (vgap 3) garmin v12 artifact 장부 비어 있음 — G5. fix-1.
  - `[low]` `[reject]` (intent 1) 확장 verify가 FileStore 실제 바이트·core legacy 행 내용을 더 이상 대조하지 않음 — 지휘자 결정(2026-11-05): 티켓이 core import-verification runtime·readVerification 제거를 명시하고 확장 role에는 그 표 SELECT 권한이 없다. 공용 계약은 `apps/cli/test/import-staging.test.ts`(hash·size 불일치 거부), `apps/cli/test/channels-legacy.test.ts`, `core-garmin-cleanup.test.ts`가 증명한다.
  - `[medium]` `[patch]` (intent 2) inventory 변조 기대가 실패→성공으로 바뀜 — G1. baseline 기대 복원을 fix-1로 지시.
  - `[medium]` `[patch]` (intent 3) `core-garmin-cleanup.test.ts`의 v22→23·v25→26·v28→29 시험이 제거된 계약 자체를 실행(정리 검증 예외 밖) — 삭제를 fix-1로 지시.

### 2026-11-05 — Review pass (후속 2차)
- verdicts: 16 findings — high 0, medium 4, low 11, false 1, maybe-false 0 (carried 5 포함)
- findings:
  - `[medium]` `[patch]` (edge 1) 서로 다른 notification 두 행의 legacy `target_id` 중복이 통과 — G-L(legacy 기대 집합 미대조). fix-2로 legacy 기대 집합·중복 검사 지시.
  - `[medium]` `[patch]` (vgap 1) 원본에 없는 `artifact_file` mapping 추가 사례 시험 없음 — fix-2로 시험 추가.
  - `[medium]` `[patch]` (vgap 2) v12 non-null `analysis_id` artifact 장부 재사용 시험 없음 — fix-2로 시험 추가.
  - `[low]` `[reject]` (blind 1) files 검사가 file_id 내용·바이트를 입증하지 않음 — carried: 1차 intent 1과 같은 지휘자 결정(core 쪽 비교 제외).
  - `[low]` `[reject]` (blind 2) legacy 검사가 core `channel_legacy_*` 행을 읽지 않음 — carried: 1차 intent 1.
  - `[medium]` `[patch]` (blind 3) raw_payloads 원문을 논리 문자열로만 비교(`SQLiteText`는 `str` 상속) — 같은 문자열의 다른 encoding 변조 통과. fix-2로 바이트·encoding 비교 지시.
  - `[low]` `[reject]` (blind 4) `raw_identity is null`인 옛 tracer raw 행을 verifier가 거부 — 정상 재사용에서 verify가 실패하는 큰 소리 실패이며 운영 DB에 Garmin raw 행이 없다(처분표 전제). 반입·검증기는 21.2가 다시 세운다.
  - `[low]` `[patch]` (blind 5) notification·delivery가 아닌 키의 예상 밖 legacy mapping 통과 — G-L. fix-2.
  - `[low]` `[patch]` (blind 6) 원본에 없는 표의 `source_schemas` 행 미검사 — 직접 수정이 작아 fix-2로 지시.
  - `[low]` `[patch]` (blind 7) NULL이어야 할 `preserved_rows.run_id` parent 변조 미검사 — fix-2.
  - `[low]` `[reject]` (blind 8) v2 checkpoint 재개 불가 — carried: 1차 blind 4.
  - `[low]` `[patch]` (blind 9) 신규 역할의 deliveries 원문·label 및 일반 file/channel INSERT grant 단언 부족 — fix-2로 `has_column_privilege` 단언 추가.
  - `[low]` `[reject]` (blind 10) 0031 실패 시 롤백 시험 없음 — carried: 1차 blind 7.
  - `[low]` `[reject]` (intent A) core 업그레이드 시험은 SQL 행 비교이며 FileStore blob 디스크 바이트는 다루지 않음 — 이 diff는 FileStore·blob 경로를 바꾸지 않았고, 실제 파일 바이트는 `garmin-artifacts.test.ts`가 다룬다.
  - `[low]` `[reject]` (intent B) import-verify 감사 범위 축소 — carried: 1차 intent 1.
  - `[false]` `[reject]` (intent C) 옛 `health_analysis` work 행 보존 — 계획 Never("work_items 행 삭제·수정 금지")가 요구한 동작이며, 미등록 kind 행은 claim되지 않는다(Implementation Notes).

## Design Notes

**보존 목록(0031이 손대지 않음, 시험이 비교):** 대화 수집 표 전부(sessions·messages·conversation chunk·transcript/attachment·extractions 등 `packages/postgres/src/{sessions,transcript-files,conversation-index,attachments,extractions}.ts`가 쓰는 표), `files`·FileStore 관련 표, `file_requests`·`file_request_handoffs`·`file_request_results`·`file_request_results_public_v1`·`file_import_cleanup`·`queue_import_cleanup`·`guard_import_locator`·`reject_import_mutation`·`file_requests`의 RLS 정책·trigger·`metadata` 열, `channel_*`(0017~0021)와 legacy 채널 원문·label 열·`reconcile_channel_legacy`, `original_utf8`, `extension_predecessor_results`, `work_attempts.result_summary/previous_result`, `extension_work_kinds.followup_kind`, 확장 registry·예약·설정 표, `work_items`·`failures` 행.

**Garmin 0013:** drop `garmin.raw_records`·`raw_records_v2`·`body_records`·`collect_target_accounts`와 `brain_app`의 `garmin` schema usage·select grant(AD-30: core는 확장 schema를 읽지 않음), epic 16 전용 표(`collect_state, collect_runs, collect_fetch_errors, collect_meta, collect_targets, collect_published, normalize_items, normalize_days, normalize_day_dirty, normalize_day_revisions, authority_v2, body_documents, body_sources, body_measurements, collect_snapshots, collect_snapshot_items, collect_notices`), core 건강 provenance 전용 `import_provenance`·`authority_provenance`(남은 코드가 쓰지 않을 때). 보존: `datasets, import_batches, raw_payloads, import_mapping, source_schemas, preserved_rows, import_checkpoints, import_conflicts, attempt_valid, legacy_conversations, artifact_inventory, input_inventory, artifact_relations`. 근거: 처분표 "epic 14 capture·reader·hash·checkpoint·preserved_rows·verify 틀 수정 재사용", 사용자 "옛 경로를 남기면 헷갈리므로 바로 지운다", 운영 DB에 Garmin 행 없음. 남긴 epic 14 코드가 위 drop 표를 쓰면 drop하지 말고 Notes에 이유를 적는다.

**판단 기록:** `health_analysis` kind는 domain·launcher에서 빼고 기존 `work_items` 이력 행은 남긴다(설치본 schema 27은 0029 이전이라 그 kind 행이 없음; 새 설치에는 생길 수 없음). 미지의 kind 행이 claim되지 않는 현재 동작을 Notes에 확인 기록한다.

## Verification

**Commands (반복):**
- `pnpm build && pnpm typecheck` -- expected: 성공
- `pnpm test:changed` 및 바뀐 시험 파일 직접 실행(`pnpm vitest run <file>`, Python 통합은 `pnpm vitest run --config apps/cli/python-test/vitest.config.ts <file>`) -- expected: 통과
- 삭제 검색: `git grep -nE 'health_observations|health_resolution_v1|health_current_v1|health_aggregate_v1|health_analysis|garmin-daily-analysis|analysis_snapshots|raw_records' -- packages apps extensions tooling ':!packages/postgres/migrations/00[0-2]*' ':!packages/postgres/migrations/0030_*' ':!packages/postgres/migrations/0031_*' ':!extensions/garmin/migrations/' ':!packages/postgres/test/core-garmin-cleanup.test.ts' ':!extensions/garmin/fixtures/legacy/' ':!*.md'` -- expected: 0건(남으면 Notes에 위치별 사유)

**Commands (마무리, 지휘자, 커밋 직전 순차 1회):**
- `pnpm test` -- expected: 통과
- `pnpm test:python` -- expected: 통과

## Auto Run Result

**요약:** 옛 core Garmin 경로(core 건강 계약, 18.1·18.2 core 분석, `garmin.*` 읽기 view, epic 14 importer의 core 건강·분석 쓰기, core 반입 검증 runtime)와 epic 16 확장 코드·시험을 제거했다. core `0031_remove_core_garmin.sql`과 Garmin `0013_remove_legacy_collect.sql`이 객체를 이름별로 drop하고, 공용 `guard_import_attempt`·`reconcile_import_target`는 analyses 분기만 뺀 정의로 교체했다. `CORE_SCHEMA_VERSION`=31. 적용된 migration 파일은 바꾸지 않았다. 대화 수집·files·FileStore·`file_requests`·채널 원문·legacy 채널 이력·확장 설치·스케줄러는 보존했다. Garmin 확장은 epic 14 capture·reader·hash·checkpoint·`preserved_rows`·raw·파일 발행·legacy 채널 반입과 확장 소유 verify만 남긴다.

**바뀐 파일(171개, 추가 426행·삭제 33,375행; 삭제 118·수정 53·신규 6 묶음):**
- `packages/postgres/migrations/0031_remove_core_garmin.sql` — core 건강·분석 객체 drop, 공용 함수 교체
- `extensions/garmin/migrations/0013_remove_legacy_collect.sql` — core 노출 view 4개·`brain_app` usage·epic 16 표·건강 provenance 표 drop
- `packages/postgres/src/extension-provision.ts` — 건강·analyses grant와 허용 목록 제거, legacy 채널 원문·label grant 조건을 채널 표 자기 열로 이전
- `packages/postgres/src/{migrate,imports,store}.ts`, `packages/core/src/**`, `apps/cli/src/daemon/supervisor.ts` — 분석·건강 port·domain·worker·runtime·오류 코드·launch 제거
- `packages/core/src/extensions/manifest.ts`, `packages/core/schemas/extensions/v1/manifest.schema.json` — 제거된 `verification_snapshot` 선언을 설치 단계에서 거부
- `extensions/garmin/{manifest.json,src/*}` — epic 16 모듈·일감·예약·설정·인증 제거, `analyses.py`→`artifact_publish.py`(core 분석 쓰기 제거), 반입·verify 정리
- `extensions/garmin/fixtures/legacy/` — 18.1 fake Codex, 18.2 입력 fixture·oracle, epic 16 정규화·digest·chart oracle·fixture(21.2~21.4 회귀 기준, 현재 시험에서 실행하지 않음)
- `packages/postgres/test/core-garmin-cleanup.test.ts` — v30→31 보존·제거·권한·fence 수락 시험
- `apps/cli/python-test/garmin-*.test.ts`, `packages/*/test/*` — 제거 계약 전용 시험 삭제, 공용 단언 유지, 변조·업그레이드 사례 보강
- `tooling/test-changed/{rules.mjs,rules.d.mts,run.mjs}`와 그 시험 — 분석 tracer·input 분류 제거
- `.gitignore` — Python 캐시 규칙, `README.md`·schema README — 지운 코드·명령 정리

**리뷰:** thorough 4렌즈(blind-hunter, edge-case-hunter, verification-gap, intent-alignment; Codex gpt-6.1-sol/medium) 2회. 1차 18건: patch 14(전부 medium; 묶음 G1 확장 소유 verify 복원, G2 manifest 거부, G4·G5 업그레이드 seed, 옛 건강 시험 삭제, schema 변조 시험, pyc), reject 3(low), defer 1(maybe-false). 2차(후속) 16건: patch 8(medium 4·low 4), reject 7(low, carried 5 포함), false 1. 기각 사유는 각 triage 행에 있다. 보류 1건은 frontmatter `deferred`(확장 갱신 시 manifest에서 빠진 옛 Garmin 예약 정리 미확인 — 20.3·21.7). 리뷰 원문은 로컬 `.brain-automation/review/`.

**후속 리뷰 권고:** `false` — 후속 패스에서 high를 수정하지 않았다(patch: medium 4, low 4). 1차 패스는 medium 2건 이상을 수정해 후속 리뷰를 수행했다.

**검증(티켓 전용 PG 컨테이너 `brain-206-test`, throwaway `brain_test_*` DB, 합성 데이터):**
- `pnpm build && pnpm typecheck` — 통과.
- 삭제 검색(Verification 명령) — 허용 위치 밖 잔여 2줄, 모두 `apps/cli/python-test/garmin-upgrade.test.ts`의 `raw_records` 부재 단언(정리 검증).
- `pnpm test:changed` — fix-1 후 통과(기본 3,167·PostgreSQL 527·Python 32). 그 전 실행들은 매번 다른 시험 1건이 부하성 시간 초과로 실패했고 단독 재실행은 통과했다. fix-2 후: 기본 병렬 1/3167 실패(`packages/postgres/test/store.test.ts` 60초 시간 초과, 무관 파일). `VITEST_MAX_WORKERS=1` 재실행은 기본 3,167 통과, PostgreSQL 단계 1/527 실패(`unavailable.test.ts`의 `readSchemaVersions`가 3초 안에 lock 대기로 관측되지 않음 — 경합형 시험). 이 파일 단독 3회 연속 10/10 통과. Python 단계는 그 실행에서 돌지 않았고, 같은 트리의 직접 실행·`pnpm test:python`이 통과했다.
- Python 통합 직접 실행 — 8파일 32개 통과(여러 번).
- 마무리 전체 회귀(이후 epic 20·21 예외로 티켓별 필수에서 빠졌지만 진행 중이던 실행은 끝냄): `pnpm test:python` 1회 통과(8파일 32개). `pnpm test` 기본 병렬 실행은 1/3898(dispatch, PG 연결 시간 초과), 1/3898(sessions-ingest, 연결 시간 초과), `VITEST_MAX_WORKERS=4` 2/3898(redaction failures 행 수, sessions-ingest 30초), 기본 1+3/3898(ext-install-resume: 정리 hook 60초 초과 뒤 고정 역할 연쇄 충돌), `VITEST_MAX_WORKERS=2` 1/3898(schedules-queue-list 5초)로 실패했다. 실패 파일 단독 재실행은 모두 통과했다. 같은 환경의 baseline `bd2744d` 전체 실행에서도 `commit-unknown` 30초·`ext-install` 연결 시간 초과가 재현됐다(git 의존 실패는 `.git` 없는 export 때문이라 비교에서 뺐다). `VITEST_MAX_WORKERS=1` 전체 실행은 171파일 3,897개 통과·1 skip.

**잔여 위험·운영 조치:**
- 이 Mac 설치본(schema 27)에는 0031·0013을 적용하지 않았다. 적용·확인은 21.7. 설치본에 옛 Garmin 예약이 있으면 갱신 뒤 정리 여부를 21.7에서 확인한다(deferred).
- importer version 3은 옛 v2 checkpoint를 완료로 신뢰하지 않고 `checkpoint_mismatch`로 멈춘다. 운영 DB에 Garmin 반입 checkpoint가 없다는 처분표 전제에 기댄다. 반입기는 21.2가 다시 세운다.
- 확장 verify는 core FileStore 실제 바이트와 core legacy 채널 행을 대조하지 않는다(지휘자 결정). 공용 계약은 core 시험이 증명한다.
- 전체 `pnpm test`의 병렬 실행 불안정(PG 연결·시간 초과)은 baseline에도 있는 환경 문제다. 전체 회귀는 21.6 뒤 중앙 gate에서 다시 수행한다.
- 공용 시험 컨테이너 `second-brain-test-postgres-1`에는 다른 작업이 남긴 `brain_ext_garmin` 역할이 있다. 이 티켓은 건드리지 않았다. 중앙 판단이 필요하다.
