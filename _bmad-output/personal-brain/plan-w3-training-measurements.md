---
title: 'W3 운동 측정 snapshot과 기간 실행 입력'
type: feature
ticket: ''
created: '2026-11-12'
status: in-progress
baseline_revision: acf8329112bf8c7ead0201fb766eb55885c13a32
route: full
route_source: pinned
risk: high
review: quick
review_source: pinned
context: []
---

<frozen-after-approval reason="중앙 Task 및 계약 범위 사전 승인">

## Intent

운동 세트 정보가 일일 입력에만 남고 기간 입력에는 무게·횟수·맨몸·결측 구분이 사라진다. 서로 다른 시점에 DB를 읽으므로 성공 기간을 재사용할 때 실패 기간과 측정 시점이 달라질 수 있다. C1을 코드에서 계산하고 C2의 네 기간 입력을 같은 불변 snapshot에서 만든다. C7에 따라 분석 구조체를 기존 revision에 저장한다.

## Boundaries & Constraints

원본은 `extensions/garmin/**`, 배포 산출물은 `tooling/package-garmin/build.mjs`로 갱신한다. 프로필 생산은 프로필 워커가 담당하며 기간 폴더의 profile.json/profile.md를 소비한다. 분석 출력은 W4, 재시도·실패 메시지 정책은 W5, 그래프는 W6, 에이전트 실행은 W7 소유다. 운영 DB·실 계정·발신을 사용하지 않는다. 개발 중 시험은 실행하지 않고 최종 구현·리뷰 수정 뒤 전체 회귀를 순차 실행한다.

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

- [ ] C1 스키마·합성 fixture·오프라인 로드 API를 먼저 공개한다.
- [ ] 측정 생산자에서 canonical key, 세트 시간·부하·횟수, 근력 파생, 심박·유산소, 비교·회복 맥락을 계산한다.
- [ ] 단일 읽기 snapshot을 work별 불변 경로로 저장하고 기간 입력을 먼저 준비한다.
- [ ] 다른 기간 평가를 없애고 같은 기간의 과거 next_checks와 provenance만 제공한다.
- [ ] C7 구조체 저장·같은 snapshot 성공 결과 조회 함수를 구현한다.
- [ ] 합성 시험을 추가하고 독립 리뷰를 반영한 뒤 전체 회귀를 실행한다.

수락 조건: 네 기간을 만들 때 같은 snapshot_id와 data_cutoff가 전달되고, 재시도에도 값이 바뀌지 않는다. 모든 운동은 완료 현지 날짜에 귀속되고 맨몸을 외부중량 볼륨으로 환산하지 않는다. 저장된 v2 구조체는 원문대로 조회되며 구 revision의 NULL은 보존된다.

## Implementation Notes

- 중앙이 Task·공통 계약 범위 안 계획을 사전 승인했다. 구현은 배정된 워커인 현재 세션이 직접 맡으며 추가 구현 워커를 만들지 않는다.
- [ASSUMPTION] 기구·변형·무게 관례가 원본에 없으면 comparable이라고 추정하지 않고 한계를 기록한다.

## Plan Change Log

## Review Triage Log

## Verification

개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 최종 수정 이후 `pnpm test` 다음 `pnpm test:python`을 순차 한 번 실행하며 실패를 수정한 뒤 관련 재검증만 한다. 독립 리뷰는 지정 Codex 모델 한 명이며 결과를 이 계획과 최종 보고에 기록한다.
