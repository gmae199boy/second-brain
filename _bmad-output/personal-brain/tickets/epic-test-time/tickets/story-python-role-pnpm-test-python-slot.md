---
id: 5
type: story
title: "Python 통합 시험 병렬화: 확장 role 계약을 지킨 채 pnpm test:python이 여러 slot에서 동시에 돈다"
parent: epic-test-time
covers: [E19-5]
after: [20.6]
refined: true
hitl: false
risk: high
---

# Python 통합 시험 병렬화: 확장 role 계약을 지킨 채 pnpm test:python이 여러 slot에서 동시에 돈다

## Description

20.6 정리 뒤 남은 Python 통합 시험을 독립 PostgreSQL slot에서 병렬 실행해 E19-5의 시간 목표를 달성한다. 생산 확장 role 계약과 현재 fixture 격리를 유지하면서 파일 간 자원 소유권·실패 정리를 보장한다. 이 문서와 정제 계획은 구현 전 명세이며 구현 완료 증거가 아니다.

## Requirements

1. **파일 집합과 결과 보존** (E19-5)
   **Given** 구현 baseline의 전체 시험 목록과 기존 조건부 skip 목록이 고정되어 있다.
   **When** Python 회귀 명령이나 단독·변경 시험을 실행한다.
   **Then** 선택된 모든 파일·case가 정확히 한 번 실행되고 기존 pass/fail/조건부 skip 의미가 같다.
   **And** 목록 수집만으로 실행 통과를 주장하지 않으며 Python 자식의 개별 unittest·oracle 결과도 보존한다.

2. **slot 격리와 순차 재사용** (E19-5)
   **Given** 같은 checkout 또는 다른 checkout의 동시 실행과 한 파일 안의 여러 독립 fixture가 있다.
   **When** 각 slot에 파일을 배정한다.
   **Then** 서로 다른 slot·실행·독립 fixture가 cluster 전역 확장 role이나 DB·home·venv·container를 공유하지 않는다.
   **And** slot 안 파일은 순차 실행하며 깨끗한 경계를 확인한 cluster만 재사용한다. 같은 파일의 동시 fixture에는 별도 cluster를 준다. 생산 role 이름·ownership marker·권한·advisory lock을 바꾸지 않는다.

3. **실패와 timeout 뒤 진행** (E19-5)
   **Given** 파일의 assertion 실패, timeout, 자식 중단, 부분 시작 실패 또는 정리 오류가 발생한다.
   **When** runner가 해당 파일의 종료를 처리한다.
   **Then** 원래 실패와 정리 실패가 모두 보존되고 실행 결과는 nonzero다. 자기 자식의 실제 종료와 자기 PG 자원 정리를 확인한 뒤 다음 파일·다음 실행은 깨끗한 자원에서 진행하고 다른 slot은 영향받지 않는다.
   **And** 소유권·종료가 불명확하면 그 slot을 격리하고 새 파일을 배정하지 않는다. 성공·실패·timeout·중단 경로마다 자신이 만든 role·DB·container·volume·port·자식 잔존0의 증거가 있어야 완료다.

4. **Python 준비와 hook lane** (E19-5)
   **Given** 파일마다 다른 pinned Python과 설치 홈별 venv를 사용하며 hook은 두 suite에 존재한다.
   **When** 여러 slot 또는 두 suite를 실행한다.
   **Then** Garmin 3.14.10과 pyfixture/pyresume 3.12.13 등 각 파일의 pin·실제 설치·갱신·재개 검증이 유지되고 다른 fixture venv를 수정하거나 공유하지 않는다.
   **And** hook은 suite별 한 번씩 기존 case 순서·Python 보존 조건을 유지해 전용 직렬 lane에서 실행한다. 두 hook의 실행 경합 및 해시 port 충돌을 막고, 타인 자원은 거부·보존한다. 중복 제거는 19.6에서 한다.

5. **동일 runner의 시간 판정** (E19-5)
   **Given** 동일 SHA·입력·환경·hook 배치·venv 준비 정책과 최장 파일 묶음이 측정 전에 고정된다.
   **When** 새 runner의 1·2·3·4 slot 각각 warm-up 1회 뒤 3표본을 얻는다.
   **Then** 선택 구성의 명령 wall 중앙값 / 같은 runner 1 slot 중앙값이 0.5 이하이고 선택 파일·case·결과가 같다. 준비·정리·hook 대기까지 wall에 포함하고 실패 표본은 삭제하지 않는다.
   **And** 미달·timeout·자원 잔존·미실행은 완료로 처리하지 않는다. 과거 시간 재배치 모델이나 삭제된 시험 시간을 비교 분모로 쓰지 않는다.

6. **두 suite 병행과 최종 회귀** (E19-5)
   **Given** 구현·리뷰 수정이 끝나고 build가 완료되어 있다.
   **When** 기본/Python Vitest process를 한 번 병행 실행하고 이후 마지막 전체 회귀를 순차 실행한다.
   **Then** 서로 다른 소유 cluster를 사용하고 hook lane 계약을 지키며, 양쪽 결과·자원 격리가 확인된다. 마지막 `pnpm test` → `pnpm test:python` 각1회가 통과하고 시간·peak CPU·PG 연결·정리 결과가 남는다.
   **And** build가 포함된 두 pnpm 명령 자체를 병행하지 않는다. 19.5의 검증을 21.8로 넘기지 않는다.

## Boundaries

- 시험 case·단언·fixture 의미·기존 timeout·실제 PG/Python/설치 검증을 줄이거나 mock·결과 캐시로 대체하지 않는다.
- 공용 54329·운영 DB·실계정·실제 transcript/건강값을 사용하지 않는다. private venv와 빈 harness 환경을 유지한다.
- DB template/초기화 최적화는 19.1, hook 중복 제거는 19.6, 선택 범위 축소는 19.9, normalize 순서 경합은 19.10의 책임이다.
- 이번 승인 범위는 문서·티켓 정제 및 그 커밋·브랜치 push뿐이다. 제품·시험 실행기·config·lockfile·SQL·fixture 변경과 build/typecheck/test/eval/성능측정/PG생성은 금지한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-test-time/epic-test-time.md, E19-5·Constraints·2026-11-05 결정
- refinement — _bmad-output/personal-brain/tickets/epic-test-time/tickets/story-python-role-pnpm-test-python-slot-refinement.md, 정적 근거·소유권·측정·검증·Task
- handoff — _bmad-output/personal-brain/tickets/epic-extension-platform/tickets/story-core-garmin-epic-16-plan.md, Code Map·Auto Run Result
- history — _bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-reader-preflight-brain-ext-run-garmin-import-preflight-plan.md, 직렬화 이유
- research — _bmad-output/personal-brain/research-performance-2026-11-04/research-performance-2026-11-04.md, 확정 결과 5~7

## Notes

- Decision(2026-11-08, 사용자·중앙 명세): 원본 baseline `9004c35b20c1b38b66af795668056ecdcdbaa1a9`에서 구현 전 명세 정제만 한다. 20.6 선행과 절반 이하 목표는 유지하며 구현 시작은 중앙 수락 뒤 별도 배정한다.
- Decision(2026-11-05, 부모): 18.10 대신 20.6 정리 뒤 현행 시험 집합에서 다시 정제한다. 원문에 남은 health-perf·옛 normalize·body-digest·review-boundaries 인계를 부활시키지 않는다.
- Risk: high — 잘못된 격리는 회귀를 숨긴다. 추가 검사는 파일 실패·timeout 주입과 기본/Python Vitest 병행의 소유권 대조다.
- Waits on 20.6 because: 정리된 계약·시험 집합이 비교 기준이며 baseline에 해당 산출물이 포함되어 있다. built/done 전이는 하지 않는다.
