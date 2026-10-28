---
title: "epic 14 기존 Garmin 데이터·분석 이전 — 정적 조사와 읽기 전용 집계"
date: 2026-10-28
status: research
---

# epic 14 코드·이전 조사

이 문서는 구현·실제 반입·기준 소스 결정을 하지 않는다. 고정 Garmin 소스는 저장소 밖 새 임시 디렉터리에 풀어 텍스트로만 읽었다. 테스트·빌드·Docker·네트워크·설치·Garmin 프로그램 실행은 하지 않았다. private capture는 Python 표준 `sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)`와 읽기 SQL로 집계했다. 파일은 메타데이터와 해시 비교만 했으며 원문을 보고서로 가져오지 않았다.

근거 약칭: `G/`는 `prep-garmin-absorption/inputs/garmin-source.tar.gz`의 `garmin-source/` 아래 경로이고, `G/P/`는 그 안의 `src/garmin_pipeline/`이다. 저장소 문서 경로의 공통 앞부분은 `_bmad-output/personal-brain/`이다. `spine`은 `architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `prep`은 `prep-garmin-absorption/`, `tickets`는 그 아래가 아닌 이니셔티브의 `tickets/`다. 고정 소스 식별자는 `source-manifest.json`의 Garmin commit을 따른다. 본문에 원본 해시 값은 싣지 않는다.

이니셔티브 R5·R6·R7·C5·C6, 에픽 Notes 끝의 위임 Decision을 우선했다. **어긋남:** C6 본문·spine AD-32·36·Deferred의 “사용자가 고르기 전”과 옛 prep의 미결 질문은 이니셔티브 Notes 2026-10-28 위임으로 채워졌다. 추천 규칙을 티켓에 기록하고 에이전트가 반입한다는 결정은 재논의 대상이 아니다. 이 조사 단계에서는 다음 정제자가 고를 수치·선택지만 제시한다. Python `sqlite3` 읽기도 에픽 Notes의 결정이다.

## 1. 옛 schema·원본·파생 이력

아래는 소스 SQL의 명세다. 표가 현재 capture에도 있다는 뜻은 아니며, 관찰 결과는 3절과 구별한다.

| migration | 표·키·변경 | 정적 근거 |
|---|---|---|
| 0001 | `auth_event`: 정수 `id`, 현지 날짜와 로그인 epoch ms | `G/P/store/migrations/0001_auth_event.sql:3` |
| 0002 | `raw_response`: PK `(scope,key,endpoint)`; day 또는 activity; raw TEXT·fetched·checked·library_version 필수 | `G/P/store/migrations/0002_raw_response.sql:1` |
| 0003 | `run(id)` 상태·시작/종료·detail; `fetch_error(id)`의 run_id FK, 원본 항목 키·오류 종류·시각 | `G/P/store/migrations/0003_run_fetch_error.sql:5`, `:29` |
| 0004 | `meta(key)` → value; history_start는 최초 수집 경계 | `G/P/store/migrations/0004_meta.sql:1` |
| 0005 | `notification`: UNIQUE `(local_date,event)`, detail·at. 최초 시도 gate | `G/P/store/migrations/0005_notification.sql:1` |
| 0006 | `normalize_result(scope,key,endpoint)` 성공/오류·원본 fetched·정규화 시각; `daily_metric(day_key)` endpoint별 열 소유, 값 NULL 허용 | `G/P/store/migrations/0006_normalize.sql:6`, `:18` |
| 0007 | daily 수면·스트레스·BB 열 추가; `body_battery_sample(day_key,ts_ms)` level nullable | `G/P/store/migrations/0007_sleep_stress_body_battery.sql:8`, `:31` |
| 0008 | `hr_sample(day_key,ts_ms)` bpm nullable, 일 키 밖 시각도 보존 | `G/P/store/migrations/0008_hr_sample.sql:4` |
| 0009 | `activity(activity_id)` day nullable, 요약·zone 시간; `activity_hr_sample(activity_id,ts_ms)` bpm nullable | `G/P/store/migrations/0009_activity.sql:9`, `:28` |
| 0010 | `activity_recovery(activity_id)` 파생 HRR, nullable 계산 불가; hr_sample 시각 인덱스 | `G/P/store/migrations/0010_activity_recovery.sql:1`, `:11` |
| 0011 | `exercise_set(activity_id,set_index)` REST 포함 배열 위치, 무게 g·반복·시간·종목; 파생 사이 FK 없음 | `G/P/store/migrations/0011_exercise_set.sql:1` |
| 0012 | activity_recovery 삭제, hr_sample 시각 인덱스 유지. 저해상도 HRR 한계로 facts에서 제외 | `G/P/store/migrations/0012_drop_activity_recovery.sql:1` |
| 0013 | activity_hr_sample에 nullable body_battery 추가 | `G/P/store/migrations/0013_activity_body_battery.sql:1` |
| 0014 | activity zone 하한 bpm 5열 추가; `stress_bb_sample(day_key,ts_ms)` 추가 | `G/P/store/migrations/0014_zone_bounds_stress_bb.sql:1`, `:10` |
| 0015 | `delivery(id)`: 날짜·kind·event nullable·ok·reason nullable·at, 성공과 reason NULL의 CHECK | `G/P/store/migrations/0015_delivery.sql:3` |
| 0016 | `day_summary(date)` 수면/체중/생활 JSON; `workout(activity_id)`; `exercise_log(activity_id,exercise)`; `evaluation(report_date,scope)` day/7d/30d/all, 본문·JSON·model·created_at 필수 | `G/P/store/migrations/0016_day_values_evaluation.sql:1`, `:28`, `:30`, `:31` |

schema 10→15는 0011~15의 변화다. **schema 15가 최신 계산을 뜻하지 않는다.** capture D1은 schema 15인데 normalize_version 2이며, 추가 열 NULL·추가 표 0행이 가능하다(3절 Q1). schema 16의 evaluation·day_summary·workout·exercise_log는 capture 다섯 후보 어디에도 없다(Q1).

원본은 수신 라이브러리 객체를 당시 `json.dumps`로 저장한 문자열이다. 네트워크 원시 바이트라고 과장하지 않는다. 일반 문자열은 key 순서와 비ASCII를 보존하고, 인코딩 불가 surrogate에는 ASCII escape fallback이 있다. 같은 문자열 또는 NoData가 기존 원문 위에 오면 checked_at만 움직이며, 내용 변경 때 fetched_at·library_version도 갱신한다. JSONB 재직렬화로 이 TEXT를 대체하면 안 된다(`G/P/store/__init__.py:270`, `:294`, `:314`, `:321`). 키별 최신 한 행뿐이어서 잃어버린 과거 revision은 복원할 수 없다.

정규화 규칙 버전은 8이며 스키마 번호와 별개다(`G/P/store/__init__.py:49`). 대상/샘플/결과 및 day_summary·workout·exercise_log가 rebuild 집합이고 evaluation은 제외된다(`G/P/normalize/__init__.py:221`). 버전 불일치 시 전체 파생 삭제·재계산을 한 트랜잭션에 묶으며, 증분은 원본 fetched_at 차이로 잡는다(`:243`, `:339`). importer는 이 경로를 원본에서 호출하지 않는다. 구버전 파생을 보존한 뒤 새 계산을 별도 정규화 버전으로 쌓아야 한다. daily/activity 파서의 NULL·반올림·단위 처리는 각각 `G/P/normalize/daily.py:88`, `G/P/normalize/activity.py:98`이며 SQL 주석과 공유 fixture로 의미를 옮긴다. rawparse의 activity_refs는 목록의 local date와 운동 id를 연결한다(`G/P/rawparse.py:37`, `:74`).

## 2. 이전 대상 목록과 manifest 재확인

이번 관찰 기준은 `~/github/garmin/data/absorption-prep/LATEST`가 가리키는 capture다. 후보 이름은 공개 보고서에서 D1~D5로 축약한다. 모두 별도 dataset이며 파일 이름으로 권위를 추정하지 않는다.

| 후보 | private manifest의 source 분류 | schema | normalize meta | DB bytes |
|---|---|---:|---:|---:|
| D1 | 개발 `data/garmin.db` | 15 | 2 | 5,742,592 |
| D2 | 운영 `runtime/data/garmin.db` | 10 | 2 | 5,742,592 |
| D3 | 개발의 이전 보관본(before 변경) | 10 | 없음 | 114,688 |
| D4 | 운영의 epic5 이전 보관본 | 10 | 2 | 3,993,600 |
| D5 | 운영의 history-start 이전 보관본 | 10 | 1 | 3,338,240 |

근거 Q1 및 파일 `stat().st_size`. 실제 일자·계정·해시는 기재하지 않는다. DB 5개 모두 schema와 표별 건수가 manifest와 같고, DB 파일 해시도 5/5 일치했다. 파일 349개 모두 존재하고 크기가 manifest와 같았다. 아래 대분류마다 manifest 순서의 첫 3개, 총 12개의 해시 표본이 전부 일치했다. 전수 파일 해시 검증이나 살아 있는 원본과 capture의 최신성 검증을 이번에 했다는 뜻은 아니다.

| 파일 대분류(경로의 facts 여부→확장자 순) | 개수 | 총 bytes |
|---|---:|---:|
| facts 계열(JSON 10, Markdown 9, log 2) | 21 | 185,582 |
| 그 밖의 리포트 Markdown | 10 | 30,836 |
| 이미지 PNG | 11 | 930,979 |
| 입력·기타(JSON 289, log 16, TOML 2) | 307 | 6,489,924 |
| 전체 | 349 | 7,637,321 |

확장자 기준 교차 확인: JSON 299/6,614,019 bytes, Markdown 19/54,720, log 18/35,805, PNG 11/930,979, TOML 2/1,798. 입력·기타는 보고서 입력 snapshot·로그·설정의 묶음이며 전부 건강 측정으로 해석하지 않는다. 비밀·기계 설정은 import 대상에서 분류해야 한다(migration-contract 대상 표).

파일 집계 모양 QF: `for entry in manifest['files']: group = classify(entry['source'], suffix); count[group]+=1; bytes[group]+=Path(snapshot).stat().st_size`; `stat_size == entry['bytes']`; `sha256(read_bytes(snapshot)) == entry['sha256']`는 boolean만 출력. DB에도 같은 해시 비교. `rglob`의 manifest 밖 파일은 10개이며 모두 SQLite WAL/SHM 보조 파일이다. 이들은 349개 산출물 수에 섞지 않았다. 보조 파일의 생성 시점·writer 상태는 이 집계로 판정하지 않았다. 재캡처 때 WAL 포함 일관성은 별도로 확인해야 한다.

## 3. C6 증거: 후보별 건수·범위·겹침·충돌

### 집계 정의와 실행 질의의 모양

Q1은 각 DB를 read-only URI로 연결한 뒤 `PRAGMA user_version`, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, `PRAGMA table_info(<table>)`, `SELECT COUNT(*) FROM <table>`, `SELECT value FROM meta WHERE key='normalize_version'`를 실행했다. meta 값은 이 기술 버전 한 항목만 읽었다.

Q2 날짜 범위는 `SELECT substr(min(<date-column>),1,7),substr(max(<date-column>),1,7) FROM <table>`이며, raw는 `WHERE scope='day'`의 key, 샘플은 `strftime('%Y-%m',min/max(ts_ms)/1000,'unixepoch')`로 집계했다. 개인 날짜를 출력하지 않고 월로만 축약했다. D1·D2·D4·D5의 비어 있지 않은 local_date/day_key 표, raw day 키, 세 샘플 표의 최소~최대는 모두 **2026-10~2026-10**이었다. D3은 auth_event만 같은 월이며 나머지는 NULL 범위다. normalize_result는 `WHERE scope='day'`의 key 최소/최대를 월로 집계했고 D1·D2·D4·D5는 같은 월, D3은 NULL이었다. recovery의 `end_ms` 최소/최대에도 샘플과 같은 strftime 집계를 적용했고 D2·D4·D5는 같은 월, D3은 NULL, D1은 표 없음이었다. meta는 날짜 범위를 만들지 않았다. activity는 day_key, activity_hr_sample은 ts_ms를 사용한다. 빈 표는 범위 NULL이다.

Q3은 한 read-only 연결에 다른 후보를 `ATTACH DATABASE 'file:<snapshot>?mode=ro' AS peer`로 붙여 집계했다. 키는 SQL PK, notification만 UNIQUE `(local_date,event)`다. `run/auth_event/fetch_error/delivery`의 id는 **dataset-local 보관 키**이며 cross-dataset 같은 id가 같은 사건이라는 뜻은 아니다. 그 표의 겹침은 구조 비교일 뿐 자동 사건 병합 근거가 아니다.

```sql
SELECT COUNT(*) AS overlap,
       coalesce(sum(a.c1 IS NOT b.c1 OR a.c2 IS NOT b.c2 OR ...),0) AS conflict
FROM main.<table> a JOIN peer.<table> b
 ON a.k1 IS b.k1 AND a.k2 IS b.k2 ...;
SELECT COUNT(*) FROM main.<table> a
 WHERE NOT EXISTS (SELECT 1 FROM peer.<table> b WHERE <same-key>);
-- 반대 방향도 같은 모양. raw 본문 충돌은 sum(a.raw IS NOT b.raw)로 별도 집계.
```

서로 다른 schema는 **공통 비키 열 전부**를 NULL 안전 비교한다. 따라서 fetched/checked·정규화 시각 차이도 충돌이며, schema 15에만 있는 추가 열은 비교 밖이다. 추가 열 누락은 schema metadata로 따로 보존해야 한다. 충돌 수는 열 개수가 아니라 다른 열이 하나 이상 있는 행/키 수다.

### 후보별 표별 건수(Q1)

| 표 | D1 | D2 | D3 | D4 | D5 |
|---|---:|---:|---:|---:|---:|
| activity | 15 | 15 | 0 | 14 | 12 |
| activity_hr_sample | 14416 | 14416 | 0 | 12768 | 10457 |
| activity_recovery | 없음 | 15 | 0 | 14 | 12 |
| auth_event | 0 | 0 | 1 | 0 | 0 |
| body_battery_sample | 124 | 124 | 0 | 89 | 60 |
| daily_metric | 27 | 27 | 0 | 21 | 19 |
| delivery | 0 | 없음 | 없음 | 없음 | 없음 |
| exercise_set | 0 | 없음 | 없음 | 없음 | 없음 |
| fetch_error | 0 | 0 | 0 | 0 | 0 |
| hr_sample | 10907 | 10907 | 0 | 7170 | 6153 |
| meta | 2 | 2 | 0 | 2 | 2 |
| normalize_result | 261 | 261 | 0 | 210 | 188 |
| notification | 2 | 1 | 0 | 1 | 1 |
| raw_response | 288 | 288 | 0 | 231 | 207 |
| run | 9 | 9 | 0 | 4 | 2 |
| stress_bb_sample | 0 | 없음 | 없음 | 없음 | 없음 |

### 쌍별 겹침·차이(Q3)

각 칸은 `겹침/충돌/왼쪽만/오른쪽만`이다. `없음`은 한쪽에 표가 없어서 비교 불가이고 0행과 다르다. D3과 나머지의 공통 키 겹침은 전부 0이며, D3의 auth_event 1행만 오른쪽/왼쪽 단독이고 상대의 모든 비어 있지 않은 행도 단독이다. 따라서 D3 쌍은 건수 표로 전수 계산할 수 있어 반복을 생략했다.

| 표 | D1:D2 | D1:D4 | D1:D5 | D2:D4 | D2:D5 | D4:D5 |
|---|---|---|---|---|---|---|
| activity | 15/0/0/0 | 14/0/1/0 | 12/0/3/0 | 14/0/1/0 | 12/0/3/0 | 12/0/2/0 |
| activity_hr_sample | 14416/0/0/0 | 12768/0/1648/0 | 10457/0/3959/0 | 12768/0/1648/0 | 10457/0/3959/0 | 10457/0/2311/0 |
| activity_recovery | 없음 | 없음 | 없음 | 14/0/1/0 | 12/0/3/0 | 12/0/2/0 |
| auth_event | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 |
| body_battery_sample | 124/0/0/0 | 85/0/39/4 | 56/0/68/4 | 85/0/39/4 | 56/0/68/4 | 56/0/33/4 |
| daily_metric | 27/0/0/0 | 21/1/6/0 | 19/5/8/0 | 21/1/6/0 | 19/5/8/0 | 19/5/2/0 |
| delivery | 없음 | 없음 | 없음 | 없음 | 없음 | 없음 |
| exercise_set | 없음 | 없음 | 없음 | 없음 | 없음 | 없음 |
| fetch_error | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 |
| hr_sample | 10907/0/0/0 | 7170/0/3737/0 | 6153/1/4754/0 | 7170/0/3737/0 | 6153/1/4754/0 | 6153/1/1017/0 |
| meta | 2/0/0/0 | 2/0/0/0 | 2/2/0/0 | 2/0/0/0 | 2/2/0/0 | 2/2/0/0 |
| normalize_result | 261/0/0/0 | 210/5/51/0 | 188/188/73/0 | 210/5/51/0 | 188/188/73/0 | 188/188/22/0 |
| notification | 1/0/1/0 | 1/0/1/0 | 1/0/1/0 | 1/0/0/0 | 1/0/0/0 | 1/0/0/0 |
| raw_response | 288/0/0/0 | 231/9/57/0 | 207/9/81/0 | 231/9/57/0 | 207/9/81/0 | 207/9/24/0 |
| run | 9/0/0/0 | 4/0/5/0 | 2/0/7/0 | 4/0/5/0 | 2/0/7/0 | 2/0/2/0 |
| stress_bb_sample | 없음 | 없음 | 없음 | 없음 | 없음 | 없음 |

raw 본문만 비교하면 D1:D2 0, D1:D4·D1:D5·D2:D4·D2:D5·D4:D5는 각각 6키가 다르다(Q3의 raw 전용 비교). metadata 포함 raw 충돌 9와 구분한다.

### 전체 후보 합집합과 단독 키(Q4)

Q4는 공통 열을 `SELECT <key, common columns> FROM D1.<table> UNION ...`으로 중복 제거한 뒤 키별 `GROUP BY <key> HAVING count(*)>1`의 개수를 센다. 다른 후보 어느 곳에도 키가 없는 수는 `NOT EXISTS`를 나머지 후보 모두에 적용했다. 여기서 전체 충돌은 후보 쌍들의 단순 합이 아니다.

| 표 | 합집합 키 | 값 다른 키 | D1만 | D2만 | D3만 | D4만 | D5만 |
|---|---:|---:|---:|---:|---:|---:|---:|
| activity | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| activity_hr_sample | 14416 | 0 | 0 | 0 | 0 | 0 | 0 |
| activity_recovery | 15 | 0 | 없음 | 1 | 0 | 0 | 0 |
| auth_event | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| body_battery_sample | 132 | 0 | 0 | 0 | 0 | 4 | 4 |
| daily_metric | 27 | 6 | 0 | 0 | 0 | 0 | 0 |
| delivery | 0 | 0 | 0 | 없음 | 없음 | 없음 | 없음 |
| exercise_set | 0 | 0 | 0 | 없음 | 없음 | 없음 | 없음 |
| fetch_error | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| hr_sample | 10907 | 1 | 0 | 0 | 0 | 0 | 0 |
| meta | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| normalize_result | 261 | 193 | 0 | 0 | 0 | 0 | 0 |
| notification | 2 | 0 | 1 | 0 | 0 | 0 | 0 |
| raw_response | 288 | 18 | 0 | 0 | 0 | 0 | 0 |
| run | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| stress_bb_sample | 0 | 0 | 0 | 없음 | 없음 | 없음 | 없음 |

Q4의 raw를 key+raw만 UNION하면 본문이 다른 자연키는 12개다. metadata 포함 raw 18, daily_metric 6, hr_sample 1, meta 2, normalize_result 193을 합하면 **표별 충돌 키 220개**다. 서로 다른 표의 같은 일자를 하나로 묶은 수가 아니다. 건강 파생 값만 보면 daily 6·hr 1 = 7키다. D4·D5에 각각만 있는 BB 샘플 4행씩은 최신 후보에 없으며, 최신 우선만으로 폐기하면 R6 위반이다. D2의 recovery 15행은 0012 삭제 이전 자료이므로 legacy로 보존해야 한다. D3의 로그인 1행, D1의 추가 알림 1행도 별도 출처로 남긴다(Q1·Q3·Q4).

### 기준 소스 규칙 선택지(미결정)

다음 수는 위 220키를 대상으로 규칙을 **모든 충돌 표에 완전히 적용한다는 가정**의 잔여다. 미선택 값도 보관한다. 권위 선택 기록에는 규칙 버전·대상 dataset 순서·적용 범위·선택/미선택 provenance를 남겨야 한다.

| 선택지 | 근거·처리 | 미선택 충돌 키 잔여 |
|---|---|---:|
| A 운영 우선, 없는 키는 개발→D4→D5→D3 순으로 보완 | D2·D1 공통 건강 값 동등, 운영의 legacy recovery 포함. D1 전용 알림·D3 로그인·보관본 전용 BB도 보존한다. 정수 id 이력은 병합하지 않고 dataset별 저장한다 | 0(명시 순서가 220키 모두 선택); 대안 값은 전부 보관 |
| B 개발 우선, 없는 키는 운영→D4→D5→D3 순으로 보완 | 추가 schema를 가진 D1 사용, normalize 2라는 한계는 그대로. 운영 recovery는 legacy 보완. 최신 schema를 더 정확한 값이라고 주장하지 않는다 | 0(동일 전제); 대안 값은 전부 보관 |
| C 공통 값만 현재로, 차이는 ambiguity | 권위를 추정하지 않고 5후보의 동등 행만 현재로 노출, 단독 키는 출처를 유지해 별도 승인 범위로 다룬다 | 220 전체 키(건강 파생만 7; raw 본문만 12) |

A/B의 0은 차이가 사라진다는 뜻도, 데이터 정확성을 검증했다는 뜻도 아니다. deterministic 선택으로 “미선택”이 없어진다는 뜻이다. 원본 revision과 정규화 provenance를 고려해 raw 선택과 정제 선택을 함께 기록하지 않으면 서로 다른 시대의 계산을 현재로 섞을 수 있다. 최종 규칙은 정제 티켓 Notes와 추천 결정 장부에 기록할 후속 작업이다.

## 4. core 계약 표 재료(AD-32·35)

다음은 설계 재료와 선택지이며 최종 DDL·API 명칭은 앞 에픽 구현 HEAD를 읽고 정한다. AD-8·22에 따라 UUIDv7·시각·해시·값은 작성자가 명시적으로 공급한다. DB default now/serial/identity로 생성하지 않는다(spine:176, :367). 모든 core 계약 INSERT에는 12.3의 현재 attempt 확인 함수/trigger와 13.4의 role 출처 결합 RLS를 같이 적용한다. 확장은 INSERT만 하며 core 표 owner가 아니다(spine:463).

| core 칸/의미 | 옛 입력 | 누락·주의/계약 후보 |
|---|---|---|
| source·account identity | raw에는 scope/key/endpoint만 존재 | 계정 ID 칸이 없으므로 manifest 밖의 검증된 계정 매핑 필요. 폴더나 library_version으로 계정 추정 금지 |
| metric 식별자·정규 단위·타입 | daily_metric 각 열, 샘플 bpm/level, activity·exercise_set 열과 SQL 주석 | 버전 있는 metric catalog 후보. 초·m·g·bpm·점수·분류형 구별, day_summary의 분과 daily_metric의 초를 명시 변환. 문자열/JSON은 숫자 집계에서 제외 |
| local_date / instant / timezone | day_key/local_date, ts_ms/start_ms, 옛 config timezone | 날짜형·순간형의 배타 조건과 timezone provenance. workout의 날짜와 시작 순간은 운동 메타로 따로 연결. account·운동 없음은 NULL 안전 UNIQUE 필요 |
| 운동 identity | activity_id·raw activity key; set_index | dataset-local 보관키와 계정 안 원천 운동 identity 구별. set_index는 세트 배열 위치이며 전역 id가 아님 |
| NULL 의미 | 원문 null·누락·음수 센티넬·실패 모두 nullable로 수렴 | 원래 NULL과 normalize error를 함께 보존. 이미 합쳐진 결측 이유를 복원했다고 주장하지 않음 |
| 논리 키 | source/account/metric/activity/date 또는 instant/timezone | dataset을 빼고 같은 관측을 가리키는 키. 집계는 metric별 sum/mean/min/max 허용 목록으로 제한 |
| 보관 키 | 논리 키 + dataset·source table·원래 키 + normalize 버전 + observation revision | dataset을 섞지 않고 원래 값을 보존. 수정 관측은 새 행. 원문 TEXT hash 또는 원천 안정 revision 후보 |
| observation revision | raw_fetched_at→raw.fetched_at 연결, raw 원문 | old schema는 안정 revision 번호 없음. 원문 hash는 식별만 가능하며 순서가 아님. 같은 dataset 내 fetched_at 순서를 후보로 두되 같은 시각 다른 hash는 ambiguity |
| normalize 버전·순서 | meta.normalize_version; normalize_result 상태·normalized_at | 기존 meta 1/2를 8로 바꿔 쓰지 않음. 버전 비교는 정수 의미와 지원 규칙, timestamp 최신으로 대체 금지 |
| 현재 view 권위 | 별도의 소스 선택 기록 필요 | 승인 dataset 범위→관측 revision→지원 normalize 버전의 명시 순서 후보. 동률 동일 입력은 멱등, 다른 값은 ambiguity·기본 집계 제외 |
| body 측정·원본 관계 | 측정일, value_mtime_ns, source_files | 필드별 최신 입력 의미 보존. 파일 등록 결과에 연결; 공개 보고서에는 개인 경로 금지 |

단위/NULL 근거: `G/P/store/migrations/0006_normalize.sql:18`, `0007_sleep_stress_body_battery.sql:1`, `0008_hr_sample.sql:4`, `0009_activity.sql:5`, `0011_exercise_set.sql:5`, `0016_day_values_evaluation.sql:1`. body 병합은 field mtime별 비교이고 전체 문서 하나의 수정일로 대신할 수 없다(`G/P/body.py:14`, `:18`, `:267`). digest는 순수 계산된 수치를 분석 서술과 분리한다(`G/P/digest.py:1218`). charts는 그 수치를 그림으로 표현하는 산출물이며 원본 측정을 대체하지 않는다(`G/P/charts.py:755`, `G/tests/test_charts.py:512`, `:856`).

`analyses` 최소 계약 후보는 id·source·dataset·legacy_table·legacy_key·import batch·revision·report/facts 원문 참조·nullable model/created_at·각 누락 flag·file_request 관계와 확정 file 관계다. schema 16 evaluation이 있으면 `(report_date,scope)`, summary/judgments/evidence/next_checks/report_md/model/created_at를 그대로 옮긴다(`G/P/store/migrations/0016_day_values_evaluation.sql:31`; `G/P/report.py:1030`). 이번 capture는 evaluation이 없으므로 파일 기반 원래 키(별도 안정 artifact key)가 필요하다(Q1). Markdown/facts에 모델·시각이 확인되지 않으면 NULL+missing flag이며 파일 mtime을 모델 생성 시각으로 쓰지 않는다(C5). 원문 파일 bytes와 관계를 유지하고 다시 분석해 채우지 않는다. epic 18의 새 평가 revision·입력 snapshot·선행 analysis ID는 이 최소 계약을 호환 확장한다.

`file_requests` 후보는 출처+안정 요청 키 UNIQUE, producer/work/attempt·batch·보존된 입력 위치 참조·예상 hash/size/media type다. 확장은 요청만 INSERT하고 파일 bytes는 core FileStore가 수용한다. core 인계 표식과 `work_items` 생성은 같은 짧은 트랜잭션, 파일 I/O는 밖에서 수행한다. 요청 직후 crash·인계 중 crash·파일 저장 후 결과 확정 전 crash에 같은 요청으로 수렴해야 한다. 결과 공개 view는 `request_id → file_id / failure`, pending/processing/completed/failed와 재개 가능 여부를 구별하는 안이다. 확장 불변 요청과 core 처리 기록을 분리하면 INSERT-only를 지킬 수 있다. 분석 행이 불변이므로 미완료 file_id를 UPDATE하는 대신 request 링크를 처음 기록하고 core가 별도 관계를 확정하는 안이 있다. 해시 검증·관계 확정까지 생산자가 bytes를 보존한다(spine:388, :473, :581). 이후 기존 문서 추출 일감으로 이어져 epic 17 검색이 소비한다. PNG의 텍스트 추출 성공을 요구하지는 않는다.

`garmin.raw_records` 고정 view는 `(source,account,key,endpoint,fetched_at,checked_at,body)`다. raw TEXT→body, 나머지는 원래 필드와 dataset/account mapping에서 온다. scope·library_version·정규화 provenance는 garmin 내부에 보존한다(spine:470, :543). **scope가 view에 없는데 key는 day/activity 양쪽에 존재한다.** key를 scope 포함한 안정 정규형으로 투영하거나 source와 key의 결합 규칙으로 scope를 복원하는 안을 정제 때 고정해야 한다. 기존 key를 맹목적으로 노출해 scope 충돌을 만들면 안 된다. core는 이 view 외 확장 표를 읽지 않는다.

## 5. importer 계약 재료

`migration-contract.md`의 “대상별 보존/검증”, “importer 계약”, “이전 완료 gate” 및 spine AD-36이 기준이다. 옛 store reader는 최신 schema와 다르면 거부하므로 그대로 쓰면 schema10/15를 읽지 못한다(`G/P/store/__init__.py:7`, `:179`). importer에는 migration/normalize를 import·실행하지 않는 표준 sqlite3 reader와 schema별 mapping이 필요하다.

| 입력군 | 원래 키 mapping | 대상과 보존 사항 |
|---|---|---|
| raw·normalize_result | scope,key,endpoint | garmin 원본/상태; raw TEXT, library_version, fetched/checked, ok/error/raw_fetched_at/normalized_at |
| meta | key | dataset별 원문 value; history_start·normalize_version·미지원 meta도 잃지 않음 |
| daily·샘플·activity·세트·recovery | 1절 PK | garmin legacy 보존 + core 건강 행 mapping; schema/계산 버전·원래 수치·NULL·단위 |
| auth_event·run·fetch_error | dataset,table,id | 원래 id→UUID mapping; fetch_error.run_id를 해당 dataset의 run으로 연결 |
| evaluation 또는 legacy 분석 파일 | dataset,table,(date,scope) 또는 artifact key | core analyses, 파일 요청·관계; 기존 본문/JSON/누락 metadata |
| notification·delivery | 원래 UNIQUE 또는 id | core legacy 이력; 발신 요청으로 바꾸지 않음(6절) |
| 파일·body/profile/설정 | dataset,artifact 안정 key | 예상 bytes/hash·상대 원본 참조·원본 관계·필드 mtime·처리 상태; secret/machine 설정은 분류 |

식별자는 `(dataset_id,source_table,original_key)`이고 batch/version과 target UUID mapping을 확장 schema에 영속 저장한다. batch는 식별자 일부를 대체하지 않는다. 같은 key 재실행 때 보존 필드와 원문 hash를 비교하고 같으면 멱등, 다르면 충돌이다. 새 batch라고 기존 값을 UPDATE하지 않는다. 자연키 순서의 keyset checkpoint 후보와 source key 목록 ordinal 후보가 있으며 source hash/버전이 달라졌으면 checkpoint 재사용을 거부한다. 한 작은 트랜잭션에 데이터·mapping·checkpoint를 함께 확정하고 2초 제한을 지킨다. 파일 대기는 별도 단계로 남기고 완료 결과 view에서 다시 잇는다(spine:171, :186, :540).

preflight 출력 재료: 지원 schema 목록(10·15; 16 대응 여부는 명시), source/capture 식별·목록 fingerprint, 실제 표·열과 미지원 차이, 표별 예상 건수·제외 사유, 키 겹침/본문 충돌/metadata 충돌, 권위 규칙과 미선택 수, 계정 매핑·단위/NULL 손실 위험, target core/garmin migration·manifest/ABI 호환·role/attempt 준비, 예상 INSERT/파일 요청 수, 재개할 batch와 source 불변 검사다. 이번 3절의 숫자는 preflight 출력 fixture 설계 재료이지 실제 반입 preflight 통과 판정이 아니다.

검증 보고서는 source→target 표별 건수와 자연키 집합 차이, raw TEXT hash 동등성, NULL 개수/단위·수치 동등성, fetch_error FK·dataset-local ID mapping, 기존 분석 본문/JSON·누락 flag, 전체 파일 해시·크기·artifact 관계·request 결과, 미선택 충돌과 배제 사유, 동일 batch 재실행/중단 재개/비발신 결과를 포함해야 한다. private 상세 검증과 공개 집계 보고서를 분리한다. hash 자체·원문·계정은 공개 보고서에 쓰지 않는다. raw의 과거 revision이나 존재하지 않던 evaluation을 만들어 낸 것으로 보고하지 않는다.

## 6. 알림·전송 이력 → epic 15.3 칸 대응

15.3은 legacy 표 모양과 같은 conversation 연결·RLS·attempt trigger·비인계/재발신 불가를 먼저 만든다(`tickets/epic-channels/tickets/tickets.toml`, entry 3). 이 에픽은 그 계약을 소비하고 별도 채널 표를 설계하지 않는다.

| 옛 칸 | legacy 입력 칸/의미 |
|---|---|
| notification `(local_date,event)` | dataset+원래 표+복합 원래 key; 날짜·event 그대로 |
| notification detail·at | detail·원래 gate 시각. 성공 발신 증거로 해석하지 않음 |
| delivery id | dataset+delivery+id mapping; global id 아님 |
| delivery local_date/kind/event | 날짜·항목 종류·nullable 사건 보존 |
| delivery ok/reason/at | 당시 결과·이유·시각. network를 지금의 확정 실패/불명으로 재추정하지 않음 |
| 없음 | 외부 message id·본문·당시 bot/chat 참조 NULL+누락 표시 |
| importer가 공급 | source/dataset/table/key/batch, legacy 표식·resend 부적격, 검증된 현재 conversation 연결 |

notification은 먼저 기록 후 전송하는 gate이고 전달 성공과 다르다(`G/P/ports.py:50`, `:253`). delivery는 본문·token·chat id를 저장하지 않는다(`G/P/store/migrations/0015_delivery.sql:1`). 따라서 두 표를 날짜로 억지 1:1 join하거나 gate를 sent라고 만드는 것은 손실이다. D1 notification 2, D2/D4/D5 각 1, D3 0이고 delivery는 D1 0·나머지 표 없음(Q1). 실제 delivery가 없더라도 합성 delivery fixture가 필요하다. 기존/새 이력을 같은 conversation으로 연결하되 새 발신 gate나 인계 일감은 만들지 않아야 한다.

## 7. 확장 뼈대·잠금·macOS arm64

13.1의 설치 registry·owner별 migration 실행기, 13.2 manifest v1·설정 snapshot, 13.3 Python frozen 설치, 13.4 role을 받는다. 11의 PG baseline·FileStore와 12의 감독자·12.3 attempt 함수가 선행한다. 아직 계획이므로 실제 경로·시그니처·core 다음 migration 번호는 해당 HEAD에서 확인한다. 이번 조사에서 이들이 구현됐다고 가정하지 않는다.

| `extensions/garmin/` 재료 | 가져올 것/바꿀 경계 |
|---|---|
| pyproject.toml | 기존 Python>=3.12·uv_build·패키지 리소스/SQL 포함 규칙. CLI는 옛 전체 운영 CLI 대신 importer/연결 확인 진입점 후보 |
| uv.lock·.python-version | 원본 잠금은 uv format version1/revision5, Python pin 3.14.8. manifest와 함께 출처·검증 일치 여부 기록 |
| manifest v1 | name/version/core 호환/ABI 버전, import 일감 `supervised`·명령, 연결 확인, garmin DDL 위치·raw view; 필요한 garmin.* 설정 타입/기본값/비밀 참조 |
| 인증·예약 선언 | importer는 외부 로그인·수집 예약이 필요 없음. epic16이 인증/수집·기본 예약을 추가. 빈/선택 필드 허용은 13.2 schema로 검증 |
| migrations | garmin 보존·mapping/batch/checkpoint DDL 선언; 적용은 core 실행기 하나. 기존 SQLite migrations를 실행용 PG SQL로 복사하지 않음 |

기존 의존은 curl-cffi, garminconnect, jsonschema, matplotlib, requests이고 PG driver는 없다(`G/pyproject.toml:6`). `psycopg` 계열 sync driver를 더하는 안 또는 다른 PG driver 안을 구현 때 선택해야 한다. driver를 더하면 pyproject와 uv.lock을 함께 변경·재잠금해야 하며 옛 lock을 frozen으로 그대로 쓸 수 없다. 이번에는 설치/잠금 갱신을 하지 않았다. core 기본 설치가 이 Python 환경을 강제하지 않는 13.8 계약도 유지한다.

정적 확인: `G/.python-version:1`=3.14.8, `G/pyproject.toml:19` uv_build 범위, `:29` uv 최소 버전·src cache-key. `G/uv.lock:1`의 잠금 메타와 `:338` curl-cffi 패키지, `:348` macOS arm64 abi3 wheel 선언, `:61` cffi cp314 arm64, `:290` contourpy cp314 arm64가 있다. wheel 목록은 실설치 성공 증거가 아니다. archive의 pyproject·lock·pin 세 파일을 source-manifest 항목과 해시 비교했고 3/3 일치했다(해시 값은 기록하지 않음).

실측 필요: 정확한 patch interpreter의 확보·실행, 선택 driver 포함 frozen sync, macOS arm64에서 driver/garminconnect/curl-cffi·matplotlib import, libpq/binary 의존과 PG 연결·UTF-8/epoch/NULL 왕복, package SQL·schema 리소스 포함, 폰트·Agg·차트 산출, 재설치/갱신 후 확장 환경 보존. 옛 `scripts/deploy.sh:27`은 Python pin을 검사하고 `:35`에서 frozen 환경을 만들지만 별도 normalize/LaunchAgent는 새 설치에서 재사용하지 않는다. Deferred “Garmin lock·설치 재현성”은 이 정적 자료만으로 닫지 않는다.

## 8. 공유 파일 레인과 세션 크기

후보 경로는 최종 구현 경로가 아니다. 앞 에픽 HEAD에서 실제 파일명으로 바꾼다.

| 여러 스토리가 함께 고칠 파일군 | 겹치는 작업 | 레인 제안 |
|---|---|---|
| `packages/postgres/migrations/` 다음 번호·Store 조립 | 건강/analyses/file_requests/RLS·현재 view·인계 | core 계약 변경은 순차; 같은 번호 병렬 배정 금지 |
| `packages/core/src/ports/`·domain·공유 schema/fixture | 측정 catalog·revision/단위·파일 요청·분석 최소형 | Python/TS가 같은 fixture 판정을 기준으로 함께 갱신 |
| `extensions/garmin/{pyproject.toml,uv.lock,.python-version,manifest*}` | tracer·driver·import 명령·DDL 선언 | lock/manifest 변경은 한 레인 |
| `extensions/garmin/` importer·migrations·batch/mapping | schema10/15 mapping·재개·충돌·검증 | 보존 reader와 core publisher 경계부터 고정 |
| core 파일 인계·handler 등록·runtime 조립 | file_requests·work_items·FileStore·추출 | 채널 인계와 의미를 맞추되 표 소유권 혼동 금지 |
| CLI CommandSpec·SDK·명령 메타·출력 코덱 | preflight/import/status/검증 공개 출력 후보 | 명칭 정한 뒤 1:1 등록, 비밀 가리기 적용 |
| `plugin/app-ref`·plugin.json | 배포 확인 | 마지막 배포 스토리에서 ref는 앞선 commit, version 함께 상승 |

전체 16개 SQLite migration을 PG로 바꾸면서 metric catalog·TS/Python fixture·파일 crash 복구·실데이터까지 한 세션에 넣으면 큰 위험이다. tracer는 합성 raw 1건과 legacy 분석 문서 1건이 core query에서 읽히는 수직 경로에 제한하는 안이다. 건강 값 전체·schema별 legacy 전수 보존·파일 실패 행렬·실데이터 gate는 뒤 후보로 이름 붙여 분리한다. 단, tracer의 RLS·현재 attempt 검사·비발신·원문 보존은 뒤로 미루지 않는다.

## 9. Done when 1~5의 기존 시험 기반·빈 곳·실제 반입 전제

아래는 시험 소스의 존재/의도 확인이며 실행 결과가 아니다.

| Done when | 재사용할 기반 | 빠진 검증 |
|---|---|---|
| 1 schema10/15 합성·문서, 중복/재개 | `G/tests/test_store.py:209` migration, `:324` rollback, `:604` 읽기 전용·`:626` 구버전 거부; `G/tests/test_raw_response.py:117` exact text·`:129` checked·`:157` NoData; `G/tests/test_body.py:291` mtime 병합 | schema10/15를 표준 reader로 읽는 합성 원본, PG mapping·불변 충돌·같은 batch 중복/중간 crash/checkpoint·오래된 token 거부 |
| 2 capture 확인·실반입 | 이번 Q1~Q4/QF 집계·manifest, prep preparation-checks의 준비 검사 | writer 정지 확인·capture 최신성/재캡처·권위 추천 규칙 적용·계정 mapping·실제 PG 반입. 이번에 수행하지 않음 |
| 3 값/본문/hash/관계 보고 | raw 보존 시험, `G/tests/test_digest.py:97` cutoff·`:167` bad shape·`:378` day values, `G/tests/test_charts.py:856` snapshot | source-target 전수 자연키·NULL/단위/FK/본문·파일 관계 검증, 실패/누락/충돌의 공개 집계와 private 상세 보고 |
| 4 원본·private 보존 | `G/tests/test_body.py:755` 경로 경계·`:672` 로그 값 비노출; 합성 body/inbody fixtures | 원본 무변경 검증, 공개 보고서/패키지에 개인 데이터·비밀 유입 방지, production과 격리된 PG/Home cleanup |
| 5 플러그인 배포·이 Mac | 13.3 Python 선택 suite·13.8 기본 Python 불요·13.10 설치본 확인 계획 | Garmin 실제 잠금 재현·설치본 importer 경로·migration/role 상태·로컬 app-ref/version·설치본 관찰 |

`G/tests/test_acceptance_report.py:18`은 fake Codex 경로다. pyproject의 “실제 Codex” 설명(`G/pyproject.toml:59`)과 **어긋남**이 있으므로 실제 모델 품질 근거로 쓰지 않는다. 기존 분석을 보존하는 importer는 모델을 호출할 이유가 없다. `G/tests/test_digest.py:193`의 실제 Garmin fixture 검사는 로컬 fixture 없으면 skip하므로 archive만으로 실데이터 동등성을 입증하지 않는다. 합성 fixture는 `G/tests/fixtures/body/measurement.json`, `inbody/`와 tests 내부 생성 입력을 출발점으로 삼는다. normalize 시험의 전체 rebuild/실패 단위·report fakes는 계산/문서 구조에 유용하지만 새 PG 계약을 검증해 주지는 않는다(`G/P/normalize/__init__.py:243`; `G/tests/test_report.py:739`, `:1186`).

2026-10-28 위임에 따른 실제 반입 스토리 사전 조건은 다음과 같다.

1. 기록된 추천 규칙·dataset/계정 대응·충돌 처리 범위를 티켓 Notes와 추천 결정 장부에 남긴다. 이 보고서의 선택지 제시만으로 완료 처리하지 않는다.
2. 옛 writer(collect/report/body·예약·수동 실행)의 정지 여부를 확인한다. 현재 capture 검증은 writer가 멈췄다는 증거가 아니다. 새 수집이 snapshot 뒤 진행됐거나 파일/DB가 달라졌으면 원본에서 normalize/upgrade를 하지 않고 별도 새 일관 capture를 만든다. WAL이 있을 수 있으므로 DB 파일만 복사한 것을 일관 snapshot이라고 단정하지 않는다. source가 바뀌면 새 dataset/batch 또는 명시 재개 정책으로 처리한다.
3. 현재 capture manifest의 전체 파일 해시·DB 지원 schema/목록·원본 최신성을 다시 확인하고, 필요한 writer 정지/재캡처 절차를 private 작업 기록에 남긴다. 이번에 확인한 것은 capture 자체의 일치와 해시 표본이다.
4. 앞 에픽 코드 HEAD에서 PG·감독자/attempt 함수·manifest v1·Python 설치·role·15.3 legacy 계약을 확인하고 합성 suite를 먼저 통과한다. 격리된 Brain 홈/DB와 실제 target을 혼동하지 않으며 실제 반입 target·보존 snapshot을 명시한다.
5. importer의 외부 수집·모델·메시지 발신 경로를 열지 않고 작은 batch로 반입→전수 검증→현재 view 권위 publish를 구분한다. 실패·미선택 충돌·파일 요청 대기는 성공으로 기록하지 않는다. 로컬 플러그인 출처부터 확인하고, 원격 push가 있어야 하는 단계는 위임 지침대로 operator_actions에 남긴다.

## 스토리 후보

결정이나 새 tickets.toml이 아닌 순서 선택지다. prep `integration-boundaries.md`의 tracer(합성 원본 한 건+기존 분석 형식 문서 한 건→PostgreSQL→core query)를 유지하면 언어·DB·파일 경계를 초기에 확인할 수 있다. epic17의 최종 검색 CLI를 tracer 선행 조건으로 묶지 않고 core 읽기 port/계약 fixture로 관찰하는 안이다.

| 후보 | 결과와 근거 | 고칠 파일 후보 |
|---|---|---|
| T1 tracer | 설치된 Garmin importer가 합성 raw 1건·legacy Markdown 1건을 남기고 request→FileStore→analysis에서 core query로 원문을 읽음. 최소 건강 행·raw view·RLS·attempt·비발신 포함 | `extensions/garmin/{pyproject.toml,uv.lock,.python-version,manifest*,migrations/,src/,tests/}`; `packages/postgres/migrations/`·관련 Store; core 분석/측정/파일 요청 port·인계/조립·공유 fixture |
| T2 보존 reader·preflight | schema10/15 전수 표·원래 키·dataset mapping, 차이/충돌/미지원 출력. 원본 미변경 | Garmin importer reader/schema mapping·preflight·합성 schema fixture; CLI/SDK/메타·출력 코덱 후보 |
| T3 건강 의미·현재 view | metric catalog·단위/NULL·account/운동/날짜·revision/버전·권위/ambiguity와 TS/Python fixture. epic16/17/18의 소비 계약 | core domain/fixture·PG migration/view·Garmin publisher/adapter tests |
| T4 batch·재개·검증 | 작은 transaction+mapping/checkpoint, source 변경·같은 키 다른 값·충돌 보고·FK·본문/hash 검증 | Garmin batch/mapping/checkpoint/verification·PG migrations·failure injection tests |
| T5 파일·분석·legacy 전수 | 349개 종류 대응·body/profile provenance·누락 metadata, file_requests crash 복구, 15.3 입력·비발신 | core file-request 인계/결과 view·analysis 관계·Garmin artifact/legacy mapper·PG/합성 tests |
| T6 재현성·정리 | 새 driver lock·pin·arm64 import/접속·공유 파일 정리, 미룬 항목만 sweep | Garmin 패키지/lock·선택 Python suite·관련 계획/검증 기록 |
| T7 실제 반입·설치본 확인 | 위임된 추천 규칙 기록, writer/capture 재확인, 실반입·전수 검증, 플러그인 설치본에서 관찰 | importer 실행/검증 기록·추천 결정 장부·해당 티켓 plan; `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json` 배포 묶음 |

순서안 A는 T1→T2→T3→T4→T5→T6→T7이다. 규약의 최소 경로를 일찍 관통하고 뒤에서 전수화한다. 순서안 B는 T2→T1→T3→T4→T5→T6→T7이며, 원본 schema 해석을 먼저 고정해 tracer mapping을 덜 바꾸는 장점이 있다. T1이 한 세션을 넘으면 패키지/설치·최소 DDL 준비를 별도 선행 후보로 나누되 마지막 수직 경로에서만 tracer 성공을 선언한다. T4·T5를 병렬화하려면 core 인계/analysis 관계·migration 번호 소유를 먼저 나눠야 하므로 기본은 한 레인 후보가 타당하다. 실제 교차 after는 11의 최종 코드 기반, 12.1/12.3/12.4, 13.2/13.3/13.4 및 최종 코드 조립, 15.3을 받는 스토리에 선언한다. 앞 에픽의 이 Mac 확인·사람 닫기를 전체 gate로 다시 만들지 않는다.

자체 확인: 보고서만 대상으로 절대 홈 경로·긴 해시 패턴·개인 일자 패턴을 검색하고, 수치/문자열을 집계 출력·정적 코드 근거와 대조하여 측정값·본문·개인 파일명·계정 식별자·해시 값이 포함되지 않았음을 확인했다.
