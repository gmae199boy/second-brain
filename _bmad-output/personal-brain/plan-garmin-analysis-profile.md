---
title: Garmin 분석 프로필 DB 저장과 항목 수정
type: feature
ticket: ''
created: '2026-11-12'
status: built
baseline_revision: acf8329112bf8c7ead0201fb766eb55885c13a32
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
context: []
---

<frozen-after-approval reason="사용자 Task의 구현 승인">

## Intent

분석 프로필을 사용자 DB 설정 `garmin.analysis_profile`의 버전 1 JSON으로 저장하고 공식 CLI·스킬로 조회·수정한다. DB snapshot을 분석 작업별로 고정하여 일일·기간 분석에 JSON과 Markdown을 제공한다.

## Boundaries & Constraints

모든 개인 항목은 선택이다. 미설정 값을 만들거나 과거 사본을 승격하지 않는다. DB가 원본이며 기존 계정 profile.md는 DB 프로필이 없을 때 읽기만 한다. 운영 checkout과 운영 DB는 변경하지 않는다. 명시한 수정 외의 항목은 보존하고 동시 변경은 충돌로 반환한다. 이미 저장된 평가는 사용자가 재생성을 요청할 때만 새 프로필을 반영한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 | 결과 |
|---|---|---|
| 저장·조회 | 버전 1과 선택 항목 | 검증된 사용자 DB 값 |
| 무효 입력 | 알 수 없는 버전·필드·단위 범위·날짜 | CONFIG_INVALID, 기존 값 보존 |
| 부분 수정 | 항목 set/unset | 다른 항목 보존, 원자 저장 |
| 동시 수정 | 오래된 기준 값 | DB_LOCKED, 덮어쓰기 방지 |
| 분석 | snapshot 뒤 설정 변경·재시도 | 동일 작업 사본과 hash 유지 |
| 없음·일부 없음 | 빈 프로필·일부 항목 | profile_status와 missing_fields 제공 |
| 하위 호환 | DB 없음, 계정 파일 있음 | legacy_file 출처 표시, DB에 쓰지 않음 |

</frozen-after-approval>

## Code Map

- `packages/core/src/settings/index.ts`, `extensions/snapshot.ts`: 설정 검증·확장 정의·snapshot.
- `packages/postgres/src/settings.ts`, `packages/core/src/testing/fakes/store.ts`: 원자 비교 저장.
- `apps/cli/src/commands/config-*.ts`: 공개 설정 CLI와 등록.
- `extensions/garmin/src/report_runtime.py`, `supervised_input.py`, `garmin_pipeline/config.py`: 시작 snapshot을 Config에 전달.
- `extensions/garmin/src/garmin_pipeline/report_input.py`, `period_analysis_runtime.py`: 분석 입력 사본 생성.
- `plugin/skills/brain-config/SKILL.md`, `extensions/garmin/skills/*/SKILL.md`, `plugins/garmin/skills/brain-garmin-operations/SKILL.md`: 설정·결측 정책.

## Tasks & Acceptance

- [x] 프로필 구조 검증과 config patch CLI·비교 저장 구현.
- [x] 작업별 profile.json/profile.md 사본과 결측 상태 구현.
- [x] 배포 스킬·패키지 사본·CLI 커버리지 갱신.
- [x] 저장·검증·원자 수정·사용자 격리·snapshot·하위 호환 시험 작성.
- [x] 독립 리뷰 1명, 수정 후 전체 회귀와 자기 브랜치 push(최종 기록은 운영 보고서).

Given 유효 프로필, when 저장 후 조회, then 지정 필드와 버전이 일치한다.
Given 다른 필드가 있는 프로필, when 항목만 수정, then 다른 필드는 유지된다.
Given 작업 시작 사본, when 모든 기간과 재시도 분석, then 같은 hash와 결측 상태를 받는다.
Given 미설정 항목, when 분석 입력 생성, then 추정 없이 항목별 누락을 제공한다.

## Implementation Notes

최종 관련 실행에서 설치 후 기본값은 insertSetting으로 DB에 저장됨을 확인했다(extensions/install.ts). 새 CLI 시험의 source 기대값을 default에서 db로 정정했으며 제품 동작은 변경하지 않았다. 관련 TS 8파일 453검사는 통과했다.

[ASSUMPTION] 프로필의 문서화된 필드만 허용하고 목록의 빈 배열은 명시적 없음으로 취급한다. 개인 값은 등록하지 않는다. 사용자 Task가 직접 구현과 독립 리뷰를 지정하므로 구현 위임과 대화형 계획 승인 단계는 적용하지 않는다.

## Plan Change Log

최종 정적 확인에서 확장 snapshot 16KiB 한도보다 프로필 원문 한도 24KiB가 컸다. 원문과 문자열 인코딩 기여분을 각각 8KiB로 제한하고 TS·Python 회귀 시험을 추가한다. 첫 전체 회귀의 도움말 한국어 검사 실패는 설명을 한국어로 바꾸어 해결한다.

## Review Triage Log

후속 독립 검토: 최초 2건 해소, 직접 회귀 발견 없음. 최종 회귀 후 snapshot 인코딩 예산 보완도 같은 리뷰어가 추가 확인했고 직접 회귀 발견 없음으로 보고했다.

1. high / patch: daemon·로그인의 원본 manifest 선언은 userOnly 변환을 거치지 않아 전역 프로필이 섞인다. 공통 readScopedSettings에서 프로필 키를 사용자 전용으로 강제하고 원본 선언 회귀 시험을 추가한다.
2. medium / patch: 조회 기반 음주 배열 병합은 함수 내부 CAS만으로 오래된 기준을 탐지할 수 없다. patch의 expected_value 기준 비교와 음주 배열 변경 시 필수 기준값, CLI·core 회귀 시험을 추가한다.

## Verification

개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 2026-11-12 중앙 전달 사용자 지시(통합 전체 회귀만 공용 잠금)에 따라 최종 수정·리뷰 뒤 관련 시험 파일만 명시 실행한다. 이미 끝난 전체 pnpm test 결과는 보존하고 무관한 실패는 통합 재검증 대상으로 기록한다. 전체 Python·test:changed는 실행하지 않는다. 관련 파일은 core 설정·프로필·확장 snapshot, Postgres settings, CLI 도움말·스킬 커버리지·패키지, Garmin 프로필 CLI·보고 입력과 지정 Python 계약이다.
