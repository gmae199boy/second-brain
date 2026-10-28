---
title: "epic 18 core 건강 분석 — 정적 코드 조사"
date: 2026-10-28
status: research
---

# epic 18 정적 코드 조사

지정 archive를 저장소 밖 새 빈 임시 디렉터리에 풀어 텍스트로만 읽었다. 테스트·빌드·Docker·네트워크·설치·Garmin 코드·모델 CLI를 실행하지 않았다. 로그인 파일은 존재만 확인했으며 내용을 읽지 않았다. 아래 구현 경로와 키 이름은 **후보**이며, 이 보고서는 결정·구현·커밋을 하지 않는다.

근거 약칭: `B/` = `_bmad-output/personal-brain/`, `G/` = `B/prep-garmin-absorption/inputs/garmin-source.tar.gz` 안의 `garmin-source/`, `P/` = `G/src/garmin_pipeline/`. `E18` = `B/tickets/epic-health-analysis/epic-health-analysis.md`, `E14` = `B/tickets/epic-garmin-import/epic-garmin-import.md`, `E16` = `B/tickets/epic-garmin-runtime/epic-garmin-runtime.md`, `I` = `B/initiative-personal-brain.md`, `S` = `B/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `J` = `B/tickets/epic-jobs-and-scheduler/tickets/tickets.toml`, `C` = `B/tickets/epic-channels/tickets/tickets.toml`. `파일:행`은 이 조사 시점의 소스 행이다. 앞 에픽은 계획이며 그 경로·시그니처를 이미 구현된 것으로 취급하지 않는다(`I:174`, `E14:117`).

우선순위는 R2·R10·R11·R12, C4·C5와 2026-10-28 위임이다. core는 TypeScript이고 Python 계산 재사용을 허용하며, legacy metadata를 추정해 채우지 않는다(`I:28`, `I:36`, `I:37`, `I:38`, `I:50`, `I:51`). 설치본 확인과 실계정 실행의 형식 검증은 에이전트가 하고 모델 품질만 사람이 판단한다(`I:188`, `I:189`, `I:192`, `B/decisions-by-recommendation.md:47`). 프롬프트/schema v1 재사용·두 adapter·20분 timeout·25분 정체 창·11:30·끄기 보류는 재논의하지 않는다(`E18:60`, `E18:61`, `E18:63`, `E18:64`, `E18:66`).

동시 작업 반영: 조사 중 다른 worker가 spine을 갱신했다. Codex 로그인 한정은 두 adapter·고른 CLI 로그인 환경으로 해소됐고(`S:534`), 프롬프트/schema Deferred도 v1 재사용으로 해소됐다(`S:777`). E18 Source conflict 문구는 아직 남지만 현재 spine과의 실제 충돌은 해소된 상태다(`E18:62`). C6도 위임과 epic 14 규칙 A로 해소됐다(`S:493`, `S:790`; `I:190`, `E14:106`). 현재 view에서 규칙이 고른 값과 미선택 보관값을 구분하며, 규칙으로 고를 수 없는 충돌만 ambiguity다(`S:493`). 다시 선택하지 않는다.

## 1. 옛 평가 흐름과 실패 경계

| 단계 | 관찰한 흐름·실패 경계 | 근거 |
|---|---|---|
| 진입 | report 전용 락을 잡고 시작 시각·오늘 날짜를 한 번 정한다. 일반 실행은 오늘 day evaluation이 있으면 파일 존재와 관계없이 전체 skip | `P/report.py:806`, `P/report.py:810`, `P/report.py:812` |
| 수집 대기 | 당일 block이면 중단 없이 평가로 진행, 락 또는 not_run이면 최대 30분 대기. DB 오류·차단·대기 만료가 평가 자체의 금지는 아니다 | `P/report.py:422`, `P/report.py:487`, `P/config.py:43` |
| 체성분 | pending 입력의 선택적 intake를 먼저 호출. 실패해도 다음 단계로 가며 pending은 재시도 대상 | `P/report.py:816`, `G/tests/test_report.py:849` |
| day snapshot | SQLite BEGIN으로 run/raw/activity를 읽고 닫는다. profile·body·이전 평가 파일은 그 DB snapshot 밖에서 읽는다. 임시 폴더→rename으로 날짜 입력을 교체하고 이전 날짜 폴더 삭제 | `P/report_input.py:142`, `P/report_input.py:219`, `P/report_input.py:258`, `P/report_input.py:334`, `P/report_input.py:345` |
| 수치·프롬프트 | exported dict들을 digest.build에 주고 digest.json 기록. `$garmin-daily-analysis`와 상대 입력 폴더를 전달. 기간은 `$garmin-period-review <scope>`와 기간 폴더·profile 경로 | `P/report.py:137`, `P/report.py:835`, `P/report.py:875`, `P/digest.py:1252` |
| 모델·검증 | Codex stdout은 private events.jsonl, 최종 출력은 analysis.json. 파일 없음·읽기 실패·JSON 실패·schema 불일치·빈 Markdown·UTF-8 오류는 output_invalid. `status=failed`는 skill_failed | `P/report.py:245`, `P/report.py:355`, `P/report.py:574`, `P/report.py:586` |
| 개별 저장 | 성공 day를 즉시 evaluation에 저장하고 7d→30d→all을 직렬 실행, 각각 성공 즉시 저장. 한 scope 실패에도 이후 scope 실행은 계속 | `P/report.py:848`, `P/report.py:871`, `P/report.py:885`, `P/report.py:887` |
| 파일·발신 | 그래프 실패는 빈 목록으로 격리. Markdown fsync→replace 실패는 알림 후 종료(기존 성공이면 0). 파일 쓰기 뒤 sink로 묶음 전달, sink 예외는 로그만 | `P/report.py:667`, `P/report.py:691`, `P/report.py:929`, `P/report.py:781`, `P/report.py:950` |

선행 평가 선택은 단순히 바로 앞 호출 결과 하나가 아니다. day는 **정확히 어제**의 day·7d 및 어제 Markdown을 참조한다(`P/report_input.py:339`, `P/report_input.py:383`). 7d는 창 안의 모든 day, 30d는 끝 날짜 이하 최근 7d 5개, all은 월별 마지막 30d를 읽는다. 각 기간의 previous는 끝 날짜보다 앞선 같은 scope 최신 1개다(`P/report_input.py:489`, `P/report_input.py:495`, `P/report_input.py:501`, `P/report_input.py:507`). DB에 먼저 저장하므로 당일 선행 성공도 다음 입력에 나타난다(`G/tests/test_report.py:1196`).

**어긋남 — 재시작과 불변성:** 옛 일반 실행은 day 성공 이후 죽으면 7d 이후를 복구하지 않고 skip한다. regenerate는 전부 다시 호출하며 실패한 기간은 당일 저장 평가를 재사용한다. 저장은 `(report_date,scope)` UPSERT이므로 원래 성공을 덮는다(`P/report.py:812`, `P/report.py:896`, `P/report.py:1033`, `G/tests/test_report.py:1279`). 새 계약은 scope별 저장 성공부터 이어가고 재생성은 새 행이다(`E18:17`, `E18:18`, `S:495`, `S:533`). 옛 “실패 뒤에도 다음 scope 실행”을 12.6의 성공 의존으로 그대로 옮길 수 없다. 새 그래프는 성공한 선행 analysis ID만 풀고 실패는 dependency_failed로 관찰하는 안이 계약과 맞는다(`J:68`).

## 2. core 계약 위의 입력 snapshot

### 2.1 옛 읽기 표·열과 대응 후보

| 옛 입력 | 실제 읽는 열·필터 | core 대응 후보·보존할 의미 |
|---|---|---|
| `run` | local_date로 최근 non-skipped_blocked의 started_at/status/detail/finished_at; 어제 started_at은 workout 창 시작 | 수집 일감의 **결과 참조**에 cutoff·수집 상태를 실어 snapshot 생성에 전달. core가 garmin.run을 직접 읽지 않음. 없을 때의 시작시각 fallback도 명시 (`P/report_input.py:101`, `P/report_input.py:109`, `P/report_input.py:143`; `S:528`) |
| `raw_response` | scope/day, key, endpoint, raw; 오늘 포함 31일, MIN(day key)는 all 시작. activity raw는 완료 운동만 | `garmin.raw_records(source,account,key,endpoint,fetched_at,checked_at,body)`의 승인 출처·고정 revision 사본. key의 day/activity 접두사를 제거해 기존 폴더 모양으로 export. raw TEXT는 원형 보존하고 export만 parse·scrub (`P/report_input.py:154`, `P/report_input.py:160`, `P/report_input.py:202`; `E14:50`) |
| `activity` | day_key/start_ms/activity_id/duration_s; start<cutoff는 recovery 경계, start+duration*1000<cutoff만 결과에 포함 | 건강 현재 view의 운동 identity·현지 날짜·시작 순간·지속시간 catalog 항목. 진행 중 운동의 시작은 별도 경계로 남기고 결과는 제외 (`P/report_input.py:183`, `P/report_input.py:192`; `E14:51`) |
| `day_summary` | date, sleep_total/deep/light/rem/awake_s, sleep_score, sleep_hr_min/time, hrv_avg, spo2_avg/min, resp_avg, wake_bb, bb_high/low/charged/drained, stress_avg/high_s, steps, active_kcal, moderate/vigorous_min, resting_hr, weight_kg, drinks_json | 지표 catalog의 단위·타입·NULL 의미로 선언한 날짜형 측정/요약을 pivot하여 옛 day_values.json 열을 재현. 문자열·JSON 열을 숫자 평균에 넣지 않음 (`P/store/migrations/0016_day_values_evaluation.sql:1`, `P/report_input.py:435`; `E14:51`) |
| `workout` | activity_id/date/type/start_ms/duration_s/hr_avg/max/zone1~5_s/bb_change/session_no | 운동 identity의 지표·분류/세션 metadata. start_ms는 UTC 순간, date는 IANA 시간대와 묶고 duration/zone은 초 (`P/store/migrations/0016_day_values_evaluation.sql:28`, `P/digest.py:1312`; `S:255`) |
| `exercise_log` | activity_id/exercise/sets/reps/max_kg/volume_kg/set_peak_hr_avg/rest_drop_avg | 운동+종목별 요약. catalog에 count·kg·kg volume·bpm 및 허용 집계를 명시. 단순 숫자 통합 평균 금지 (`P/store/migrations/0016_day_values_evaluation.sql:30`, `P/digest.py:1329`; `S:494`) |
| `evaluation` | report_date/scope/summary/judgments/evidence/next_checks; day skip·기존 본문은 report_md도 읽음 | `analyses`의 legacy 포함 호환 reader. 누락 metadata는 null/flag 유지, predecessor 목록에 선택된 ID를 기록 (`P/report_input.py:369`, `P/report.py:602`; `E14:52`) |
| body/profile/labels/previous Markdown | body measured_on≤report_date, schema 검증, profile 원문, labels JSON, 어제 리포트 파일 | body는 epic 16의 계약 값·파일 provenance, profile은 사용자 자료의 FileStore 참조, labels는 버전 고정 리소스, 이전 본문은 analyses의 확정 파일 참조. 파일도 snapshot 내용 목록에 고정 (`P/report_input.py:258`, `P/report_input.py:268`, `P/report_input.py:334`; `E14:58`, `E16:19`) |

옛 all 집계는 day_summary에서 date/sleep_hr_min_time/drinks_json을 제외한 열을 AVG, 월별 workout COUNT·SUM(duration_s), 운동종목별 MAX(max_kg)·SUM(volume_kg)한다(`P/report_input.py:460`). 새 catalog의 허용 집계와 맞는 항목만 같은 계산을 허용한다. 없는 날을 0으로 채우지 말고 actual_days와 누락을 유지한다(`P/report_input.py:419`, `G/skill/garmin-period-review/SKILL.md:10`; `E14:51`).

### 2.2 cutoff·필터와 고정 방안

옛 day export는 오늘 user_summary/body_battery를 빼고 stress_data의 stressValuesArray/bodyBatteryValuesArray와 heart_rates의 heartRateValues에서 `timestamp < cutoff`만 남긴다. 종료가 cutoff와 같은 운동도 제외한다. nested dict/list의 식별자 키는 대소문자 무시 부분문자열 scrub이다(`P/report_input.py:17`, `P/report_input.py:44`, `P/report_input.py:73`, `P/report_input.py:164`, `P/report_input.py:194`). malformed raw JSON·안전하지 않은 endpoint·유효하지 않은 body는 제외하고 notes에 사유를 남긴다(`P/report_input.py:166`, `P/report_input.py:179`, `P/report_input.py:266`).

후보: 수집·정제 성공 결과를 받아 한 짧은 read snapshot에서 그래프 입력 manifest를 확정한다. manifest에는 report_date+IANA timezone, UTC 밀리초 cutoff, 운동 window, collection result ID, catalog/normalization 버전, 건강 행 revision ID 목록, 권위 선택 규칙 버전·승인 dataset 순서·계정, 선택/ambiguity 제외 목록, raw 입력 내용 참조, profile/body/labels 파일 참조를 넣는다. 모델·effort·prompt/schema revision도 시작 시 고정한다. core 시각 저장은 UTC 정규형, 옛 입력 호환 export에만 offset을 렌더한다(`S:255`, `S:256`, `S:492`, `S:533`; `P/report_input.py:94`, `P/report_input.py:288`).

**어긋남과 구현 조건:** 옛 day와 각 period는 서로 다른 DB read snapshot이고 raw 표는 최신본이므로 fetched_at 필터만으로 과거 값을 복구할 수 없다(`P/report_input.py:142`, `P/report_input.py:418`; `P/store/migrations/0002_raw_response.sql:1`). 새 core에서는 확정한 건강 행 ID와 raw export 바이트를 materialize하고 네 scope·그래프가 같은 snapshot ID를 읽는 안이 안전하다. 장시간 DB transaction을 열어 놓는 안은 피한다(`E18:43`, `S:533`). epic 14 현재 view의 ambiguity 제외와 dataset→관측 revision→지원 정규화 버전 선택을 따르며, raw도 그 provenance에 연결한다. fixed-shape raw view만으로 과거 revision 선택이 안 되면 **snapshot 생성 시 raw 바이트를 보존**해야 한다(`E14:50`, `E14:51`).

Done when 1 비교 후보: 동일 합성 raw/run/activity/body/profile/평가 fixture를 옛 SQLite reader와 새 PG 계약 reader에 넣고, clock·timezone·cutoff·권위를 같게 준다. 파일 목록·JSON 구조/값·배열 순서·notes·NULL·누락·선행 선택·digest 입력까지 비교하며 임시 루트 차이만 제거한다. 같은 입력의 직렬화 bytes도 비교할 수 있으나 값 차이를 숨기는 반올림/누락 무시는 하지 않는다. cutoff 직전/동일/직후, 미완료 운동, 짧은 이력, 월 경계, invalid raw/body, 식별자 중첩 fixture가 출발점이다(`G/tests/test_report_input.py:31`, `:96`, `:127`, `:158`, `:224`, `:335`, `:347`). ambiguity·복수 dataset은 옛 단일 소스에 없으므로 별도 새 계약 시험으로 검증하고 “옛 입력 동등” 증거와 구분한다(`E14:51`). digest 계산을 core에서 다시 실행하는 것은 epic 16/18 경계를 흐린다. epic 16이 동일 cutoff 입력에 대응하는 digest를 계약 요약으로 제공하는 인계가 필요하다(`E16:22`, `S:532`; `P/digest.py:1252`).

## 3. 프롬프트·schema·skills 재사용

| 그대로 보관할 v1 자산 | 위치 후보·주의 | 근거 |
|---|---|---|
| `G/skill/garmin-daily-analysis/SKILL.md` | `packages/core/resources/health-analysis/v1/skills/garmin-daily-analysis/SKILL.md`; provider별 설치 wrapper와 원문 분리 | 입력 manifest/digest/profile·이전 평가 계약 `:21`, `:31`, 숫자 재계산 제한 `:38`, 출력 규칙 `:225` |
| `G/skill/garmin-period-review/SKILL.md` | 같은 v1 resources 아래 garmin-period-review. scope별 파일명 유지 | `:8`, `:10`, `:31`, `:33` |
| `P/schemas/daily_analysis_output.schema.json`·`period_review_output.schema.json` | `packages/core/resources/health-analysis/v1/schemas/`; 빌드/설치 산출물에 함께 복사. 두 파일 모두 보존 | 두 schema `:1`, `:37`, `:45`; `E18:60` |
| `codex_prompt`의 문자열 template | `packages/core/src/analysis/prompts.ts` 후보. skill invocation 이름·상대 입력 목록의 의미 보존 | `P/report.py:137`, `:153` |
| `P/labels/exercise_types_ko.json` | epic 16 소유 리소스/입력 snapshot 복사본 참조 | `P/report_input.py:268`, `:332`; `E16:22` |

body-intake skill·`body_intake_output.schema.json`·`body.schema.json`은 옛 흐름에 있지만 별도 체성분 입력 경계다. 분석 출력 v1의 두 schema와 섞어 core 소유로 복제하지 않고 epic 16 인계에서 위치를 확인하는 선택지다(`P/report.py:296`, `:335`, `P/report_input.py:257`; `E16:19`). profile.md는 사용자 파일이므로 공개 리소스로 복사하지 않는다(`G/skill/garmin-daily-analysis/SKILL.md:33`). 일별 skill의 한국 시각 전제는 임의 timezone 지원과 어긋날 수 있다. v1 문구를 조용히 고치지 말고 시간대 fixture로 한계를 드러내고 후속 revision 후보로 남긴다(`G/skill/garmin-daily-analysis/SKILL.md:59`, `:228`; `E18:60`, `S:255`).

AD-11 적용점 후보는 **모델에 보일 입력 폴더를 내보내는 출력 코덱**과 **도구 read 응답 코덱**이다. prompt 문자열만 가리면 CLI가 읽는 profile/raw/previous 파일이 우회한다. scrub은 계정 키 제거이고 API 키 패턴 가리기를 대체하지 않는다. 보존 원문과 모델용 export를 나누고 전자에는 비밀 원문을 유지하며, 모델용 모든 JSON 문자열·Markdown·진단·tool 응답은 등록된 코덱을 통과시킨다(`P/report_input.py:44`; `S:221`, `S:229`, `S:535`; `packages/core/src/output/codecs.ts:20`, `:72`). CLI에는 export와 scratch만 보이고 원 DB URL·보존 원문·다른 홈 파일은 도구로 읽을 수 없게 실행 port의 경계를 검증해야 한다(`S:528`; `G/skill/garmin-period-review/SKILL.md:33`).

## 4. 모델 adapter·설정·usage·취소

Codex의 확인된 argv는 `codex exec -C <runtime> -s workspace-write --skip-git-repo-check --ephemeral --json -c project_root_markers=[] -c model_reasoning_effort=<effort> -m <model> --output-schema <schema> -o <output> <prompt>`이며 intake일 때만 뒤에 `-i <images...>`가 붙는다. shell은 쓰지 않는다(`P/report.py:161`, `:195`, `:377`). cwd는 runtime root, stdin/stderr는 DEVNULL, OPENAI_API_KEY/CODEX_API_KEY만 env에서 제거하고 나머지 로그인 환경은 상속한다(`P/report.py:65`, `:215`, `:377`). Brain adapter에서는 DB 비밀을 무차별 상속하지 않도록 Runtime 설정 snapshot과 프로세스 입력을 분리해야 한다(`S:319`, `S:509`).

`--json` event 중 `turn.completed.usage`의 input_tokens/cached_input_tokens/output_tokens **셋 모두 비음수 정수**일 때만 합산한다. 없으면 None이며 0으로 만들지 않는다. stdout event 파일은 output 검증 후 삭제하고 본문을 로그에 남기지 않는다(`P/report.py:355`, `:362`, `:965`; `G/tests/test_report_codex.py:742`). ABI v1 `result.usage`에 이를 옮기고 attempt에 걸린 시간과 함께 남긴다. 옛 `_evaluate`는 status=ok일 때만 usage를 취하므로 실패 호출 토큰을 관찰하지 못한다. adapter 단계의 유효 usage를 실패 attempt에도 보존할 수 있는지는 12.4 실제 ABI에 맞춰 확인해야 한다(`P/report.py:1007`; `J:44`, `J:45`).

**기본값 어긋남:** 옛 config는 model=None, effort=high, timeout=20분이지만 Writer는 model 미설정이면 실행 거부하고 항상 `-m`을 넣는다. “모델 CLI 기본”은 새 Decision의 행동이며 옛 그대로 실행된다는 뜻이 아니다(`P/config.py:44`, `:45`, `:46`; `P/report.py:315`; `E18:61`). 새 adapter에서 model=null이면 `-m`을 생략하는 후보가 이 결정을 구현한다. 설정 값과 실제 모델 식별자를 구별해 기록한다. CLI가 실제 모델을 알려 주지 않으면 추정하지 않는다(`S:495`).

| 설정 키 후보(DB `brain.settings`) | 기본·검증 후보 | 근거 |
|---|---|---|
| `analysis.agent` | `codex`; enum codex/claude-code, 모르는 adapter 거부 | `E18:61`, `S:318` |
| `analysis.model` | null = 고른 CLI 기본; adapter별 허용 문자열 검증 | `E18:61`; 위 model 어긋남 |
| `analysis.effort` | high; CLI별 지원 값 검사, 지원 안 되면 조용히 무시하지 않음 | `P/config.py:46`, `E18:61` |
| `analysis.timeout_minutes` | 20, 양의 정수; scope 호출별 제한 | `P/config.py:44`, `P/report.py:317` |
| 예약·timezone | 기본 11:30 예약과 공용 `timezone`; 이중 설정 원천을 만들지 않음 | `E18:64`, `S:318`, `J:92` |

키 이름은 아직 결정이 아니다. core 분석은 Garmin 전용 `garmin.*` manifest 키와 구분할 수 있다. Runtime의 설정 코덱이 실행 시작 snapshot을 만들어 Core 실행 port에 adapter를 주입하는 구조가 후보이고, 현재 조립 지점은 `apps/cli/src/assembly.ts:23`, `:66`이다(`S:509`, `S:533`).

Claude Code adapter의 **검증 전 인자 후보**는 `claude -p <prompt> --output-format json --json-schema <schema-json> [--model <model>] --effort <effort>`이다. streaming이 필요하면 `--output-format stream-json --verbose`를 검토한다. `$skill`은 Codex 전용 호출 표현이므로 Claude에서는 같은 원문 skill과 template를 읽히는 wrapper가 필요하다. 최종 structured_output을 공통 schema로 재검증하고 `is_error`/비정상 종료/structured output 누락을 실패로 매핑하는 안이다. **이 archive와 저장소에는 Claude 실행 adapter·CLI flag 명세가 없으므로 이 인자 및 event field를 확인된 계약으로 주장하지 않는다.** 근거는 기존 교체 seam이 CodexWriter뿐이라는 점과 새 adapter 요구다(`P/report.py:110`, `:280`, `:414`; `E18:61`). 이번 금지 범위에 따라 CLI help나 네트워크 문서를 호출하지 않았다. 구현 스토리에서 설치 버전 공식 명세/정적 fixture를 확보해야 할 잔여 검증이다.

Claude usage 매핑 **후보**: 최종 result의 `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`를 ABI의 입력·출력·캐시에 연결하고 cache_creation_input_tokens는 별도 provenance로 남기거나 입력 집계의 정의를 먼저 명시한다. result aggregate와 `modelUsage`/stream의 중간 message usage를 함께 더하면 이중 계산할 수 있으므로 하나의 권위만 쓴다. 누락은 unknown, 잘못된 숫자는 거부한다. 이는 provider 필드 검증이 남은 설계안이며, 확인된 것은 ABI의 3개 비음수 정수 요구와 Codex 추출뿐이다(`J:44`; `P/report.py:976`). provider별 usage fixture 확보를 tracer 이후의 필수 불확실성으로 둔다(`E18:61`).

프로세스 감독은 옛 `start_new_session=True`, TERM→5초 wait→KILL→wait에서 출발한다. 정상 리더 종료 후 남은 자식도 정리한다(`P/report.py:224`, `:384`, `:397`). 하지만 killpg의 PermissionError 억제는 종료 확인이 아니므로 그대로 AD-33 완료 증거로 쓰지 못한다(`P/report.py:219`; `S:508`). 모델 CLI를 wrapper 안에서 새 session으로 분리하면 감독자가 wrapper PGID만 죽여 모델이 남을 수 있다. 모델과 모든 손자의 그룹 소유·PID 시작 신원·close/reap 확인을 12의 감독 계약에 연결해야 한다(`S:505`, `S:508`, `S:509`).

20분은 **호출 timeout**, 25분은 **진행 없는 모델 일감 정체 창**이다. 정상 heartbeat가 정체 창을 갱신하는 진행으로 취급되어서는 안 된다(`J:56`; `P/report.py:317`). scope마다 supervised 모델 일감을 만들고 취소·확장 끄기·CLI 실패 때 동일 그룹 정리와 attempt fencing을 쓴다. 취소 뒤 늦은 JSON/파일 성공이 DB에 확정되지 않아야 한다(`E18:63`, `E18:66`, `S:508`).

fake CLI 시험 후보는 기존 fake-codex처럼 argv/env를 기록하고 schema에 맞는 output/events를 내는 작은 실행 파일이다. 성공·failed·invalid JSON/schema·빈 본문·nonzero·출력 없음·unknown usage·여러 turn·잘린 event를 두 adapter에 같은 판정 fixture로 준다. TERM 무시 child/손자·정상 리더 뒤 child·감독자 사망/재시작·권한 불명은 실제 OS process fixture로 확인해야 하며 fake port만으로 reap을 증명하지 않는다(`G/tests/test_report_codex.py:188`, `:368`, `:383`, `:412`, `:455`, `:581`, `:742`; `J:56`, `S:508`).

## 5. analyses 호환 확장과 파일 등록

최소 계약은 legacy dataset/key/import batch/revision, nullable 모델·생성시각과 누락 flag, file request 관계와 core 파일 관계다. analyses 행 자체는 불변이며 file_id UPDATE도 하지 않는다(`E14:52`; `S:581`). 다음은 추가 후보이며 migration 번호는 epic 14 완료 HEAD의 다음 번호를 확인한다(`E14:67`; `S:482`).

| 추가 후보 | 의미·불변/새 행 규칙 | 근거 |
|---|---|---|
| bundle/graph ID, report_date, timezone, scope | 같은 분석 실행의 결과 묶음 식별; scope UNIQUE는 날짜만 아닌 snapshot+평가 revision 기준 | `S:533`, `S:535`; 옛 PK `P/store/migrations/0016_day_values_evaluation.sql:31` |
| evaluation_revision, prompt_revision, output_schema_revision | 프롬프트/schema v1; 명시적 재분석은 새 revision·새 ID | `E18:60`, `S:495` |
| input_snapshot_id | cutoff·건강 revision·권위·설정 snapshot의 불변 참조 | `E18:16`, `S:533` |
| predecessor analysis 관계 | 당일 바로 앞 scope와 참조한 과거 평가들의 ID·역할. 다대다 별도 관계 표 후보 | `P/report_input.py:489`, `:507`; `E18:17` |
| agent/requested_model/resolved_model/effort | 실제 알려진 값만; legacy null/누락 flag를 유지 | `E18:61`, `E14:52` |
| work_id/attempt_id, usage, elapsed | 결과 provenance와 ABI usage. 재시도 이력은 12 attempt가 권위, 이곳은 확정 결과의 참조/사본 | `J:44`; `B/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:91` |
| output_json, report_md/파일 관계 | schema 통과한 원 JSON과 summary/judgments/evidence/next_checks·본문. 실패 attempt를 성공 analyses로 저장하지 않음 | `P/report.py:245`, `:586`, `:1030`; `S:529` |

scope 검증·성공 확정과 다음 일감 해제는 짧은 transaction으로 묶고, 모델 호출과 FileStore I/O는 밖에 둔다. 파일 준비/DB 확정 사이 crash에는 같은 scope 성공을 재사용하고 모델을 다시 부르지 않는 수렴 키가 필요하다(`S:533`, `E18:43`; `P/report.py:691`).

파일 등록 선택지 A: **core 분석 일감이 직접 FileStore.put** 후 core 등록 use case로 files/locations·추출 일감·분석 파일 관계를 확정한다. 이미 Core 소유이므로 확장용 요청을 반드시 경유할 근거는 없다(`packages/core/src/ports/file-store.ts:4`, `S:529`, `S:390`). 선택지 B: 안정된 요청 키로 `file_requests`에 넣어 epic 14의 crash 복구/공개 결과 view를 재사용한다. 단 현 계약의 writer는 확장으로 표기되어 있어 core 생산자를 허용할 API/RLS를 확인해야 한다(`S:583`, `E14:53`). 어느 안이든 분석 행의 file_id를 나중에 UPDATE하지 않고 별도 확정 관계 행을 추가한다(`E14:52`). epic 16 그래프는 이미 file_requests 경로이므로 `request_id→file_id` 확정 결과를 기다려 묶음에 넣는다(`E16:19`, `E14:53`).

## 6. 결과 묶음과 REPORT_FAILED

옛 ReportBundle은 날짜·요약·앨범 여럿·전문 경로·regenerated다. 순서는 요약→앨범들→전문이며 앨범은 10장씩, 1장이면 sendPhoto, 2장 이상이면 sendMediaGroup으로 보낸다. 항목 실패 뒤에도 계속 보내며 항목마다 결과를 기록한다(`P/ports.py:61`, `:101`, `:126`, `:139`). 그래프는 실제 파일 존재를 확인하고 이름 앞 두 자리 01~49/50~99로 두 그룹을 만든다(`P/report.py:921`, `:939`). summary는 day+7d+30d+all, UTF-16 4000 초과 시 뒤 기간 줄부터 버리고 마지막으로 day를 자른다(`P/report.py:904`, `:1048`).

15.4 대응은 경로 대신 FileStore file ID와 정렬된 album 목록을 담은 요청이다. graph snapshot ID와 생산한 파일 역할/순서를 epic 16에서 받아 선택하되, 파일명 숫자에 기대는 구분을 역할 metadata로 옮기는 후보가 있다. 이미 파일이 확정된 것만 넣고 그래프 실패는 평가를 삭제하지 않는다(`C:43`, `C:44`; `E18:19`; `E16:19`). Markdown의 상대 이미지 링크도 파일 관계로 재구성/해결 가능한지 확인해야 한다(`P/report.py:627`; `S:390`).

의미 키 후보는 `(analysis_bundle_id, conversation_id, health-report, bundle_revision)`이다. 요청 UUID나 실행 attempt를 생산 결과 식별자로 쓰면 같은 묶음 retry가 새 발신이 된다. 같은 묶음 재조립은 같은 키, 명시적 새 평가 revision은 새 묶음/개정으로 구분한다(`B/tickets/epic-channels/epic-channels.md:40`; `S:535`). 옛 sink에는 bundle dedup gate가 없으므로 그대로 재사용하면 Done when 4를 만족하지 못한다(`P/ports.py:101`; `B/prep-garmin-absorption/inputs/research/garmin-runtime.md:37`).

REPORT_FAILED는 날짜+event 최초 시도 gate를 먼저 기록하고 detail에 사유·실패 scope를 남겼다. 알림 실패도 평가/본문 성공을 취소하지 않는다(`P/report.py:712`, `:721`, `:725`, `:759`). 새 요청 후보는 `(분석 그래프/묶음 식별자, conversation, REPORT_FAILED, 알림 revision)`이며, 날짜별 한 번 의미를 유지하려면 producer ID를 계정+현지날짜의 안정된 실패사건으로 정규화하는 선택지도 있다. 날짜 gate와 재분석 revision 알림의 차이는 plan에서 명시해야 한다(`P/ports.py:50`; `S:535`; `E18:64`).

최초 시도 gate·sent/definite_failed/unknown·항목별 재개·retry는 epic 15 소유다. 15.4는 sent 항목을 건너뛰고 못 간 항목만 재개하며, 크기 초과는 too_large다. **“한 번만 나감”의 시험은 중복 요청/성공 항목 재발신 억제이며 외부 전송 exactly-once 보장을 뜻하지 않는다.** 응답 유실은 unknown으로 남긴다(`C:44`, `C:45`; `B/tickets/epic-channels/epic-channels.md:27`, `:28`, `:40`). 발신 오류를 이유로 analyses를 삭제하거나 모델을 다시 부르지 않는 통합 시험을 추가한다(`E18:33`; `P/report.py:786`).

## 7. 예약·수집 의존·놓친 날·끄기

옛 기본값은 수집 11:00, 리포트 11:30, 수집 대기 30분이다. report LaunchAgent는 시각만 정하고 collection 의존 edge가 없으며 report 함수가 당일 상태/락을 polling한다(`P/config.py:40`, `:42`, `:43`; `P/schedule.py:151`, `:163`; `P/report.py:487`). 대기 만료·DB 오류·block에도 평가를 진행하므로 “수집 성공 뒤에만 분석”을 보장하지 않는다(`P/report.py:441`, `:498`, `:508`).

새 예약은 12.8의 현지 날짜+IANA timezone 예약(기본 11:30)으로 분석 그래프를 넣고, 12.6의 **수집/정제 성공 결과**를 선행 입력으로 참조하는 안이다. completed_at만으로 성공을 추정하거나 11:30이라는 시각만으로 digest 완료를 추정하면 안 된다(`J:68`, `J:92`; `E18:34`, `E18:66`; `E16:30`). 수집 실패 시 dependency_failed로 닫기/실패 알림, 복구 후 동일 대상 재개 정책을 공통 큐에 연결하고 18이 별도 polling scheduler를 만들지 않는다(`J:68`; `S:356`).

**Assumption 확인 범위:** report.run은 현재 날짜 하나만 고르고 빠진 날짜를 순회하지 않는다. 수동 regenerate도 과거 날짜를 받지 않는 시험이 있다(`P/report.py:808`; `G/tests/test_report.py:696`). 따라서 “빠진 day를 소급하지 않음”은 확인된다. 다만 **“수집이 끝난 최신 날짜”**를 DB에서 고르는 로직은 없다. 오늘 수집이 실패해도 오늘 날짜로 분석할 수 있어 Assumption 전체가 옛 구현에서 증명되는 것은 아니다(`P/report.py:815`, `P/report_input.py:120`; `E18:65`). 새 그래프 대상은 깨어난 뒤 최신 현지날짜 수집 결과와 일치시키고, 여러 날 누락 시 그 하나만 평가하는 시험이 필요하다. 공통 스케줄러의 놓침은 빠진 날짜가 있을 때만 한 번이며 12.8이 맡는다(`B/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:84`; `J:92`; `E16:61`).

분석 예약과 생성하는 모델/조립 일감에 `extension:garmin` 보류 그룹을 붙이는 책임은 18이다. 끄면 새 예약 생성/청구 중지·진행 취소·대기 보류, 켜면 대기부터 재개하고 저장된/legacy 분석은 보존한다. 그룹 없는 core 작업은 영향받지 않는다(`E18:63`, `E18:66`; `J:116`, `J:117`). 12.10의 보류 use case와 13 registry를 소비하되 18에서 Garmin 끄기 상태를 별도 저장하지 않는다(`B/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md:103`).

## 8. 레인과 한 세션 위험

| 함께 고칠 실제/후보 파일 | 겹치는 스토리·다른 에픽 | 위험/조정 근거 |
|---|---|---|
| `packages/core/src/analysis/`(신규), `ports/`·`brain.ts`·`index.ts` | 입력·모델·그래프·저장·예약 | 공통 DTO/snapshot·결과 판정이 바뀌므로 독립 레인으로 보기 어려움 (`S:533`) |
| `packages/postgres/migrations/`·Store/계약·fake | snapshot·analyses·파일 관계·재개 | epic 14 최소 계약을 확장. epic 17과 migration 번호가 겹치면 뒤 합류자가 조정 (`E14:52`; `I:184`, `I:186`) |
| `apps/cli/src/assembly.ts`, 신규 runtime model adapters | Codex·Claude·설정·설치본 | 한 조립 지점에 Core port 구현을 주입 (`apps/cli/src/assembly.ts:23`; `S:533`) |
| `packages/core/src/output/codecs.ts`, mask·비밀 fixture | 모델 입력·tool response·channel | 등록부 누락 방지, epic 17도 수정 가능 (`packages/core/src/output/codecs.ts:72`; `I:184`) |
| 공통 queue/schedules/supervisor 소비 경로 | scope 의존·취소·usage·보류 | 12.4·5·6·8·10 실제 완료 HEAD 시그니처 확인 (`J:44`, `:56`, `:68`, `:92`, `:116`) |
| `packages/core/resources/health-analysis/v1/`(후보), 빌드 리소스 목록 | 프롬프트/schema·adapter·플러그인 | v1 bytes와 설치 산출물 parity 필요 (`E18:60`; `C:44`) |
| `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` | 마지막 배포·다른 worker 배포 | ref는 앞선 commit, version 동시 증가. 이 조사에서 수정 안 함 (`AGENTS.md:11`) |

tracer에 day 입력 변환·PG migration·schema 검증·모델 그룹·저장·파일·채널·예약 전부를 완성시키면 한 세션 범위를 넘기 쉽다. 가장 얇은 정상 day 관통을 먼저 만들고 snapshot 동등성, 네 scope 복구, 두 provider 실패 행렬을 뒤에 넓히는 후보가 있다. 단 감독/가리기가 끝나기 전 실모델을 노출해서는 안 된다(`E18:30`, `:31`, `:32`; `S:508`, `S:535`). resource 복사와 합성 fixture 작성은 병렬 후보지만 공통 DTO/migration·조립 파일은 순차가 안전하다(`I:184`; `B/prep-garmin-absorption/integration-boundaries.md:63`).

## 9. Done when 1~6 시험 기반과 빠진 것

이 절의 기존 시험은 **본문을 정적으로 읽은 근거**이며 이번에 통과시킨 결과가 아니다. 기존 acceptance도 fake 모델이고 모델 품질 증거가 아니다(`G/tests/test_acceptance_report.py:1`; `B/prep-garmin-absorption/integration-boundaries.md:89`).

| Done when | 기존 기반 | 추가 확인 후보 |
|---|---|---|
| 1 입력 동등 | `G/tests/test_report_input.py:31` 필터·식별자, `:127` subminute, `:158` 미완료 회복 경계, `:224` 기간/월 집계, `:335` 어제 평가, `:347` 생활기록 | 동일 fixture SQLite↔core snapshot 파일 tree 비교; catalog pivot·NULL·권위·ambiguity·동시 revision 수정·timezone/DST·고정 snapshot 재시작 |
| 2 순서/즉시 보존/재시작 | `G/tests/test_report.py:1186` 네 scope 즉시 저장·write lock 없음·실패 격리, `:1279` 당일 평가 재사용 | 각 scope commit 직후 kill→미완료만 재실행, legacy 불변·새 revision, stale attempt 거부, 파일 저장/관계/다음 해제 사이 crash. 옛 skip/UPSERT 동작을 새 기대값으로 바꿈 (`P/report.py:812`, `:1033`) |
| 3 병행/CLI 정리 | `G/tests/test_report_codex.py:368` timeout 그룹, `:383` TERM 무시, `:412` 남은 child, `:455` 외부 SIGTERM | 두 fake provider 실제 OS child·손자, supervisor 재시작·PID 재사용·EPERM unknown, 25분 창 가속 시계, 20분 timeout 구별, 긴 모델 중 session_ingest 진전 (`S:508`; `J:56`) |
| 4 발신 격리/중복 억제 | `G/tests/test_report.py:317` sink 실패·파일 유지, `:1150` 전송기록 실패 gate 유지; `G/tests/test_ports.py:232` adapter/recorder 예외 | 15.4 fake 서버와 같은 bundle 재요청·중간 album 응답 유실·sent skip·REPORT_FAILED·가림·파일 누락. 평가 행/ID/본문이 그대로이고 모델 재호출 0 (`C:44`, `C:45`) |
| 5 공통 예약·실계정 | `G/tests/test_report.py:400` 수집 종료 대기, `:480` 자정 날짜 유지; fake E2E `G/tests/test_acceptance_report.py:18` | 12.8 예약과 12.6 수집 성공 입력 의존, 여러 날 놓침 최신 하나·수동 합침·끄기/켜기, 실제 한 번의 형식/순서/저장 확인. 품질은 사람 (`E18:34`; `I:192`) |
| 6 설치본 | fake E2E의 schema·labels·4행·파일 검증 `G/tests/test_acceptance_report.py:55`, `:62`, `:69` | 앱 리소스 포함·선행 commit app-ref/version·이 Mac 로컬 설치본/doctor/예약/usage·두 adapter 발견. 원격 push만 operator_actions (`E18:35`; `I:189`; `AGENTS.md:11`) |

실계정 평가의 실행 전제: 12 감독자·14 현재 view/analyses/file 관계·15 채널·16 동일 snapshot digest/그래프가 준비되고, 설정/가림/schema/로그인 adapter가 설치본에 있어야 한다(`E18:55`, `:56`, `:57`, `:58`, `:61`). 이 Mac 확인은 `command -v codex`가 `/opt/homebrew/bin/codex`를 반환했고 선택된 Codex 홈의 `auth.json` 존재 여부가 exists였다. **존재는 로그인 유효·만료 없음·모델 사용 가능의 증거가 아니다.** 이는 2026-10-28 정적 환경 관찰이며 파일 내용이나 모델 CLI를 읽거나 실행하지 않았다. 나중 실계정 스토리에서 실제 호출 성공을 확인해야 한다(`E18:61`; `I:189`).

에이전트는 실계정 한 번의 실행 여부·schema 판정·scope 순서·저장·파일·usage/unknown·발신 상태를 민감 원문 없이 plan에 남길 수 있다. 로그인 갱신이 필요하면 그 단계만 operator_actions로 남기고, 임상적 해석이나 권고 품질을 자동 형식 시험으로 통과 처리하지 않는다. 품질 판단·원격 push는 사람 몫이고 run 전체 gate로 되돌리지 않는다(`I:189`, `I:192`; `B/decisions-by-recommendation.md:40`, `:44`, `:47`).

## 스토리 후보

아래는 선택지이며 entry/after/risk의 확정이 아니다. 앞 에픽의 전체 닫기 대신 필요한 코드 스토리의 결과를 받는 규칙을 따른다(`I:187`). 동시 추가된 Handoff에 따라 건강 입력은 14.2, 최소 analyses/파일 관계는 14.1·14.5를 받는 교차 after 후보로 구체화할 수 있다(`E18:67`). epic 16 조사도 cutoff 조립·scrub을 18 경계로 두고 있으므로, 두 쪽이 같은 snapshot을 쓰는 digest 인계 DTO를 정제 때 맞춰야 한다(`B/tickets/epic-garmin-runtime/epic-garmin-runtime-research-code.md:93`).

| 후보 | 관통 결과·고칠 파일 후보 | 근거/선행 |
|---|---|---|
| T1 tracer: 합성 day 한 건 | `packages/core/src/analysis/{input,evaluate,save}.ts`, 모델 실행 port, PG analyses 호환 migration/Store·fake·계약, `apps/cli/src/assembly.ts`, fake CLI, 모델 입력 codec. 고정 합성 snapshot→fake JSON→검증→analyses+Markdown 파일을 읽음 | 성공 경로의 가장 얇은 증거. 14 최소 분석/건강 계약·12 supervised ABI/감독·FileStore를 받음 (`E14:51`, `:52`; `J:44`; `S:529`) |
| T2 입력 동등성과 snapshot | input reader/export·snapshot manifest/PG 관계, fixture comparison, raw view reader·body/profile 파일 참조. catalog·cutoff·ambiguity·월 집계와 v1 리소스 parity | 가장 큰 의미 손실 위험. 14 현재 view와 16 digest 인계를 받음 (`E18:30`; `E14:51`; `E16:30`) |
| T3 네 scope 의존·재개·revision | graph/enqueue·scope handler·predecessor 관계·PG/fake, scope 파일 등록/복구, 취소/fencing fixture | day 성공 후 중단 복구가 옛 코드와 달라짐. 12.6 결과 기반 의존 필요 (`E18:31`; `J:68`; `P/report.py:812`) |
| T4 두 모델 adapter와 장애 행렬 | `apps/cli/src/runtime/`의 codex/claude adapter, Core ModelRunner port/설정 DTO, config codec, provider usage fixture, OS child/손자 시험 | Codex known argv와 Claude 미확인 flag/event를 먼저 고정. 12.4·5 usage/25분·감독 정리 소비 (`E18:61`; `J:44`, `:56`) |
| T5 결과 묶음·실패 알림 | bundle assembler·파일 관계 reader·channel request producer·가림 fixture, 15.4 fake 서버 통합 | 16 graph file_requests 결과와 15 bundle 계약 소비. 같은 bundle key/발신 실패 평가 불변 (`E18:33`, `:64`; `C:44`) |
| T6 예약·끄기·관찰 | schedule graph registration, settings/timezone reader, 보류 그룹 연결, doctor/queue usage 소비·통합 시험 | 11:30·최신 날 하나·수집 결과 의존·extension:garmin; 12.8·10과 13 registry 받음 (`E18:64`, `:65`, `:66`; `J:92`, `:116`) |
| T7 정리·설치본·실계정 | 앞 plan의 정리 목록, resource 빌드/배포 목록, `plugin/app-ref`·plugin version, 해당 plan의 비민감 증거/operator_actions | 에이전트 로컬 확인과 사람 품질 분리 (`I:189`, `:192`; `E18:35`) |

순서안 A는 T1→T2→T3→T4→T5→T6→T7이다. 먼저 입력·보존 의미를 닫고 adapter의 실패 행렬을 넓힌다. 순서안 B는 T1→T4→T2→T3→T5→T6→T7로 Claude CLI의 미확인 계약과 그룹 감독 위험을 먼저 드러낸다. T1은 fake 전용으로 안전한 관통을 보이고 실모델은 T4의 가림·감독 검증 후에만 연다(`S:508`, `S:535`). T7이 크면 정리와 설치/실계정 검증을 두 후보로 나눌 수 있다. T2/T3의 Store·T4/T6의 설정·T5의 출력 codec·공통 assembly가 겹치므로 이 표를 곧바로 병렬 DAG로 보지 않는다(8절; `I:184`).
