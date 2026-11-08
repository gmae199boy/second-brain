---
id: 12
type: bug
title: "Garmin 회귀: 재발행 직렬화 시험의 세 번째 반입이 간헐적으로 실패한다"
parent: epic-test-time
covers: []
after: ["21.8"]
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# Garmin 회귀: 재발행 직렬화 시험의 세 번째 반입이 간헐적으로 실패한다

## Description

재발행 staging과 core 정리를 같은 locator 잠금으로 직렬화하는 회귀에서 세 번째 반입 자식이 간헐적으로 비정상 종료한다. 같은 사례는 독립 전체 회귀와 4 slot 측정에서도 실패했으며 오류 원문이 reporter에서 빠져 원인을 확인할 수 없었다. 실제 잠금·정리·재발행 계약을 유지하며 원인을 판별하고 결정적으로 검증되는 회귀를 복구한다.

## Reproduction

1. 19.5 고정 source65792e86acb92ed121a224026a938731249809bd의 격리된4slot warmup1을 2026-11-08 09:37:54~09:41:23 UTC 실행했다. 합성 capture·가짜 외부 의존·전용 PostgreSQL/home을 사용했다.
2. 대상 사례는 첫 반입 뒤 두 번째 반입을 staging barrier에서 멈추고 core 정리를 같은 locator 잠금에서 대기시킨다. 두 번째 자식 종료와 정리 행 완료·staging 부재를 관찰한 다음 세 번째 반입을 실행한다.
3. 세 번째 자식이 nonzero로 종료해 warmup exit1, 전체50/51pass였다. sample1은 실행하지 않았다. 자식 stdout/stderr/SQLSTATE는 원래 reporter가 생략했다. 오류는20초poll이나90초시험timeout이 아니다.
4. 앞선19.11 최초전체에서도 같은case가 실패했으나 허용된단일관측진단은통과했다. W9뒤추가허용진단1회도4slot에서artifacts원래10case와동시job3개를실행해24/24pass였고 재현되지않았다. 성공을원인해결로보지않으며실패시점환경을그대로재현했다는뜻도아니다.

## Cause Hypothesis

실제 진입점인 보존 시험 어댑터의 DB 제한과, core가 cleaned_at을 커밋한 뒤 별도 쿼리로 locator 잠금을 해제하는 사이의 경합이 후보이다. 시험의 동기 자식 실행이 같은 Node 프로세스의 비동기 정리 진행에 미치는 영향도 구별해야 한다. slot 사이 DB·staging·잠금 직접 공유 근거는 없고 호스트 부하의 간접 영향은 가능하지만 원인을 확정하지 않는다.

## Acceptance Criteria

1. **실패 원인과 단계가 구별되고 필요한 최소 교정이 검증된다**
   **Given** 같은 locator에서 반입·재발행·core 정리가 겹치는 합성 사례
   **When** 첫 반입, barrier가 있는 두 번째 반입, 정리와 세 번째 반입의 순서를 결정적으로 검증한다
   **Then** 각 자식과 정리의 실제 잠금 보유/해제·작업소유·staging 상태가 의도한 계약에 맞으며 세 번째 반입이 정상 완료된다. 원인이 시험 전제인지 제품 결함인지 근거를 구별하고 필요한 최소 교정을 설명한다.
2. **원래 잠금·반입 계약과 실패 진단을 유지한다**
   **Given** 의도적으로 정리 완료 표시와 잠금 해제 또는 자식 실행 사이 순서를 제어하는 회귀
   **When** 정상과 실패 경계를 검증한다
   **Then** 실제 반입과 실제 locator 잠금·정리 경로를 통과하고, 너무 이른 삭제·불필요 재staging·오래된 작업 쓰기·중복 발행을 거부한다. 오류 발생 시 자식 exit/status/signal/stdout/stderr 및 필요한 phase/SQLSTATE를 비밀 없이 보존한다. 임의 sleep·timeout 증가·재시도·완화된 단언으로 안정성을 대신하지 않는다.
3. **관련 수정과 인계 증거가 완결된다**
   **Given** 독립 리뷰가 끝난 수정 source와 격리 자원
   **When** 필수 전체TS→Python을 순차각1회 실행하고 실패는 관련 재검증한다
   **Then** 남은 필수 실패가 없고 최초 실패·관련 처분·정확 source·소유 자원 부재를 남긴다. 19.5에 fixture/시험/workload/measurement 의미 변경 범위를 인계하며 이전 성능 표본을 새 source 측정으로 바꾸어 쓰지 않는다.
4. **또는 수정 불필요를 증명한다**
   **Given** 보고 당시 경합과 실패 단계
   **When** 실제 계약과 원문 증거를 대조한다
   **Then** 보고 전제가 잘못됐거나 기존 동작이 이미 올바름을 결정적 근거로 설명한다. 재현되지 않은 단일 성공이나 원인 미확정 추정만으로는 이 대안을 충족하지 않는다.

## Boundaries

- 19.5 runner·slot·동결집합·성능임계와 적용 migration을 바꾸지 않는다. 실제 반입/잠금/정리·바이트/멱등성·가림 계약은 유지한다.
- 제품 변경 필요가 확인되면 최소 diff와 실패 원인 근거로 중앙에 소유 범위를 먼저 요청한다. 우선 시험·보존 어댑터와 실제 호출 순서를 조사한다.
- 개발·리뷰 수정 중 시험 실행 금지, 컴파일 확인만. 기존 원문과 정적 분석으로 진행하며 필수 실행 진단은 구체 범위를 중앙에 요청한다. 자동 반복과 성능 목표 완화는 없다.
- 실제 계정/건강값/발신/운영DB를 사용하지 않고 자기 정확 자원만 정리한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-test-time/epic-test-time.md, Constraints·Notes
- related — _bmad-output/personal-brain/tickets/epic-test-time/tickets/bug-garmin-core-channel-date-plan.md, artifacts 관찰 위험

## Notes

- Decision(2026-11-08, 중앙, 사용자 무인 구현·필요 버그 분리 승인): 19.5 W9 실패는19.12로분리해조사·수정한다.19.5전체gate는미완료로유지하며4slot제외수락이나임계완화를하지않는다.
- Open question: 실제 SQLSTATE/phase·잠금해제와동기자식실행의순서는기존원문·정적분석과결정적검증으로판별한다. 조사대상이며착수차단미정사항으로전환하지않는다.
- Risk: medium — 잘못된 안정화는 잠금 누락·너무 이른 삭제·중복 발행 회귀를 숨긴다.
- 조사 위치: apps/cli/python-test/garmin-artifacts.test.ts의 재발행 직렬화 사례, extensions/garmin/tests/preservation_entry.py, packages/postgres/src/imports.ts. 경로는 조사 단서이며 특정 수정법을 요구하지 않는다.
- 원시 인계는 중앙 .brain-automation/tickets/19.12/evidence/의 W9 실패/독립추적/단일진단과 19.11 보존 위험 원문이다. 공개 Git에는 합성 비밀·URL·원시 전체를 넣지 않는다.
