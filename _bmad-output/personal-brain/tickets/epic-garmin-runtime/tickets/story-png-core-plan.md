---
title: '그래프 PNG: 날짜별 그래프의 core 파일 등록과 그래프별 실패 격리'
type: 'feature'
ticket: '6'
created: '2026-11-03'
status: 'built'
baseline_revision: '986b0401d9753d95e05d48e59bb0c2d02b5cd481'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 옛 Garmin은 그래프를 report 안에서 그렸으므로, connector의 `artifacts` 일감에는 날짜별 그래프 PNG를 만들어 core 파일로 넘기는 진입점이 없다. epic 18의 결과 묶음이 고를 그래프 파일이 비어 있다.

**Approach:** `artifacts`가 digest 뒤에 같은 수집 snapshot과 body 측정으로 옛 charts의 그래프별 PNG를 그린다. 성공한 PNG는 닫은 뒤 metadata와 함께 `file_requests`로 하나씩 보내고, core 결과 view에서 file_id를 확인할 때까지 바이트를 보존한다. 그래프 하나가 실패해도 그 그래프만 빠진다.

## Boundaries & Constraints

**Always:** 그래프 종류와 계산은 옛 `charts.py`(`7fb33dd`)와 같다. 대상은 01 어제, 02~03 최근 세션 2개, 04~49 근력(종목당 1개, 최대 46개), 50~53 30일, 54~58 전체 추세, 59 body다. Agg, 12×6 inch·150 DPI, `font.family=["Apple SD Gothic Neo","DejaVu Sans"]`, `axes.unicode_minus=False`를 쓴다. matplotlib은 render 안에서 늦게 import하고, 그 전에 확장 홈 아래 private `MPLCONFIGDIR`(0700)을 설정한다. PNG는 0600으로 먼저 만든 뒤 쓴다. 10,000,000 bytes를 넘거나 그리다 실패한 그래프는 파일을 지우고 다음 그래프로 넘어간다. 그래프 입력은 collect 부모의 불변 snapshot(`collect_store.artifact_snapshot`)과 `body_runtime.ingest`의 측정이다. snapshot을 읽은 뒤 PNG 파일 I/O 동안 DB 트랜잭션을 잡지 않는다(AD-7). 쓰기는 attempt 확인을 포함한 짧은 트랜잭션이다. 요청 metadata에는 `kind:'graph'`, 현지 날짜, 그래프 이름·제목, 역할(`today`=01~49, `trend`=50~99로 옛 두 앨범을 가른다), 수집 결과 id, 산출 revision, 시간대, cutoff를 담는다. media type은 `image/png`이다. 종목 라벨은 기존 `labels.load_bytes/load`를 쓴다. 합성 fixture와 `compose.test.yaml`의 127.0.0.1:54329 시험 PG만 쓴다.

**Never:** 실계정·운영 데이터·모델 호출. 폰트 파일 번들, PNG 바이트 golden 동등성 요구, report·결과 묶음 발신(epic 18), core 건강 계약 변경, 기존 migration·권위 규칙 v1·digest 산출 의미 변경, 새 공개 진단·보존 정책 추가. 폰트가 없는 환경을 충족으로 세지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 결과 | 오류 처리 |
|---|---|---|---|
| 정상 | 합성 snapshot·body로 그릴 수 있는 그래프 N개 | 그래프마다 `file_requests` 1건, 모두 core 파일 completed, metadata 완비 | 없음 |
| 빈 부분 | 어제·세션·근력·추세·body 값이 없거나 2점 미만 | 해당 그래프만 PNG·요청 없음(옛 규칙) | 다른 그래프 계속 |
| 렌더 실패 | 그래프 하나의 draw가 예외 | 그 PNG 삭제, 요청 없음, 나머지 등록 | 결과 summary에 실패 이름 |
| 크기 초과 | PNG > 10,000,000 bytes | 파일 삭제, 요청 없음 | 다른 그래프 계속 |
| 재실행 | 같은 현지 날짜·이름·revision | 요청 수 불변(기존 요청 재사용) | 입력이 바뀌면 새 revision 요청, 이전 요청 보존 |
| 중단 | 요청 INSERT 뒤 core 완료 전 kill | 바이트가 staging에 남음, 재시작 시 같은 요청으로 수렴 | 중복 요청 없음 |
| DST | 25시간 어제 | x축 0~25, 마지막 시각 샘플 표시 | 없음 |

</intent-contract>

## Code Map

- 옛 기준: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`의 `garmin-source/src/garmin_pipeline/charts.py`(reader `_read_*`·`_bucket`, draw `_yesterday/_session/_strength/_daily_trend/_daily_workouts/_all_trend/_body_trend`, `render` 869~915행), `report.py` 939~950행(이름 앞 두 자리 1~49와 50~99의 두 앨범), `tests/test_charts.py`, `tests/chart_db.py`(`synthetic`은 raw를 넣고 옛 normalizer로 파생 표를 만든다). 저장소 밖 임시 디렉터리에만 푼다.
- `extensions/garmin/src/normalize_tables.py` `normalize_all(items, timezone, history_start)`: raw에서 옛 모양의 파생 표(daily_metric·activity·hr_sample·stress_bb_sample·activity_hr_sample·day_summary·workout·exercise_log)를 만든다. 입력 key는 `raw`·`fetched_at`이므로 snapshot의 `body`·`fetched_at_ms`를 변환해 넘긴다. 새 reader는 옛 SQL을 이 표 위의 순수 Python으로 옮긴다. 계산은 바꾸지 않는다.
- `extensions/garmin/src/runtime_artifacts.py` `run`: 부모 결과(`local_date`·`timezone`·`cutoff_ms`·`snapshot_id`) 검증 → body ingest → snapshot → digest 요청과 완료 대기. 그래프 단계를 digest 완료 뒤에 더하고 result summary에 그래프 결과를 덧붙인다. 기존 digest 경로·오류 코드 매핑은 유지한다.
- `extensions/garmin/src/runtime_files.py` `request`: kind는 `body_source|digest`만 허용하고, identity에 content hash가 들어간다. `graph` kind(`image/png`)를 더하되, 그래프 identity는 `(dataset,'graph',local_date,name,revision)`으로 바이트와 무관하게 정한다. 같은 revision을 다시 돌려도 PNG 바이트 차이로 요청이 늘지 않게 하기 위해서다. 이미 요청이 있으면 다시 그리지도 INSERT하지도 않는다. staging은 `artifacts.stage`(0700 dir·0600 file)를 재사용한다. body_source·digest identity는 바꾸지 않는다.
- `extensions/garmin/src/artifacts.py` `MAX_BYTES`(32MiB)는 staging 상한이다. 그래프 10,000,000 bytes 상한은 렌더 쪽에서 따로 지킨다.
- `extensions/garmin/src/body_runtime.py` `ingest`는 sidecar dict 목록(`measured_on`, `values`)을 돌려준다. 옛 `_read_body`처럼 `measured_on <= report_date`만 쓰고 옛 `BODY_LABELS`를 쓴다.
- `extensions/garmin/pyproject.toml`·`uv.lock`·`.python-version`(3.14.10): `matplotlib==3.11.2`(옛 pin)를 더해 다시 잠근다. `requests`는 curl-cffi/garminconnect의 전이 의존으로 lock에 있다. `jsonschema`는 현재 `src/`가 직접 import하지 않으므로 직접 의존으로 더하지 않는다(epic F2: 직접 쓰는 것만 직접 의존). 근거로 grep 결과를 남긴다.
- `extensions/garmin/scripts/legacy_normalize_oracle.py`·`tests/fixtures/`: 격리 archive opt-in 생성기 패턴이다. 옛 `chart_db.synthetic`의 raw와 옛 `_read_chart_data` 결과(그리고 그림 입력 수치)를 고정 기대 JSON으로 만든다. 새 코드로 기대값을 만들지 않는다.
- `apps/cli/python-test/garmin-body-digest.test.ts`, `garmin-review-boundaries.test.ts`, `apps/cli/test/ext-fixture.ts`, `extensions/garmin/tests/collect_fixture.py`: 실제 감독자·시험 PG·core 파일 인계, kill 재개, 정규 Python 스크립트 등록 패턴.
- `extensions/garmin/manifest.json`: 새 일감이나 설정은 필요 없다. `garmin.artifacts`와 collect followup을 그대로 쓴다.

## Tasks & Acceptance

**Execution:**
- [x] `extensions/garmin/pyproject.toml`, `uv.lock` -- matplotlib을 더하고 3.14.10 pin으로 다시 잠근다 -- frozen 설치·import가 가능해야 한다.
- [x] `extensions/garmin/src/charts.py`(신규) -- snapshot+body로 옛 chart_data를 만드는 순수 reader, 옛 draw 함수, 그래프별 격리 render(private MPLCONFIGDIR·0600·크기 상한·경고 기록)와 그래프별 revision을 만든다 -- 계산 재사용.
- [x] `extensions/garmin/src/runtime_files.py`, `runtime_artifacts.py` -- graph 요청, 기존 요청 재사용, 그래프별 core 완료 확인(실패 격리), summary를 만든다 -- core 인계.
- [x] `extensions/garmin/scripts/legacy_normalize_oracle.py`, `tests/fixtures/charts_v8/` -- 옛 synthetic raw와 옛 chart_data·draw 기대값을 opt-in으로 고정한다 -- 순환 검증 방지.
- [x] `extensions/garmin/tests/check_charts.py`, `check_chart_fonts.py` -- reader 동등성, 옛 test_charts의 무게·volume·DST·빈 부분·실패 격리·크기 초과, 실제 선택 face의 한국어 glyph와 missing-glyph 경고 0을 시험한다. 정규 suite(`garmin-review-boundaries.test.ts` 목록)에 등록한다.
- [x] `apps/cli/python-test/garmin-charts.test.ts`(신규) -- 설치된 감독자로 그래프별 요청·core 파일·metadata·재실행 멱등·실패 격리·kill 재개를 관찰한다.

**Acceptance Criteria:**
- Given 합성 collect 결과와 body 측정, When 설치된 artifacts 일감이 끝나면, Then 그릴 수 있는 그래프마다 `file_requests` 1건이 `image/png`·실제 크기와 함께 생긴다. 각 요청은 core 결과 view에서 `completed`·file_id를 가지며, core 파일 바이트는 PNG 시그니처·1800×900 크기를 가진다. metadata에는 현지 날짜·이름·역할·수집 결과 id·revision이 있다.
- Given 같은 합성 raw, When 새 reader와 archive의 옛 `_read_chart_data`를 비교하면, Then chart_data가 같다. 옛 test_charts의 무게·volume 값, DST 25시간 축, 빈 부분 무출력이 고정 기대값과 같다.
- Given 그래프 하나의 렌더 실패 또는 10,000,000 bytes 초과, When artifacts를 실행하면, Then 그 그래프만 요청과 PNG가 없고 나머지는 core 파일이 되며 일감은 성공한다.
- Given 같은 날 같은 입력으로 artifacts를 한 번 더 돌리면, When 끝나면, Then 그래프 요청 수가 늘지 않는다. 입력을 바꾸면 바뀐 그래프만 새 revision 요청이 된다.
- Given 그래프 요청 INSERT 뒤 core 완료 전에 worker를 SIGKILL하면, When 재시작하면, Then staging 바이트가 남아 있다가 같은 요청이 completed가 되고 중복이 없다.
- Given 이 Mac, When 폰트 검사를 실행하면, Then 실제로 선택된 face 경로·이름이 기록되고, 대표 한국어 glyph(그래프 제목·라벨 문자)가 모두 있으며, 렌더 중 missing-glyph 경고가 0이고, `MPLCONFIGDIR`은 0700, PNG는 0600이다. Apple SD Gothic Neo가 없는 환경은 미충족으로 따로 보고한다.
- Given 결합 lock, When `uv sync --frozen --reinstall`로 다시 설치하고 import를 검사하면, Then macOS arm64에서 Python 3.14.10이고 psycopg·garminconnect·curl_cffi·matplotlib·requests import가 성공한다.

## Implementation Notes

2026-11-03 구현(Terra/medium, Dispatch `ctx_391d0bfa63fa`→후속 `ctx_e137eff6f38e`). 상세 보고는 `.brain-automation/implementation-report-16-6.md`(gitignored 실행 증거)다.
- 첫 Task는 lock만 바꾸고 `failed`로 끝났다(구현자 sandbox의 Docker 접근 오류). 같은 Dispatch에 후속 Task를 보내 전체를 구현했다.
- `charts.py`: 옛 draw·bucket을 그대로 옮기고, reader는 snapshot raw를 `normalize_tables.normalize_all`로 옛 파생 표로 만든 뒤 옛 SQL을 순수 Python으로 옮겼다. `prepare`가 확장 홈 `.matplotlib`(0700)을 import 전에 설정한다. 렌더는 `graph-work/`(0700)의 0600 임시 파일에서 하고, 실패·크기 초과면 지운다.
- `runtime_files.graph_request/graph_lookup`: 그래프 identity는 `(dataset,'graph',local_date,name,revision)`이다. 이미 요청이 있으면 다시 그리지 않는다.
- `runtime_artifacts.py`: digest 완료 뒤 그래프마다 요청하고, core 결과가 completed/failed가 될 때까지 기다린다. 그래프 실패(렌더·크기·core import)는 격리해 summary에 넣는다.
- 채택 가정(계획 Design Notes): 같은 날 다른 collect 부모가 같은 revision을 내면 첫 요청과 그 metadata(첫 collect_result_id)를 재사용한다. revision은 그 그래프가 쓰는 chart_data 부분·렌더 상수·matplotlib 버전·선택 face 경로의 hash다.
- 범위 확대(지휘자 결정, 질문 `msg_f0bc77586ea3`·`msg_763c74ca49c7`): intent-contract가 "결과 summary에 실패 이름"을 요구하는데 core `publicCollectSummary`가 artifacts summary 키를 엄격히 제한했다. 계획의 Never는 core 건강 계약 변경만 금지하므로 `packages/core/src/queue/supervisor.ts`와 직접 시험만 좁게 바꿨다. 타입(`ResultSummary`)은 넓히지 않고 스칼라 키 `graphs_registered/skipped/failed/failed_names`를 엄격히 검증한다.
- `jsonschema`: `rg -n jsonschema extensions/garmin/src` 결과 0건이라 직접 의존으로 더하지 않았다(epic F2). `requests`는 전이 의존으로 lock에 있고 import 검사에 포함했다.
- oracle: archive `chart_db.synthetic`과 옛 `_read_chart_data`로 `fixtures/charts_v8/synthetic.json`을 만든다. 옛 body sidecar reader만 격리 프로세스 안에서 JSON 읽기로 대체했다(합성 sidecar는 생성기가 만든 유효 데이터, 옛 reader는 jsonschema 의존). archive SHA-256 `02cbaf47…6b25`, fixture SHA-256 `960794313de35a5ea31ca0962ab2f44e195d630dc8749d2515838858b4e7b038`(지휘자 재생성 전후 동일).
- 기존 `garmin-body-digest.test.ts`의 요청 수 검사는 새 graph 요청을 빼고 세도록 좁혔다(digest·body 의미는 그대로).
- operator_actions: 없음.

## Plan Change Log

## Review Triage Log

### 2026-11-03 — 후속 독립 리뷰 1(수정 확인)
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- Sol/medium 독립 리뷰어(Dispatch `ctx_c3863ded14df`)가 pass 1의 `[patch]` 13건(VG1~3, BH1·2·3·5·6·7·8·9, IA-B, IA-C)을 현재 코드·시험과 archive `_read_chart_data`·`test_charts.py:1033`에 대조해 모두 해결로 판정했다. 각 추가 시험이 해당 회귀에서 실패하는 단언인지도 확인했고, 이번 수정이 만든 새 결함은 없었다. 원문: `.brain-automation/reviews-16-6/review-followup-1.md`.
- 수정 적용: `RENDERER_VERSION`의 revision 반영, reader의 raw/body 두 실패 경계, `publish_graphs`의 그래프별 revision 격리와 시작·종료 중단 경계, `check_charts.py` 12건(전체 이름·월별 집계·54 시간 단위·body revision·10,000,000 경계·reader/revision 격리·중단 전파), `garmin-charts.test.ts`의 모든 graph 요청 left join 검증.

### 2026-11-03 — Review pass 1
- verdicts: 17 findings — high 0, medium 10, low 4, false 3, maybe-false 0
- 원문: `.brain-automation/reviews-16-6/review-{verification-gap,blind-hunter,intent-alignment,edge-case-hunter}.md`(edge-case-hunter는 빈 배열).
- findings:
  - `[medium]` `[patch]` VG1 6개월 초과 전체 추세의 월별 집계(`_bucket`) 미검증 — 검증 렌즈 사전 검증. fixture는 주간 집계뿐이다. 월 경계·결측 제외·mean/min/max·half-up 시험을 추가한다(BH8과 같은 원인).
  - `[medium]` `[patch]` VG2 54 수면 전체의 초→시간 divisor 미검증 — 검증 렌즈 사전 검증. draw 값 단언을 추가한다.
  - `[medium]` `[patch]` VG3 body 값 정정이 59 revision을 바꾸는지 미검증 — 검증 렌즈 사전 검증. 같은 날 weight_kg만 바꿔 59는 변경·51은 불변을 단언한다.
  - `[low]` `[patch]` BH1 revision에 렌더 구현 버전 없음 — `charts.revision` 입력에 draw 코드 버전이 없다. 같은 날 같은 입력이면 draw를 고친 배포 뒤에도 옛 PNG를 재사용한다. revision 입력에 명시적 renderer 버전 상수를 더하는 직접 수정이다. 같은 경로 폰트 교체는 드물고 내용 hash는 비용이 커서 반영하지 않는다.
  - `[low]` `[patch]` BH2 그래프별 revision 계산이 `try` 밖 — `runtime_artifacts.py:89`. `allow_nan=False` 직렬화 등 한 그래프의 예외가 artifacts 전체를 끝낸다. 도달 입력은 입증하지 못했지만 수정은 한 줄을 try 안으로 옮기는 직접 수정이다(BH5·IA-B와 같은 격리 원칙).
  - `[medium]` `[patch]` BH3 그래프 루프의 중단 확인 누락 — `collect.boundary`가 대기 루프에만 있다. 재사용·skip·렌더 경로에서는 SIGTERM 뒤에도 다음 그래프를 처리하고 success를 낼 수 있다. 그래프마다 시작 시 `collect.boundary()`를 부른다.
  - `[low]` `[reject]` BH4 SIGKILL 시 `graph-work/` 임시 PNG 잔존 — 0700 private 폴더 안이고 렌더 중 강제 종료는 드물다. 소유권 기반 정리·복구는 새 상태 관리를 더하는 복잡성이다. 잔여 위험으로 기록한다.
  - `[medium]` `[patch]` BH5 reader 전체가 단일 실패 경계 — 옛 `_read_chart_data`(archive charts.py 724~752행)는 DB 파생 부분 실패 시 `{report_date}`만 남기고 body를 따로 읽었다. 새 `read_chart_data`는 예외 하나로 모든 그래프와 artifacts 결과를 잃는다. 옛 두 경계를 그대로 옮긴다.
  - `[medium]` `[patch]` BH6 렌더 시험이 일부 이름 존재만 검사 — job 누락을 못 잡는다. 합성 fixture에서 기대되는 전체 이름 목록을 정확히 비교한다.
  - `[medium]` `[patch]` BH7 통합 시험이 inner join·`length>0`·01번만 검사 — 다른 그래프가 pending이거나 빠져도 통과한다. 모든 graph 요청을 left join해 각 요청이 completed+file_id+metadata+PNG 헤더·크기이거나 summary 실패 이름에 있음을 단언한다(IA-C와 같은 원인).
  - `[medium]` `[patch]` BH8 `_bucket` 월 전환·월말·부분 월 min/max·null·반올림 미검증 — VG1과 같은 원인. archive test_charts 1033행 사례를 이식한다.
  - `[low]` `[patch]` BH9 10,000,000 bytes 허용 경계 미검증 — 렌더와 `graph_request` 양쪽의 경계 허용·초과 거절 단언을 추가한다(직접 시험 추가).
  - `[false]` `[reject]` IA-A 저장된 파생 snapshot 대신 raw 재정규화 — 새 구조의 core 건강 계약에는 옛 모양 파생 표(hr_sample·workout·exercise_log 등)가 없다. 불변 collect snapshot에서 같은 v8 normalizer로 만든 값이 그 날의 일관된 읽기 snapshot이다. archive 기대값과의 chart_data 동등성으로 계산 의미를 확인했다.
  - `[medium]` `[patch]` IA-B 실패 격리의 시작점 — BH2·BH5와 같은 원인으로 함께 수정한다. 그래프를 순차로 기다리는 것은 원문이 병렬성을 요구하지 않으므로 바꾸지 않는다. digest 실패 시 그래프를 하지 않는 순서는 digest 의미 보존 결정이다.
  - `[medium]` `[patch]` IA-C core 통합 관찰이 01번 하나에 집중 — BH7과 같은 원인.
  - `[false]` `[reject]` IA-D 폰트 시험이 Apple SD Gothic Neo를 필수로 assert — 원문이 "폰트가 없는 환경은 충족/미충족을 따로 보고"하라고 했고, 계획은 폰트 부재를 충족으로 세지 않는다. 폰트가 없으면 시험이 명시 메시지(`Apple SD Gothic Neo is unavailable`)로 실패하므로 미충족이 따로 드러난다. 이 Mac에서는 선택 face 경로·glyph 54/누락 0·경고 0으로 충족했다(`.brain-automation/commander-verify-python.log`).
  - `[false]` `[reject]` IA-E lock에 jsonschema 없음·requests 비직접 — epic Notes 세트 검증 F2가 "jsonschema·requests는 직접 쓰는 것만 직접 의존으로 두고 나머지는 전이 의존으로 충족됨을 확인"으로 정했다. `src`에 jsonschema·외부 requests 직접 import가 없다. 환경 실행 증거: frozen 재설치 뒤 3.14.10·arm64에서 psycopg·garminconnect·curl_cffi·matplotlib·requests import 성공(같은 로그).

## Design Notes

- revision은 그래프별로 `sha256(canonical({name, 그 그래프의 chart_data 부분, 렌더 상수, matplotlib 버전, 선택 face 식별}))`이다. 같은 입력과 같은 환경이면 같은 값이고, 값이 바뀐 그래프만 새 요청이 된다. 같은 날 다른 collect 부모가 같은 revision을 내면 첫 요청을 재사용한다. epic 18은 날짜·이름·역할·revision과 완료 결과로 고르므로 이것으로 충분하다(채택 가정, Implementation Notes에 기록).
- 그래프 등록 실패(core 실패)는 그래프 실패로 격리해 summary에 남긴다. digest 실패 의미는 바꾸지 않는다.
- PNG 렌더는 확장 홈 아래 private 작업 폴더(0700)에서 한다. staging에 복사한 뒤에는 core completed를 확인할 때까지 staging 바이트를 지우지 않는다.

## Verification

**Commands:**
- `pnpm install --frozen-lockfile && uv sync --frozen --reinstall --project extensions/garmin` -- 결합 lock frozen 재설치 성공.
- `extensions/garmin/.venv/bin/python -B -c "import sys,platform,psycopg,garminconnect,curl_cffi,matplotlib,requests;print(sys.version,platform.machine(),matplotlib.__version__)"` -- 3.14.10·arm64·import 성공.
- `python3.14 extensions/garmin/scripts/legacy_normalize_oracle.py` -- opt-in 기대값 재생성 결과가 고정 fixture와 같다(archive SHA 기록).
- `extensions/garmin/.venv/bin/python -B extensions/garmin/tests/check_charts.py` 및 `check_chart_fonts.py` -- 통과, 선택 face·glyph·경고 0 출력.
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-charts.test.ts apps/cli/python-test/garmin-body-digest.test.ts apps/cli/python-test/garmin-review-boundaries.test.ts` -- 실제 감독자·시험 PG 통과.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test:python && PYTHONDONTWRITEBYTECODE=1 pnpm test && git diff --check` -- 전체 회귀·typecheck·공백 통과.

**Manual checks:**
- 시험이 만든 대표 PNG(어제·세션·근력·30일·전체·body)를 이미지로 열어 한국어 라벨·축·범례·레이아웃이 깨지지 않았는지 지휘자가 직접 확인하고 경로를 기록한다.

## Auto Run Result

상태: `built`. 구현·독립 리뷰(공식 4렌즈)·리뷰 수정·후속 독립 리뷰·필수 검증을 마쳤다. 사용자 인수 전이므로 done으로 올리지 않는다. 커밋 SHA와 원격 브랜치는 최종 실행 보고(`.brain-automation/ticket-16.6-report.md`)에 적는다.

### 구현 요약
`garmin.artifacts`가 digest를 등록한 뒤, 같은 불변 collect snapshot과 body 측정으로 옛 charts의 그래프별 PNG를 그린다. 각 PNG는 `kind:'graph'`, 현지 날짜, 이름·제목, 역할(`today`/`trend`), 수집 결과 id, revision, 시간대, cutoff와 함께 `file_requests`로 하나씩 보낸다. core 결과 view에서 completed·file_id를 확인할 때까지 staging 바이트를 보존한다. 렌더·크기·revision·core 등록 실패는 그 그래프만 빼고 결과 summary의 실패 이름에 남긴다.

### 변경 파일
- `extensions/garmin/src/charts.py`(신규): snapshot·body 순수 reader(raw/body 두 실패 경계), 옛 draw·bucket, 그래프 job 목록, `RENDERER_VERSION`을 포함한 그래프별 revision, private `MPLCONFIGDIR`·0600·10,000,000 bytes 렌더.
- `extensions/garmin/src/runtime_artifacts.py`: `publish_graphs` 그래프 루프(그래프별 격리, 시작·종료 중단 경계), summary 그래프 키.
- `extensions/garmin/src/runtime_files.py`: 날짜·이름·revision 논리 identity의 graph 요청·조회, `image/png`.
- `extensions/garmin/pyproject.toml`, `uv.lock`: `matplotlib==3.11.2` 추가, 3.14.10 재잠금.
- `extensions/garmin/scripts/legacy_normalize_oracle.py`, `tests/fixtures/charts_v8/synthetic.json`: archive `chart_db.synthetic`·`_read_chart_data` 기반 고정 기대값.
- `extensions/garmin/tests/check_charts.py`, `check_chart_fonts.py`(신규): 동등성·전체 이름·월별 집계·DST·무게/volume·시간 단위·revision 국소성·크기 경계·격리·중단, 실제 선택 face glyph·경고.
- `apps/cli/python-test/garmin-charts.test.ts`(신규), `garmin-review-boundaries.test.ts`, `garmin-body-digest.test.ts`: 실제 감독자·시험 PG·core 파일 인계, 정규 suite 등록, 기존 요청 수 검사의 graph 제외.
- `packages/core/src/queue/supervisor.ts`, `packages/core/test/supervisor-abi.test.ts`: artifacts summary의 그래프 스칼라 키 엄격 허용(범위 확대 근거는 Implementation Notes).

### 리뷰와 처분
- pass 1(4렌즈): 17건 — medium 10, low 4, false 3. patch 13건(medium 10, low 3)은 모두 같은 구현자가 수정했다. 기각 4건: BH4(private 폴더 임시 PNG 잔존, 드묾·정리는 새 상태 관리), IA-A(raw 재정규화는 불변 snapshot의 일관된 읽기, archive 동등성 확인), IA-D(폰트 부재는 명시 메시지로 미충족 보고), IA-E(epic F2 직접 의존 결정, import 확인). 근거는 Review Triage Log 행별로 있다.
- 후속 리뷰 권고: pass 1에서 medium patch가 2건 이상이라 규칙상 `true`였다. 그래서 별도 Sol/medium 후속 독립 리뷰를 실제로 수행했고, 13건 모두 해결·새 결함 0이었다. 남은 미확인 구현 위험은 없어 `followup_review_recommended: false`로 둔다.
- deferred: 없음.
- 원문: `.brain-automation/reviews-16-6/review-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment,followup-1}.md`.

### 검증
- 결합 lock frozen 재설치 후 Python 3.14.10·arm64에서 psycopg·garminconnect·curl_cffi·matplotlib 3.11.2·requests import 성공.
- archive oracle 재생성: charts fixture SHA-256 `960794313de35a5ea31ca0962ab2f44e195d630dc8749d2515838858b4e7b038` 전후 동일.
- `check_charts.py` 12건 통과. `check_chart_fonts.py`: 선택 face `/System/Library/Fonts/AppleSDGothicNeo.ttc`(Apple SD Gothic Neo), 대표 glyph 54개 누락 0, missing-glyph 경고 0, cache 0700·PNG 0600.
- 최종 `pnpm test:python` 17파일 59건 통과. `pnpm test` 171파일 3,926건 통과·1 skip(기본 설정에서 건너뛰는 bootstrap Python 갱신 시험; test:python에서 실행·통과). `git diff --check` 통과. 로그: `.brain-automation/commander-fix1-*.log`.
- 수동: 대표 PNG(01 어제·02 세션·04 근력·59 인바디)를 직접 열어 한국어 라벨·축·범례·레이아웃 정상 확인(`.brain-automation/png-samples-16-6/`).
- 폰트 없는 환경: 이 Mac에서만 확인했다. Apple SD Gothic Neo가 없는 환경은 `check_chart_fonts.py`가 실패(미충족)로 보고한다.

### 가정·권고·잔여 위험
- 채택 가정: 같은 날 다른 collect 부모가 같은 그래프 revision을 내면 첫 요청과 그 metadata(첫 collect_result_id)를 재사용한다.
- 운영 권고: draw 의미를 바꾸는 이후 변경은 `RENDERER_VERSION`을 올려야 같은 날 재발행된다.
- 잔여 위험: 렌더 중 SIGKILL 시 `graph-work/`(0700)에 임시 PNG가 남을 수 있다(BH4 기각, 정리 정책 없음). 그래프는 순차로 core 완료를 기다리므로 core가 늦으면 artifacts가 그만큼 길어진다.
- `operator_actions: []`. 실계정·운영 데이터·모델 호출 없음. 시험 PG는 127.0.0.1:54329만 사용.
