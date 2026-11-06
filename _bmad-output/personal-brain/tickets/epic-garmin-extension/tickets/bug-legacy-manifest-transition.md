---
id: 10
type: bug
title: "옛 확장 manifest가 등록된 설치본은 지원 갱신과 패키지 교체로 이어지지 않는다"
parent: epic-garmin-extension
covers: []
after: [9]
refined: true
hitl: false
risk: high
severity: P1
---

# 옛 확장 manifest가 등록된 설치본은 지원 갱신과 패키지 교체로 이어지지 않는다

## Description

21.9의 옛 core 갱신 경로가 등록된 옛 확장 manifest를 현재 형식으로 해석하다 거부해, 같은 DB를 유지한 core 갱신과 새 확장 패키지 교체가 막힌다. 설치본은 비활성·보류 등 기계 전제를 충족해도 다음 단계에 도달하지 못한다. 지원 전환을 끝낸 확장만 다시 실행할 수 있어야 하며 실제 Mac 운영 전환은21.7에 남긴다.

## Reproduction

1. 전용 PG와 격리 home에 core schema27, 설치 기록, 비활성 등록 확장과 보류 예약·일감을 둔다. 공개 이력 `09947d2`의 Garmin 1.0.0 manifest 및 당시 migration0001~0008을 합성 설치 fixture로 사용한다. 실제 계정·운영자료는 쓰지 않는다.
2. 이전 실행·쓰기 자식 종료와 새 진입 차단 등21.9 안전 전제를 갖추고, 새 core 지원 설치 경로로 갱신을 요청한다.
3. 현재는 `DB_LOCKED: 확장 manifest 또는 대상 core 호환성을 확인할 수 없습니다`로 거부된다. 옛 work의 `verification_snapshot`이 현재 decoder에서 `EXTENSION_INVALID`이며, `core_compat`도 없다. 옛 설정·예약 전체가 각각 문법상 불법이라는 주장은 아니다.
4. 새 패키지를 먼저 설치하는 경로도 설치·실행 core 신원 불일치와 옛 decoder 때문에 막힌다. 기대는 수동 파일 덮어쓰기·registry 삭제·빈 DB 없이 지원된 core 갱신→패키지 교체로 이어지는 것이다.

## Cause Hypothesis

옛 설치의 migration 이력을 보존해 새 core로 옮기는 전환과, 현재 형식·호환 검증을 마친 확장만 실행하는 일반 계약이 같은 manifest 판독을 전제하는 것으로 보인다. 옛 패키지를 실행하지 않고 안전하게 교체하는 상태를 명시하지 않아 두 계약 사이에 지원 경로가 없다. 구체 구현은 이력·신원·정지 및 복구 계약을 조사해 정한다.

## Acceptance Criteria

1. **실제 옛 형식으로 지원 전환**
   **Given** 위 공개 옛 manifest·migration을 가진 합성 설치본이21.9의 기계 전제·진입 차단·현재 시도에 결합된 대화형 운영자 확인을 충족한다.
   **When** 지원 설치 경로로 core를 갱신하고 지원 패키지 설치 경로로 호환 새 확장을 설치한다.
   **Then** 같은 DB·기억·확장 이력과 사용자 상태를 유지하며 두 단계가 완료된다. 기존 migration은 재적용·변조되지 않고 새 패키지의 적용 이력 접두와 바이트가 일치하는지 확인한 뒤 새 migration만 진행한다. core 갱신만으로 옛 확장 코드·명령·예약·새 청구가 실행되지 않는다.
2. **교체 전 실행 금지와 새 패키지 검증**
   **Given** core만 갱신됐고 옛 형식 패키지가 남아 있거나 교체가 중단됐다.
   **When** enable·예약 재개·명령·청구 등 실행 진입을 시도하거나 새 패키지를 교체한다.
   **Then** 교체와 현재 형식·대상 core 호환·패키지 신원 검증이 완료되기 전 실행은 진단과 함께 거부한다. 성공한 교체 뒤에도 사용자 비활성·보류를 자동 해제하지 않으며 정상적인 명시 재개만 허용한다. 재시도·재시작 뒤에도 같은 상태를 유지한다.
3. **불명·변조·현행 manifest 오류는 변경 전 거부**
   **Given** 옛 설치 신원 불명, 이름 불일치, 경로 이탈·symlink, malformed manifest, migration 이력·checksum 불일치, 비호환 새 패키지, 타 owner gate/journal 또는21.9의 미충족 전제가 있다.
   **When** 같은 전환·교체를 요청한다.
   **Then** 영향 상태를 바꾸기 전에 거부하고 기존 앱·패키지·DB·기억과 소유권을 보존한다. 옛 전환의 제한된 판독이 일반 신규 설치·현행 갱신·runtime decoder의 형식/호환 검증을 완화하지 않는다. core에 Garmin 전용 분기를 두지 않는다.
4. **실패·중단과 지원 복구**
   **Given** core 전환·패키지 승격·migration·registry·실행 금지 상태의 저장/해제 경계에서 실패하거나 프로세스가 중단된다.
   **When** 재시도 또는 지원 복구 절차를 수행한다.
   **Then** 옛 코드의 오실행·옛새 writer 동시 실행 없이 완료하거나 정확한 복구 진단과 함께 안전 상태를 보존한다. 확정 migration을 되돌렸다고 주장하지 않고 타 owner·사용자 보류를 해제하지 않는다.
5. **실행 증거와 일반 경로 회귀**
   **Given** 소유 전용 환경·합성 데이터·공개 옛 manifest fixture 및 다른 이름의 합성 확장이다.
   **When** 정상 core 갱신→패키지 교체→명시 재개, 거부·변조·경합·중단 재개, 기억/예약/회계 보존과 신규/현행 설치 회귀를 검증한다.
   **Then** 외부 지원 설치·명령 경로를 거치는 시험이 결함을 검출하고 수정 후 통과하며, 독립 리뷰·필요 후속·최종 `pnpm test`→`pnpm test:python` 순차 실행에 미해결 실패가 없다. 전체 회귀는 모든 구현/리뷰 수정 뒤 마무리 직전에 실행하고 반복 검증은 `test:changed`다.21.10은 기존 시험 유예 번호에 포함되지 않는다.
6. **또는 변경 불필요 입증**
   **Given** 현재 코드에 위 지원 경로가 있다고 판단한다.
   **When** 같은 합성 설치본에서 외부 진입점으로 실행한다.
   **Then**1~5의 안전/보존·지원 절차와 실행 증거를 기록한다. 단순 거부·수동 우회·운영 진단만으로 입증하지 않는다.

## Boundaries

A1 불명 잠금 보존·기존 offline 확인·소유 정지·호환/신원 검증을 유지한다. 운영 DB/home/계정/예약 변경, credential·실건강자료 fixture, 강제종료/새 감독 의존성, registry SQL 삭제, 적용된 migration 수정과 범용 decoder의 임의 unknown-key 허용은 제외한다.21.9의 schema bridge와 이번 옛 패키지 교체 경계를 함께 회귀하되 실제 전환은21.7이 소유한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-garmin-extension/epic-garmin-extension.md, E21-6·Notes
- predecessor — _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-extension-core-upgrade-plan.md, legacy 경로·잔여 위험
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-19·38·40
- observation — _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/story-mac-plan.md, 2026-11-06 재진단·q2

## Notes

- Decision(2026-11-06, 중앙): 무인 구현 지속 승인에 따라21.7 새 제품 차단을 별도21.10으로 분리한다.21.7은21.10 수락·원격main 반영·release 뒤 재개하며 운영자 확인을 대신하지 않는다. 제한된 legacy 판독과 실행 금지 상태를 포함하는 지원 경로를 허용하되 구체 설계는 지휘자가 정한다.
- Risk: high — 옛 패키지 실행이나 이력 변조를 허용하면 기억 손실/동시 쓰기가 생길 수 있다. 추가 확인: 공개 실제 옛 manifest와 다른 이름의 합성 확장에서 중단 재시작 후 실행 금지가 유지되는지 독립 대조한다.
- 공개 fixture 출처는 `git show 09947d2:extensions/garmin/manifest.json` 및 당시 migration이다. 실제 운영 사본·식별자는 공개하지 않는다.
