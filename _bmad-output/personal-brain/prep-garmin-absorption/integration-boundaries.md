# 통합 경계와 기존 계획 영향

이 문서는 흡수 준비용 설계 입력이다. 확정된 사용자 조건과 코드 근거를 정리하며, 아래 권고 구조를 완성된 아키텍처/DDL로 취급하지 않는다.

## 소스 기준

- Garmin: `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`.
- Brain: `22390f56cdb1e939d74209f152c6b7d2a51a9f96`.
- 상세 코드 근거: `inputs/research/`와 archive의 원본 파일. archive는 실행될 새 확장이 아니라 이식할 고정 소스다.

## 가져갈 코드와 교체할 경계

| 현재 Garmin 자산 | 가져갈 것 | 새 제품에서 바꿀 것 |
|---|---|---|
| rawparse, normalize/daily·activity, digest, errors | 원본 파싱·단위·NULL·수치 계산·오류 분류 | 도메인 계산은 Python 확장 내부 재사용 권고. 순수 계산과 저장 부작용 분리 |
| garmin adapter, auth | MFA/token/session 직렬화, account block, pacing·first-call 보호 | core 인증 상태·작업 실패 계약에 연결. PostgreSQL로 바꿔도 외부 계정 보호를 유지 |
| collect, coverage, normalize coordinator | 누락/증분 계획, endpoint 격리, rebuild rollback | SQLite connection/SQL 의존성을 PostgreSQL 저장 포트로 교체 |
| store/migrations 0001~0016 | 테이블·키·변경/삭제 이력의 명세 | PRAGMA/WAL/flock/? bind/INSERT OR IGNORE/sqlite3 오류를 그대로 새 런타임에 사용하지 않음 |
| report_input, report, JSON schemas, skills | snapshot/cutoff/scrub, 평가 scope·근거·본문, 출력 검증 | core 작업/AI 실행·취소·lease·결과 저장 계약에 맞춤 |
| body | 장부 값·필드별 출처 mtime·원본 파일 연결 | core 파일/측정 모델과 경로로 연결; 기존 경로 하드코딩 제거 |
| charts, exercise labels | 계산·표현·한국어 종목 리소스 | DB 조회와 artifact 저장 포트 교체. worker의 OS/폰트는 실제 배치 환경에서 결정 |
| ports, telegram | 결과 bundle·사건 분류·전송 이력 의미 | 공통 채널 adapter로 발신. 향후 수신/대화/선제 메시지는 core 소유 |
| config, schedule, deploy, cli | 설정 default/검증과 수동 진단의 의미 | 공통 DB 설정·core 예약·설치/업데이트로 교체. 별도 Garmin LaunchAgent를 제품 기본 경로로 유지하지 않음 |
| tests/fixtures/fakes | 계산·원본 보존·실패 경계·합성 fixtures | PG 계약과 확장 통합 fixture를 추가하고 package/import 이름 변경을 반영 |

## 실행·의존성

Python 패키지 요구는 >=3.12이며 기존 배포는 3.14.8 고정이다. `pyproject.toml`, `uv.lock`, `.python-version`을 함께 가져가 선택 확장 런타임을 재현한다. 기존 의존성은 garminconnect, curl-cffi, jsonschema, matplotlib, requests다. Garmin 비설치 core가 이 환경을 강제로 설치/로드하지 않게 한다.

TS↔Python은 process/worker 경계로 연결하는 안을 권고한다. 정확한 형식은 아직 미정이다. DB는 Docker PostgreSQL로 확정됐지만, core daemon이나 Python/Codex worker까지 Docker에서 실행하기로 결정한 것은 아니다. 기존 로컬 Codex 로그인/실행 환경을 성급히 컨테이너로 옮기지 않는다.

Core port에는 외부 실행·결과 저장·artifact·채널의 계약을 두고, domain core가 subprocess/특정 채널 SDK를 직접 import하도록 만들지 않는다. 기존 Python import-linter/AST 경계는 새 adapter 위치와 함께 의도적으로 갱신한다.

## 확장 설치 안내 스킬 — 2026-10-28 추가

공통 install 스킬은 에이전트용 Brain 플러그인에 기본 포함한다. Garmin이 설치되기 전에도 에이전트가 “Garmin 연결해 줘” 요청을 받아 설치 절차를 안내할 수 있어야 한다. 실제 패키지 설치·호환성·상태 저장은 Brain CLI/runtime의 책임이며, 스킬은 그 기능을 호출하는 절차를 제공한다. `brain install garmin`은 계획한 사용 형태이고 현재 구현됐다는 뜻은 아니다. 이번 변경은 준비 요구사항 반영이며 실행 가능한 SKILL.md나 설치 CLI를 배포한 것이 아니다.

```text
사용자 요청 → 공통 install 스킬 → CLI 기능/확장 상태 확인
  → 필요한 확장 설치 → 사용자 로그인 안내 → 연결 상태 확인
  → 공통 스케줄러에 예약 등록 → 실제 단계별 결과 보고
```

- 스킬은 실제 CLI 메타/도움말에서 지원 기능을 확인한다. 설치 명령이 없으면 미구현임을 알리고 임의 패키지 설치 명령으로 우회하지 않는다.
- 이미 설치된 확장은 중복 설치하지 않고 현재 연결/설정 상태에서 이어간다. 설치와 활성화·로그인·자동 실행은 별도 상태로 다룬다.
- 로그인은 사용자가 인증 절차를 직접 완료하도록 안내한다. 비밀번호/MFA를 대화 기록이나 스킬 본문에 저장하지 않는 기존 인증 계약을 유지한다.
- Garmin 사용 안내·기능 정보는 확장과 함께 제공하고 설치 후 Brain을 통해 에이전트가 확인할 수 있게 한다. 공통 install 스킬 자체를 Garmin 설치물 안에만 두지 않는다.
- 확장 실행 환경과 데이터는 Brain의 공통 설치 위치/DB에서 관리한다. 에이전트 플러그인의 버전별 캐시에 설치해 플러그인 업데이트 때 잃어버리는 구조를 사용하지 않는다.
- 설치 실패·취소·로그인 필요·스케줄러 미준비를 구분한다. 이미 성공한 단계를 보존하고, 끝나지 않은 단계를 완료로 보고하지 않는다.
- 자동 실행은 Brain 공통 스케줄러가 구현된 뒤 등록한다. 미준비 상태에서는 예약 설정 대기를 알리고 수동 실행 가능 여부를 안내한다. 별도 Garmin LaunchAgent를 임시로 생성하지 않는다.

완료 검증은 미설치→설치→사용자 인증→연결 확인→예약 등록의 정상 경로, 이미 설치/부분 설정된 상태의 재실행, 설치 실패/취소, 로그인 미완료, 스케줄러 미준비에서 수행한다. 설치 안내를 보였다는 사실과 실제 CLI 상태가 바뀌었다는 사실을 구분한다.

## 작업 그래프와 병렬성

```text
원본 수집 → 정규화/측정 snapshot → day → 7d → 30d → all
                     └→ 그래프 ───────────────────┐
                          평가 결과 조립 ─────────┴→ 발신
대화 수집 / 문서 작업 ───────── 별도 실행 용량으로 병렬 ─────
```

현재 기간 평가는 앞 기간의 평가를 사용한다. 모든 scope를 무조건 병렬화하지 않는다. 같은 계정 수집은 token/pacing/block 때문에 직렬화한다. 그래프는 정규화 snapshot 뒤 평가와 병렬 실행할 수 있다. 작업 의존성을 코드/DB 상태로 표현하고 정규화 도중의 서로 다른 snapshot을 섞지 않는다.

현재 Brain drain은 handler를 직렬 await하고 daemon 기본 예산10초는 handler timeout이 아니다. 기본 lease600초, 갱신 구현 미발견, 진행 중 drain에 abort signal 전달 없음이 확인됐다. 긴 작업의 owner renewal/진행 상태/worker 사망/사용자 취소/단계별 timeout을 구현하고, 외부 호출 동안 DB write transaction을 잡지 않는다. heartbeat만 살아 있는 무한 대기를 진행으로 단정하지 않는다.

## 단일 DB 경계

권고 구분은 core 기억/사용자/출처/설정/작업/채널과 Garmin raw/관측/파생/평가다. 같은 PostgreSQL database 안에서 관계를 연결하되 schema·테이블 이름과 버전 체계는 후속 아키텍처가 정한다. core가 전체 migration을 관리하고 확장은 자기 DDL을 선언하는 구조를 검토한다. 두 migration 엔진이 같은 version row를 따로 소유하는 구조는 채택하지 않는다.

raw는 현재 JSON 텍스트의 표현까지 보존한다. 검색/필터용 JSONB를 추가할 수 있어도 원본 문자열을 JSONB 직렬화 결과로 대체하지 않는다. source/account·event time·local date/timezone·fetched/checked·normalization version·model evaluation provenance를 연결한다.

## 기존 Brain 계획과 조정할 곳

| 기존 문서/기능 | 현재 전제 | 이번 방향의 변화 |
|---|---|---|
| architecture AD-10 | SQLite 원본/Postgres 복제 | PostgreSQL을 단일 primary로 변경 |
| initiative Boundaries / epic-replicas | Docker/Postgres와 원본 이전은 V1 뒤 | primary 변경은 별도 선행 작업으로 계획. 복제 epic을 그대로 primary 구현으로 간주하지 않음 |
| initiative Outcome / LLM0 | 기본 수집·검색은 LLM 호출0 | 선택 건강 AI 분석과 미래 채널 agent의 적용 범위를 명시. 기본 수집/검색에 LLM 필수화하지 않는 안 검토 |
| latest settings decision / Drive E8-7 | 사용자 설정 DB, machine config, secrets 분리 | 같은 공통 설정 계약 재사용. Garmin 설정만 독립 DB 시스템으로 중복 작성하지 않음 |
| daemon / schedules | interval tick, 짧은 drain, 기본 lease | 긴 작업 감독과 calendar/timezone 예약을 공통 기능으로 보강 |
| Drive/recall 계획 | 아직 작성·구현 중 | 텍스트/원문 query 계약은 협의하되 Drive 전체를 흡수의 전제조건으로 묶지 않음 |
| operations | 백업·복구가 V1 뒤 | 이번 실제 데이터 이전의 source snapshot/검증은 별도 필수 조건으로 포함 |

기존 문서와 티켓의 이 행들을 이번 준비에서 직접 재작성하지 않았다. 후속 PO가 변경 영향과 순서를 재계획하고 architecture가 shared contract를 확정해야 한다.

## 테스트 근거와 이전 완료 기준

계산 동등성은 raw/normalize/digest/weight-lifestyle/report-input fixture, 실패 격리는 collect/store/normalize, 평가 순서·개별 저장은 report, subprocess 정리는 report-codex 테스트를 기준으로 삼는다. 기존 acceptance-report는 fake Codex E2E다. 실제 모델 품질 검증은 별도이며 현재 준비에서는 모델 호출하지 않았다.

기존 합성 fixture·fakes는 archive에 포함한다. ignored 실제 Garmin fixture는 포함하지 않는다. 새 PG 계약은 raw exact-text·NULL/단위·중복/재개·FK mapping·rebuild 평가 비삭제·lease/cancel·계정 차단을 검증해야 한다. 초기 tracer는 합성 원본 한 건과 기존 분석 형식 문서 한 건을 PostgreSQL에 넣고 core query로 읽는 경로로 제안한다.
