---
type: epic
title: "기존 Garmin 데이터·분석 이전"
parent: personal-brain
covers: [R5, R6, R7]
after: []
refined: false
risk: high
---

# 기존 Garmin 데이터·분석 이전

## Description

Garmin 확장 뼈대와 스키마를 PostgreSQL에 만들고 기존 Garmin 데이터와 분석을 옮긴다.
- 확장 뼈대: `pyproject.toml`·`uv.lock`·`.python-version`·확장 manifest와 DDL 선언. epic-extensions의 등록 방식 위에 처음 만드는 실제 확장이다. 수집·정제 runtime은 epic-garmin-runtime, 평가는 epic-health-analysis가 더한다.
- core 계약 표: 이 에픽이 처음 쓰므로 만든다(2026-10-28, 사용자). 각 표의 RLS(`brain_ext_garmin`은 INSERT만, 자기 출처 행만)와 현재 attempt 대조(AD-30·33)를 함께 둔다.
  - 건강 측정·요약 표와 "현재" view(AD-32): 지표 식별자·정규 단위·값 타입·NULL 의미·계정 identity·날짜/순간·운동 identity·지표별 허용 집계, 관측 revision 순서·정규화 버전 비교·동률 처리·소스 선택 기록, 미선택 충돌의 ambiguity. TS와 Python이 같은 fixture를 통과한다. epic 16·17·18이 소비한다.
  - `analyses` 최소 계약·DDL(AD-35): legacy 원래 키·dataset, nullable 모델·생성 시각과 누락 flag, 파일 요청·파일 관계, 새 분석 revision. epic 18이 호환 확장한다.
  - `file_requests`와 core 인계 일감(AD-23·30): 출처+안정된 요청 키, 요청→`work_items` 인계와 crash 복구, 예상 해시·크기·미디어 타입, 공개 결과 view(`request_id → file_id`/실패), 상태·재개 규칙. 처리한 파일은 기존 추출 일감에 들어간다.
  - `garmin.raw_records` view(AD-30의 고정 모양).
- 스키마: Garmin migrations 0001~0016의 테이블·키·이력 명세를 따른다. raw는 원본 JSON 텍스트를 그대로 보존한다.
- 이전 대상: 기존 Garmin DB 후보 다섯(schema 10·15)과 리포트·facts·이미지·입력 파일 349개. 출처 목록으로 관리한다. 리포트·facts·이미지는 파일 등록 요청으로 core 파일이 되고, `analyses` 행이 그 파일을 가리킨다(AD-23).
- importer 계약(migration-contract "importer 계약")은 다음과 같다.
  - dataset·source table·원래 key가 재실행 식별자이고, batch와 mapping을 저장한다.
  - preflight가 지원 버전·예상 변경·충돌을 출력한다.
  - 원본 SQLite snapshot은 확장의 Python `sqlite3`로 read-only로 읽고, 작은 트랜잭션과 checkpoint로 옮기며, 실패 뒤 재개한다.
  - 검증 보고서는 건수·자연키·원문 해시·NULL/단위·FK·분석 본문·파일 해시를 비교한다.
- 기존 분석은 그대로 등록하고 재분석으로 대체하지 않는다(R7).
- 옛 알림·전송 이력은 epic-channels가 만든 core 채널 이력 표에 legacy로 표시해 넣는다(2026-10-28, 사용자). 이 에픽은 그 표의 모양을 정하지 않는다.
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
- 새 수집·정제는 epic-garmin-runtime, 새 평가는 epic-health-analysis, 검색과 수치 조회는 epic-search-and-health-query다.
- 기존 Brain `brain.db`는 옮기지 않는다(2026-10-28).
- Must not change: 원본 Garmin 저장소에서 normalize·업그레이드 SQL을 실행하지 않는다. 이전된 발신 이력이 메시지를 다시 보내지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R5, R6, R7, Constraints C5, C6
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-8, AD-23, AD-30, AD-31, AD-32, AD-35, AD-36, Table Contract(건강 측정·요약, `analyses`, 채널 발신 요청·이력, `file_requests`)
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, 전체
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S3·S12·E2·E3
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/source-manifest.json (소스 커밋·archive 해시)

## Notes

- Waits on epic-postgres-primary because: core 문서·출처·사용자 테이블과 마이그레이션 실행기가 있어야 한다.
- Waits on epic-jobs-and-scheduler because: importer가 감독되는 확장 일감으로 돌며 임대 갱신과 attempt token을 받는다. 계약 표 INSERT는 DB가 현재 attempt와 대조한다(AD-33).
- Waits on epic-extensions because: Garmin 스키마를 확장 DDL로 선언·등록하고, 확장 패키지 위치와 Python 런타임을 쓴다.
- Decision(2026-10-28): Garmin SQLite snapshot은 Brain의 `node:sqlite`가 아니라 확장의 Python `sqlite3`로 읽기 전용으로 읽는다. 그래서 epic 11이 Brain의 SQLite 경로를 지워도 이전이 가능하다. spine AD-29(확장은 별도 프로세스, 언어 무관)와 AD-36(원형 snapshot을 읽기 전용으로 보존)과 맞다. 이전의 Assumption을 대신한다.
- Decision(2026-10-28, spine AD-23·35): 구형 Markdown·facts·PNG는 파일 등록 요청으로 core 파일이 되고 문서 추출·조각 색인을 탄다. `analyses` 행이 그 파일을 가리킨다. 이전의 Open question을 대신한다.
- Decision(2026-10-28, 사용자): core 계약 표는 처음 쓰는 에픽이 만든다. 이 에픽이 건강 측정·요약 표와 "현재" view, `analyses` 최소 계약, `file_requests`와 그 인계 일감을 만든다. epic 18이 `analyses`를 호환 확장하고, epic 16·17·18이 건강 계약 표를 소비한다. 채널 발신 요청·이력 표는 epic 15가 만든다.
- Open question: 개발/운영 DB 중 기준 소스는 무엇이고, 겹치는 자연키의 충돌은 어떻게 고르나? 실제 반입 전에 사용자가 정한다(C6). 2026-10-28 결정 묶음에서도 묻지 않았다. preflight 보고서를 본 뒤 실제 반입 직전에 정한다(사람 확인 스토리).
- Waits on epic-channels because: 옛 Garmin 알림·전송 이력이 core 채널 발신 이력에 들어간다(2026-10-28, 사용자).
