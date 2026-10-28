---
title: "epic 16 Garmin connector — 정적 코드 조사"
date: 2026-10-28
status: research
---

# epic 16 코드 조사

지정 archive를 저장소 밖 새 임시 디렉터리에 풀어 텍스트로만 조사했다. Garmin 코드·시험·빌드·Docker·설치·네트워크·계정 호출은 실행하지 않았다. 이 Mac은 경로 존재·mtime·LaunchAgent 이름/등록 상태만 관찰했으며 tokenstore·설정·비밀 파일 내용은 읽지 않았다. 아래 시험 근거는 소스 정의이지 실행 성공의 증거가 아니다.

근거 약칭: `G/`는 `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 안 `garmin-source/`, `P/`는 `G/src/garmin_pipeline/`다. 문서의 공통 접두사는 `_bmad-output/personal-brain/`이며 `spine`은 `architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `I`는 `initiative-personal-brain.md`, `D`는 `decisions-by-recommendation.md`, `E16`은 `tickets/epic-garmin-runtime/epic-garmin-runtime.md`, `T12/T13/T14/T15`는 각각 jobs-and-scheduler/extensions/garmin-import/channels 에픽의 `tickets/tickets.toml`이다. 각 약칭 뒤 `:행`은 해당 파일의 실제 행이다. 제안 경로는 앞 에픽 완료 HEAD에서 확인할 구현 후보이며 현재 코드가 있다는 주장이 아니다.

범위는 R2·R11·C4의 Python connector 재사용이며 평가·report-input 필터·Codex·리포트 묶음은 epic 18이다(`I:28`, `I:37`, `I:50`, `I:172`, `I:173`). 2026-10-28 위임을 우선한다: 로컬 설치본 확인은 에이전트, MFA만 해당 스토리 awaiting-operator, 원격 push는 operator_actions다(`I:188`, `I:189`, `I:191`, `I:192`, `D:10`, `D:46`). **어긋남:** prep의 프로세스 형식 미정 문구는 뒤의 ABI v1으로 채워졌다. C6 위임은 조사 중 갱신된 spine에도 반영됐으므로 이전 조사 보고서의 사용자 선택 대기를 되살리지 않는다(`prep-garmin-absorption/integration-boundaries.md:30`, `spine:509`, `spine:493`, `I:190`).

## 1. 옛 코드 지도와 교체 경계

| 모듈 | 책임·호출 흐름 | 가져갈 것과 교체할 것·근거 |
|---|---|---|
| auth → garmin | login은 토큰 폴더 준비→대화형 로그인→auth_event, smoke는 저장 토큰→어제 user_summary 한 번 | 프롬프트·오류 분류 재사용, DB 기록과 설치 인증 단계 교체. `P/auth.py:1`, `P/auth.py:101`, `P/garmin/__init__.py:443` |
| garmin(client 경계) | 유일한 garminconnect/curl-cffi import 지점, 세션 락·로그인·fetch·차단 | 외부 라이브러리 접근 한 곳 유지. 별도 client.py가 아니라 이 패키지의 `_configured_client`/`_new_client` 경계. `P/garmin/__init__.py:33`, `:38`, `:443` |
| coverage·rawparse | DB raw/error/run→day/activity CoverageItem, 목록→id/date/needs_sets, 생활 습관 재확인 | 판단과 파싱 재사용, SQLite SELECT를 PG reader port로. `P/coverage.py:1`, `:133`, `:318`, `P/rawparse.py:37`, `:123` |
| collect | 저장 상태 진입표→history_start→계획→첫 호출 보호→day fetch→목록 재조회→activity fetch→종료 알림→normalize | 계획/실패 격리 보존, 실행 수명·SQL·알림 adapter 교체. `P/collect.py:212`, `:248`, `:35`, `:42` |
| store | SQLite WAL/쓰기 flock/마이그레이션/raw upsert | 옛 SQL은 의미 명세로만 활용. PG role·짧은 transaction·단일 core 실행기로 교체. `P/store/__init__.py:135`, `:270`, `:402`; `spine:470`, `:481` |
| normalize | endpoint 파서→daily/activity/샘플/세트→day_summary/workout/exercise_log·결과 상태 | 순수 daily/activity 계산 재사용, coordinator의 삭제/UPDATE는 불변 INSERT publisher로 교체. `P/normalize/__init__.py:221`, `:243`, `:285`; `spine:492` |
| body | 이미지 등의 원본 경로+검증 JSON→필드 mtime 병합 sidecar→processed/unreadable | 값·출처 보존, 옛 runtime 상대 경로는 새 staging/파일 관계로. `P/body.py:1`, `:13` |
| digest | raw dict+manifest+labels+body→수치 dict, day_values는 저장할 일 값 | 순수 계산 재사용. 모델 서술과 분리. `P/digest.py:1`, `:1218`, `:1252`, `:1259` |
| charts·labels | 파생 DB·body 읽기→그래프별 PNG; 한국어 종목 표 | 읽기 snapshot port·파일 요청 교체, 렌더 계산 재사용. `P/charts.py:1`, `:755`, `:869`; `P/report_input.py:268` |
| errors·ports·telegram | 도메인 상태와 사건→날짜 gate→직접 Telegram→delivery | 사건 분류만 connector, 실제 발신·봇 비밀·결과는 epic 15. `P/errors.py:23`, `P/ports.py:253`; `T15:8`, `:20` |
| config·cli·schedule·deploy | config TOML→수동 명령/로깅; frozen runtime 설치→normalize→두 LaunchAgent | snapshot·manifest 명령·core 설치/공통 예약으로 교체. `P/config.py:1`, `G/pyproject.toml:15`, `G/scripts/deploy.sh:35`, `:89`, `P/schedule.py:33` |
| report_input·report·Codex | snapshot/cutoff/scrub→day/7d/30d/all 평가→Markdown/PNG/bundle | epic 18 경계. 이 에픽에서 report.run을 수집 후 자동 호출하면 안 됨. 옛 sync는 collect 뒤 report 호출. `P/cli.py:404`, `P/report.py:810`, `:845`; `I:173` |

이 흐름은 body가 반드시 네트워크 정규화 뒤 실행되는 단일 직선이 아니다. body는 별도 오프라인 입력 장부이며 digest/charts의 공통 입력이다. 옛 charts 호출은 report 안에 있으므로 connector용 산출 진입점을 분리할 후보가 필요하다(`P/body.py:1`, `P/digest.py:1252`, `P/charts.py:755`, `P/report.py:921`).

## 2. 인증·계정 보호와 ABI v1

무인 세션은 tokenstore 디렉터리 검사→`.session.lock` flock→block 검사→client→`login(tokenstore)`→세션 yield다. 자격 증명·MFA는 login 명령의 LoginPrompts로만 받고, 락 밖에서 묻고 락 안에서 credentials login(`return_on_mfa=True`)·resume_login을 한다. 잘못된 MFA 코드는 같은 client에서 최대 3회이며 성공 뒤 dump한다(`P/garmin/__init__.py:443`, `:486`, `:511`, `:542`; `P/auth.py:55`, `:68`). 비밀번호는 getpass이고 TTY가 없으면 거부한다. 새 감독자 stdout은 JSONL이므로 옛 input 프롬프트/일반 print를 그 stdout과 섞지 않는 별도 operator 로그인 경로가 필요하다(`P/auth.py:55`, `:61`; `spine:504`, `T13:56`).

토큰 기본 위치는 `~/.garmin-pipeline/tokens`, 명세상 파일은 `garmin_tokens.json`(라이브러리 dump의 JSON, 0600), 폴더는 0700이다. block.json은 비밀 토큰과 별개인 schema_version/local_date/reason JSON이며 임시 파일→replace로 쓴다. 토큰 JSON 내부 필드/세대 변환은 archive에 라이브러리 소스가 없어 확정하지 않는다. **garth 어긋남:** 현재 lock의 garminconnect 0.3.17 의존은 curl-cffi/requests/ua-generator이며 garth 패키지가 없다. 옛 garth oauth 파일이 있을 것이라는 가정을 새 token reader 계약으로 만들지 말고 라이브러리의 login/dump를 경유한다(`P/config.py:35`, `P/auth.py:5`, `P/garmin/__init__.py:69`, `:545`, `:676`, `:721`; `G/uv.lock:472`).

| 보호·상태 저장 위치 | 옛 동작 | 이식 경계 |
|---|---|---|
| 호출 pacing·세션 메모리 | 매 데이터 호출 직전 uniform 1~2초; 날짜 사이 5초. 내부 라이브러리 재시도에는 별도 pause가 적용되지 않음 | 라이브러리 버전을 고정하고 wrapper pacing을 보존. 내부 retry까지 보장한다고 쓰지 않음. `P/garmin/__init__.py:301`, `P/config.py:48`, `G/tests/test_garmin.py:1862` |
| 연속 403, 메모리 `_consecutive_403` | 데이터 403은 Rejected, 3회면 Blocked403; 다른 응답은 카운터 reset | 계정 직렬 세션 안 상태 보존. 로그인 403은 즉시 차단. `P/garmin/__init__.py:317`, `:627` |
| 429·403 차단, tokenstore/block.json | 세션 `_blocked` 뒤 추가 fetch 0회. 다음 실행은 당일 block 확인; 이전 날짜 block은 무시. 파일 쓰기 실패는 삼킴 | 날짜 경과만으로 해제되는 옛 동작과 새 “해제 전 외부 호출 금지”는 어긋남. 새 계정 보호 상태를 영속화하고 해제/재인증 사실 확인 전에는 예약·수동 실행 모두 로그인 전에 차단하는 안. 파일 기록 실패에도 같은 세션은 막지만 재시작 보호 보장은 추가해야 함. `P/garmin/__init__.py:292`, `:371`, `:668`; `E16:31` |
| auth_failed·토큰 mtime, run 표 | 당일 auth_failed는 토큰 mtime이 finished_at보다 뒤일 때만 재수집. 다음 날 not_run은 다시 로그인 가능 | MFA/login_required 영속 latch와 인증 세대 후보. 단순 mtime은 유효 토큰 증거가 아님. 실패 뒤 재인증 없이 다음 날 다시 로그인하는 경로를 막아야 함. `P/collect.py:25`, `:29`; `D:10` |
| first-call, raw 상태·실행별 시도 수 | exercise_sets/weigh_ins/lifestyle에 non-null raw가 전혀 없으면 보호; endpoint마다 실행당 3건. 보호 403은 카운터 증가/감소 없음. 429는 여전히 중단 | PG raw 전체 상태를 같은 계정으로 조회, 실행 시작에 고정. 건너뛴 항목은 fetch_error가 아니며 다음 실행 계획에 남음. `P/collect.py:46`, `:112`; `P/garmin/__init__.py:317` |

ABI는 code+retryable을 운반하되 아래는 **매핑 제안**이다. exact code 이름은 epic 12 완료 schema/codes에 맞춘다. 옛 collect의 종료 코드 0은 success·partial·차단도 포함하므로 그대로 supervisor 성공 판정에 쓰지 않는다(`T12:44`, `:56`; `P/collect.py:179`).

| 옛 결과 | ABI 분류 후보와 재호출 제약 | 근거 |
|---|---|---|
| NoData | 정상 관측, null/checked 갱신; 오류 이벤트 아님 | `P/errors.py:133`, `P/store/__init__.py:312` |
| Transient·login_transient·session lock timeout | retryable=true, 저장 완료분 유지. 계정 guard가 허용할 때만 다음 시도 | `P/errors.py:114`, `P/collect.py:57`; `T12:56` |
| Rejected | 항목 실패; 같은 날 자동 재호출 제외, 서로 다른 거부 일수 상한. 무조건 일감 전체 영구 실패로 합치지 않음 | `P/collect.py:31`, `P/coverage.py:96` |
| AuthFailed/MFA/privacy | retryable=false 또는 login_required 분류, 새 인증 전 네트워크 금지 | `P/garmin/__init__.py:350`, `:635`; `T13:56` |
| RateLimited/Blocked403/SessionBlocked | 보호 상태부터 저장, 즉시 재시도 금지. blocked 자체는 retryable=false, 해제 사실 뒤 별도 일감 재개 후보 | `P/garmin/__init__.py:343`, `:363`; `E16:31` |
| BlockFileInvalid·설정/ABI 불일치 | fail closed, retryable=false; 수정 후 재개 | `P/garmin/__init__.py:676`; `T13:20` |
| 파서 실패·예상 밖 내부 오류 | 항목별 normalize 상태/사건을 남김. 입력 수정/규칙 변경 전 동일 실패 무한 retry 방지 | `P/normalize/__init__.py:309`, `:339` |

인증·연결 확인·수집은 epic 14가 확인한 account identity를 기준으로 같은 `(source, account)` 직렬화 키를 받아야 한다. 폴더명·토큰 문자열을 키로 쓰지 않는다. 로그인 profile의 Garmin 사용자 profile id를 계정 identity로 쓰는 handoff가 추가됐다. 최초 로그인에서 identity가 확정되기 전에는 tokenstore 락/안정 인증 대상의 보호 키를 사용하고, 이후의 수집은 확인된 계정 키로 고정하는 안이 있다(`E16:64`). `unknown` attempt는 키를 놓지 않고 다른 계정만 병렬 가능하다. 옛 flock도 전환 기간 유지하면 옛 writer와 경합을 막는 보조 장치가 되지만, 서로 다른 tokenstore를 쓰는 동일 계정은 막지 못한다(`D:30`, `T12:80`; `P/garmin/__init__.py:459`).

비밀은 core 설정 코덱이 ABI 입력으로 전달하고 DB URL도 argv에 두지 않는다. 확장은 .env/settings/config.toml을 다시 읽지 않는다. 토큰은 라이브러리 전용 비밀 저장소로 두고 snapshot에는 경로/참조만 전달하는 후보가 기존 dump와 맞는다. DB/봇 비밀의 .env와 Garmin tokenstore를 합쳐 로그·공개 설정으로 노출하지 않는다. 오류는 allowlist code/단계/endpoint만, 라이브러리 예외 문자열·응답·계정·MFA는 제거하고 traceback/stderr도 감독자 가리기/길이 제한을 거친다(`spine:473`, `:509`; `P/garmin/__init__.py:34`, `:328`; `T12:44`, `T13:20`, `:44`).

## 3. 수집·raw·정규화와 PG의 불변 이력

날짜 endpoint 11개는 sleep_data, hrv_data, rhr_day, heart_rates, stress_data, body_battery, user_summary, training_readiness, daily_weigh_ins, lifestyle_logging_data, activities_by_date다. 활동 4개는 activity, activity_details, activity_hr_in_timezones, activity_exercise_sets이고 세트는 needs_sets 활동만 받는다. heart_rates/user_summary는 라이브러리의 빈 응답 예외를 피하려 같은 URL의 connectapi를 직접 부르며 activities_by_date의 paging은 라이브러리 내부다(`P/garmin/__init__.py:82`, `:97`, `:214`, `:233`; `P/coverage.py:138`).

history_start는 첫 실행 today−30일을 INSERT OR IGNORE로 고정한다. 최신 날짜부터 최대 10일, today·확정되지 않은 어제와 누락을 메우므로 기본 30일 백필은 여러 성공 실행에 나뉜다. final은 day 다음 날 이후 확인 여부, plannable은 서로 다른 rejected 날짜 수<3, activity fresh는 세트 checked_at≥소속 목록 fetched_at다. 생활 습관 completionStats가 최신 응답과 다른 이전 6일 항목은 다시 확인한다. 여러 목록의 같은 activity는 목록 key 오름차순 첫 소속을 쓴다(`P/collect.py:4`, `:21`, `:35`; `P/config.py:51`; `P/coverage.py:93`, `:138`, `:318`).

11:15는 별도 무조건 전체 수집이 아니다. 같은 collect 진입표가 당일 상태를 읽는다: not_run/error/rate_limited/blocked_403은 전체 계획(단 당일 block 선검사), auth_failed는 새 토큰 mtime일 때만, partial+transient는 오늘 checked/rejected를 제외한 재시도, success·거부만 있는 partial은 no-op다. force도 block을 우회하지 않는다. sync의 recent_lists는 최근 7일 목록을 상한 안에서 다시 받는 별도 옵션이다. 새 공통 예약의 놓친 날짜 처리는 epic 12 규칙을 소비한다(`P/collect.py:25`, `:31`, `:39`; `E16:61`; `T12:92`).

raw는 HTTP 바이트가 아니라 라이브러리가 decode한 객체를 json.dumps(ensure_ascii=False)한 **그 문자열**이다. key 순서·비ASCII가 보존되고 surrogate만 ensure_ascii=True fallback이다. 첫 NoData는 literal null, 기존 data 위 NoData/같은 문자열은 checked_at만 바뀌고 내용 변경은 fetched_at/library_version도 바뀐다. JSONB 재직렬화로 대체하지 않는다(`P/store/__init__.py:270`, `:294`, `:312`).

정규화 버전은 8(schema 버전과 별개)이다. 옛 증분은 normalize_result가 없거나 raw_fetched_at≠raw.fetched_at인 항목이고 실패도 같은 fetched_at이면 자동으로 다시 하지 않는다. rebuild/버전 불일치는 파생 표 전부 삭제→재계산→meta 갱신을 한 transaction으로 묶고 항목 savepoint로 실패를 격리한다. evaluation은 삭제 집합 밖이다. 파서 실패 때 기존 담당 열/샘플을 지우는 동작도 있다(`P/store/__init__.py:49`; `P/normalize/__init__.py:221`, `:243`, `:309`, `:339`). **어긋남:** 이 DELETE/UPDATE 방식을 core 건강 표에 가져가면 AD-32 위반이다(`spine:492`, `:495`).

| PG에 붙일 지점 | 보장할 계약·설계 선택지 | 근거 |
|---|---|---|
| raw sink | epic 14 garmin 보존 표에 새 수집 출처/dataset을 추가해 이어 씀. legacy 원본은 덮지 않음. 내부 scope/library_version/error/history_start 연결 유지 | `T14:44`, `spine:545` |
| raw 공개 view | 기존 key를 `<scope>/<원래 key>`로 투영. source/account/endpoint/fetched/checked/body 모양 유지 | `D:29`, `spine:471` |
| 계정/권위 publish | epic 14 계정 확인 규칙 재사용, 새 수집 출처를 맨 앞에 둔 **새 권위 규칙 버전** 기록. 기존 규칙 v1 수정 금지. 미확인/동률 ambiguity는 현재 집계 제외 | `D:30`, `:31`; `T14:20`; `spine:493` |
| 건강 publisher | 논리 키+출처/dataset+정규화 8+관측 revision(안정 revision 또는 원문 hash)의 새 행 INSERT. 같은 원문 재처리는 같은 key, 수정 관측은 새 revision. NULL 키도 DB 중복 억제 | `spine:492`, `:494`, `:580`; `T14:20` |
| 증분·재개 | raw 저장→계산→건강 행/normalize 상태/checkpoint를 작은 단위로 확정. raw와 건강은 같은 DB transaction 가능. 둘을 나누면 미발행 raw를 재발견할 내구 상태 필요. 멱등 키가 attempt id에 종속되면 재시도 중복이 되므로 분리 | `spine:470`, `:186`; `P/normalize/__init__.py:339`; `T14:44` |
| 외부 I/O 경계 | coverage read snapshot을 닫고 외부 호출; 받은 뒤 짧은 write. pacing/로그인/PNG 파일 I/O 동안 transaction 없음, 2초 제한. 옛 write_session 전체를 PG transaction으로 감싸면 안 됨 | `spine:171`; `P/collect.py:192`, `P/store/__init__.py:291` |
| 취소/오래된 attempt | endpoint 전후·날짜 대기·정규화 batch마다 취소 반응/진행 이벤트. core 계약 INSERT는 12.3 trigger, garmin 내부 raw·상태 쓰기도 현재 attempt 검사와 같은 transaction으로 보호할 후보. 새 attempt가 있는데 옛 `_abandon_running`이 전부 종료시키지 않도록 변경 | `spine:505`, `:508`; `P/collect.py:319`; `T12:20`, `T13:44` |

정규화 일감 분리는 collect 안 후처리를 유지하는 안과 별도 supervised normalize 일감으로 이어 실패 재개를 분리하는 안이 있다. 어느 안이든 받은 raw가 남고 취소 후 오래된 생산자의 건강·파일·알림 요청이 거부돼야 하며, core 일감을 확장이 직접 청구/생성하지 않고 계약 요청만 낸다(`P/collect.py:54`, `:79`; `spine:474`, `:502`, `:508`).

## 4. body·digest·그래프 산출물

| 산출 | 입력→출력·형식 | 새 파일 경계·근거 |
|---|---|---|
| body | inbox/inbody 바로 아래 원본 참조+stdin measurement JSON→body schema v1 JSON sidecar. NaN/Infinity/중복 key 거부, 필드별 source 최대 mtime로 병합, 같은 mtime이면 새 값. processed/unreadable로 원본 이동 | 원본을 `file_requests` staging으로 먼저 보존하고 측정 행에 필드 mtime/원본 관계. 완료 전 이동으로 locator를 잃지 않게 함. 이미 FileStore에 있는 원본이면 관계 재사용 후보. `P/body.py:13`, `:18`, `:20`, `:47`; `spine:545`, `:583` |
| digest | manifest(timezone/cutoff/baseline)+날짜 raw+활동+종목 labels+검증 body sidecars→순수 dict(JSON 직렬화 가능). sleep/day/workouts/body/weight/drinks/recovery/notes | 수치와 provenance를 건강 계약/확장 산출물에 남기고 epic 18이 소비. cutoff snapshot 조립·scrub은 epic 18; 여기서 모델을 호출하지 않음. `P/digest.py:1`, `:1218`, `:1252`; `I:173` |
| 그래프 | 파생 값 read snapshot+body→PNG와 Graph(name,title) 목록. 어제/최근 세션/근력, 30일·전체 추세·body | 성공 PNG를 닫고 크기/미디어 타입/안정 산출 revision과 함께 file_requests INSERT. core 완료 view에서 file_id를 읽어 관계 확정, bytes는 완료까지 보존. `P/charts.py:755`, `:793`, `:866`, `:894`; `T14:56` |

그래프는 matplotlib을 render 안에서 늦게 import하고 Agg, 12×6 inch·150 DPI, Apple SD Gothic Neo/DejaVu Sans를 사용한다. private MPLCONFIGDIR(0700), PNG 0600, 10,000,000 bytes 상한·그래프별 실패 삭제/계속을 유지한다. archive 경로 목록에서 ttf/otf 번들은 발견되지 않았고 코드도 OS 폰트 family를 지정하므로 한국어 glyph 실측은 배치 환경에서 남는다. PNG exact bytes 동등성은 폰트/렌더 버전 영향이 있으므로 수치·축·라벨·빈 부분/실패 격리와 파일 형식 검증을 우선하고 고정 환경에서만 이미지 golden 후보를 둔다(`P/charts.py:22`, `:875`, `:882`, `:892`, `:895`; `G/tests/test_charts.py:102`, `:476`, `:512`).

종목 이름은 `P/labels/exercise_types_ko.json` 리소스이며 옛 report_input이 importlib.resources로 읽어 snapshot labels에 쓴다. connector에서 labels loader를 분리해 normalize/digest/charts가 같은 자산을 보게 할 후보다. 원본/생성기와 같이 이동하고 번역을 코드에 복제하지 않는다(`P/report_input.py:268`, `:332`; `G/scripts/build_exercise_labels.py:1`; `G/tests/test_charts.py:1093`).

## 5. 수집 사건 알림과 의미 키

최신 handoff는 14.1 raw view·14.2 건강/권위·14.5 파일 요청·14.8 이후 차분과 예약 중지를 이 에픽에 연결한다(`E16:64`).

이 에픽 사건은 auth_failed, rate_limited, blocked_403, normalize_failed, repeated_partial, error 6개다. report_failed는 epic 18이다. 종료 상태 중 success/skipped_blocked/no-op/쓰기 lock timeout은 알리지 않고, 반복 partial은 오늘·어제가 모두 transient 포함 partial일 때다. normalize_failed는 이번 명령 시작 이후 실패만 endpoint 건수로 묶는다(`P/errors.py:23`; `P/collect.py:73`, `:79`).

옛 TableNotifier는 `(local_date,event)`를 먼저 INSERT OR IGNORE하고 처음만 TelegramNotifier.send한다. budget 부족/전송 실패에도 gate가 남으며 delivery 성공과 gate는 다르다. 새 구조에서 connector가 Telegram 직접 호출/봇 설정 읽기를 해서는 안 된다(`P/ports.py:50`, `:253`; `spine:582`; `T15:8`).

**의미 키 매핑 후보:** 생산 결과 식별자는 `(source, account, timezone, local_date, event)`의 안정 사건 행 id, conversation은 epic 15의 봇·채팅 연결, 목적은 `collection-notice:<event>`, 개정은 고정한 사건 템플릿 revision이다. 같은 날짜의 뒤 attempt/run UUID·새 detail이 새 생산 결과 id를 만들면 옛 gate가 깨지므로 최초 사건 행은 재사용한다. account/timezone 범위는 옛 단일 계정·시간대의 gate를 다계정에서도 보존하기 위한 명시 범위다. 요청 UUID는 의미 키가 아니다(`P/ports.py:52`; `spine:535`; `T15:8`, `:32`).

사건 기록+채널 요청을 짧은 transaction으로 넣거나 미요청 사건 재발견 checkpoint를 둔다. INSERT 뒤 crash는 core 인계가 복구한다. 최초 발신 gate·sent/definite_failed/unknown·재시도는 epic 15의 구현 계약을 소비하며 수집 결과는 바꾸지 않는다. **어긋남:** 옛 전송 실패 후 그날 재발신 없음과 T15의 unknown/일시 실패 재시도는 다르다. 날짜 사건 중복 요청 억제는 유지하면서 실제 attempt 재시도는 채널 결정에 따른다고 명시해야 한다(`P/ports.py:253`; `T15:20`, `:21`; `spine:474`).

## 6. manifest·설정 snapshot

아래 명령/키 이름은 **선택지**이며 manifest v1 실제 schema에 맞춰 정제한다. `garmin.collect`(supervised; Python 모듈 worker collect), `garmin.normalize`(같은 worker normalize/rebuild), `garmin.body-*`, `garmin.artifacts`로 나누는 안과 collect에서 normalize/artifacts까지 돌리는 안이 있다. 인증은 token 연결 확인과 operator login을 구분한다. 수동 실행은 epic 14의 공용 `brain ext run garmin <job>`를 소비하고 옛 전용 CLI 전체를 core에 추가하지 않는다(`T13:20`, `:56`; `D:33`; `G/pyproject.toml:15`; `P/auth.py:13`).

기본 예약은 collect 11:00·retry 11:15, 시간대는 core DB timezone이다. retry는 3절 진입표를 공유하며 예약 두 개가 같은 계정 직렬 키를 사용한다. report 11:30은 epic 18에서 선언한다. 놓친 날짜의 한 번 보충은 epic 12.8, 확장 끄기/재활성화는 12.10 보류 그룹을 소비한다(`P/config.py:39`; `E16:61`; `T12:92`, `:116`; `T13:68`).

| 옛 `_DEFAULTS`·필수 키 | 새 대응 후보 | 근거 |
|---|---|---|
| tokenstore=`~/.garmin-pipeline/tokens` | `garmin.tokenstore` 비밀 위치 참조(경로 값), 토큰 본문은 공개 설정 아님 | `P/config.py:35`; `D:10` |
| data_dir=data, reports_dir=reports, inbox_dir=inbox | 확장 홈의 private data/staging/inbox locator. reports는 분석 소유와 분리. 기계 경로인지 사용자 키인지 manifest에서 구별 | `P/config.py:36`; `spine:520`; `T13:20` |
| timezone=Asia/Seoul | core `timezone` snapshot, 별도 garmin.timezone으로 이원화하지 않는 안 | `P/config.py:39`; `spine:318`; `E16:61` |
| collect_time=11:00, retry_time=11:15 | `garmin.collect_time`, `garmin.retry_time` 예약 기본값·사용자 DB 키 | `P/config.py:40`; `T13:20` |
| date_pause_seconds=5, call_pause_min_seconds=1, max=2 | 같은 이름의 `garmin.*` 수치; min≤max 검증 | `P/config.py:48`, `:157` |
| max_dates_per_run=10, max_rejected_attempts=3, max_consecutive_403=3 | `garmin.*` 정수; 최소 3/1/1 | `P/config.py:51`, `:149` |
| lock_wait_seconds=60, cffi_api_session=false | `garmin.*` 숫자/boolean, supervisor 임대 시간과 혼동 금지 | `P/config.py:54`, `:153` |
| report_time=11:30, wait_minutes=30, codex_timeout_minutes=20, model=None, reasoning_effort=high, profile_path=profile.md | epic 18 설정 소유 경계, connector manifest에 분석 명령/예약을 넣지 않음 | `P/config.py:42`; `I:173` |
| environment 필수(runtime/dev), path·db_path | core 격리 홈/DB와 installer의 실행 컨텍스트로 대체. SQLite db_path는 제거 | `P/config.py:31`, `:74`, `:101`; `spine:521` |

옛 config는 인자>환경변수>cwd TOML이며 GARMINTOKENS를 읽지 않는다. 새 worker는 설정 코덱이 실행 시작에 만든 불변 snapshot만 받아 한 실행 중 설정 변경에 흔들리지 않는다. 인증 단계에도 같은 계약을 쓴다. `.env`는 core/role/봇 비밀, tokenstore는 Garmin 라이브러리의 session 파일 자리라는 차이를 유지한다. **어긋남:** AD-18의 “토큰은 .env에만”을 문자 그대로 적용하면 라이브러리 tokenstore와 충돌한다. 기록된 옛 tokenstore 재사용 Decision을 우선하되, 구현 티켓에는 라이브러리 관리 session 파일의 예외·경로 참조·0600/0700 경계를 명시하는 선택지가 필요하다(`spine:319`; `D:10`). snapshot에 비밀번호/MFA를 저장하거나 모델/스킬 채팅으로 받지 않는다(`P/config.py:3`, `:11`; `spine:312`, `:509`; `T13:20`, `:44`, `:80`).

## 7. 의존·설치와 macOS arm64

정정(2026-10-28, 세트 검증 S2): 아래의 pin 3.14.8은 옛 archive의 값이다. epic 14가 채택한 새 배포 pin은 spine Stack의 3.14.10이다.

epic 14가 이미 결정한 pin 3.14.8+psycopg[binary] 3(sync)를 전제로 옛 curl-cffi>=0.15, garminconnect>=0.3.17,<0.4, jsonschema>=4.26, matplotlib==3.11.2, requests==2.34.2를 더한다. 이 조사에서는 새 resolve/install을 하지 않았다. 옛 lock 전체를 덮어써 driver를 잃거나 importer가 불필요한 수집 import를 하게 하면 안 된다(`D:28`; `G/pyproject.toml:6`; `T14:8`).

| 잠금의 정적 증거 | 의미·한계 |
|---|---|
| `G/.python-version:1`, `G/uv.lock:1` | 정확 patch pin과 기존 lock format. Python>=3.12 메타만으로 배포 버전을 낮추지 않음 |
| `G/uv.lock:472`, `:481` | garminconnect 0.3.17 py3-none-any. garth가 없는 현재 라이브러리 모델을 보존 |
| `G/uv.lock:348`, `:61` | curl-cffi 0.16.3 cp310-abi3 macOS11 arm64, cffi cp314 arm64 wheel 목록 |
| `G/uv.lock:290`, `:669`, `:779`, `:846`, `:930` | contourpy/kiwisolver/matplotlib/numpy/pillow cp314 macOS arm64 wheel 목록. binary 의존군의 자료이며 실제 import 성공 아님 |
| `G/pyproject.toml:19`, `:29`, `:33`; `G/scripts/deploy.sh:35` | uv_build/uv 하한·src 리소스 cache-key·frozen noneditable 설치 선례. 새 설치기는 epic 13 경로를 사용 |

합친 pyproject와 lock을 함께 재잠금하고 설치 때는 frozen, patch 일치 검사를 해야 한다. psycopg-binary의 cp314 arm64 대응·libpq 포함, curl TLS 동작, matplotlib/한국어 glyph, tzdata·schema/labels package resource, PG NULL/시간/문자열 왕복은 후속 설치 검증에 남는다. old lock에 wheel 이름이 있다는 이유로 새 driver 포함 설치 재현성을 완료 처리하지 않는다(`T13:32`; `spine:789`; `D:28`; `P/charts.py:875`). Garmin 없는 core 설치는 Python/uv를 찾지 않아야 하고 확장 환경은 플러그인 cache 밖에 남는다(`spine:460`, `:520`; `T13:92`).

## 8. 같은 합성 fixture의 동등성 검증안

옛 archive는 수정하지 않는 기준으로 남기고, 후속 구현에서 **합성 데이터만** 옛 고정 환경과 새 PG adapter에 각각 넣어 기대값을 만드는 안이다. 이번에는 어느 쪽도 실행하지 않았다. 먼저 사람이 읽을 수 있는 expected JSON/표를 fixture와 함께 고정하고 Python/TS 판정이 공유하게 하면, 새 코드와 같은 계산으로 매번 기대값을 만드는 순환 검증을 피할 수 있다. 옛 구현을 테스트마다 직접 실행하는 reference runner 안은 lock/SQLite/폰트 의존이 크므로 별도 opt-in suite 후보다(`prep-garmin-absorption/integration-boundaries.md:89`, `:91`; `T14:20`; `G/tests/test_weight_lifestyle.py:142`).

| 비교 범위 | 가져올 합성 입력·시험과 비교할 것 |
|---|---|
| raw | `G/tests/test_raw_response.py:117`, `:129`, `:138`, `:157`, `:204`: key 순서·한국어·surrogate·NoData·순서만 바뀐 문자열, exact TEXT와 fetched/checked/library_version 전이 |
| normalize v8 | `G/tests/test_normalize.py:913`, `:1018`, `:4644`, `:4667`, `:4682`, `:4808`, `:5549`: 열별 수치/NULL·단위·샘플 timestamp/순서·activity/day 연결·세트/휴식·실패 격리·day_summary/workout/exercise_log. 삭제 동작 자체는 비교 목표가 아니라 각 revision 결과를 비교 |
| digest | `G/tests/test_digest.py:97`, `:141`, `:167`, `:304`: cutoff·날짜 경계·원본 무변경·잘못된 shape와 notes, sleep/day/workouts/recovery/body/weight/drinks 모든 dict 값. 수치 허용오차는 지표별로 명시하고 NULL을 0으로 만들지 않음 |
| weight-lifestyle | `G/tests/test_weight_lifestyle.py:64`, `:142`, `:196`, `:248`, `:295`, `:315`: completionStats stale 계획, 최신 체중·일 평균/기간 포함·음주 NULL·한 잘못된 행이 다른 측정을 지우지 않음 |
| body·차트 | `G/tests/test_body.py:291`, `:672`, `:755`; `G/tests/test_charts.py:381`, `:463`, `:856`: 필드 mtime·경로 경계·값 비노출, 무게/volume 수치·DST·한 읽기 snapshot·렌더 실패 격리 |

ignored 실제 Garmin fixture는 archive에 없고 실데이터 기반 digest 시험은 fixture 없으면 skip한다. 그 시험 이름만으로 실데이터 동등성을 주장하지 않는다. report-input fixture와 실제 모델 품질은 epic 18 경계다(`prep-garmin-absorption/integration-boundaries.md:91`; `G/tests/test_digest.py:193`; `I:173`).

## 9. 이 Mac 관찰과 전환 스토리의 실행 가능성

2026-10-28 읽기 전용 관찰 Q9: Python stdlib Path.exists/stat/lstat/iterdir로 아래 고정 경로와 tokenstore 바로 아래 이름·mtime만 출력했다. `launchctl list`는 sandbox 안 검색이 비어 등록 부재를 확정할 수 없어 같은 읽기 명령을 sandbox 밖에서 다시 조회했다. plist 내용·config·token JSON·DB 내용·로그는 열지 않았다. 아래 시각은 건강 관측 날짜가 아니라 filesystem UTC 수정 시각이다. 경로/이름의 정적 근거는 `P/config.py:35`, `G/scripts/deploy.sh:24`, `:35`, `P/schedule.py:33`이다.

| Q9 관찰 대상 | 결과(UTC mtime) | 해석 경계 |
|---|---|---|
| `~/.garmin-pipeline/tokens` | 존재, 2026-10-28 02:00:05 | 토큰 유효성 증거 아님 |
| 바로 아래 `garmin_tokens.json` | 존재, 2026-10-28 02:00:05 | 내용/권한 값은 읽지 않음 |
| 바로 아래 `.session.lock` | 존재, 2026-10-19 08:18:43 | 락을 지금 보유한다는 뜻 아님 |
| `~/github/garmin/runtime` | 존재, 2026-10-19 08:44:37 | deploy의 고정 운영 root와 일치 |
| `~/github/garmin/runtime/.venv` | 존재, 2026-10-19 08:37:57 | Python patch·설치 버전 미검사 |
| `~/github/garmin/runtime/data/garmin.db` | 존재, 2026-10-28 02:15:05 | writer 최신성/내용 미검사 |
| `~/Library/LaunchAgents` 이름 | local.garmin-pipeline.collect.plist, local.garmin-pipeline.report.plist | 이름만 열거, plist 내용 미검사 |
| `launchctl list` | local.garmin-pipeline.collect / local.garmin-pipeline.report 모두 등록; PID `-`, 마지막 상태 0 | 조회 시 실행 PID 없음. 미래 예약·수동 실행 부재의 보장은 아님 |

Q9는 코드로부터 추론한 현재 상태가 아니라 이번 메타데이터 명령의 관찰 기록이다. 전환 스토리에서 에이전트가 기존 두 label을 bootout하고 등록 부재/진행 writer를 재확인할 수 있는 구체적인 대상이 있다. bootout argv 형식도 옛 schedule에 있으나 이번에는 정지하지 않았다(`P/schedule.py:196`). 14.8은 옛 writer를 멈추지 않고 capture하는 결정이므로 전환 정지는 epic 16 후속 스토리 책임이다(`D:35`; `T14:91`).

전환 순서 후보는 새 계정 보호/직렬화·설치 준비→옛 collect 예약 중지→writer 종료 확인→14 반입 이후 차분 경계/마지막 capture 확인→새 공통 예약 등록·한 번 수집 확인이다. 옛 report가 자체 collect를 부르는지 최종 코드에서 점검하고, 필요하면 report 예약 중지도 분석 전환과 연결한다. 모든 예약을 일찍 내리면 epic 18 전까지 옛 평가 서비스가 끊기는 trade-off가 있으므로 수집 전환과 분석 전환의 정지 범위를 티켓에 명시한다. 재개용 plist는 보존하고 실패 때 옛 예약/새 예약을 동시에 켜지 않는 복구 절차 후보가 필요하다(`P/schedule.py:151`, `P/cli.py:404`; `I:173`; `E16:34`).

유효한 tokenstore가 있으면 에이전트의 실수집 한 번은 이미 위임됐다. 존재·최근 mtime만으로 유효하다고 판정하지 않으며 후속 스토리에서 계정 guard 확인 뒤 라이브러리 로그인/수집으로 검증한다. MFA가 필요하면 그 스토리만 awaiting-operator, 재인증/차단 해제 전 외부 호출을 중단하고 나머지 run은 계속한다. 이번 조사에서 해당 검증 호출은 하지 않았다(`D:10`, `:46`; `I:191`, `:192`; `E16:63`).

## 10. 공유 파일 레인과 한 세션 위험

| 함께 고칠 파일군(후보) | 충돌하는 작업 | 레인·크기 근거 |
|---|---|---|
| `extensions/garmin/{manifest*,pyproject.toml,uv.lock,.python-version}` | tracer·dependency·인증/일감·기본 예약·설정 | 한 레인. 한 lock에 importer driver와 connector 의존 보존. `D:28`; `T13:20`, `:32` |
| `extensions/garmin/src/` worker·config snapshot·auth/garmin | ABI 출력·login·오류·보호 상태·취소 | 인증/수집 모두 같은 계정 키이므로 하나의 경계 소유. `T12:44`, `:80`; `spine:509` |
| Garmin store port·PG adapter·migrations | raw/coverage/run·checkpoint·권위 규칙·현재 attempt | 원본 보존과 새 publisher가 같이 고침. migration 번호는 owner 내 순차. `spine:481`; `T14:44` |
| normalize·건강 publisher·공유 fixtures | endpoint·v8·NULL/단위·revision·catalog | epic 14의 계약을 변경하지 않고 소비. 변경이 필요하면 명시 호환 migration. `T14:20`; `spine:494` |
| body·digest·charts·labels·file request adapter | 공통 읽기 snapshot·artifact revision·파일 관계 | 렌더 입력 DTO를 먼저 분리하면 뒤 계산/표현 작업 분리 후보. `P/digest.py:1252`, `P/charts.py:755`; `T14:56` |
| 사건 producer·채널 request adapter | event id·gate 의미·conversation·attempt | epic 15 스키마를 재정의하지 않음. `T15:8`, `:32` |
| plugin install skill·배포 ref/version·검증 plan | 새 기능 안내·설치본·예약 전환 | 마지막 통합 레인; ref 변경은 앞선 commit을 가리키고 plugin version 동반 상승. `T13:80`, `:115`; `I:189` |

전체 endpoint 이식·PG 불변 이력·인증/MFA·취소·폰트·실계정을 한 세션에 넣으면 범위가 크다. 특히 옛 normalize의 전역 rebuild 삭제를 불변 revision으로 바꾸는 부분과 legacy dataset 위 current publish는 계산 이식보다 저장 의미 변경이 크다. tracer에는 최소 한 raw→한 건강 행 경로와 role/attempt/재실행을 남기고, 전수 endpoint·파일 crash·계정 실패 행렬·실설치를 이름 있는 다음 후보로 분리하는 안이 타당하다(`P/normalize/__init__.py:243`; `spine:492`, `:508`; `prep-garmin-absorption/integration-boundaries.md:91`).

## 11. Done when 1~5의 시험 기반과 빠진 검증

| Done when | 기존 기반(실행 안 함) | 새로 필요한 것 |
|---|---|---|
| 1 같은 fixture의 raw/normalize/digest/weight-lifestyle와 버전·revision | `G/tests/test_raw_response.py:117`; `G/tests/test_normalize.py:4667`, `:5549`; `G/tests/test_digest.py:97`; `G/tests/test_weight_lifestyle.py:142` | PG publisher·TS/Python 공유 기대값, normalization8 불변 재생성·원문 revision/권위 새 버전·NULL 키/단위·계정 ambiguity |
| 2 차단/MFA/pacing/직렬·재인증 전 무호출 | `G/tests/test_garmin.py:423`, `:496`, `:1488`, `:1518`, `:1650`, `:1815`, `:2218`; `G/tests/test_auth.py:790`; `G/tests/test_collect.py:3104` | 두 프로세스 동일 계정 직렬/다른 계정 병렬·unknown 키 보유, 날짜 경과 뒤에도 보호 latch, block 파일 쓰기 실패 재시작·MFA 이후 재예약/force 무호출, ABI 비밀 fixture |
| 3 멱등·수정 새 행·실패 재개·취소·오래된 쓰기 거부 | `G/tests/test_raw_response.py:138`; `G/tests/test_normalize.py:1018`, `:4808`, `:4873`; `G/tests/test_collect.py:2876` | raw 저장 직후/계산 후/요청 후 crash, PG checkpoint 수렴·변경 raw revision·trigger 오래된 INSERT 거부(건강/파일/알림과 garmin 내부 상태 모두), TERM/kill 중단·취소 후 무호출 |
| 4 공통 예약과 실계정 한 번 | `G/tests/test_collect.py:2891`; 옛 schedule의 두 collect 시각 `P/schedule.py:141`; `T12:92` | 현지 timezone/DST·놓친 날짜 한 번·11:15 진입표·disable/manual 우회 차단, 위임된 token 검증/수집·MFA awaiting-operator, 실제 수치 공개 금지 |
| 5 별도 LaunchAgent 없이 플러그인 배포 설치본 | 옛 frozen/pin 검사 `G/scripts/deploy.sh:35`, `:37`; 새 Python 설치 계획 `T13:32`, 확장 보존 `T13:92` | 결합 lock frozen 재설치·arm64 import/PG/폰트, 로컬 marketplace 설치본·install skill·core 예약 동작, 옛 label 비등록·writer 부재·원격 push operator_actions |

옛 “같은 write lock/connection으로 normalize” 시험은 결과 동등성/중간 실패 근거로만 가져간다. PG의 2초 제한과 취소·attempt 계약에 맞춘 새 저장 단위로 바꾸어야 하며 옛 락 보유 자체를 새 acceptance로 삼지 않는다(`G/tests/test_collect.py:2850`; `spine:171`, `:508`). Done when 4의 “사람이 확인” 본문과 최신 Notes 위임은 표현이 어긋나지만 후속 Decision에 따라 유효 token이면 에이전트 확인, MFA만 사람 몫으로 적용한다(`E16:33`, `:63`; `D:10`).

## 스토리 후보

다음은 근거와 선택지이며 결정·새 티켓 생성이 아니다. 앞 에픽의 필요한 **코드 스토리** 완료 HEAD를 받되 에픽 전체 사람 닫기를 다시 gate로 만들지 않는다(`I:187`; `T14:20`; `T12:44`, `:80`; `T13:20`).

| 후보 | tracer/결과와 근거 | 고칠 파일 후보 |
|---|---|---|
| S1 최소 connector tracer | 합성 GarminPort endpoint 한 건→coverage→raw→v8 건강 행→current view, 같은 일감 재실행 멱등과 오래된 token 거부. 실제 네트워크 없음. `spine:462`, `:508`; `T14:20` | Garmin manifest·worker/ABI·store port/PG adapter·최소 publisher·공유 합성 fixture/tests |
| S2 인증·계정 보호 | token 세션·MFA 경계·403/429/pacing/first-call·영속 latch·같은 계정 직렬화. `P/garmin/__init__.py:291`, `:443`; `T12:80` | Garmin auth/client adapter·보호 migration/port·snapshot decoder·ABI error mapper·manifest 인증 단계·경계 tests |
| S3 coverage·전수 수집·재개 | 11+4 endpoints·history_start·retry/recent_lists·raw exact text·crash/취소. `P/collect.py:25`, `:42`; `P/coverage.py:133` | collect/coverage/rawparse·PG raw/run/error/checkpoint adapter·worker 진행/취소·tests |
| S4 전수 정규화·건강 계약 | v8·day values·불변 revision·새 권위 규칙·같은 fixture 전수 수치. `P/normalize/__init__.py:243`; `D:31` | normalize daily/activity/coordinator·publisher·Garmin migration/authority adapter·TS/Python 공유 fixture |
| S5 body·digest·그래프·파일 요청 | 수치/서술 분리, 필드 mtime·원본/PNG 등록·성공 bytes 유지·폰트/labels. `P/body.py:13`; `P/digest.py:1252`; `T14:56` | body/digest/charts/labels loader·schema/resources·file request adapter·artifact tests |
| S6 수집 사건 요청 | 6 사건·날짜 gate→의미 키·같은 conversation·비밀 비노출. `P/errors.py:23`; `T15:8`, `:20` | notice producer·PG 사건/요청 adapter·manifest conversation 설정 참조·합성 채널 tests |
| S7 설치·예약·전환 | 결합 lock/pin arm64 frozen, 공통 11:00/11:15·옛 writer 정지·로컬 설치본 실수집. MFA만 awaiting-operator. `D:10`, `:28`; `E16:61`; `I:189` | Garmin packaging/lock/manifest·install 안내·전환/검증 plan·필요 시 `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json` |
| S8 정리 후보 | 앞 후보가 이름 붙여 남긴 정리만, 기능 누락은 별도 후보. 공통 포트 중복·CLI/로그 비밀·리소스 패키징 점검 | 해당 plan에서 확인한 파일만; 변경 범위는 미리 결정하지 않음. `prep-garmin-absorption/integration-boundaries.md:15`, `:23` |

순서안 A는 S1→S2→S3→S4→S5→S6→S7→S8이다. 수직 경로를 일찍 열고 실패 경계를 전수화한다. 순서안 B는 S2→S1→S3→S4→S6→S5→S7→S8로 계정 보호를 먼저 고정하고 알림을 빨리 붙인다. 두 안 모두 S1에는 fake만 쓰고 S7 전에는 실계정을 호출하지 않는 구성 후보다. S1의 설치/최소 contract 작업이 한 세션을 넘으면 package/ABI 준비를 분리하되 raw→건강 행 tracer의 완료 관찰을 둘로 나누지 않는다(`spine:462`, `:508`; `T13:20`, `T14:8`).

S5도 body 원본/mtime와 PNG/file request crash를 한 세션에 담기 크면 body+digest, charts+파일 요청 두 후보로 나눌 수 있다. 병렬화 선택지는 순수 계산 fixture/labels와 PG publisher 경계를 먼저 고정한 뒤에만 열며 manifest/lock/migration 번호는 한 레인을 유지한다. 앞 epic 12·13·14·15 코드에서 실제 파일과 시그니처를 다시 읽어 교차 after를 정하는 것은 다음 정제의 일이다(`P/body.py:13`, `P/charts.py:869`; `spine:481`; `I:187`).
