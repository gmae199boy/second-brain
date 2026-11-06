---
id: 11
type: bug
title: "플러그인의 detached 설치본에서 새 ref 갱신에 필요한 대화형 offline 확인을 입력할 수 없다"
parent: epic-garmin-extension
covers: []
after: [10]
refined: true
hitl: false
risk: high
severity: P1
---

# 플러그인의 detached 설치본에서 새 ref 갱신에 필요한 대화형 offline 확인을 입력할 수 없다

## Description

21.10의 지원 설치기는 옛 manifest를 처리하지만, 플러그인이 만든 detached app을 새 ref로 준비하면서 운영자의 TTY offline 확인을 받는 지원 진입점이 없다. 안전한 대화형 갱신 경로와 운영 안내가 필요하다. 실제 Mac의 데몬·DB·계정·예약 전환과 사람의 확인은21.7에 남긴다.

## Reproduction

1. 전용 PG와 격리 home에 공개 옛 core27·Garmin1.0.0 manifest 및 migration0001~0008을 가진 합성 설치본을 만든다. 플러그인 설치와 같이 app은 detached HEAD이며 기억·예약·회계와 비활성 확장·사용자 보류를 포함한다.
2.21.9·21.10의 정지·진입 차단 전제를 충족하고, 실제 터미널에서 플러그인 배포 ref의 새 코드로 지원 갱신을 요청한다.
3. ref 없는 대화형 진입은 detached clone을 거부한다. ref를 주는 진입은 TTY에서도 hook 모드를 선택해 설치기 stdin을 닫는다. 기존 shim의 setup은 새 ref를 준비하지 않는다.
4. 기대는 내부 환경 변수 수동 주입·브랜치 전환·직접 staged 설치기 호출 없이, 지원 bootstrap 진입부터 새 설치기의 현재 시도 offline 확인과 갱신까지 이어지는 것이다.

## Cause Hypothesis

ref 선택과 hook 실행 방식이 결합되어 고정 ref 갱신과 대화형 설치기 확인을 함께 사용할 수 없는 것으로 보인다. detached 거부·스트림 전달·잠금 및 staged 승격의 계약을 조사해 지원 경로를 정한다. 특정 플래그나 내부 구현을 정답으로 고정하지 않는다.

## Acceptance Criteria

1. **detached 옛 설치본의 지원 대화형 갱신**
   **Given** 재현의 합성 설치본과 현재 시도에 결합된 정지/진입차단 전제 및 실제 PTY가 있다.
   **When** 문서화된 사용자 진입점에서 검증된 새 ref 갱신을 요청하고 운영자가 설치기 challenge에 응답한다.
   **Then** 대상 ref 준비부터 설치기 실행·같은 DB의 갱신·staged 승격이 끝나고 기억·사용자·예약·회계·적용 이력 접두가 보존된다. 새 패키지 교체 전 실행 금지와 사용자 비활성·보류도 유지된다.
2. **대화형과 hook의 안전 구분**
   **Given** hook, 비TTY, JSON, 잘못된 응답·EOF·취소 또는 정지 전제 불충족이다.
   **When** 같은 갱신을 요청한다.
   **Then** hook은 질문하지 않으며 명시 offline 확인을 자동 수락하지 않는다. 확인이 필요한 경로는 정확한 진단과 안전 상태로 거부한다. hook 출력/로그 계약과 기존 일반 설치·갱신 동작을 보존한다.
3. **ref·소유권·중단 복구**
   **Given** 불명/변조 ref·다른 저장소·dirty app·이력 불일치·타 owner 잠금 또는 준비/설치/승격 중 실패·중단이다.
   **When** 갱신 또는 지원 재시도를 수행한다.
   **Then** 기존 신원·잠금·검증을 우회하지 않고 이전 app/DB와 복구 가능한 상태를 지킨다. 두 writer를 함께 실행하거나 확인 없이 승격하지 않는다. 재개·정리 결과를 실제 외부 경로에서 입증한다.
4. **bootstrap부터 실제 PTY로 검증**
   **Given** 소유 전용 자원·합성 자료와 옛 detached app이다.
   **When** 지원 bootstrap부터 정상/거부/중단복구 및 일반 hook·npx 회귀를 실행한다.
   **Then** 새 CLI에 app을 미리 연결하거나 내부 staged 환경 변수를 시험 호출자가 주입해 진입점을 생략하지 않고, 실제 PTY 확인·종료코드·진단·보존/승격을 검증한다. 실패 상태를 skip·단언 축소로 통과시키지 않는다.
5. **운영 안내·배포·최종 검증**
   **Given** 구현·필요 후속 독립 리뷰가 완료됐다.
   **When** 배포와 최종 검증을 마친다.
   **Then** 운영자에게 대상 ref 선택·옛 데몬 중지/종료 재확인·대화형 확인·실패 복구의 지원 명령을 안내하고, 배포 bootstrap과 소스가 일치한다. 최종 pnpm test → pnpm test:python을 순차 실행하고 실패 수정 뒤 관련 재검증에 미해결 실패가 없다. plugin ref는 이전 구현 commit을 가리키고 같은 release에서 version을 증가시킨다.
6. **또는 변경 불필요 입증**
   **Given** 현재 제품에 지원 경로가 있다고 판단한다.
   **When** 재현의 detached 옛 설치본에서 bootstrap부터 실행한다.
   **Then**1~5의 안전/보존·지원 진입·실행 증거를 남긴다. 이미 준비된 새 CLI의 확인 기능만으로 대체하지 않는다.

## Boundaries

기존 A1·offline 확인·owner fence·staged 승격·ref/저장소/이력 검증을 유지한다. 운영 DB/home/계정/예약 변경, 실제 daemon 중지, 과거 migration 변조, clone 강제 브랜치 전환, 내부 환경 변수 수동 우회는 제외한다.21.11은 Garmin 시험 실행 유예 대상이 아니다. 개발·리뷰 수정 중 시험 실행 금지와 개발 뒤 순차 전체 회귀 정책을 따른다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-garmin-extension/epic-garmin-extension.md, E21-6·Notes
- observation — _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/story-mac-plan.md, 재진단2·quick리뷰3
- predecessor — _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-manifest-transition-plan.md, Auto Run Result

## Notes

- Decision(2026-11-06, 중앙): 기존 무인 구현 승인과 closing 운영 인수의 버그 분리 규칙으로21.11을21.10 뒤21.7 앞에 둔다. 구체 진입점 설계는 지휘자가 결정한다. 실제 운영자 확인을 자동화하지 않는다.
- Risk: high — 진입점이 잠금/TTY 계약을 잘못 연결하면 확인 없는 DB 갱신이나 동시 쓰기가 생길 수 있다. 추가 확인: 독립 리뷰가 bootstrap부터 PTY까지의 실행 증거와 hook 무질문 경계를 별도로 대조한다.
