# 후속 착수 순서 제안

공식 epic/story 분할이나 착수 승인이 아닌 구현 준비 제안이다. 다음 세션은 이 입력을 기존 personal-brain의 변경 계획으로 채택하고, 공유 계약을 먼저 확정한다. 이 폴더만 보고 기존 티켓을 중복 생성하지 않는다.

## 0. 기존 제품 계획에 채택

accepted-intent와 요구사항을 기존 이니셔티브에 반영한다. SQLite primary/Postgres replica, Docker 없음, core LLM0, 사용자 설정DB(E8-7), Drive 우선순위와 충돌/영향을 명시한다. 이미 구현된 Capture/Daemon/Attachments를 다시 만드는 작업은 만들지 않는다.

## 1. PostgreSQL primary와 설정 계약

같은 database의 core/extension schema, identity/source keys, migration owner, Store parity, query/output shape와 최소 bootstrap을 architecture로 정한다. 영속 volume을 가진 OrbStack용 제품 Compose와 테스트 DB를 분리한다. pgvector는 필수화하지 않는다.

첫 tracer 제안: 합성 세션 한 건과 건강 raw 한 건 및 legacy 분석 문서 한 건을 저장하고, 재시작 후 core query로 원문/출처를 읽는다. 기존 Brain 기본 수집 경로의 계약도 이 저장소에서 유지되는지 확인한다.

## 2. 선택 확장과 긴 작업 runtime

확장 비설치/설치/비활성화, 의존성 설치와 compatible version, TS↔Python 실행·저장/설정 계약을 구현한다. 작업 dependencies, independent concurrency, 계정별 직렬성, owner renewal, 진행 정체/오류/취소/worker 사망을 검증한다. calendar/timezone 예약 계약을 정한다. fake worker를 써서 600초 임대 가정에 묶이지 않는 경로를 확인한다.

같은 단계에 공통 확장 설치 CLI와 Brain 플러그인의 install 스킬을 포함한다(R17). 설치 스킬은 Garmin 미설치 상태에도 기본 제공하며, 실제 CLI 지원/설치 상태 확인→필요한 설치→사용자 인증→연결 확인→공통 예약 등록을 안내한다. 설치 후 제공할 Garmin 사용 안내와 공통 설치 스킬을 구분한다. CLI 사용 형태는 `brain install garmin`으로 제안하며 아직 구현된 것으로 취급하지 않는다.

공통 스케줄러 구현은 자동 수집/분석 활성화의 선행 조건이다(R10). 미준비 때는 설정 대기와 수동 실행을 안내하고, 별도 Garmin 전용 예약을 만들지 않는다. 검증에는 이미 설치된 상태 재실행, 부분 성공 뒤 재개, 설치 실패/취소, 로그인 필요와 예약 기능 미준비를 포함한다.

## 3. 기존 데이터 importer

단계1의 schema/mapping을 기준으로 schema10/15 fixture와 legacy 문서 importer를 먼저 검증한다. private capture의 실제 source 선택/충돌을 해결하고, migration-contract의 검증을 통과한 뒤 실제 반입한다. 실제 반입은 이번 준비에 포함되지 않는다.

## 4. Garmin 실행 기능 편입

인증/수집/정규화/body/digest/평가/그래프를 새 저장·작업 포트에 연결한다. 같은 fixture의 수치와 입력 snapshot을 기존 구현과 비교한다. day→7d→30d→all와 결과 즉시 보존, 계정 차단, subprocess 종료를 검증한다. 기존 deploy·별도 Garmin LaunchAgent는 제품 경로에서 core 설치/예약으로 대체한다.

## 5. 텍스트·원문·건강 query와 채널 발신

질문을 해석하는 agent와 실제 query를 실행하는 code의 경계를 제공한다. 텍스트 검색/필터→원문 읽기, typed 건강 집계, 출처·날짜/단위·NULL을 검증한다. 두 글자 한국어·동의어/표현 바꾸기·데이터 없음 회귀 문항을 둔다. 새 임베딩을 요구하지 않는다.

초기 전송을 core channel 계약으로 연결하고 평가와 전송 상태를 분리한다. channel/conversation/thread 식별자는 미래 수신/선제 대화에서도 사용할 수 있게 정한다. Slack과 Telegram의 완전한 양방향 agent 대화 출시는 별도 후속 범위로 계획한다.

## 병렬로 할 수 있는 부분

- 단계1에서 source/key/Store contract가 확정되면 importer(3)와 runtime(2)/Garmin 연결(4)의 일부를 분리해 작업할 수 있다.
- 공통 Store/migration/설정/작업 타입을 수정하는 부분은 순서를 지정한다. 같은 파일을 각 lane이 독립적으로 정의하지 않는다.
- 단계5의 query contract와 회귀 문항은 schema 계약 이후 importer/실행 기능과 병렬 준비할 수 있다.

## 다음 세션에 줄 시작 지시

> `_bmad-output/personal-brain/prep-garmin-absorption/README.md`와 `accepted-intent.md`를 먼저 읽는다. PostgreSQL primary(OrbStack Docker), Garmin optional extension, 기본 제공 공통 install 스킬, 기존 데이터와 분석 보존, DB 설정, 긴 작업과 common channel 방향을 기존 personal-brain 계획에 채택하라. 자동 실행은 Brain 공통 스케줄러를 사용하고 그 구현을 선행 조건으로 둬라. 현재 prep initiative는 미등록 초안이므로 기존 보드와 중복되지 않게 배치하고, shared architecture와 실제 source 선택/충돌을 정한 뒤 구현 작업을 나눠라. 소스는 source-manifest의 archive에 있고 개인 데이터는 원본 Garmin repo의 ignored private capture에 있다. 지금까지 이미 완료된 구현이나 실제 PostgreSQL 반입으로 간주하지 말라.

## 준비 완료의 의미

이 패키지는 사용자 요구·코드 자산·개인 원본 보존·실제 스키마 차이·후속 검증 기준을 넘겨준다. 통합 DDL, PostgreSQL Store parity, importer, extension runtime과 채널 대화는 후속 개발이다. 공식 보드 등록/commit/배포나 데이터 반입을 준비 완료와 혼동하지 않는다.
