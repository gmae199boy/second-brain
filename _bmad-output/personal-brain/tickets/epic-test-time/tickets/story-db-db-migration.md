---
id: 1
type: story
title: "시험 DB 초기화: 독립 DB 격리를 유지한 채 매 시험의 전체 migration 반복이 사라진다"
parent: epic-test-time
covers: [E19-1]
after: [5]
refined: true
hitl: false
risk: medium
---

# 시험 DB 초기화: 독립 DB 격리를 유지한 채 매 시험의 전체 migration 반복이 사라진다

## Description

19.5의 slot·lease 수명 위에서 시험 DB 준비의 전체 migration 반복을 줄여 E19-1을 충족한다. template 복제와 초기화 재사용을 현행 준비·권한·회수 경계에서 비교하고 하나를 고른다. 빠른 경로를 적용할 수 없는 시험에는 새 DB의 실제 준비·migration 경로를 유지한다. 구현 선택과 성능 판정은 별도 배정 후 수행한다.

## Acceptance Criteria

1. **격리와 준비 결과가 새 DB와 동등하다** (E19-1)
   **Given** 서로 다른 시험 또는 동시에 존재하는 두 확장 home
   **When** DB를 준비하고 한쪽에서 행·schema·권한·role 상태를 바꾸거나 정리한다
   **Then** 다른 쪽에 상태가 새거나 정리가 간섭하지 않는다. 기본 데이터·migration ledger/checksum·소유자·grant/default privilege·확장 role marker·advisory lock과 app/maintenance 권한의 성공·거부 결과는 새 migration DB와 같다. DB별 입력·self user는 seed에 섞이지 않는다. 같은 이름의 cluster 전역 확장 role을 쓰는 동시 home은 독립 cluster를 유지하며 동시성 시험을 직렬화하지 않는다.
2. **최적화 제외 경로가 실제 계약을 검증한다** (E19-1)
   **Given** migration 자체·파괴적 DDL·role/권한·빈 DB 상태를 검증하는 시험
   **When** 명시적으로 빠른 준비를 제외하고 실행한다
   **Then** 새 DB에서 실제 준비와 migration을 수행하며 기존 실패 경로·단언을 보존한다. 권한 전용 cluster와 물리 정리·snapshot 검증은 기존 격리를 유지한다. 제외 대상 목록과 호출 경계를 기록하고, 정상 빠른 경로와 제외 경로가 각각 선택됨을 입증한다.
3. **준비 상태의 재사용과 실패 회수가 안전하다** (E19-1)
   **Given** 동일 cluster 세대의 동시 준비, migration 내용 변경, 부분 생성·중단·정리 실패 또는 cluster 재생성
   **When** 준비 상태를 만들거나 다시 사용한다
   **Then** template 채택 시 순서 있는 migration 파일 내용 hash 및 준비 계약에 맞는 완성본만 원자적으로 공개되고 cluster 세대·hash당 생성은 한 번이다. 실패한 생성은 사용되지 않으며 재시도할 수 있다. 초기화 재사용 채택 시 행·sequence·schema/DDL·권한·ledger와 남은 연결/transaction까지 새 DB와 동등함을 확인한 뒤에만 다시 배정한다. 둘 다 소유 불명·잔존·실패 상태를 재사용하지 않으며 타인 자원을 지우지 않는다. 정상·실패·timeout·강제 중단 뒤 정확 소유 자원의 회수 책임과 복구 증거가 있다.
4. **실제 DB 준비·정리 합계가 절반 이하이다** (E19-1)
   **Given** 구현 착수 시 동결한 기준/후보 SHA와 동일한 네 파일·case·입력·환경·cache 정책·계측 경계
   **When** 전용 자원에서 공통 직렬 잠금 아래 각 구성 warm-up 1회 뒤 독립 표본 3회씩 실행한다
   **Then** 네 파일을 합친 DB 준비·정리 시간의 중앙값 비율 후보/기준이 0.5 이하이고 모든 표본의 case·통과 결과와 행·순서·오류 분류가 동등하다. 생성·권한 준비·migration·drop의 기존 네 구간과 새 seed/template 생성·무효화·초기화·잠금대기·회수 비용을 빠짐없이 귀속하며 중복 합산하지 않는다. 별도 cluster 시작/인증/종료 비용도 포함 여부와 별도 수치로 공개해 비용 이동을 숨기지 않는다. 미달·실패를 표본 제외·case 축소·assertion/임계 완화로 해결하지 않는다.
5. **물리 정리·권한 회귀가 보존된다** (E19-1)
   **Given** 19.14가 보강한 redaction 41 case와 권한 전용 cluster
   **When** 빠른 준비를 연결한 뒤 같은 입력을 검증한다
   **Then** 실제 container 전체 ID·port와 SQL system identifier 매핑 단언, 세 대상 전체 작업/실패 집합, messages MAINTAIN 단독 실패1·attempts10·미완료0, 다른 두 대상 rewrite/비밀 bytes 제거, 권한 복구 retry1·skip0·messages bytes 제거·제어값 보존·doctor 회복을 유지한다. 같은 DB 오래된 snapshot의 음성/해제 복구와 새 세대 CAS 보호도 실제 경로로 통과한다. 준비와 물리 작업 비용을 구별하고 후자를 줄이거나 mock하지 않는다. 역사 두 실패 행의 원인 미확정을 새 성능/해결 증거로 소급하지 않는다.
6. **필수 최종 검증과 비교 증거가 있다** (E19-1)
   **Given** 모든 구현·독립 리뷰 수정 완료
   **When** 구현 커밋 전 전용 환경에서 전체 `pnpm test` → `pnpm test:python`을 순차 각 1회 실행한다
   **Then** 종료 코드·case 결과·명령별 시간·소유 자원 정리를 남기고 통과한다. 기준 커밋의 같은 환경 전체 각1회 기록과 나란히 적되 전체 suite를 반복 측정하지 않는다. 실패 원문과 수정 처분을 보존하고 이후 관련 시험·`pnpm test:changed -- <기준 SHA>`로 재검증한다. 기존 기록이 동등하지 않으면 기준 전체 각1회도 별도로 확보한다. 필수 검증 미실행·미해결 실패를 built로 처리하거나 21.8로 넘기지 않는다.

## Boundaries

- 기존 생산 migration·DDL·권한·role 이름·marker·잠금·확장 설치/반입/정리 의미와 fixture 정리 오류 전파를 유지한다. 시험 결과 캐시·mock·skip·timeout 증가는 성능 수단이 아니다.
- slot lease 검증과 직접 실행, 동시 추가 home의 isolated fallback을 보존한다. fixture는 자기 DB를 반납하고 slot cluster의 폐기·복구는 실행 소유자가 맡는다.
- 19.6의 hook 중복/Python config/test-changed 변경과 8.5의 Drive/0044 작업은 별도 소유다. 이 문서 정제가 구현 병렬 승인을 뜻하지 않는다. 구현 배정 때 중앙이 실제 공유 경계와 최신 migration을 다시 확인한다.
- 개발·리뷰 수정 중 시험을 실행하지 않고 컴파일만 확인한다. 대상 측정과 전체 회귀는 마지막 수정 뒤 검증 단계에 수행한다. 이번 문서 정제에서는 컴파일·시험·목록 조회·PG·측정도 모두 실행하지 않는다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-test-time/epic-test-time.md, E19-1·Constraints·Notes
- research — _bmad-output/personal-brain/research-performance-2026-11-04/tests/report.md, 4개 파일의 실제 구간·영향·18.10·티켓 판단
- handoff — _bmad-output/personal-brain/tickets/epic-test-time/tickets/story-python-role-pnpm-test-python-slot-refinement.md, slot·fixture·hook 소유권 계약
- result — _bmad-output/personal-brain/tickets/epic-test-time/tickets/story-python-role-pnpm-test-python-slot-plan.md, Auto Run Result
- contract — _bmad-output/personal-brain/tickets/epic-test-time/tickets/bug-redaction-cleanup-failure-count.md, Acceptance Criteria
- refinement — _bmad-output/personal-brain/tickets/epic-test-time/tickets/story-db-db-migration-refinement.md, 현행 seam·선택 기준·검증 인계

## Notes

- Decision(2026-11-09, 중앙 정제 명세): 문서 범위만 정제·독립 Ticket/Dependencies 확인·커밋·자기 브랜치 push한다. 중앙 수락과 별도 구현 배정 전 구현하지 않는다. 원본 baseline은 cb8391173aead346abb5177d87212d999ce30bd8/schema43이다.
- Waits on 19.5 because: slot cluster·lease·직접 실행·fixture 반납 계약을 소비한다. 수락 source 5b2fff1은 원본 baseline의 조상이다. after [5]와 entry refine=true를 유지한다.
- Decision: template과 초기화 재사용의 최종 선택은 구현의 책임이다. AC를 바꾸는 제품/범위 판단이나 필수 조건을 충족할 수 없는 선택은 중앙에 올린다. 성능 절반 목표는 추정 보장이 아니다.
- Risk: medium — 상태나 권한이 새면 회귀를 숨기므로 준비 결과 동등성과 음성 경로까지 검증한다.
