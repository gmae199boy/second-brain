---
title: 'Garmin 분석을 수집과 독립 실행'
type: feature
ticket: ''
created: '2026-11-11'
status: built
baseline_revision: '1e09e106a69e8e647b3033c5a6cf1a3032d3438f'
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

분석 코드의 수집 상태 polling·대기를 제거하고 snapshot은 분석 시작 시점의 저장 DB 자료를 사용한다. 기존 계정 쓰기 락은 유지한다. 실행 시각은 사용자가 예약으로 정하며 수집 11:00·분석 11:30은 신규 설치 기본값으로만 남긴다.

## Boundaries & Constraints

수집 대기 함수·관측 보조 함수·poll 상수와 호출을 제거한다. report/report-regenerate/report-send와 기간 분석 코드에는 수집 상태 polling gate를 두지 않으며 기존 계정 락 대기는 보존한다. report 기본 예약의 after_schedule 연결과 core 기능은 유지한다. 예약 순서·같은 날 수집 성공 조건은 core가 맡고 분석 프로세스 자체에는 수집 gate를 두지 않는다. DB 쓰기 무결성·분석끼리의 중복 실행 방지 락은 보존한다. 기존 사용자 예약과 운영 DB는 수정하지 않는다. 고정 Config 필드는 생성자 호환용 중립값으로만 두며 분석 데이터 창에 사용하지 않는다. core plugin/app-ref와 core plugin version은 유지한다. 구현은 본 워커가 직접 하고 독립 리뷰어 한 명만 사용한다.

## I/O & Edge-Case Matrix

| 경우 | 입력·상태 | 기대 동작 |
|---|---|---|
| 수집 진행·미실행·실패 | 저장 DB에 가용 자료가 있음 | 수집 상태 polling 없이 입력을 생성하며 기존 계정 락 대기·실패 가능 |
| 수집 락 | 장시간 외부 수집 진행 | 기존 최대 60초 계정 락 대기·실패 계약 유지 |
| 사용자 예약 변경 | 임의 분석 실행 시각 | report 코드가 11:30을 강제하지 않음, core 예약 의존은 별도 유지 |
| 재발신 | 저장 평가 존재 | 분석 호출·수집 대기 없이 기존 경로 유지 |

</frozen-after-approval>

## Code Map

- `extensions/garmin/src/garmin_pipeline/report.py`: wait_for_collect 및 전용 관측 함수·상수·seam, legacy run의 호출을 제거한다. 감독 경로와 파일 게시 대기는 보존한다.
- `extensions/garmin/src/report_runtime.py`: 생성자 호환 필드인 collect_time/retry_time/report_time은 time.min, report_wait_minutes는 0으로 둔다.
- `extensions/garmin/src/garmin_pipeline/report_input.py`: 고정 collect_time과 수집 시작 시각이 데이터 창에 미치는 영향을 조사해 승인된 기준으로 교체한다.
- `extensions/garmin/manifest.json`: 설치 기본 cron과 after_schedule을 유지한다.
- `extensions/garmin/tests/test_report_store_pg.py`, `test_supervised_input_contract.py`, `test_report_supervised.py`: 제거된 대기 시험을 수집 상태 polling 부재 수락 시험으로 바꾼다.
- `apps/cli/python-test/garmin-core.test.ts`, `garmin-collect.test.ts`: 기본 예약의 수집 의존 기대값을 유지한 기존 통합 경로를 검증한다.
- `extensions/garmin/README.md`, 분석·운영 스킬: 고정 시각·수집 대기 약속을 제거하고 설치 기본값과 사용자 예약을 구분한다.
- `tooling/package-garmin/build.mjs`: 원본 수정 뒤 manifest·Garmin plugin 버전을 올리고 공식 package를 재생성한다.

## Tasks & Acceptance

- [x] 대기 전용 코드만 제거하고 기본 예약 gate는 유지한다.
- [x] 런타임 호환 필드와 DB 스냅샷 시각 기준을 정리한다.
- [x] 수집 상태 polling 없이 하루·기간 분석 코드가 진행되는 시험과 문서·스킬을 갱신한다.
- [x] package 재생성·컴파일 확인 후 독립 리뷰와 필요한 수정을 수행한다.
- [x] 관련 시험과 전체 pnpm test → pnpm test:python을 순차 실행하고 실패는 test:changed·관련 시험으로 재검증한다.
- [x] 같은 브랜치의 새 커밋·push와 보고서를 작성한다.

Given 수집 상태가 진행·미완료일 때, when snapshot을 생성하면, then 상태는 품질 정보이며 cutoff는 분석 시작 시각이다. 기존 계정 락이 비어 있으면 하루·기간 분석은 상태 polling 없이 진행한다.
Given 사용자 예약이 임의 시각일 때, when 분석 일감이 접수되면, then report 코드가 설치 기본 cron을 실행 조건으로 강제하지 않고 core 예약 의존은 유지한다.
Given 기존 report-send 평가가 있을 때, when 재발신하면, then 수집·분석을 호출하지 않고 기존 멱등 계약을 유지한다.

## Implementation Notes

## Plan Change Log

## Review Triage Log

- 1차 리뷰 medium / patch 1건: 정수 초 반올림이 자정 경계 귀속을 바꾼다. 원본 summaryDTO의 시작·소수 초 길이로 digest와 같은 datetime 완료 시각을 계산하고 cutoff에도 같은 값을 사용하도록 수정했다. 원본이 불완전한 보존 자료는 기존 정수 초 계약을 유지한다. 소수 초 자정 경계 시험을 추가했다.

## Verification

개발 중 build/typecheck/diff --check만 실행한다. 독립 리뷰 후 관련 수락 시험, 이어 전용 시험 cluster에서 전체 pnpm test → pnpm test:python을 순차 1회 실행한다. 실패 수정 후 test:changed와 관련 사례만 재검증한다. 실제 발신·실 건강 데이터·운영 설정은 사용하지 않는다.

- 중앙 승인: cutoff는 분석 시작 시각이다. 운동 창은 직전 현지 날짜 자정부터 대상 날짜 자정까지의 완료 시각 기준 반열림 구간으로 정한다. 연속 창이 겹치거나 벌어지지 않고 자정 넘긴 운동이 미완료로 빠지는 문제를 피하기 위해 시작 시각 대신 완료 시각을 쓴다. 대상 날짜 자료는 진행 중으로 구분한다.
- 추가 사용자 명확화로 manifest after_schedule 제거와 기존 예약 전환 migration은 보류한다. core 파일은 수정하지 않는다.

- 사용자 최종 결정: after_schedule:collect를 유지하며 전환 migration과 Garmin schema 버전 18 변경을 하지 않는다. 확장 role은 brain.schedules UPDATE 권한이 없고 현재 CLI도 after 옵션이 없음을 코드로 확인했다. 기존 설치 ext install은 ensureSchedule이 기존 예약을 그대로 유지하므로 의존 관계도 유지한다. core 파일은 수정하지 않는다.

- 중앙 범위 재확정: store.write_session·쓰기 경로는 변경하지 않는다. 실제 수집 중 즉시 실행은 수락 조건에서 제외하며 상태 polling·대기 함수 부재와 분석 시작 cutoff만 검증한다. 수동 report는 기존 계정 락으로 최대 60초 대기·실패할 수 있다.

- 최종 전체 TS 회귀 5391건 통과. Python 전체 89 통과/1 실패: 보존된 int64 극단 운동 시각의 datetime 변환 회귀였다. 원본 소수 초는 밀리초로 계산하고 불완전 보존 자료는 기존 SQLite int64 overflow→binary64 수치 계약을 그대로 유지하도록 수정했다. native oracle 비교에서 의도적으로 바뀐 manifest 운동 창·목록·안내만 새 계약으로 검증하고 나머지 바이트 비교는 유지한다.

- 최종 검증 완료: 관련 Python 280건·native oracle 사례 통과, 전체 pnpm test 5391건 통과, 전체 Python 최초 89/1 뒤 수정한 test:changed 전체 Python 90/0/0 통과. 기존 설치 after_schedule과 사용자 예약 보존 업그레이드 3건도 통과했다. core·계정 락·migration은 변경하지 않았다.
