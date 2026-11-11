---
title: 저장 리포트 재발신 첨부 복원
type: bugfix
ticket: ''
created: '2026-11-11'
status: built
baseline_revision: 7b61fa3b85ea9653d78fd5a3d134ee0ea2b2e5b8
route: full
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="명시된 Dispatch 작업 승인">

## Intent

**Problem:** report-send가 저장 평가의 문구만 보내 그래프와 전체 보고서를 누락한다.

**Approach:** 선택 revision의 게시 파일을 우선 재사용하고 없으면 기존 결정적 렌더링·게시 경로를 사용한다. 기간 분석도 저장된 전체 문서를 첨부한다.

## Boundaries & Constraints

**Always:** 계정·날짜·revision 고정, 요약 → 앨범 → 문서 계약, 첨부·서식 버전 기반 멱등성을 지킨다. 개발 중에는 시험을 실행하지 않고 마지막 수정·리뷰 뒤 전체 회귀를 순차 실행한다.

**Never:** 분석기 재실행, 실제 발신, 운영·중앙 변경, main 병합·push를 하지 않는다. 구현은 현재 워커가 직접 수행하고 독립 리뷰어 한 명만 사용한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 | 결과 | 오류 처리 |
|---|---|---|---|
| 기존 게시 | 네 범위 revision·완료 파일 | 기존 전체 문서·정렬된 앨범 재사용 | 재렌더링 없음 |
| 미게시 | 저장 평가만 존재 | 기존 렌더러로 그래프·전체 문서 게시 후 첨부 | 게시 대기는 재시도, 렌더링 불가 시 표시·사유 |
| 재시도 | 같은 revision·첨부·서식 | 동일 요청 | 이전 문구 전용 요청과 구별 |
| 기간 분석 | 저장된 기간 평가 | 전체 문서 첨부 | 임의 기간 그래프 렌더러 부재 명시 |

</frozen-after-approval>

## Code Map

- `extensions/garmin/src/report_runtime.py`: send_saved가 revision을 고정하지만 document=None으로 호출한다.
- `extensions/garmin/src/report_publish.py`: publish_and_wait와 bundle 문서 게시를 재사용한다. 분석기를 호출하지 않는다.
- `extensions/garmin/src/report_channel.py`: 앨범 정렬·분할과 core 발신 계약, 서식 기반 요청 키를 관리한다.
- `extensions/garmin/src/period_analysis_runtime.py`: 기간 평가 report_md를 저장하지만 발신에서 문서를 버린다. 임의 기간 그래프 게시·렌더링 경로는 없다.
- `extensions/garmin/tests/test_report_send.py`, `test_report_channel.py`, `test_period_analysis.py`: 가짜 파일·서버 계약 시험을 확장한다.
- `plugins/garmin/skills/brain-garmin-operations/SKILL.md`, `extensions/garmin/README.md`: 첨부·복원·제한·멱등 설명을 갱신한다.

## Tasks & Acceptance

**Execution:**
- [x] report_publish·report_runtime에 게시 파일 조회와 결정적 복원을 연결한다.
- [x] report_channel에서 첨부 manifest를 요청 버전에 포함한다.
- [x] 기간 평가 문서를 core 파일 계약으로 게시하고 발신한다.
- [x] 가짜 파일·서버 시험, 배포 스킬·README, 버전·package를 갱신한다.
- [x] 독립 리뷰와 수정 후 전체 회귀·커밋·자기 브랜치 push를 완료한다.

**Acceptance Criteria:**
- Given 게시 완료된 네 범위 평가, when report-send, then 분석 없이 기존 문서와 그래프가 첨부된다.
- Given 미게시 평가, when report-send, then 결정적 게시로 복원되거나 불가 사유와 보고서·그래프 없음이 표시된다.
- Given 동일 첨부·revision, when 재실행, then 요청이 중복되지 않으며 이전 문구 전용 발신과는 구별된다.
- Given 일반 report, when 완료, then 요약·앨범·전체 문서 순서가 유지된다.
- Given 기간 평가, when 발신, then 저장 문서가 첨부되고 그래프 지원 범위가 명시된다.

## Implementation Notes

- Dispatch가 구현·리뷰·검증·브랜치 push를 승인했으므로 추가 계획 승인 없이 진행한다. 스킬의 별도 구현자·push 금지 요구보다 현재 Dispatch 지시를 우선한다.

## Plan Change Log

## Review Triage Log

## Verification

- 개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다.
- 마지막 구현·리뷰 수정 후 `pnpm test` → `pnpm test:python`을 순차 한 번 실행한다.
- 실패 수정 후에는 `pnpm test:changed`와 관련 시험으로 재검증한다.

- core가 파일 원본 일감과 발신 일감의 target 일치를 요구하므로 날짜 target의 멱등 사본 요청을 게시한다. 기존 바이트를 그대로 사용하며 core 권한은 변경하지 않는다.

## 후속 리뷰 반영

- F1: high / patch. 미게시 복원은 공용 바이트만 고정하고 날짜 target의 별도 파일 요청만 게시하도록 수정했다. 공용 요청은 일반 report가 자기 연결 target으로 처음 게시하며, 두 경로를 실제 함수와 core 계약 대역으로 연결한 회귀 시험을 추가했다.
- F2: medium / patch. 실제 그래프 렌더링 블록에서만 RenderUnavailable을 분류하고 staging OSError는 전파하도록 수정했다. 기존 파일 재사용 중 staging 실패 시 발신되지 않는 시험을 추가했다.

- F3: medium / patch. 시험 대역의 실제 바인드 인덱스(work/token 9~10, sha256 5)와 bundle 전용 media·링크 인자를 분리해 수정했다.

- 최초 전체 회귀: `pnpm test` 246개 파일·5415개 통과/2개 실패, `pnpm test:python` 16개 파일·89개 통과/2개 실패. 개발 중에는 시험을 실행하지 않았으며 리뷰 수정 후 순차 전체 회귀를 실행했다.
- report-send 통합 시험의 기존 문구 전용 기대값을 새 수락조건(가짜 PNG·문서·단일 dispatch·요청 2개)으로 갱신했다. 독립 리뷰 추가 finding 없음.
- `pnpm test:changed` 종료 0: Python 전체 16개 파일·91개 시험 통과, Garmin unit 내부 296개 시험 통과. 새 첨부와 기간 문서 통합도 통과했다. 최초 batch-import 체크포인트 실패는 소스 변경 없이 재실행 통과했다.
- 최초 TS 실패 2개는 합성 resumext 인증 활성 work 재사용과 legacy L5 migration 복구이다. 두 시험은 관련 경로 단독 재실행에서 각각 종료 0·1개 통과했다. 두 설치 기능은 수정하지 않았다.
- 독립 리뷰: `.brain-automation/report-send-review.md`, `report-send-review-followup.md`, `report-send-review-final.md`, `report-send-review-integration.md`. F1·F2·F3 해결, 잔여 finding 없음. 실제 발신은 실행하지 않았다.
