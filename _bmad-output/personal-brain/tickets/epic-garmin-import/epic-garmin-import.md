---
type: epic
title: "기존 Garmin 데이터·분석 이전"
parent: personal-brain
covers: [R5, R6, R7]
after: ["epic-postgres-primary", "epic-extensions", "epic-channels"]
refined: false
risk: high
---

# 기존 Garmin 데이터·분석 이전

## Description

Garmin 확장 뼈대와 스키마를 PostgreSQL에 만들고 기존 Garmin 데이터와 분석을 옮긴다.
- 확장 뼈대: `pyproject.toml`·`uv.lock`·`.python-version`·확장 manifest와 DDL 선언. epic-extensions의 등록 방식 위에 처음 만드는 실제 확장이다. 수집·분석 runtime은 epic-garmin-runtime이 더한다.
- 스키마: Garmin migrations 0001~0016의 테이블·키·이력 명세를 따른다. raw는 원본 JSON 텍스트를 그대로 보존한다.
- 이전 대상: 기존 Garmin DB 후보 다섯(schema 10·15)과 리포트·facts·이미지·입력 파일 349개. 출처 목록으로 관리한다.
- importer 계약(migration-contract "importer 계약")은 다음과 같다.
  - dataset·source table·원래 key가 재실행 식별자이고, batch와 mapping을 저장한다.
  - preflight가 지원 버전·예상 변경·충돌을 출력한다.
  - 원본 SQLite snapshot은 확장의 Python `sqlite3`로 read-only로 읽고, 작은 트랜잭션과 checkpoint로 옮기며, 실패 뒤 재개한다.
  - 검증 보고서는 건수·자연키·원문 해시·NULL/단위·FK·분석 본문·파일 해시를 비교한다.
- 기존 분석은 그대로 등록하고 재분석으로 대체하지 않는다(R7).
- 옛 알림·전송 이력은 epic-channels의 core 채널 이력에 출처와 함께 넣는다(2026-10-28, 사용자).
- 실제 반입은 사용자가 기준 소스와 충돌 처리를 정한 뒤에만 한다(C6).

## Outcome

지금까지 쌓인 Garmin 원본과 이미 만든 분석이, 덮이거나 지어낸 값 없이 출처와 함께 Brain의 PostgreSQL에 들어간다(이니셔티브 Done when 7).

## Done when

1. schema 10·15 합성 fixture와 legacy 문서로 importer를 검증한다. 같은 batch를 다시 돌려도 중복·덮어쓰기·발신이 생기지 않고, 중간 실패 뒤 재개된다.
2. private capture를 다시 확인(또는 재캡처)한다. 사용자가 기준 소스와 충돌 처리를 정한 뒤에 실제로 반입한다(사람 확인).
3. 이전 보고서가 출처별 건수·값/본문·해시·관계·미해결 충돌·빠진 metadata를 보인다.
4. 원본 snapshot이 그대로 남고, 개인 데이터와 자격 증명이 공개 저장소에 들어가지 않는다.
5. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 새 수집·평가는 epic-garmin-runtime, 검색과 수치 조회는 epic-search-and-health-query다.
- 기존 Brain `brain.db`는 옮기지 않는다(2026-10-28).
- Must not change: 원본 Garmin 저장소에서 normalize·업그레이드 SQL을 실행하지 않는다. 이전된 발신 이력이 메시지를 다시 보내지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R5, R6, R7, Constraints C5, C6
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, 전체
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S3·S12·E2·E3
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/source-manifest.json (소스 커밋·archive 해시)

## Notes

- Waits on epic-postgres-primary because: core 문서·출처·사용자 테이블과 마이그레이션 실행기가 있어야 한다.
- Waits on epic-extensions because: Garmin 스키마를 확장 DDL로 선언·등록하고, 확장 패키지 위치와 Python 런타임을 쓴다.
- Assumption(2026-10-28): Garmin SQLite snapshot은 Brain의 `node:sqlite`가 아니라 확장의 Python `sqlite3`로 읽는다. 그래서 epic 11이 Brain의 SQLite 경로를 지워도 이전이 가능하다. 아키텍처에서 확인한다.
- Open question: 구형 Markdown·facts·PNG를 core 파일·문서 모델에 넣을지, Garmin 평가 테이블에 넣을지는? 아키텍처가 정하고, 이 에픽과 epic 16·17이 기다린다.
- Open question: 개발/운영 DB 중 기준 소스는 무엇이고, 겹치는 자연키의 충돌은 어떻게 고르나? 실제 반입 전에 사용자가 정한다(C6).
- Waits on epic-channels because: 옛 Garmin 알림·전송 이력이 core 채널 발신 이력에 들어간다(2026-10-28, 사용자).
