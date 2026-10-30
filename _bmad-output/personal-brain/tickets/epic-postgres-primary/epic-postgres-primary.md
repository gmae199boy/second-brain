---
type: epic
status: done
title: "PostgreSQL 단일 주 저장소"
parent: personal-brain
covers: [R3, R4, R18]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary-research-code.md]
after: ["epic-daemon", "epic-attachments"]
risk: high
---

# PostgreSQL 단일 주 저장소

## Description

이 에픽이 끝나면 OrbStack Docker의 PostgreSQL 하나가 Brain의 주 저장소이고, 기존 기능은 그 위에서 SQLite 때와 같은 계약을 지킨다(2026-10-28, 이니셔티브 C1·R3·R18). 범위는 다음과 같다.
- 제품용 Compose: 영속 볼륨을 쓰고, 테스트용 tmpfs Compose(`compose.test.yaml`)와 분리한다. 테스트 Compose도 공식 `postgres:18`로 바꾸고 pgvector 의존을 없앤다.
- 공통 스키마의 PostgreSQL baseline 0001: SQLite 0001~0009의 테이블·키·불변 trigger·청구 인덱스와 같은 수준이다. 전문 색인(조각·도구 메모·작업 로그·문서·파일 이름)도 PostgreSQL에 둔다.
- 마이그레이션 실행기 하나: 소유자별 버전 표와 확장이 자기 DDL을 넣을 자리를 포함한다.
- PostgreSQL Store: Store port 전부를 구현하고 공통 계약 테스트를 통과한다. DB에 못 쓸 때의 오류 분류와 spool, 저장본 가리기와 그 뒤의 정리를 포함한다.
- 사용자 설정 DB와 `brain config get/set`: epic-drive E8-7에서 옮겨 왔다. 지금 `config.toml`에 있는 시간대도 사용자 설정으로 DB에 옮긴다(2026-10-28, 사용자).
- 설치(`setup run`)·플러그인 bootstrap의 갱신 경로(ff+build)·doctor·`setup uninstall`의 PostgreSQL 경로: OrbStack과 컨테이너 상태를 확인하고, DB가 꺼져 있으면 spool로 보낸다. `setup upgrade`는 아직 없다(epic-operations).
- 데몬의 컨테이너 재연결(AD-27): DB에 닿지 않으면 backoff로 `compose up`을 다시 부른다.
- 런타임 전환, 전환 뒤 Brain Store의 SQLite adapter(`packages/sqlite`)와 런타임·테스트의 `node:sqlite` 경로 삭제, 플러그인 배포.

기존 `brain.db`는 옮기지 않는다(운영 전, 2026-10-28). 빈 DB로 설치하고 디스크의 transcript를 다시 가져온다. 기존 구현은 다시 쓴다: `packages/postgres`의 연결·마이그레이션·setup, `@second-brain/test-db`, Store 계약 테스트. 지금 PG Store는 Store verb 49개 중 3개만 구현한다(코드 조사 §3).

## Outcome

컨테이너를 다시 만들어도 남는 PostgreSQL 하나에 이 Mac의 Brain이 쓰고 읽으며, Garmin 없이도 기존 수집·첨부·doctor가 그대로 동작한다(이니셔티브 Done when 6).

## Requirements

- E11-1 (R3): 제품 컨테이너 — setup이 `<home>/postgres/compose.yaml`(공식 `postgres:18`, named volume, `127.0.0.1` 포트, `restart: unless-stopped`, 비밀번호는 `.env`)을 쓰고 `docker compose up -d --wait`로 띄운다. compose project·볼륨·포트·LaunchAgent Label은 Brain 홈에서 함수 하나로 만들고, 기본 홈이 아니면 접미사를 붙여 개발·테스트가 운영 자원을 건드리지 않는다. 컨테이너를 지우고 다시 만들어도(볼륨 유지) 데이터가 같은 값(ID·시각)으로 되읽힌다. 테스트 Compose는 공식 `postgres:18`(tmpfs)이고 pgvector·`vector` 의존이 없다. (AD-34, C2)
- E11-2 (R3): role·schema·마이그레이션 — setup만 마이그레이션 소유자 role과 `brain_app`, core schema `brain`을 만들고, 생성한 비밀번호를 `.env`(0600)에 둔다. 런타임은 `[store] url_env`(기본 `BRAIN_DATABASE_URL`)가 가리키는 `brain_app` 접속만 쓰고 database·schema·role을 만들지 않으며, 없으면 `DB_UNAVAILABLE`이다. 실행기 하나가 `brain.schema_migrations(owner, version, name, checksum, applied_at)`에 소유자별 연속 번호로 기록하고, 파일마다 자기 트랜잭션에서 advisory lock 아래 적용하며, 번호 중복·누락과 적용된 파일의 checksum 변경을 거부한다. 확장 소유자의 마이그레이션을 받을 자리가 있다. (AD-10·20·30·31)
- E11-3 (R18): baseline 0001 — SQLite 0001~0009와 같은 수준의 core 표(singleton `schema_version` 대신 `schema_migrations`, `settings` 추가), 멱등 UNIQUE 키, 불변·변경 규칙(plpgsql trigger, TRUNCATE 방어), 청구·due 색인, 검색 대상 다섯 열(`chunks.body`, `log_entries.text`, `tool_notes.target`, `document_chunks.body`, `file_names.text`)의 `lower(col)` pg_trgm expression GIN을 담는다. DB는 값을 만들지 않는다(`DEFAULT now()`·serial·identity 없음). `chunk_locator`는 Core 정규형 그대로의 `text`이고 JSON object인지 CHECK한다. (AD-15·22·24·31, Table Contract)
- E11-4 (R18): PostgreSQL Store — Store port 전부를 구현하고 공통 계약 suite를 PG에서 통과한다. 쓰기는 `withWrite` 하나, 같은 세션 수집은 세션 토큰의 `pg_advisory_xact_lock`, 일감 청구는 `FOR UPDATE SKIP LOCKED`, 연결 설정(경로별 `lock_timeout`·`statement_timeout`·`application_name`·UTC)은 연결 함수 한 곳이다. 쓴 ID·시각이 같은 값으로 되읽힌다. 계약 밖의 adapter 시험으로 두 프로세스의 청구 중복 없음, 같은 세션 동시 수집, 직접 SQL UPDATE·DELETE 거부를 확인한다. (AD-7·8·22)
- E11-5 (R18): DB에 못 쓸 때 — 연결 거부·접속 끊김과 `brain` schema 없음은 모든 verb에서 `DB_UNAVAILABLE`, 잠금 초과는 `DB_LOCKED`, 소유자별 버전 불일치는 `SCHEMA_MISMATCH`로 내려가 기존 spool 경로가 그대로 돈다. hook 경로의 연결 시도는 경로별 Core 상수의 짧은 시간 한도를 넘으면 spool로 가서 Harness를 막지 않는다. DB가 돌아오면 drain이 spool을 넣는다. (AD-7·9·20, NFR-3)
- E11-6 (R18; spec CAP-2): 저장본 가리기 — `messages.redact`·`files.redact`가 PG에서 한 트랜잭션 연쇄(본문 치환, `redactions`, 파생물 삭제, 정리 일감)를 지키고, 실패하면 되돌리며 spool하지 않는다. 표시는 트랜잭션 로컬 GUC `brain.redacting`이다. 정리 일감은 트랜잭션 밖의 `VACUUM FULL` 뒤 `CHECKPOINT`이고, 끝날 때까지(실패·권한 부족·잠금 대기 포함) doctor가 `warn`이다. 정리 권한은 제한된 경로로만 주고 확장에는 주지 않는다. (AD-11)
- E11-7 (R4): 사용자 설정 — `brain.settings(key, value, updated_at)`와 `brain config get/set`(CLI·SDK·명령 메타). 키는 설정 코덱이 정의하고, 첫 키는 `timezone`(기본 `Asia/Seoul`, 유효한 IANA 이름)이다. setup은 `config.toml`의 `timezone`을 기본값으로 보여 주고 DB에 쓰며, 그 뒤로 `config.toml`의 `timezone`은 읽지 않고 남아 있으면 doctor가 `warn`이다. 확장 키 `<ext>.*`의 자리가 있다. 기계 값은 `config.toml`, 비밀은 `.env`다. 값이 재시작·컨테이너 재생성 뒤에도 남는다. (AD-18)
- E11-8 (R3, R18): 설치·갱신·doctor·제거 — `setup run`과 플러그인 bootstrap 갱신 경로가 OrbStack 확인(없거나 꺼져 있으면 안내하고 멈춤) → compose → 컨테이너 → role·schema → 마이그레이션 → "나" → 시간대 → … → doctor → 완료 기록을 멱등으로 돌고, 디스크의 transcript를 다시 가져온다. 이 Mac의 옛 `brain.db`는 지우지 않고 "더 쓰지 않음" 한 줄을 보인다. doctor는 OrbStack·컨테이너·DB 접속·쓰기·pg_trgm·소유자별 schema 버전을 보이고, OrbStack이 실패하면 DB 항목을 이유와 함께 건너뛴다. 조회 명령은 컨테이너를 띄우지 않는다. `setup uninstall`은 컨테이너를 내리고, 볼륨은 명시적 확인 없이는 남긴다. (AD-19·20·34)
- E11-9 (R3, R18): 데몬 재연결 — DB에 닿지 않으면 데몬이 `docker compose -f <home>/postgres/compose.yaml up -d`를 backoff로 다시 부르고(drain 깨움이 backoff를 건너뛰지 않음), 다시 닿으면 schema 확인 뒤 drain이 spool을 넣는다. hook과 명령은 컨테이너를 띄우지 않는다. (AD-27·34)
- E11-10 (R3, R18): 전환과 삭제 — 런타임(CLI·데몬·hook·bootstrap)이 PG Store만 쓰고, `packages/sqlite`, 런타임과 테스트의 `node:sqlite` import, SQLite 전용 doctor·설치 단계, `second_brain`의 SQLite 재export가 저장소에서 없어진다. 전환 뒤 Store 시험은 모두 PG에서 돈다. (AD-10)

## Constraints

- C1 (parent): PostgreSQL 단일 주 저장소와 OrbStack Docker(영속 볼륨)는 확정이다. SQLite 원본 + Postgres 복제를 유지하는 완료안은 인정하지 않는다.
- C2 (parent): pgvector를 쓰지 않는다. 임베딩·Drive 구현을 선행 조건으로 만들지 않는다.
- spec Constraints: hook은 Harness를 막지 않는다(async, exit 0). 원문 불변과 나갈 때 가리기를 지킨다. Node 24 이상, Core·CLI는 TypeScript다.

## Done when

1. OrbStack이 없거나 꺼져 있으면 설치기와 doctor가 설치·실행 방법을 안내하고 멈춘다(OrbStack은 선행 조건, 2026-10-28). OrbStack이 있는 Mac에서 설치하면 영속 볼륨을 가진 PostgreSQL 컨테이너가 뜨고 스키마가 만들어지며, 디스크의 transcript를 가져온 뒤 다음 Claude Code 세션이 hook으로 수집된다.
2. 컨테이너를 지우고 다시 만들어도(볼륨 유지) 세션·메시지·파일·설정이 같은 값(ID·시각)으로 되읽힌다.
3. Store 공통 계약 테스트(멱등, 원문 불변, 첨부·추출, 일감 청구, schedules, 저장본 가리기)를 PostgreSQL에서 통과하고, Brain Store의 SQLite adapter와 런타임·테스트의 `node:sqlite` 경로가 저장소에서 없어졌다.
4. PostgreSQL이 꺼져 있을 때 hook이 Harness를 막지 않고 spool에 남긴다. doctor가 DB·컨테이너 상태를 보이고, DB를 다시 켜면(데몬의 재연결 포함) drain이 spool을 넣는다.
5. `brain config set`으로 바꾼 사용자 설정(시간대 포함)이 재시작과 컨테이너 재생성 뒤에도 남는다. 기계별 값은 `config.toml`, 비밀은 `.env`에 남는다.
6. 기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 확장 DDL은 자리까지만 만든다. Garmin 스키마 내용은 epic-garmin-import, 확장 설치·등록과 `brain_ext_<name>` role은 epic-extensions다.
- 전문 색인은 PostgreSQL 대응(스키마와 쓰기)까지만 한다. 대화 조각 생성, 에이전트용 검색 질의, 결과 계약은 epic-search-and-health-query다.
- 임대 갱신·작업 의존성·현지 시각 예약·감독자는 epic-jobs-and-scheduler다.
- 백업·복구는 epic-operations다.
- `drive.keep_local_days` 키 등록은 epic-drive다. 이 에픽은 설정 틀과 `timezone`을 만든다.
- pgvector는 쓰지 않는다(C2).
- Must not change: 원문 불변, 나갈 때 가리기, hook이 Harness를 막지 않음(R18).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R3, R4, R18, Constraints C1, C2
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7·8·9·10·11·15·18·19·20·21·22·24·27·30·31·34, Stack, Table Contract, Consistency Conventions
- research — _bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary-research-code.md (현재 PG 코드, SQLite 전용 경로, Store verb·계약 case 수, chunk_locator, 설정, 컨테이너 접점, collision map)
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "단일 DB 경계"
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S2·S4·E1·E5
- epic — _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md, E8-7(옮겨 옴)

## Notes

- Decision(2026-10-30, 감독자 종료 R-2): E11-1~10과 Done when 1~6을 티켓 결과에 대조했다. 11.13의 원격 배포 확인은 운영자 목록에 남기며 DW-8~11은 수동 sweep 대상이다.

- Waits on epic-daemon because: setup run·플러그인 bootstrap 갱신·doctor·데몬 재시작 흐름과 플러그인 배포 경로가 있어야 PostgreSQL 설치·점검 단계를 더할 수 있다.
- Waits on epic-attachments because: SQLite 0008(첨부·추출 변경 규칙 trigger)과 FileStore·추출 세대 Store 계약이 PostgreSQL로 옮길 마지막 SQLite 스키마다. 10.1·10.2·10.3·10.4·10.6도 완료로 닫았고, 에픽은 열린 항목을 남긴 채 닫혔다(2026-10-28, `epic-attachments-closure.md`).
- Decision(2026-10-28, 사용자): 기존 `brain.db`는 옮기지 않는다. 빈 PostgreSQL에 설치하고 transcript를 다시 가져오며, 전환 뒤 SQLite 경로를 지운다.
- Decision(2026-10-28): epic-drive의 E8-7(사용자 설정 DB와 `brain config get/set`)을 이 에픽으로 옮겼다. 확장 설정(R4)도 같은 계약을 쓴다.
- Decision(2026-10-28, spine 갱신): 정제 전에 아키텍처가 정하기로 한 스키마·잠금 질문은 spine이 답했다. 이전의 Open question을 대신한다.
  - 한국어 텍스트 색인: `lower(col) LIKE`와 pg_trgm expression GIN(AD-15)
  - 잠금·트랜잭션: AD-7
  - 불변 규칙: plpgsql trigger, core baseline 0001에 함께 넣는다(Table Contract, Conventions)
  - 컨테이너: 공식 `postgres:18`, named volume, `restart: unless-stopped`, 로그인 때는 OrbStack이 띄우고 닿지 않으면 데몬이 다시 띄운다(AD-27·34)
  - schema 경계와 마이그레이션: core schema `brain`, `brain.schema_migrations(owner, version, …)`, 실행기 하나, PG 0001부터 다시 끊는다(AD-30·31)
- Decision(2026-10-28, 사용자): 시간대를 `config.toml`에서 사용자 설정 DB로 옮긴다. 예약(epic 12)과 현지 날짜 질의(epic 17)가 이 값을 쓴다. epic-drive의 2026-10-27 "나중에 정한다"를 대신한다.
- Decision(2026-10-28, 사용자): OrbStack은 사용자가 설치하는 선행 조건이다. 설치기는 OrbStack을 설치하지 않고, 없거나 꺼져 있으면 안내하고 멈춘다.
- Decision(2026-10-28, 사용자, 정제): `chunk_locator`는 `text`로 저장한다. Core 정규형 바이트를 그대로 보존하고, V1에는 locator 안을 질의하는 곳이 없으며, 성능 차이가 없다.
- Decision(2026-10-28, 사용자, 정제): tracer는 실제 hook 명령까지 관통한다. 수집 경로의 Store만 먼저 PG로 옮기고 명령별로 Store 타입을 좁힌다. SQLite는 런타임 전환 스토리까지 기본값으로 남는다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 개발 홈에서 `setup run`이 제품 compose·볼륨과 baseline의 수집 부분을 올리고, hook이 부르는 `brain sessions ingest`가 PG에 쓴 세션이 컨테이너를 다시 만들어도 남는다. 1은 그 경로가 실제로 부르는 verb만 구현하고, Core 수집 use case와 CLI 명령 조립을 그 capability로 좁힌다. 나머지 세션 verb와 계약은 14다(세트 검증 S1). 사람이 이 Mac의 OrbStack을 확인하고 판별 probe 결과를 남긴다(hitl, 8이 쓴다. 세트 검증 F3). 다음은 가장 덜 확실한 동시성·가리기 경계다: 2(baseline 완성) 뒤 3(청구)·4(추출)·5(가리기와 정리).
- Decision(2026-10-28, 스토리 계획): `packages/postgres`의 0001·Store 조립과 CLI 조립을 여러 스토리가 함께 고치므로 1·14·2~7은 한 줄로 만든다(6이 5를, 7이 6을 기다리는 것은 공유 코드 때문이다). 7이 hook·명령·데몬이 함께 쓰는 PG 조립과 소유자별 기대 버전을 만들고(세트 검증 S2), 8(설치·doctor)과 9(데몬)는 그 위에서 나란히 갈 수 있다. 둘이 쓰는 외부 명령 runner는 1이 만든다. 10은 SQLite 선택을 없애는 마감이다. baseline 0001은 2에서 모양을 갖추고 10에서 checksum을 고정한다. 그 전에는 개발 DB를 다시 만든다.
- Decision(2026-10-28, 스토리 계획): 스토리는 14개로 보통 범위(8~12)를 넘지만 에픽을 나누지 않는다. 런타임 전환 전까지 SQLite가 기본값이라 중간에 운영으로 내보낼 묶음이 없고, 나누면 앞 에픽이 배포 없이 끝난다. Refactor sweep(12) 뒤에 이 Mac 확인(13)을 둔다(epic-daemon 선례).
- Decision(2026-10-28, 정제, 사용자 이의 없음): 자원 이름은 Brain 홈에서 파생하고 기본 홈이 아니면 접미사를 붙인다. role과 비밀번호는 setup이 `.env`에 쓴다. 런타임 전환과 SQLite 삭제는 별도 스토리다. 전환 뒤 Store 시험은 모두 PG에서 돌아, 2026-10-26의 "Postgres 테스트는 해당 시에만" 결정을 대체한다. hook 경로의 연결 시간 한도는 Core 상수다. 옛 `brain.db`는 지우지 않는다. 데몬 재연결은 이 에픽 범위다.
- Decision(2026-10-28, 사용자): 11.1의 사람 단계(이 Mac의 OrbStack 확인)를 착수 전에 끝냈다. 그래서 11.1의 hitl을 풀었다. probe 결과는 다음과 같고, 8이 판별에 쓴다.
  - `/Applications/OrbStack.app`이 있고, `orb`·`orbctl` CLI가 `/usr/local/bin`에 있다. `orb version`은 2.2.5.
  - `docker context show`는 `orbstack`이고, 엔드포인트는 `unix://~/.orbstack/run/docker.sock`이다. `default` context는 `/var/run/docker.sock`을 가리킨다.
  - 꺼져 있으면 `orb status`가 `Stopped`이고 소켓 파일이 없어 `docker version`이 연결 실패(no such file)로 끝난다. 켜면 `orb status`가 `Running`이고 Docker 엔진은 29.8.2 linux/arm64다.
  - Docker Desktop과 가르는 근거: context 이름 `orbstack`과 `orb status`. `docker info` 성공만으로는 OrbStack이라고 볼 수 없다.
- Decision(2026-10-28, 사용자): 이 에픽은 루프로 무인 실행한다. epic-daemon처럼 `plan_checkpoint`·`done_checkpoint`는 두지 않는다. 루프는 hitl인 11.13(이 Mac 확인)과 에픽 닫기에서만 멈춘다. 루프가 도는 동안 OrbStack은 켜져 있어야 한다.
- Decision(2026-10-28, 추천으로 정함, 11.1 escalation 해소): transcript에서 온 텍스트에 U+0000이 들어 있으면 PG `text`에 넣지 못한다(SQLSTATE 22021). 원문 보존(AD-11)을 지키려고 쓰기 코덱 하나가 그 값을 둘로 나눈다. `text` 칸에는 U+0000을 U+FFFD로 바꾼 값을 넣는다. 검색·색인·표시가 이 값을 쓴다. 같은 행의 nullable `bytea` 짝 칸(예: `body_raw`)에는 원래 문자열의 UTF-8 바이트를 그대로 넣는다. U+0000이 없으면 짝 칸은 NULL이다. 읽기는 짝 칸이 있으면 그 바이트를 원문으로 돌려준다. 그래서 Core가 보는 값은 원래 문자열과 바이트 단위로 같다. 적용 범위는 parser가 transcript 내용에서 채우는 모든 `text` 칸이다(최소 `messages.body`, 그 밖에 수집 경로가 transcript 문자열을 넣는 칸). 짝 칸은 그 칸을 만드는 baseline 마이그레이션에 함께 둔다. 입력은 거부하지 않는다. 거부하면 메시지가 조용히 빠져 SM-5 = 0을 깬다. 출력은 나갈 때 기존 출력 코덱을 거친다. 텍스트 모드는 U+0000을 `\u0000`으로 보이고, JSON은 원래 escape를 쓴다. 11.2·11.4·11.14 등 transcript 텍스트 칸을 더하는 스토리도 같은 규칙과 코덱을 쓴다. spine AD-11과 Table Contract에는 다음 `bmad-architecture` 갱신 때 이 규칙을 적는다(epic 18 전 AD-35 갱신과 함께).
- Decision(2026-10-29, 추천으로 정함, 11.13 hitl 해소): 11.13(이 Mac 확인)은 에이전트가 로컬 설치본으로 하고 `hitl = false`로 바꾼다. 2026-10-28 위임(이 Mac에서 에이전트가 할 수 있는 확인·로컬 플러그인 배포는 `hitl = false`, 증거는 plan)과 사람 개입 없이 끝까지 가라는 지시가 위 "루프는 hitl인 11.13에서 멈춘다" 결정을 대체한다. 다른 에픽의 이 Mac 확인 스토리(12.12 등)와 같은 방식이다. DB를 끄는 단계 뒤에는 다시 켜고 drain을 마친 상태로 돌려 둔다. 원격 push는 사람 몫이다.
