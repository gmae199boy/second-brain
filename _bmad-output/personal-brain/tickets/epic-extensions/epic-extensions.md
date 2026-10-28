---
type: epic
title: "확장 설치와 install 스킬"
parent: personal-brain
covers: [R1, R16, R17]
after: ["epic-postgres-primary", "epic-jobs-and-scheduler"]
refined: false
risk: high
---

# 확장 설치와 install 스킬

## Description

선택 확장을 설치·활성화·비활성화하고 그 상태를 Brain이 관리한다. 범위는 다음과 같다.
- 확장 실행 환경(uv·Python ≥3.12와 잠금 파일)과 데이터는 Brain의 공통 설치 위치와 DB에 둔다. 플러그인의 버전별 캐시에는 두지 않는다.
- TS core와 확장 사이의 포트는 spine이 정했다: manifest(AD-29), DB 계약(AD-30), 프로세스 규약(AD-33). 이 에픽은 manifest JSON Schema와 설정 snapshot 전달을 만들고, epic 12가 만든 프로세스 ABI v1을 manifest 버전에 묶는다. TS·Python이 같은 fixture를 통과한다.
- 확장 registry: 설치·활성 상태의 유일한 작성자이고 공개 상태 view를 낸다. 검색·doctor·install 스킬이 이 view를 읽는다. 비활성화는 예약 발화와 새 청구를 막고, 대기·진행 작업의 중단 상태를 기록한다(AD-29).
- 설치 때 확장 schema와 `brain_ext_<name>` role(non-superuser·NOBYPASSRLS, 출처를 role에 결합)을 만들고, 확장 마이그레이션을 core 실행기로 적용한다(AD-30·31). 확장은 `<home>/extensions/<name>/`에 둔다(AD-34).
- 설치 CLI: 제안 형태는 `brain install <확장>`이다.
- Brain 플러그인에 기본 포함하는 공통 install 스킬. 순서는 CLI 지원·설치 상태 확인 → 설치 → 사용자 로그인 안내 → 연결 확인 → 공통 스케줄러에 예약 등록 → 단계별 실제 결과 보고다.
- Garmin을 설치하지 않은 Brain은 Python 의존을 요구하지 않는다.

상세 규칙은 integration-boundaries "확장 설치 안내 스킬"에 있다(2026-10-28, 이니셔티브 R1·R16·R17).

## Outcome

Garmin을 쓰지 않는 사용자는 아무것도 더 설치하지 않는다. 쓰는 사용자는 "Garmin 연결해 줘"라고 말하면 에이전트가 설치부터 예약까지 실제 상태를 확인하며 안내한다(이니셔티브 Done when 8의 설치 부분).

## Done when

1. Garmin 미설치 Brain이 Python 없이 설치·수집·doctor를 통과한다.
2. install 스킬로 미설치 → 설치 → 로그인 → 연결 확인 → 예약 등록의 정상 경로가 테스트 확장에서 돈다.
3. 이미 설치되었거나 부분 설정된 상태에서 다시 돌리면 중복 설치 없이 이어 간다. 설치 실패·취소·로그인 미완료·스케줄러 미준비는 단계별로 구분해 보고하고, 끝나지 않은 단계를 완료로 보고하지 않는다.
4. 확장을 비활성화해도 그 데이터가 남고, 확장 상태와 멈춘 작업이 드러난다. 검색 응답에 꺼진 상태를 보이는 일은 epic-search-and-health-query다.
5. 플러그인을 업데이트해도 확장 환경이 남고, 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Garmin 수집·정제는 epic-garmin-runtime, 건강 분석은 epic-health-analysis, Garmin 스키마와 기존 데이터는 epic-garmin-import다.
- 각 core 계약 표의 RLS 정책은 그 표를 만드는 에픽(14·15)이 둔다. 이 에픽은 role과 출처 결합 규칙만 만든다.
- 공개 plugin marketplace와 임의 서드파티 확장 코드 실행은 범위 밖이다.
- Must not change: 비밀번호·MFA를 대화나 스킬 본문에 저장하지 않는다. 설치 명령이 없으면 임의 패키지 설치로 우회하지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R1, R16, R17, Constraints C4
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "확장 설치 안내 스킬", "실행·의존성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-1, AD-18, AD-19, AD-29, AD-30, AD-31, AD-33, AD-34

## Notes

- Waits on epic-postgres-primary because: 확장 DDL을 받을 마이그레이션 실행기, 사용자·확장 설정 DB, PostgreSQL 위 설치 흐름이 필요하다.
- Waits on epic-jobs-and-scheduler because: install 스킬의 예약 단계가 공통 스케줄러의 등록 API를 부르고, 연결 확인이 감독자와 프로세스 ABI v1로 테스트 확장의 명령을 자식 프로세스로 부른다.
- Decision(2026-10-28, spine AD-29·30·33·34): TS↔Python 포트는 manifest·DB 계약·프로세스 규약이고, 확장 패키지는 `<home>/extensions/<name>/`(spine [ASSUMPTION])에 둔다. 이전의 Open question을 대신한다.
- Open question: 비활성화할 때 진행 중인 작업을 어떻게 끝내나? registry와 취소 ABI를 만들기 전에 epic 12와 함께 정한다(spine Deferred).
