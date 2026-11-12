---
title: 'W3 운동 측정 snapshot과 기간 실행 입력'
type: feature
ticket: ''
created: '2026-11-12'
status: built
baseline_revision: acf8329112bf8c7ead0201fb766eb55885c13a32
route: full
route_source: pinned
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="중앙 Task 및 계약 범위 사전 승인">

## Intent

운동 세트 정보가 일일 입력에만 남고 기간 입력에는 무게·횟수·맨몸·결측 구분이 사라진다. 서로 다른 시점에 DB를 읽으므로 성공 기간을 재사용할 때 실패 기간과 측정 시점이 달라질 수 있다. C1을 코드에서 계산하고 C2의 네 기간 입력을 같은 불변 snapshot에서 만든다. C7에 따라 분석 구조체를 기존 revision에 저장한다.

## Boundaries & Constraints

원본은 `extensions/garmin/**`, 배포 산출물은 `tooling/package-garmin/build.mjs`로 갱신한다. 프로필 생산은 프로필 워커가 담당하며 기간 폴더의 profile.json/profile.md를 소비한다. 분석 출력은 W4, 재시도·실패 메시지 정책은 W5, 그래프는 W6, 에이전트 실행은 W7 소유다. 운영 DB·실 계정·발신을 사용하지 않는다. 개발 중 시험은 실행하지 않고 최종 구현·리뷰 수정 뒤 관련 파일만 지정해 실행한다. 전체 회귀는 중앙 통합 단계에서 실행한다(2026-11-12 최신 사용자 지시).

## I/O & Edge-Case Matrix

| 시나리오 | 입력 | 기대 결과 | 오류 처리 |
|---|---|---|---|
| 혼합 부하 | 양수·-1·0·NULL·잘못된 무게 | weighted/bodyweight/missing/unknown 구분, 부분 볼륨 coverage | 잘못된 수치는 계산 제외 |
| 완료일 귀속 | 자정 넘는 운동과 같은 날 여러 활동 | 완료 현지 날짜에 한 번씩 전부 포함 | 진행 중 활동 제외 |
| 휴식일 | 완료 운동 없음 | 빈 세션, 0 coverage, 임의 수행 없음 | 정상 결과 |
| 기간 비교 | 7d·30d 현재 창 | 비중첩 동길이 비교 창 | 관측 부족 표시 |
| 입력 독립성 | 다른 기간 평가 및 결합 문서 존재 | 같은 scope 과거 next_checks만 전달 | DB 오류 전파 |
| 재개 | 성공 scope 저장 뒤 다른 scope 실패 | 동일 snapshot·프로필 유지, 성공 scope 조회 재사용 | 손상 snapshot은 오류 |
| 재게시 | 저장 snapshot 경로 | C1 로드, 에이전트·DB 재호출 없음 | 버전·scope 검증 |
| 장기 창 | 많은 원본 세트 | 월별 reps·세트·외부볼륨·coverage, 대표 세션 | 부분 관측 명시 |

</frozen-after-approval>

## Code Map

- `src/garmin_pipeline/digest.py`: 원본 시간·세트·심박 처리와 표시명 재사용, 기존 digest 출력 보존.
- `src/garmin_pipeline/report_input.py`: 원본 내보내기·기간 입력·원자 파일 설치 재사용. 같은 읽기 연결에서 네 기간 데이터 고정.
- `src/garmin_pipeline/report.py`: supervised 순차 실행과 저장 hook만 최소 변경.
- `src/garmin_pipeline/store/__init__.py`: append_evaluation 기존 ABI를 유지하며 별도 구조체 API 추가.
- `migrations/`: structured 컬럼을 NULL 허용으로 추가, 구 revision 불변성 유지.

## Tasks & Acceptance

- [x] C1 스키마·합성 fixture·오프라인 로드 API를 먼저 공개한다.
- [x] 측정 생산자에서 canonical key, 세트 시간·부하·횟수, 근력 파생, 심박·유산소, 비교·회복 맥락을 계산한다.
- [x] 단일 읽기 snapshot을 work별 불변 경로로 저장하고 기간 입력을 먼저 준비한다.
- [x] 다른 기간 평가를 없애고 같은 기간의 과거 next_checks와 provenance만 제공한다.
- [x] C7 구조체 저장·같은 snapshot 성공 결과 조회 함수를 구현한다.
- [x] 합성 시험을 추가하고 독립 리뷰를 반영한 뒤 관련 파일 시험을 실행한다.

수락 조건: 네 기간을 만들 때 같은 snapshot_id와 data_cutoff가 전달되고, 재시도에도 값이 바뀌지 않는다. 모든 운동은 완료 현지 날짜에 귀속되고 맨몸을 외부중량 볼륨으로 환산하지 않는다. 저장된 v2 구조체는 원문대로 조회되며 구 revision의 NULL은 보존된다.

## Implementation Notes

- 중앙이 Task·공통 계약 범위 안 계획을 사전 승인했다. 구현은 배정된 워커인 현재 세션이 직접 맡으며 추가 구현 워커를 만들지 않는다.
- [ASSUMPTION] 기구·변형·무게 관례가 원본에 없으면 comparable이라고 추정하지 않고 한계를 기록한다.

- 회복 입력 자체 점검에서 내부 datetime 직렬화 경로를 발견해 공개 측정으로 변환했다. 개인 7일 관측 기준 평균·변화·관측일 수와 수면 시작/끝을 함께 전달한다.

## Plan Change Log

## Review Triage Log

| 지적 | 판정·처리 | 근거 |
|---|---|---|
| R1 기간 요약 창 불일치 | high · patch | C1 창을 먼저 고정한 뒤 DB 회복 요약을 읽고 구 시작일 기반 운동 집계는 입력에서 제거했다. scope와 C1의 창·관측일을 일치시켰다. |
| R2 snapshot 해시 미검증 | high · patch | 필수 파일·전체 SHA256·각 기간 C1 schema와 provenance를 검증하며 손상 시 재생성 없이 실패한다. |
| R3 기존 work mapping provenance 누락 | medium · patch | mapping을 실제 revision과 조인해 같은 snapshot·v2·성공 여부를 검사한다. 구 NULL revision은 이력을 보존하고 명시적 호환 오류로 중단한다. |
| R4 all 관측 중복 | medium · patch | 값이 아니라 관측 인덱스를 선택해 실제 같은 값의 별도 세트는 보존했다. |
| F1 과거 평가 기준일 회귀 | medium · patch | 측정 창 끝과 평가 기준일을 분리하고 `_previous_checks`에 실제 report_date를 전달한다. 최신 과거 revision과 경과일을 날짜 필터 fixture로 확인한다. |
| F2 metadata 누락 로더 우회 | high · patch | 명시 scope 로드는 metadata 존재와 무관하게 snapshot 검증을 실행하며 저장 경로의 기간 폴더 직접 로드도 누락을 오류로 처리한다. standalone fixture는 별도 경로로 유지한다. |


## Verification

개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행했다. 최신 중앙 전달 사용자 지시에 따라 전체 `pnpm test:python`·`pnpm test:changed`는 실행하지 않는다. 이미 실행 중이던 `pnpm test` 결과는 보존하며 범위 밖 실패는 중앙 통합 재검증 대상으로 기록한다. `GARMIN_UNIT_TEST_FILES`로 직접 관련 Python 파일만 지정하고 Garmin report·upgrade·period 분석 Vitest 파일을 명시해 검증한다. 공용 잠금은 해제했다. 독립 리뷰는 지정 Codex 모델 한 명의 정적 검토 두 회이며 실제 지적과 수정은 위 triage에 기록했다.


## 최종 검증 결과

- 관련 Python 8개 파일에서 93개 시험 통과, Garmin upgrade 3개 시험 통과(외부 Vitest 파일 2개·시험 4개, 종료 0).
- 완전한 C3 v2 fixture로 저장 왕복을 보완한 뒤 `test_report_input_pg.py` 7개 재검증 통과(종료 0).
- `packages/postgres/test/install-legacy-manifest.test.ts` 31개 통과(종료 0). 0019 추가에 따른 고정 기대값 누락을 수정했다.
- 최신 지시 전 실행하던 전체 TS 회귀는 종료 1(253개 파일 중 242 통과·11 실패, 5446개 시험 중 5424 통과·22 실패)로 보존했다. 위 기대값 1건은 수정·재검증했고 범위 밖 21건은 중앙 통합 재검증으로 넘긴다.
- 전체 Python·test:changed는 최신 사용자 지시에 따라 실행하지 않았다. 기존 v1 report 통합 묶음은 중앙의 범위 선택으로 종료 130 중단했으며 결과를 통과로 쓰지 않는다.
- 중앙 결정: work→snapshot 규칙은 유지한다. W4 structured 부재 때문에 기존 report 통합 계약은 중앙에서 합친 뒤 검증하며 새 일반 work의 완료 noop 보완은 필요할 때 통합 워커가 담당한다.
