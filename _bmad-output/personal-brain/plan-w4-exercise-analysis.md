---
title: 운동 중심 분석 출력
created: '2026-11-12'
status: built
type: feature
baseline_revision: acf8329112bf8c7ead0201fb766eb55885c13a32
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
---

<frozen-after-approval>

## Intent

운동 수행보다 회복 지표가 앞서는 분석 지시와 문자열 중심 출력을 C3 v2로 바꾼다. C1 측정 입력에 근거해 모든 운동을 평가하고 감량 우선의 보수적 다음 행동을 제안한다. 중앙은 자기 명세·공통 계약 범위의 계획을 사전 승인했다.

## Boundaries & Constraints

원본 Garmin 분석 스킬·스키마·출력 검증과 합성 fixture만 구현한다. C7 공통 머리 키를 보존하고 전체 payload를 DailyAnalysis.structured로 W3 저장 경로에 전달한다. 구 출력 schema와 렌더링은 보존한다. 프로필 문장은 프로필 워커 소유이며 기존 전제를 유지한다. 운영 계정·발신·네트워크 분석은 사용하지 않는다. 개발 중 시험은 실행하지 않고 마지막 수정과 독립 리뷰 뒤 전체 회귀를 순차 실행한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 | 결과 | 오류 처리 |
|---|---|---|---|
| 새 분석 | C1 입력과 v2 출력 | 전체 payload와 구조 메시지 보존 | 누락 필드·세 번째 행동 거부 |
| 구 분석 | C1 없는 구 입력과 구 출력 | 기존 DailyAnalysis와 메시지 유지 | 기존 schema 검증 |
| 걷기 | 경사 미기록, 심박 존재 | 심박 기준 평가·경사 미기록 한계 | 경사·체력 향상 역산 금지 |
| 불완전 근력 | 세트나 무게 누락 | 운동 있음과 세트 없음 구별, 부분 볼륨 한계 | 0부하·과훈련 단정 금지 |
| 비교 없음 | 단일 관측·계획/RIR 없음 | 관측 변화와 증량 결정을 분리 | 임의 증량 수치 금지 |

</frozen-after-approval>

## Code Map

- `extensions/garmin/skills/garmin-daily-analysis/SKILL.md`, `garmin-period-review/SKILL.md`: 운동 우선 판단 순서·기간별 역할·걷기 해석·출력 지시.
- `extensions/garmin/src/garmin_pipeline/schemas/`: 기존 일일·기간 schema는 구 저장/입력 호환용으로 보존하고 v2 전용 schema를 추가한다.
- `extensions/garmin/src/garmin_pipeline/report.py`: `_read_output`, `DailyAnalysis`, `CodexWriter._execute`의 최소 변경. 실행 정책과 기간 반복은 다른 워커 소유다.
- `extensions/garmin/tests/`: unittest 자동 발견에 계약 시험을 추가한다. `tooling/test-changed/rules.mjs`의 extensions/ 규칙이 새 경로를 이미 포함한다.
- `plugins/garmin/package/`: 원본 수정 뒤 패키지 생성기로만 재생성한다.

## Tasks & Acceptance

- [x] v2 schema와 day/7d/30d/all 합성 출력 공개, C7 머리 키 반영.
- [x] 두 분석 스킬을 운동 수행→종목별 변화→진행 판단→다음 행동→회복 맥락 순으로 수정.
- [x] v2 결과의 구조와 근거 참조를 검증하고 전체 payload를 보존. 구 입력 호환 유지.
- [x] C1 fixture와 v2 fixture로 계약 시험 작성, 독립 리뷰 반영, 패키지 재생성.

수락 기준:
- C1 입력이 있을 때 새 분석을 읽으면 C7 키와 운동 구조 필드가 보존된다.
- v2에 필수 키 누락·허용되지 않은 이유 코드·세 번째 다음 행동이 있을 때 결과 검증이 실패한다.
- 구 schema 출력이 주어졌을 때 기존 메시지와 문자열 필드가 그대로 읽힌다.
- 걷기와 근력 결측 지시를 읽으면 경사 추정·맨몸 체중 환산·미입력 0kg 환산·심박 기반 근력 점수를 허용하지 않는다.
- 네 기간은 각각 완료 수행·주간 이행·반복 진행·장기 단계 역할을 가지며 그래프 빈도 선택으로 분석 종목을 줄이지 않는다.

## Implementation Notes

- 중앙 요청으로 schema·합성 출력 선행 공개를 두 번 WIP 커밋했다. WIP는 전체 개발 종료 전 계약 공유 목적이며 최종 전체 회귀 gate를 대체하지 않는다.
- [ASSUMPTION] 기존 custom 기간 분석은 네 기간 C7 계약에 포함되지 않으므로 구 schema를 유지한다.

## Review Triage Log

- F1 medium/patch: 유형 집합 검증만으로 동일 유형 세션 누락이 가능했다. 실제 session_id·유형·전체 coverage를 검증하고 반례를 추가했다.
- F2 medium/patch: 미기록 경사 검증을 유형 전체에 적용해 정상 기록 행도 거부했다. activity_refs별로 검사하고 혼합 행은 unrecorded로 표시한다.
- F3 medium/patch: 합성 출력의 경사 한계가 HIIT를 가리켰다. 실제 걷기/트레드밀 행으로 고치고 한계 대상 존재·scope·필요 판단별 연결을 검증한다.
- F4 medium/patch: 구 입력 선택과 스킬 출력 지시가 충돌했다. 두 스킬에 구 schema 분기를 명시하고 writer 프롬프트에 선택한 schema 이름을 전달한다.

- 후속 R1 medium/patch: C1 type=null 활동이 문자열 전용 출력과 충돌했다. activity_type에 null을 허용하고 미상 세션의 성공/잘못된 추정 거부 반례를 추가했다.

- 최종 후속 리뷰: R1 해결, 신규 finding 없음. 독립 리뷰 3회 모두 정적 검사이며 시험·build는 실행하지 않았다.

## Verification

개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`를 사용한다. 최신 중앙 지시(main 75ec75c8)에 따라 개발 완료 뒤 관련 시험 파일만 지정해 실행한다. 이미 실행한 전체 pnpm test는 끝까지 보존하고 무관한 실패는 통합 단계 재검증 대상으로 기록한다. 전체 Python 회귀와 test:changed는 실행하지 않는다. 독립 리뷰어는 Codex gpt-6.1-sol/medium이며 시험·수정·하위 워커를 금지한 읽기 전용 과업을 맡긴다.

검증 완료: 관련 Python 6개 파일 75개 시험 종료 코드 0, apps/cli/python-test/garmin-report.test.ts 17개 시험 종료 코드 0. 기존 전체 pnpm test는 종료 코드 1(5,424 통과/22 실패)이며 무관한 시간·DB·설치·Drive 실패는 최신 중앙 지시에 따라 통합 단계 재검증 대상으로 보고했다.
