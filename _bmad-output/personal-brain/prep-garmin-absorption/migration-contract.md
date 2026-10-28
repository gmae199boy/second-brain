# 데이터 이전 준비와 보존 계약

## 현재 준비 결과

개인 데이터는 소스 반입 archive에 포함하지 않는다. 원본 repo의 `data/absorption-prep/LATEST`가 private capture 디렉터리를 가리킨다. capture에는 DB5개, artifact349개와 `manifest.private.json`이 있다. private manifest는 source path·schema·건수·크기·SHA-256·snapshot 경로를 기록하며 실제 건강값/분석 본문을 보고서에 출력하지 않는다.

DB는 source URI `mode=ro`에서 SQLite backup API로 복사했다. 다섯 snapshot의 integrity_check는 모두 ok다. 원본에 normalize/업그레이드 SQL을 실행하지 않았다. SQLite read-only WAL 연결은 빈 sidecar를 생성할 수 있으나 논리 데이터/스키마 변경을 수행한 것은 아니다.

각 DB snapshot은 일관되지만 DB5개와 artifact를 전역 한 시점에 정지시킨 것은 아니다. artifact는 복사 전/복사 후 source hash와 destination hash가 같음을 확인했다. 실제 publish 전에는 writer 정지 또는 증분 재캡처/재검증 정책을 적용해야 한다.

## 발견한 데이터 소스

| 후보 | 관찰 schema | 취급 |
|---|---|---|
| `data/garmin.db` | 15 | 개발 후보. 자동 authoritative 선정 금지 |
| `runtime/data/garmin.db` | 10 | 운영 후보. 자동 authoritative 선정 금지 |
| `data/before-5-3/garmin.db` | 10 | 이전 보관본. 다른 이력이 있을 수 있어 보존 |
| `runtime/data/garmin.db.bak-20261021-pre-epic5` | 10 | backup 후보. 원본과 별도 dataset |
| `runtime/data/garmin.db.bak-20261019-history-start` | 10 | backup 후보. 원본과 별도 dataset |

현재 코드의 최신 migration은16, normalize version은8이지만 관찰 DB는 더 오래됐다. importer를 쓰기 위해 먼저 현재 프로그램으로 원본을 열어 업그레이드하지 않는다. `activity_recovery`처럼 최신 migration에서 없어진 데이터도 원형 snapshot과 provenance를 보존한다.

관찰 DB에는 evaluation/day_summary/workout/exercise_log가 없다. 따라서 기존 분석을 evaluation 행에서만 가져오는 importer는 불완전하다. `reports/`, `runtime/reports/`, `data/facts/`, `runtime/data/facts/`, `data/report-input/`의 본문과 이미지/입력 근거를 함께 보존한다. body/profile/inbox는 현재 없는 것과 빈 것을 private manifest/후속 inventory에서 구분하며, 앞으로 존재하면 포함한다.

## 대상별 보존/검증

| 대상 | 보존 필드/규칙 | 검증 |
|---|---|---|
| raw_response | `(scope,key,endpoint)`, exact JSON text, library_version, fetched_at, checked_at | 텍스트 hash·자연키·NULL/NoData 의미·timestamp |
| normalize_result / meta | 원본 처리 timestamp, 성공/오류, normalization version, history_start | 상태·버전·원본 연결 |
| daily/activity/sample/set와 legacy 파생 | 원래 키, epoch ms, local date, NULL, 단위, source schema/version | source별 건수·키·수치와 FK. 새 계산으로 덮기 전 원래 값을 보존 |
| run/fetch_error/auth_event | source-local id와 관계, 상태·시각·정제 사유 | dataset별 ID mapping, fetch_error→run 무결성 |
| notification/delivery | 최초 시도 gate와 실제 전송 결과 | 이전이 메시지 재발송을 유발하지 않음, 이력/중복 의미 보존 |
| evaluation이 있는 소스 | scope/date, summary/judgments/evidence/next_checks/report_md/model/created_at | 기존 본문과 JSON 내용·모델·시각을 보존. 재생성으로 대체하지 않음 |
| 구형 Markdown/facts/PNG | 원문 bytes/hash, 원래 경로, 확인 가능한 날짜/출처, linked artifacts | 파일별 SHA-256와 관계. 없는 model/생성 시각을 추정 사실로 만들지 않음 |
| body/profile/입력/설정 | 측정일/필드별 mtime/원본 참조/처리 상태/유효 설정 | 개인 설정과 machine/bootstrap/secret을 분류, 원본 파일 연결 |

최신 raw는 키별 한 행이고 과거 revision 전체가 아니다. evaluation도 현재 코드에서는 date/scope별 최신 행이다. 소스에 없던 이력을 importer가 복원했다고 주장하지 않는다. 서로 다른 backup의 값은 별도 출처로 보관한 뒤 합치기 정책을 적용한다.

## importer 계약 — 후속 구현

1. source snapshot/dataset ID·source table·원래 key를 재실행 식별자로 사용하고 import batch/version과 mapping을 저장한다. 충돌을 `ON CONFLICT DO NOTHING`으로 조용히 누락하지 않는다.
2. preflight에서 대상 schema compatibility와 source 지원 버전을 확인하고, 실제 이전 후보/예상 변경/충돌을 출력한다.
3. source를 read-only로 읽고 작은 transaction으로 옮기며 checkpoint를 기록한다. 실패 후 재개·동일 batch 재실행을 지원한다.
4. 원본 snapshot을 그대로 유지하고 import 결과와 관계/해시/값을 비교한다. 재구축할 파생물도 원래 값/출처를 보존한 뒤 명시적으로 새 계산 version을 연결한다.
5. 기존 분석을 target document/analysis로 그대로 등록한다. 재분석 요청은 별도 새 작업이다.
6. 운영 전환은 불변식을 통과하고 source 선택/충돌을 해결한 뒤 한다. 현재 준비 단계에서는 PostgreSQL 반입이나 환경 전환을 하지 않았다.

## 이전 완료 gate

- source별 지원 version, table/artifact 목록, 배제 사유가 전수 기록된다.
- 건수만 아니라 자연키·원문 hash·NULL/수치/단위·FK·분석 본문·artifact links가 비교된다.
- source-local integer ID가 다른 dataset에서 충돌하지 않는다.
- importer 재실행으로 중복/덮어쓰기/발신이 생기지 않고 실패 재개가 검증된다.
- 기존/새 분석을 검색·원문 조회로 읽고 확인 가능한 provenance가 연결된다.
- private 데이터와 credentials는 public repo/source archive에 들어가지 않는다.

## 남은 입력

기준 소스와 충돌 정책은 아직 미정이다. 이를 고르기 전에도 모든 후보와 기존 결과를 보존할 수 있어 준비는 완료했다. 실제 이전을 시작할 때 private inventory를 다시 확인하고, snapshot 이후 변경이 있으면 갱신해야 한다.
