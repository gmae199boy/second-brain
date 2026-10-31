---
type: epic
title: "기존 Garmin 데이터·분석 이전"
parent: personal-brain
covers: [R5, R6, R7]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-research-code.md]
after: []
refined: true
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
- 실제 반입은 기준 소스와 충돌 처리를 정한 뒤에만 한다(C6). 2026-10-28 사용자 위임으로 추천 규칙(선택지 A)을 정했고, 에이전트가 반입한다.

코드 조사(2026-10-28, `epic-garmin-import-research-code.md`)가 찾은 것은 다음과 같다.
- 관찰 DB 다섯 모두 manifest와 schema·건수·해시가 같다. 파일 349개는 모두 있고 크기가 같다. schema 16의 evaluation·day_summary·workout·exercise_log는 어느 후보에도 없다.
- D1(개발)과 D2(운영)는 겹치는 모든 키에서 값이 같다. 충돌은 보관본 D4·D5와의 사이에만 있다(표별 충돌 키 220개, 건강 파생 값 7개). D4·D5에만 있는 BB 샘플 4행씩은 최신 후보에 없다.
- raw에는 계정 칸이 없다. `garmin.raw_records`에는 scope가 없는데 key는 day와 activity 양쪽에 있다.
- 옛 store reader는 최신 schema가 아니면 거부한다. importer는 migration·normalize를 부르지 않는 표준 `sqlite3` reader가 따로 있어야 한다.
- 옛 의존(curl-cffi, garminconnect, jsonschema, matplotlib, requests)에 PG driver가 없다. driver를 더하면 다시 잠가야 한다.

## Outcome

지금까지 쌓인 Garmin 원본과 이미 만든 분석이, 덮이거나 지어낸 값 없이 출처와 함께 Brain의 PostgreSQL에 들어간다(이니셔티브 Done when 7).

## Requirements

- E14-1 (R5, R6; C4): 확장 뼈대 — `extensions/garmin/`에 `pyproject.toml`·`uv.lock`·`.python-version`(pin 3.14.10, spine Stack의 새 배포 pin·doctor 보안 기준)·manifest v1이 있고, epic 13의 설치 흐름(`brain ext install garmin`)으로 `<home>/extensions/garmin/`에 frozen 설치된다. 이 에픽의 Python 의존은 PG driver `psycopg[binary]` 3(sync)뿐이고, 옛 snapshot은 표준 `sqlite3`로 읽는다. manifest는 import 일감(`supervised`, 수동 실행 허용)·연결 확인·garmin DDL 위치·raw view를 선언하고, 인증·수집 예약은 비워 둔다(epic 16). macOS arm64에서 frozen 설치·driver import·PG 접속과 UTF-8·epoch ms·NULL 왕복이 검증된다. (AD-29·31·34, spine Deferred "Garmin lock·설치 재현성"의 epic 14 몫)
- E14-2 (R5, R6, R7): garmin 보존 schema — 확장 마이그레이션(소유자 `garmin`, core 실행기가 적용)이 옛 migrations 0001~0016의 표·키·NULL·단위를 옮긴 보존 표와 importer 상태 표를 둔다. 상태 표는 dataset 등록, import batch·version, `(dataset_id, source_table, original_key)` → 대상 UUID mapping, checkpoint, 권위 선택 기록이다. raw는 받은 그대로의 TEXT로 저장한다(JSONB 재직렬화 금지). scope·library_version·normalize 상태·오류·history_start·원본 연결은 garmin 안에 남는다. 옛 SQLite 마이그레이션을 PG 실행용으로 복사하지 않는다. (AD-30·31·36)
- E14-3 (R5): raw view — `garmin.raw_records`는 고정 모양 `(source, account, key, endpoint, fetched_at, checked_at, body)`의 읽기 전용 view다. `key`는 scope를 담은 정규형 `<scope>/<원래 key>`라서 day와 activity의 같은 key가 부딪히지 않는다. body는 저장한 TEXT와 바이트까지 같다. core는 이 view 말고 garmin 표를 읽지 않는다. (AD-30)
- E14-4 (R5, R6, C6; R15·R16의 계약 부분): 건강 계약 표와 "현재" view — 버전 있는 지표 catalog(지표 식별자, 정규 단위, 값 타입, NULL 의미, 허용 집계)가 있다. 논리 측정 키는 출처·계정·지표·운동 identity·현지 날짜 또는 순간·시간대이고, 날짜형과 순간형은 배타다. 보관 키는 논리 키에 dataset·이전 출처·정규화 버전·관측 revision을 더한 것이다. 관측 revision은 원문 해시로 식별하고, 같은 dataset 안에서 `fetched_at`으로 순서를 정한다. 같은 시각에 해시가 다르면 ambiguity다. 정규화 버전은 정수로 비교하고, 옛 meta 1·2를 8로 바꿔 쓰지 않는다. "현재" view는 권위 선택 기록의 dataset 순서 → 관측 revision → 지원 정규화 버전 순으로 고른다. 같은 값의 동률은 하나로 보이고, 다른 값은 ambiguity로 돌아와 기본 집계에서 빠진다. NULL 키는 NULL 안전 UNIQUE라 다시 넣어도 늘지 않는다. 행은 불변이고, `brain_ext_garmin`은 자기 출처 행만 INSERT한다(RLS, 12.3 attempt 확인). TS와 Python이 같은 fixture에서 같은 판정을 낸다. epic 16·17·18이 소비한다. (AD-22·30·32·33)
- E14-5 (R5, R7; C5): `analyses` 최소 계약 — id, 출처, dataset, legacy 원래 표·키(파일 기반이면 안정 artifact key), import batch, revision, nullable 모델·생성 시각과 각 누락 flag, 파일 요청 관계, core가 확정하는 파일 관계를 둔다. 분석 행은 불변이라 file_id를 UPDATE하지 않는다. schema 16 `evaluation`이 있으면 `(report_date, scope)`와 본문·JSON·model·created_at을 그대로 옮긴다. 파일 mtime을 생성 시각으로 쓰지 않는다. 기존 분석을 다시 분석해 채우거나 바꾸지 않는다. epic 18이 호환 확장한다. (AD-32·35)
- E14-6 (R5): `file_requests`와 core 인계 — 출처 + 안정된 요청 키가 UNIQUE이고, 생산자·일감·attempt·batch, 보존된 입력 위치 참조, 예상 해시·크기·미디어 타입을 둔다. core가 미인계 요청을 다시 찾아, 요청 id 대상 일감 생성과 인계 표식을 한 트랜잭션에 확정한다. 파일 I/O는 트랜잭션 밖에서 FileStore로 한다. 요청 직후, 인계 중, 파일 저장 뒤 결과 확정 전의 crash가 모두 같은 요청으로 수렴한다. 공개 결과 view는 `request_id → file_id | 실패`와 pending·processing·completed·failed, 재개 가능 여부를 보인다. 해시가 다르면 실패이고 파일을 만들지 않는다. 생산자는 확인될 때까지 바이트를 보존하고, 확인 뒤 core가 정리한다. 처리된 파일은 기존 문서 추출 일감에 들어간다(PNG의 텍스트 추출 성공은 요구하지 않는다). (AD-23·30)
- E14-7 (R5, R6; C6): 보존 reader와 preflight — 옛 snapshot을 Python `sqlite3` read-only URI로 읽고, 원본에서 migration·normalize를 부르지 않는다. 지원 schema는 10·15이고(16 표가 있으면 읽는다) 그 밖은 정해진 오류다. preflight는 대상에 쓰지 않고 다음을 낸다: 소스·capture 식별과 목록 fingerprint, 실제 표·열과 미지원 차이, 표별 예상 건수와 제외 사유, 키 겹침·본문 충돌·metadata 충돌, 권위 규칙과 미선택 수, 계정 대응 근거, 단위·NULL 손실 위험, 대상 준비(core·garmin 마이그레이션, manifest·ABI, role, attempt), 예상 INSERT·파일 요청 수, 재개할 batch, 원본 불변 확인. (AD-36, migration-contract "importer 계약" 2)
- E14-8 (R5, R6, R7): 반입과 재개 — 식별자는 `(dataset_id, source_table, original_key)`이고 batch는 그 일부가 아니다. 작은 트랜잭션(2초 안)마다 데이터·mapping·checkpoint를 함께 확정한다. 같은 batch를 다시 돌리면, 같은 키·같은 원문 해시는 건너뛰고 같은 키·다른 값은 충돌로 남긴다(`ON CONFLICT DO NOTHING`으로 숨기지 않는다). 실패 뒤에는 checkpoint부터 이어 가고, 소스 fingerprint·버전이 바뀌었으면 checkpoint 재사용을 거부한다. 정수 id 이력(run·auth_event·fetch_error·delivery)은 dataset별 UUID mapping으로 따로 두고, `fetch_error → run`은 같은 dataset 안에서 잇는다. importer는 감독되는 확장 일감으로 돌고(ABI v1, attempt token), 외부 수집·모델·발신 경로를 열지 않는다. (AD-8·33·36)
- E14-9 (R6, C6): 기준 소스와 계정 — 권위 선택 기록의 규칙 버전 1은 선택지 A다: 운영 후보(D2) → 개발(D1) → 보관본 D4 → D5 → D3. dataset의 역할은 private manifest의 source 분류에서 오고, 파일 이름으로 추정하지 않는다. 미선택 값은 모두 별도 출처로 남는다. 기록에는 규칙 버전, dataset 순서, 적용 범위, 선택·미선택 provenance가 있다. 계정 identity는 raw 본문의 Garmin 사용자 profile id로 dataset마다 확인한다. 한 값으로 모이지 않거나 없으면, 그 dataset의 행은 계정 미확인으로 보존되고 "현재" view에서 ambiguity다(폴더·library_version으로 추정하지 않는다). (AD-32·36)
- E14-10 (R7; R13은 epic 15 경유): legacy 알림·전송 이력 — 옛 `notification`(최초 시도 gate)과 `delivery`(원래 id)가 epic 15.3의 legacy 표에 출처(dataset, 원래 표, 원래 키, batch)와 함께 들어가고, 같은 Garmin 봇·채팅 conversation에 이어진다. gate를 발신 성공으로 바꾸지 않고, 두 표를 날짜로 억지로 잇지 않으며, 발신 요청·인계 일감을 만들지 않는다. 실제 delivery가 없어도 합성 fixture로 검증한다.
- E14-11 (R5): 파일 분류와 대상 — capture 파일은 리포트 Markdown·facts·PNG·입력 JSON·로그·설정으로 나뉜다. 리포트·facts는 파일 등록 요청과 `analyses` 행이 되고, PNG·입력 JSON은 파일 등록 요청과 분석과의 파일 관계가 된다. 로그는 비밀 검사를 통과한 것만 파일로 들어간다. 설정(TOML 등)과 비밀 검사에 걸린 파일은 반입하지 않고 제외 사유를 남긴다(원본 snapshot에는 남는다). body·profile·inbox는 없음과 비어 있음을 구분해 보고하고, 있으면 측정일·필드별 mtime·원본 관계와 함께 넣는다. (AD-23·36)
- E14-12 (R5): 검증 보고서 — source→target 표별 건수와 자연키 집합 차이, raw TEXT 해시 동등성, NULL 개수·단위·수치 동등성, FK·dataset-local id mapping, 분석 본문·JSON·누락 flag, 전체 파일 해시·크기·관계·요청 결과, 미선택 충돌과 제외 사유, 같은 batch 재실행·중단 재개·비발신 결과를 비교한다. 차이가 있으면 성공이 아니다. private 상세 보고서는 Brain 홈의 확장 데이터 아래에 두고, 공개 집계에는 해시 값·원문·계정·개인 날짜를 쓰지 않는다. 없던 revision·evaluation을 만든 것으로 보고하지 않는다. (AD-36, migration-contract "이전 완료 gate")
- E14-13 (R5; AD-29): 수동 실행 명령 — `brain ext run <name> <job> [--target …]`이 manifest가 수동 실행을 허락한 확장 일감을 epic 12의 작업 계약으로 넣고, 같은 대상의 열린 일감과 합친다. CommandSpec·명령 메타·SDK가 1:1이고 출력 코덱을 거친다. 확장 끄기 보류를 우회하지 않는다(E12-11). core 코드에 Garmin 이름이 없다. Garmin은 `import-preflight`·`import`·`import-verify`를 선언한다.

## Constraints

- 원본 Garmin 저장소와 capture에서 normalize·업그레이드 SQL을 실행하지 않고, 원본 snapshot을 바꾸지 않는다(AD-36).
- DB는 값을 만들지 않는다. UUIDv7·시각·해시·값은 작성자가 공급한다(AD-8·22).
- 확장은 core 계약 표에 INSERT만, 자기 출처 행만 쓴다. core → 확장 FK는 없다(AD-30).
- 새 core 마이그레이션은 epic 15 뒤의 다음 번호이고, garmin 마이그레이션은 소유자 `garmin`의 0001부터다(AD-31).
- 시험은 합성 schema 10·15 fixture와 합성 legacy 문서로 한다. 실데이터는 마지막 이 Mac 반입에서만 쓴다. 개인 데이터·자격 증명·해시 값은 저장소에 들어가지 않는다.
- importer는 모델을 부르지 않는다(기존 분석을 보존할 뿐이다).

## Done when

1. schema 10·15 합성 fixture와 legacy 문서로 importer를 검증한다. 같은 batch를 다시 돌려도 중복·덮어쓰기·발신이 생기지 않고, 중간 실패 뒤 재개된다.
2. private capture를 다시 만들거나 확인한다. 기록된 추천 규칙(선택지 A)으로 에이전트가 실제로 반입한다(2026-10-28 위임).
3. 이전 보고서가 출처별 건수·값/본문·해시·관계·미해결 충돌·빠진 metadata를 보인다.
4. 원본 snapshot이 그대로 남고, 개인 데이터와 자격 증명이 공개 저장소에 들어가지 않는다.
5. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 새 수집·정제는 epic-garmin-runtime, 새 평가는 epic-health-analysis, 검색과 수치 조회는 epic-search-and-health-query다.
- 옛 의존(garminconnect·curl-cffi·matplotlib·jsonschema·requests)과 인증·수집 코드, 옛 Garmin 예약의 중지·전환은 epic-garmin-runtime이다.
- 기존 Brain `brain.db`는 옮기지 않는다(2026-10-28).
- Must not change: 원본 Garmin 저장소에서 normalize·업그레이드 SQL을 실행하지 않는다. 이전된 발신 이력이 메시지를 다시 보내지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R5, R6, R7, Constraints C5, C6
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-8, AD-22, AD-23, AD-29, AD-30, AD-31, AD-32, AD-33, AD-35, AD-36, Table Contract(건강 측정·요약, `analyses`, 채널 발신 요청·이력, `file_requests`), Deferred("건강 계약 표의 정확한 모양", "Garmin lock·설치 재현성", "C6 기준 소스·충돌 정책")
- migration — _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md, 전체
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S3·S12·E2·E3
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/source-manifest.json (소스 커밋·archive 해시)
- research — _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-research-code.md (2026-10-28 정적 조사와 읽기 전용 집계)

## Notes

- Decision(2026-10-31, 추천으로 정함, 14.1 기준 불일치 해소): 원래 기준과 전체 diff·리뷰 이력은 보존하고 계획의 엔진 기준을 복구 시 수락된 `077e399`로 맞춰 보존 작업을 재검증·리뷰한다.

- Decision(2026-10-31, 추천으로 정함, 14.1 재개): 시간 초과 뒤 기존 구현을 미검증 WIP로 보존하고 원래 기준과 전체 diff 및 리뷰를 유지하여 전체 검증부터 재개한다. 관리상 인계는 구현 실패로 세지 않는다.

- Waits on epic-postgres-primary because: core 문서·출처·사용자 테이블과 마이그레이션 실행기가 있어야 한다.
- Waits on epic-jobs-and-scheduler because: importer가 감독되는 확장 일감으로 돌며 임대 갱신과 attempt token을 받는다. 계약 표 INSERT는 DB가 현재 attempt와 대조한다(AD-33).
- Waits on epic-extensions because: Garmin 스키마를 확장 DDL로 선언·등록하고, 확장 패키지 위치와 Python 런타임을 쓴다.
- Decision(2026-10-28): Garmin SQLite snapshot은 Brain의 `node:sqlite`가 아니라 확장의 Python `sqlite3`로 읽기 전용으로 읽는다. 그래서 epic 11이 Brain의 SQLite 경로를 지워도 이전이 가능하다. spine AD-29(확장은 별도 프로세스, 언어 무관)와 AD-36(원형 snapshot을 읽기 전용으로 보존)과 맞다. 이전의 Assumption을 대신한다.
- Decision(2026-10-28, spine AD-23·35): 구형 Markdown·facts·PNG는 파일 등록 요청으로 core 파일이 되고 문서 추출·조각 색인을 탄다. `analyses` 행이 그 파일을 가리킨다. 이전의 Open question을 대신한다.
- Decision(2026-10-28, 사용자): core 계약 표는 처음 쓰는 에픽이 만든다. 이 에픽이 건강 측정·요약 표와 "현재" view, `analyses` 최소 계약, `file_requests`와 그 인계 일감을 만든다. epic 18이 `analyses`를 호환 확장하고, epic 16·17·18이 건강 계약 표를 소비한다. 채널 발신 요청·이력 표는 epic 15가 만든다.
- Open question: 개발/운영 DB 중 기준 소스는 무엇이고, 겹치는 자연키의 충돌은 어떻게 고르나? 실제 반입 전에 사용자가 정한다(C6). 2026-10-28 결정 묶음에서도 묻지 않았다. preflight 보고서를 본 뒤 실제 반입 직전에 정한다(사람 확인 스토리). → 2026-10-28 사용자가 추천 규칙에 위임했다. 이 에픽을 쪼갤 때 preflight 증거로 추천 규칙을 정해 Decision으로 남기고, 실제 반입은 에이전트 스토리(`hitl = false`)로 한다. 미선택 후보도 원형과 출처를 보존한다(AD-36).
- Waits on epic-channels because: 옛 Garmin 알림·전송 이력이 core 채널 발신 이력에 들어간다(2026-10-28, 사용자).
- Decision(2026-10-28, 추천으로 정함, 사용자 위임, C6): 기준 소스 규칙은 코드 조사 3절의 선택지 A다. 운영 후보(D2)를 기준으로 삼고, 없는 키는 개발(D1) → 보관본 D4 → D5 → D3 순으로 보완한다. 선택되지 않은 값은 모두 별도 출처로 보관한다. 정수 id 이력(run·auth_event·fetch_error·delivery)은 dataset별로 따로 저장하고 병합하지 않는다. 근거: D1과 D2는 겹치는 모든 키에서 값이 같다. 충돌은 예전 보관본 D4·D5와의 사이에만 있다(표별 충돌 키 220개, 건강 파생 값 7개). 최신 우선만으로 고르면 D4·D5에만 있는 BB 샘플이 사라지므로 쓰지 않는다. 권위 선택 기록에는 규칙 버전, dataset 순서, 적용 범위, 선택·미선택 provenance를 남긴다.
- Note(2026-10-28): 정제와 스토리 계획은 다음 세션에서 이어 한다. 입력은 `epic-garmin-import-research-code.md`(코드 조사와 실데이터 집계)이고, 스토리 후보 T1~T7과 실제 반입 전제(9절)가 그 안에 있다. → 2026-10-28 정제와 스토리 계획을 마쳤다(아래 Decision들).
- Decision(2026-10-28, 정제, 추천으로 정함): Python 의존은 PG driver `psycopg[binary]` 3(sync)뿐이다. binary wheel이라 libpq를 따로 설치하지 않는다. pin은 spine Stack이 정한 새 배포 pin·doctor 보안 기준 3.14.10이고(옛 3.14.8은 관찰 기록), 그 위에서 다시 잠근다(세트 검증 뒤 spine rubric R2로 바로잡음). 옛 의존(garminconnect·curl-cffi·matplotlib·jsonschema·requests)은 그것을 쓰는 인증·수집·그래프 코드와 함께 epic 16이 더한다. 그래서 spine Deferred "Garmin lock·설치 재현성"의 epic 14 몫(pin·binary 설치의 arm64 import·DB 접속)은 1이 닫고, 옛 의존의 arm64 설치 확인은 epic 16으로 넘긴다.
- Decision(2026-10-28, 정제, 추천으로 정함): `garmin.raw_records`의 `key`는 `<scope>/<원래 key>`(예: `day/<날짜>`, `activity/<id>`)다. view 모양(AD-30)을 바꾸지 않고 day와 activity의 같은 key가 부딪히지 않게 한다. epic 16의 새 수집도 같은 정규형을 쓴다.
- Decision(2026-10-28, 정제, 추천으로 정함): 계정 identity는 raw 본문에 있는 Garmin 사용자 profile id로 dataset마다 확인한다. 데이터 안의 값이라 폴더·library_version 추정이 아니다. 한 값으로 모이지 않거나 없으면 그 dataset 행은 계정 미확인으로 보존하고, "현재" view에서 ambiguity로 돌려 집계에서 뺀다. epic 16은 로그인 profile의 같은 id를 쓴다.
- Decision(2026-10-28, 정제, 추천으로 정함): dataset 역할(운영·개발·보관본)은 private manifest의 source 분류에서 온다. 권위 선택 기록 규칙 버전 1은 D2 → D1 → D4 → D5 → D3이다. epic 16은 새 수집 출처를 맨 앞에 둔 새 규칙 버전을 쓴다(epic 16 Notes의 Handoff 줄로 받는 쪽에 적었다).
- Decision(2026-10-28, 정제, 추천으로 정함): 파일 분류. 리포트 Markdown·facts는 `analyses`와 파일, PNG·입력 JSON은 분석과의 파일 관계, 로그는 비밀 검사를 통과한 것만 파일로 넣는다. 설정(TOML 등)은 기계·비밀 설정이라 반입하지 않고 제외 사유를 남긴다. 비밀 검사에 걸린 파일도 같다. 원본 snapshot에는 모두 남는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 수동 실행은 공용 명령 `brain ext run <name> <job> [--target …]`이다. manifest가 수동 실행을 허락한 확장 일감을 epic 12의 작업 계약으로 넣는다. 확장마다 core 명령을 더하지 않는다(AD-29). Garmin import는 `import-preflight`·`import`·`import-verify` 세 일감이다. manifest v1에 수동 실행 허용 표시가 없으면 3이 호환되게 더한다(13.2의 schema 버전 규칙을 따른다).
- Decision(2026-10-28, 정제, 추천으로 정함): 보고서 위치. private 상세(건수·자연키 차이·해시 비교 결과)는 Brain 홈의 확장 데이터 아래(`<home>/extensions/garmin/` 밑, 저장소 밖)에 둔다. 공개 집계(건수·충돌 수·제외 사유 수)는 명령 출력과 해당 plan에 남기고, 해시 값·원문·계정·개인 날짜를 쓰지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 실제 반입(8)은 옛 writer를 멈추지 않는다. 반입 직전에 에이전트가 새 일관 capture를 만든다(옛 DB는 read-only URI의 SQLite backup API, 파일은 복사 전후 해시 비교). 위치는 Brain 홈의 확장 데이터 아래다. 옛 `LATEST` capture와의 목록·건수 차이는 보고서에 남긴다. capture 뒤 옛 writer가 쓴 것과 옛 예약 중지는 epic 16의 전환에서 다룬다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. 격리된 Brain 홈에 설치한 Garmin 확장의 import 일감이 합성 raw 한 건과 legacy 리포트 Markdown 한 건을 넣는다. 그러면 core 쪽에서 건강 값 한 건, `garmin.raw_records`의 한 행(원문 그대로), `analyses`가 가리키는 파일 원문이 읽힌다. RLS·attempt 확인·비발신·원문 보존은 1에 남긴다. 다음은 가장 덜 확실한 2(건강 의미 계약과 "현재" view)다. epic 16·17·18이 모두 그 위에 선다. 그다음 3(보존 reader·preflight·수동 실행 명령), 4(반입·재개·규칙 A·legacy 채널 이력), 5(파일과 기존 분석), 6(검증 보고서), 7(Refactor sweep), 8(이 Mac 실제 반입) 순이다. 코드 조사의 순서안 A를 따르되, T6(재현성)은 1과 epic 16으로 나눴다.
- Decision(2026-10-28, 스토리 계획): core 마이그레이션·계약 표 Store·조립·garmin 마이그레이션·importer·CLI 등록부를 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~8은 한 줄이다. 1은 epic 15의 마지막 코드 스토리(15.6)를 기다린다(15.1이 13.9를 기다린 선례). epic 11~15 쪽 entry에는 인계 문장을 더하지 않는다. 받는 쪽(1·4)이 무엇을 받는지 적고, 실제 시그니처는 그 HEAD에서 확인한다. Dependencies의 "양쪽 description" 조건의 명시적 예외다(epic 12 F3, epic 15와 같은 방식).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 8의 실제 반입은 위임에 따라 에이전트가 한다. 원격 push가 있어야만 하는 단계는 `operator_actions`에 남긴다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 high: 언어·DB·파일 경계를 처음 관통한다. 틀리면 2~8이 다시 만든다.
  - 2 high: 건강 의미가 틀리면 epic 16·17·18이 잘못된 현재 값을 쓴다.
  - 3 medium: preflight가 틀리면 반입 전 경고를 놓친다. 4·6이 다시 확인한다.
  - 4 high: 재개·충돌 처리가 틀리면 중복이나 조용한 손실이 생긴다(R6·R7).
  - 5 high: 파일 인계가 틀리면 분석 원문이 사라지거나 중복된다.
  - 6 medium: 보고서가 틀리면 손실을 놓친다. 4·5의 시험이 먼저 막는다.
  - 7 low: 정리다.
  - 8 high: 실데이터에서만 드러나는 차이(계정 미확인, 새 capture 차이)를 놓친다.
- Decision(2026-10-28, 세트 검증 F1): spine을 같은 날 고쳤다. AD-32는 규칙 순서로 고를 수 있는 값과 고를 수 없는 충돌(같은 순위의 다른 값, 계정 미확인)을 나누고, 뒤쪽만 ambiguity다. AD-36은 C6가 위임으로 충족됐다는 것과, 새 일관 capture 기준 검증·capture 뒤 변경은 epic 16 전환이라는 경계를 적는다. Deferred 세 줄("건강 계약 표의 정확한 모양", "Garmin lock·설치 재현성", "C6 기준 소스·충돌 정책")은 정한 부분과 남은 구현 검증을 나눴다.
- Decision(2026-10-28, 세트 검증 F2): 뒤 에픽에 받는 쪽 문장을 남겼다. epic 16 Notes에는 raw view key 정규형(14.1), 지표 catalog·"현재" view·계정 의미·권위 기록(14.2), 파일 요청 결과 view(14.5), 새 수집 규칙 버전 책임을, epic 17·18 Notes에는 14.2의 계약 문서·공유 fixture와 ambiguity 의미를, epic 18에는 14.5의 `analyses` 최소형·파일 관계의 호환 확장을 적었다. 정의는 복제하지 않고 이 에픽의 Decision과 산출물을 가리킨다. 뒤 에픽을 쪼갤 때 이 entry로 교차 `after`를 고정한다.
- Decision(2026-10-28, 세트 검증 F3): 공개 plan에 붙이는 증거는 6의 공개 투영(건수, 충돌·제외 사유 수, 단계별 성공/실패 상태)과 값 없는 성공 여부뿐이다. doctor·조회의 원시 출력, 오류 상세, capture 경로, private 보고서는 Brain 홈에만 둔다. 실패 원인도 plan에는 개인 값을 뺀 분류만 쓴다. 6은 합성 개인 날짜·계정·건강값 표식이 공개 투영에서 빠지는지 시험한다. 실데이터를 시험 fixture로 옮기지 않는다.
- Decision(2026-10-28, 세트 검증 F4): high entry의 추가 확인(verify와 별도, leaf를 만들 때 이어받는다).
  - 1: macOS arm64에서 frozen 설치한 driver의 import와 PG 왕복(UTF-8·epoch ms·NULL).
  - 2: 공유 fixture의 기대값을 publisher 코드와 따로, 손으로 만든 표에서 계산해 대조한다.
  - 4: 두 importer가 같은 batch를 동시에 시작해도 충돌·중복이 없다.
  - 5: 파일 결과가 확정되기 전에 정리 일감이 돌아도 staging 바이트가 남는다.
  - 8: private 전수 대조 요약과, 공개 plan에 개인 데이터가 없음을 따로 점검한다.
- Decision(2026-10-28, 세트 검증 F5): 7(Refactor sweep)은 코드 스토리 1~6의 정리를 닫는다. 8의 배포·새 capture·실제 반입은 그 뒤 따로 둔다(epic 15의 15.6·15.7과 같은 예외). 8에서 찾은 기능 문제는 버그 스토리로 고치고, 7로 밀린 기능을 넣지 않는다. 8은 verify를 통과할 때까지 실제 반입 완료로 세지 않는다.
- Decision(2026-10-28, 세트 검증 S1·S2 채택): 1의 plan 상한을 description에 고정했다(raw 한 건, 일 지표 하나, Markdown 하나, 정상 파일 인계 하나). 각 plan은 실제 PG·Python·데몬 구성 명령, 공유 fixture 경로, kill 지점의 동기화·종료 확인, 재시작·정리 명령을 적는다. 5는 요청 INSERT 뒤, 인계 commit 전, FileStore 저장 뒤 결과 commit 전을 나눈다. 7은 TS 기본 suite와 Python suite의 실행 명령을 따로 남긴다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(14.7)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(14.8)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
- Decision(2026-10-30, 추천으로 정함): 14.1의 15.6 레인 대기를 없애고 manifest(13.2)와 비발신 0건 검증에 쓰는 채널 요청 표(15.1)를 명시한다. PG FileStore(11.4)·attempt(12.3)·Python 설치(13.3)·role(13.4)이 tracer의 기능 선행이다. 채널 legacy 표는 소비자인 14.4가 15.3을 기다린다. 예전 15 완료 HEAD·번호 가정은 폐기하고 착수 시점 main HEAD에서 확인한다.
