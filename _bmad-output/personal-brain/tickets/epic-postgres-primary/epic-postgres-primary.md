---
type: epic
title: "PostgreSQL 단일 주 저장소"
parent: personal-brain
covers: [R3, R4, R18]
after: ["epic-daemon", "epic-attachments"]
refined: false
risk: high
---

# PostgreSQL 단일 주 저장소

## Description

이 에픽이 끝나면 OrbStack Docker의 PostgreSQL 하나가 Brain의 주 저장소이고, 기존 기능은 그 위에서 SQLite 때와 같은 계약을 지킨다(2026-10-28, 이니셔티브 C1·R3·R18). 범위는 다음과 같다.
- 제품용 Compose: 영속 볼륨을 쓰고, 테스트용 tmpfs Compose(`compose.test.yaml`)와 분리한다.
- 공통 스키마의 PostgreSQL 마이그레이션: SQLite 0001~0009의 테이블·키·불변 trigger·청구 인덱스와 같은 수준이다. 전문 색인(조각·도구 메모·작업 로그·문서·파일 이름)도 PostgreSQL에 둔다.
- 마이그레이션 실행기 하나: 확장이 자기 DDL을 선언해 넣을 자리를 포함한다.
- PostgreSQL Store: Store 공통 계약 테스트를 통과한다.
- 사용자 설정 DB와 `brain config get/set`: epic-drive E8-7에서 옮겨 왔다. 지금 `config.toml`에 있는 시간대도 사용자 설정으로 DB에 옮긴다(2026-10-28, 사용자).
- 설치(`setup run`)·플러그인 bootstrap의 갱신 경로(ff+build)·doctor의 PostgreSQL 경로: OrbStack과 컨테이너 상태를 확인하고, DB가 꺼져 있으면 spool로 보낸다. `setup upgrade`는 아직 없다(epic-operations).
- 런타임 전환, 전환 뒤 Brain Store의 SQLite adapter(`packages/sqlite`)와 런타임의 `node:sqlite` 경로 삭제, 플러그인 배포.

기존 `brain.db`는 옮기지 않는다(운영 전, 2026-10-28). 빈 DB로 설치하고 디스크의 transcript를 다시 가져온다. 기존 구현은 다시 쓴다: `packages/postgres`의 연결·마이그레이션·setup, `@second-brain/test-db`, Store 계약 테스트.

## Outcome

컨테이너를 다시 만들어도 남는 PostgreSQL 하나에 이 Mac의 Brain이 쓰고 읽으며, Garmin 없이도 기존 수집·첨부·doctor가 그대로 동작한다(이니셔티브 Done when 6).

## Done when

1. OrbStack이 없거나 꺼져 있으면 설치기와 doctor가 설치·실행 방법을 안내하고 멈춘다(OrbStack은 선행 조건, 2026-10-28). OrbStack이 있는 Mac에서 설치하면 영속 볼륨을 가진 PostgreSQL 컨테이너가 뜨고 스키마가 만들어지며, 디스크의 transcript를 가져온 뒤 다음 Claude Code 세션이 hook으로 수집된다.
2. 컨테이너를 지우고 다시 만들어도(볼륨 유지) 세션·메시지·파일·설정이 같은 값(ID·시각)으로 되읽힌다.
3. Store 공통 계약 테스트(멱등, 원문 불변, 첨부·추출, 일감 청구, schedules)를 PostgreSQL에서 통과하고, Brain Store의 SQLite adapter와 런타임의 `node:sqlite` 경로가 저장소에서 없어졌다.
4. PostgreSQL이 꺼져 있을 때 hook이 Harness를 막지 않고 spool에 남긴다. doctor가 DB·컨테이너 상태를 보이고, DB를 다시 켜면 drain이 spool을 넣는다.
5. `brain config set`으로 바꾼 사용자 설정(시간대 포함)이 재시작과 컨테이너 재생성 뒤에도 남는다. 기계별 값은 `config.toml`, 비밀은 `.env`에 남는다.
6. 기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 확장 DDL은 자리까지만 만든다. Garmin 스키마 내용은 epic-garmin-import, 확장 설치·등록은 epic-extensions다.
- 전문 색인은 PostgreSQL 대응(스키마와 쓰기)까지만 한다. 대화 조각 생성, 에이전트용 검색 질의, 결과 계약은 epic-search-and-health-query다.
- 임대 갱신·작업 의존성·현지 시각 예약은 epic-jobs-and-scheduler다.
- 백업·복구는 epic-operations다.
- pgvector는 쓰지 않는다(C2).
- Must not change: 원문 불변, 나갈 때 가리기, hook이 Harness를 막지 않음(R18).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R3, R4, R18, Constraints C1
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7·9·10·18·20·21·22, Stack, Table Contract (2026-10-28 PostgreSQL로 고칠 대상)
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "단일 DB 경계"
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S2·S4·E1·E5
- epic — _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md, E8-7(옮겨 옴)

## Notes

- Waits on epic-daemon because: setup run·플러그인 bootstrap 갱신·doctor·데몬 재시작 흐름과 플러그인 배포 경로가 있어야 PostgreSQL 설치·점검 단계를 더할 수 있다.
- Waits on epic-attachments because: SQLite 0008(첨부·추출 변경 규칙 trigger)과 FileStore·추출 세대 Store 계약이 PostgreSQL로 옮길 마지막 SQLite 스키마다. 10.1·10.2·10.3·10.4·10.6은 리뷰 중이다.
- Decision(2026-10-28, 사용자): 기존 `brain.db`는 옮기지 않는다. 빈 PostgreSQL에 설치하고 transcript를 다시 가져오며, 전환 뒤 SQLite 경로를 지운다.
- Decision(2026-10-28): epic-drive의 E8-7(사용자 설정 DB와 `brain config get/set`, 첫 키 `drive.keep_local_days`)을 이 에픽으로 옮겼다. 확장 설정(R4)도 같은 계약을 쓴다.
- Open question: 스키마·잠금 방식을 아키텍처가 정한다(`bmad-architecture`, 정제 전). 정할 것:
  - SQLite FTS5 trigram을 대신할 한국어 텍스트 색인
  - `withWrite`·`BEGIN IMMEDIATE`·`busy_timeout`의 PostgreSQL 대응
  - 불변 trigger
  - 컨테이너 이미지(지금 테스트는 `pgvector/pgvector:pg18`)와 로그인 때 컨테이너를 누가 띄우는지(OrbStack·restart 정책, 데몬과의 관계)
  - 공통·확장 schema 경계와 마이그레이션 버전 추적
- Decision(2026-10-28, 사용자): 시간대를 `config.toml`에서 사용자 설정 DB로 옮긴다. 예약(epic 12)과 현지 날짜 질의(epic 17)가 이 값을 쓴다. epic-drive의 2026-10-27 "나중에 정한다"를 대신한다.
- Decision(2026-10-28, 사용자): OrbStack은 사용자가 설치하는 선행 조건이다. 설치기는 OrbStack을 설치하지 않고, 없거나 꺼져 있으면 안내하고 멈춘다.
