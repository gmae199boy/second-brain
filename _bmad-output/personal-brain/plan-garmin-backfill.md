---
title: Garmin 누락 자료 백필과 backlog 표시
type: feature
created: 2026-11-12
status: built
baseline_revision: acf8329112bf8c7ead0201fb766eb55885c13a32
route: full
route_source: pinned
risk: high
review: quick
review_source: pinned
---

<frozen-after-approval reason="배정 Task가 구현·검증·리뷰를 승인한 범위">

## Intent

미완료 날짜 전체의 비어 있는 항목만 받는 재개 가능한 manual backfill을 제공한다. 실행 성공과 전체 backlog 완료를 구별하고 정기 수집에서 오래된 누락이 굶지 않게 한다.

## Boundaries & Constraints

기존 세션 잠금·토큰 증거·호출 간격·403/429 중단 보호를 그대로 사용한다. 실제 계정과 운영 백필을 호출하지 않는다. 그래프는 변경하지 않는다. 기존 원문이 있는 항목을 재호출하지 않는다. 개발 중 시험 실행 금지, 마지막 수정 뒤 전체 시험을 순차 실행한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 | 기대 결과 |
|---|---|---|
| 계획 | dry_run과 선택 기간·endpoint | 날짜·endpoint별 누락 수와 예상 호출 수, 네트워크 없음 |
| 기간 호출 | 연속 누락 활동 목록·체중·Body Battery | 지원 API의 기간 호출 후 날짜별 분할 저장 |
| 상세 | 세트가 필요한 활동 | activity ID 단일 호출, 이미 있는 상세 유지 |
| 중단·재개 | 저장 뒤 차단·취소 | 다음 실행은 남은 항목만 계획, 429/403 뒤 추가 호출 없음 |
| 빈 응답 | Garmin NoData | 제공 안 한 수를 별도로 표시하고 무한 재호출 방지 |
| backlog | 날짜 상한·첫 호출 보호 | 남은 날짜·endpoint·활동 및 미룬 수를 공개 |

</frozen-after-approval>

## Code Map

- `extensions/garmin/src/collect_runtime.py`: supervised envelope와 자격 증거 세션을 재사용한다.
- `extensions/garmin/src/garmin_pipeline/{coverage,collect}.py`: coverage 원문·final·fresh 판정과 저장·오류 정책이 있다.
- `extensions/garmin/src/garmin_pipeline/garmin/__init__.py`: 모든 외부 호출이 기존 `_Session._fetch`를 거쳐 간격·차단 보호를 받는다.
- `extensions/garmin/src/garmin_pipeline/normalize/__init__.py`: 변경 원문에서 정규화 및 day_values 재생성한다.
- `extensions/garmin/manifest.json`: manual 입력 schema와 공개 집계 계약.
- `plugins/garmin/skills/brain-garmin-operations/SKILL.md`: 배포 명령 문서. `tooling/package-garmin/build.mjs`로 산출물을 동기화한다.
- `apps/cli/src/doctor/checks.ts`: 설치된 확장 진단을 읽는 점검을 추가한다.

## Tasks & Acceptance

- [x] 백필 계획·기간 분할·실행·재개와 ABI 입력 검증 구현.
- [x] 정기 수집에서 오래된 날짜를 한 자리 예약하고 최초 호출 skip·날짜 cap·남은 작업 집계 보존.
- [x] 결과·doctor·README·스킬·커버리지 갱신.
- [x] 합성 응답 시험 작성, 독립 리뷰와 필요한 수정, 전체 회귀 실행.

Given 저장 자료가 있을 때, when 백필을 실행하면, then 기존 자료의 데이터 호출은 없고 새 자료를 정규화한다.
Given 실행이 끝났을 때, when 결과와 doctor를 읽으면, then 실행 상태와 누락 상태를 따로 확인한다.
Given 날짜 상한을 넘는 오래된 누락이 있을 때, when 정기 수집을 반복하면, then 가장 오래된 항목도 진행된다.

## Design Notes

설치 라이브러리 0.3.20 소스에서 `get_activities_by_date`, `get_weigh_ins`, `get_body_battery`가 기간 인자를 받음을 확인했다. 일일 summary는 같은 원문 계약의 기간 API가 없어 날짜별 호출을 유지한다. 기간 호출은 연속 누락 날짜로만 묶고 최대 7일로 나눠 서버 제한과 응답 크기를 보수적으로 제한한다. 활동 목록은 내부 페이징 때문에 예상 API 호출 수는 하한이며 추가 페이지 수는 사전 확정할 수 없다. 새 목록이 발견하는 상세는 실행 중 재계획하므로 dry-run 상세 수는 현재 저장 목록 기준이다.

## Implementation Notes

배정된 구현 워커가 직접 구현하며 지정된 독립 리뷰어 한 명만 Orca로 배정한다. 사용자 Task 승인으로 별도 계획 승인 중지는 하지 않는다.

## Review Triage Log

## Verification

개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`, Python 구문 컴파일만 한다. 마지막 수정 뒤 `pnpm test` → `pnpm test:python`을 순차 실행한다. 실패 수정 뒤에는 `pnpm test:changed`와 관련 시험으로 재검증한다. 전용 시험 DB와 합성 네트워크만 사용한다.


## Plan Change Log

독립 리뷰 뒤 실행 순서를 가장 오래된 날짜 우선으로 명확히 하고, backfill run은 정기 day_status에서 제외한다. 기존 실행당 최초 호출 3회 계약을 유지하고 정규화 확인 뒤 DB 상태를 확정한다. 체중 응답의 목록 밖 필드는 날짜별 원문에 함께 보존한다.

## Review Triage Log — 1차

- high / patch: 성공 외 진입 fallback이 auth_failed·partial 정책을 우회함을 확인했다. 성공 뒤 누락 재진입에만 제한하고 당일 checked/rejected 제외를 사용한다.
- high / patch: 오래된 날짜를 뒤에 붙이면 최초 호출 상한으로 영구 skip 가능함을 확인했다. 가장 오래된 날짜를 맨 먼저 호출한다.
- high / patch: 첫 data 뒤 상한 해제는 기존 계약과 다름을 확인했다. 해제를 제거하고 실행당 3회로 고정한다.
- high / patch: backfill success가 정기 provenance를 막는 것을 확인했다. detail의 backfill 토큰을 정기 day_status에서 제외한다.
- high / patch: normalize 실패 뒤 DB success가 남는 것을 확인했다. 정상·예외 최종 상태를 정규화 뒤 확정한다.
- medium / patch: 체중 기간 응답의 목록 밖 필드가 누락됨을 확인했다. 날짜별 원문에 목록 밖 필드를 보존한다.

## Review Triage Log — 2차

- high / patch: 날짜 수가 상한 이하인 경우에도 최초 호출 보호에 굶는 경계가 남음을 확인했다. 모든 opt-in 계획에서 가장 오래된 날짜를 먼저 배치하며 5·10·15일 계획의 실제 호출을 두 번씩 검증하는 합성 시험으로 보강한다. 나머지 다섯 지적은 후속 리뷰에서 해소됐다.

## Implementation Notes — 공개 결과 조회 보강

core 감독자는 일반 summary를 정해진 형태로만 보존하고 queue list는 일감 결과 본문을 노출하지 않음을 확인했다. 확장 소유의 읽기 전용 backfill-status 명령을 추가해 접수한 일감의 공개 계획·결과 영수증과 최근 정기 집계를 계정 범위로 조회한다. dry-run은 원문·수집 run·토큰을 바꾸지 않고 공개 영수증만 남긴다. core 감독자나 다른 워커 소유 파일은 변경하지 않는다.

## Review Triage Log — 공개 조회

- medium / patch: collection meta는 수집 단계 기록으로 차단 진입·후속 projection 실패의 최종 상태가 아니라는 발견을 확인했다. 새 backfill-status에서 불필요한 collection 필드를 제거해 백필 일감 영수증만 반환한다. 정기 수집의 현재 backlog는 doctor가 직접 DB에서 집계한다.

## Verification — 최신 사용자 지시 반영

중앙이 전달한 사용자 변경(main `75ec75c8d1245a21d13670706119ded7a2bf4a51`)에 따라 개발 완료 뒤 전체 `pnpm test`, `pnpm test:python`, `pnpm test:changed`는 워커에서 추가 실행하지 않는다. 이미 실행 중인 전체 TS 회귀는 종료까지 보존하며 무관한 시간 민감 실패는 통합 단계 재검증 대상으로 기록한다. 이후 새·수정 및 직접 관련된 파일만 지정해 실행한다. `apps/cli/python-test/garmin-backfill.test.ts`는 Python 여섯 관련 모듈만 선택한다. 새 관련 시험에는 공용 잠금이 필요 없으며 전체 회귀는 중앙 통합 단계 몫이다.

## 최종 검증 결과

최신 사용자 변경에 따라 직접 관련 파일만 지정했다. TypeScript 관련 5파일 116시험, Python 통합 wrapper 3파일 6시험 및 내부 Python 지정 6모듈 80시험이 통과했다. 실제 backfill-status CLI와 work_id 선택·null 반환을 보강한 wrapper 한 파일을 다시 실행하여 1시험과 내부 Python80시험이 통과했다. build·typecheck·Python 구문 compile·diff check도 통과했다. 중앙이 허용한 publicCollectSummary의 좁은 호환 수정은 같은 독립 리뷰어가 검사해 실결함 없음을 확인했다.

최신 지시 전 시작된 전체 TS 회귀는 중단 없이 보존했으며 5372통과·76실패였다. 그중 변경에 직접 관련된 doctor47실패는 수정 후 관련 파일에서 해소했다. 나머지29실패는 동시 회귀 과부하 시점에 발생했고 사용자 지시에 따라 통합 단계 재검증 대상으로 보고한다. 전체 Python과 test:changed는 최신 지시로 실행하지 않았다.
