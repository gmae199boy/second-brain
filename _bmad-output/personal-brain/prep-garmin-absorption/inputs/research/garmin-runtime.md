---
title: 'Garmin 데이터·실행 수명 조사'
type: codebase
repository: '~/github/garmin'
commit: '7fb33dd1661ad25cd73e14ed63abe0a87151f62e'
status: complete
validation: normal
created: '2026-10-27'
---

# Garmin 데이터·실행 수명 조사

Garmin은 인증·수집·원본 보존·수치 정규화·AI 평가·리포트·전송을 갖춘 Python 파이프라인이다. 분석자는 고정 커밋의 구현 15파일을 읽었고, 주요 주장은 별도 검증자가 다시 확인했다. 아래 테스트 위치는 검색으로 발견했으며 이번에 실행하지 않았다.

## 수집·인증

collect는 하나의 write session에서 원본을 수집하고, 정상 반환한 blocked/skipped 결과에도 같은 연결로 normalize를 수행한다. 예외나 write-lock timeout까지 정규화한다는 뜻은 아니다. sync는 collection의 락이 해제된 뒤 오늘 report를 재생성한다. `src/garmin_pipeline/collect.py:169-245 (collect) @ 7fb33dd`; `src/garmin_pipeline/collect.py:248-316 (_collect_once) @ 7fb33dd`; `src/garmin_pipeline/cli.py:404-424 (_sync) @ 7fb33dd`.

GarminAdapter는 tokenstore 세션 락 아래 비대화형 로그인을 수행한다. 데이터 호출 사이에 간격을 두고 429 또는 승격된 연속 403에는 세션 차단과 당일 block 기록을 시도한다. block 쓰기는 OSError를 삼키므로 디스크 영속화는 최선 노력이다. 잘못된 block 파일은 로그인 전에 거부한다. 초기 분석의 무조건적인 “차단을 영속화한다”는 표현은 이 조건으로 수정했다. `src/garmin_pipeline/garmin/__init__.py:291-347 (_fetch) @ 7fb33dd`; `src/garmin_pipeline/garmin/__init__.py:371-385 (_record_block) @ 7fb33dd`; `src/garmin_pipeline/garmin/__init__.py:443-463 (open_session) @ 7fb33dd`; `src/garmin_pipeline/garmin/__init__.py:668-708 (_blocked_on) @ 7fb33dd`.

## 저장·파생·평가

store가 SQLite 연결, WAL, migration과 user_version을 관리한다. 읽기는 mode=ro와 정확한 schema 일치를 요구한다. 보고서 락 → 쓰기 락 → Garmin 세션 락이 의도된 순서이며, 모든 역순이 중앙에서 차단된다는 뜻은 아니다. migration은 연속 번호를 검증하고 SQL과 버전 변경을 transaction으로 묶는다. 마지막 migration 번호는 0016이다. `src/garmin_pipeline/store/__init__.py:107-178 (report_session) @ 7fb33dd`; `src/garmin_pipeline/store/__init__.py:402-460 (_load_migrations) @ 7fb33dd`; `src/garmin_pipeline/store/migrations/0016_day_values_evaluation.sql:31 (evaluation) @ 7fb33dd`.

원본 raw는 payload/library version/fetched/checked 시각을 유지한다. 동일 payload나 NoData는 기존 원본을 지우지 않고 checked_at만 바꾼다. normalize의 재구성은 파생 테이블을 다시 만들면서 원본과 평가를 보존한다. 모델 평가는 report_date/scope별로 별도 저장한다. `src/garmin_pipeline/store/__init__.py:270-324 (upsert_raw) @ 7fb33dd`; `src/garmin_pipeline/normalize/__init__.py:221-274 (_DERIVED_TABLES) @ 7fb33dd`; `src/garmin_pipeline/store/migrations/0016_day_values_evaluation.sql:31 (evaluation) @ 7fb33dd`.

리포트 입력은 식별자를 scrub한 원본 snapshot, 체성분 sidecar, labels/profile/previous evaluation과 계산 digest를 준비한다. digest는 모델 서술과 별개인 수치 계산이다. 기간 입력은 별도 읽기 snapshot으로 만든다. `src/garmin_pipeline/report_input.py:44-54 (scrub) @ 7fb33dd`; `src/garmin_pipeline/report_input.py:232-366 (build) @ 7fb33dd`; `src/garmin_pipeline/report_input.py:406-540 (build_period) @ 7fb33dd`; `src/garmin_pipeline/digest.py:1218-1262 (build) @ 7fb33dd`.

## 분석·중단·전송

report는 report lock 아래 optional 체성분 입력 뒤 day→7d→30d→all 평가를 순서대로 실행하고, 각 성공 평가를 즉시 저장한다. 이후 그래프·Markdown 작성·전송을 수행한다. 일반 실행의 건너뛰기 기준은 성공 day evaluation의 존재이므로, report 파일이 없어도 건너뛸 수 있다. `src/garmin_pipeline/report.py:810-886 (run) @ 7fb33dd`; `src/garmin_pipeline/report.py:921-961 (run) @ 7fb33dd`; `src/garmin_pipeline/report.py:1030-1045 (_save_evaluation) @ 7fb33dd`.

Codex는 shell 없는 argv, 새 process session, invocation별 timeout을 사용한다. 종료·오류·timeout 때 그룹 TERM, 최대 5초 대기, KILL 및 leader reap을 수행한다. SIGTERM trap은 signal 등록이 가능한 경우에만 설치된다. `src/garmin_pipeline/report.py:161-230 (codex_argv) @ 7fb33dd`; `src/garmin_pipeline/report.py:306-411 (CodexWriter) @ 7fb33dd`.

기본 수집 대기는 30분, Codex timeout은 invocation별 20분이다. 하나의 invocation만으로도 600초보다 오래 기다릴 수 있는 코드 경로이며, 실제 실행 시간 측정은 아니다. 네 평가의 timeout 합을 전체 report의 엄격한 상한으로 볼 수 없다. 락 대기·체성분 입력·준비·그래프·전송·정리도 있기 때문이다. `src/garmin_pipeline/config.py:43-44 (_DEFAULTS) @ 7fb33dd`; `src/garmin_pipeline/report.py:317-321 (_execute) @ 7fb33dd`; `src/garmin_pipeline/report.py:845-886 (run) @ 7fb33dd`.

알림은 날짜/이벤트 행을 먼저 INSERT OR IGNORE하고 전송하므로 한 번의 논리적 전송 시도를 제한한다. 실패·예산 소진 후에도 gate는 남는다. 리포트 bundle에는 같은 중복 억제 gate가 없으며 재생성은 다시 전송할 수 있다. 이는 정확히 한 번 전달 보장이 아니다. `src/garmin_pipeline/ports.py:50-57 (TableNotifier) @ 7fb33dd`; `src/garmin_pipeline/ports.py:101-141 (TelegramReportSink) @ 7fb33dd`; `src/garmin_pipeline/ports.py:253-279 (TelegramNotifier) @ 7fb33dd`; `src/garmin_pipeline/report.py:712-759 (_notify_failed) @ 7fb33dd`.

## 배포·예약·검증 한계

패키지는 Python>=3.12이나 배포 스크립트는 정확히 3.14.8을 요구한다. 기존 config는 보존하고 runtime 의존성과 skills를 설치한 뒤 normalize→install-schedule 순서로 진행한다. 현재 예약은 collect용과 report용 두 LaunchAgent이고, 수집은 두 예약 시각을 가진다. `pyproject.toml:6 (project) @ 7fb33dd`; `scripts/deploy.sh:27-93 (deployment) @ 7fb33dd`; `src/garmin_pipeline/schedule.py:83-170 (refusals) @ 7fb33dd`.

테스트 탐색에서는 동일 연결 정규화, 재구성 rollback, rate block/MFA, 네 평가 순서와 즉시 저장, process-group timeout/SIGTERM, 식별자 필터, 전송 실패 후 gate 보존, normalize 선행 배포를 다루는 정의를 찾았다. 정확한 테스트 위치와 검색 범위는 `digests/garmin.md`에 있다. 테스트 본문을 읽거나 실행한 것으로 확대 해석하지 않는다.

## Open questions

auth/coverage/parser/chart 구현과 테스트 본문은 15파일 한도 밖이다. 다음 사실 질문은 “날짜 누락·당일 수정·실패 endpoint의 재수집 계획은 어떤 조건으로 바뀌는가?”다. 단일 제품 이전을 실행할 때 이 계약과 실제 fixture 기반 수치 동등성 확인이 추가로 필요하다.
