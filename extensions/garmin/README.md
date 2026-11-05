# Garmin native tracer 검증 인계

21.2의 수락 시험 코드는 합성 schema 16 SQLite와 합성 report·facts·graph,
격리 Brain home 및 시험 PostgreSQL만 사용한다. `fixtures/native/synthetic.py`는
명시 profile과 고정 시간으로 다섯 capture를 만들고, fake Garmin·모델·Telegram
대체물도 제공한다. `tests/oracle/src`는 Garmin 고정 commit
`7fb33dd1661ad25cd73e14ed63abe0a87151f62e`에서 추적된 원본을 변경 없이
복사한 독립 SQLite oracle이다. 제품 PG 코드로 기대값을 만들지 않는다.

이번 21.2 구현에서는 시험 실행을 **21.8로 이관, 미실행**한다. 21.8은
21.6 뒤, 21.7 전에 아래 전체 시험을 수행한다. 운영 DB·실제 Garmin 계정,
토큰·건강자료·공유 role/container는 사용하거나 삭제하지 않는다. 시험 전
Docker가 동작하고 전용 54329 포트가 비어 있는지 확인한다. 아래 프로젝트명은
이번 실행이 직접 만든 임시 자원에만 사용하며 같은 이름의 기존 자원이 있으면
소유권을 먼저 확인하고 덮어쓰거나 정리하지 않는다.

```sh
git rev-parse HEAD
docker compose -p brain-garmin-21-8 -f compose.test.yaml up -d --wait
export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres
pnpm test
pnpm test:python
```

두 전체 시험은 순서대로 한 번씩 실행한다. `pnpm test:python`의 global setup과
`extHome`이 각 시험마다 별도 `brain_test_<random>` DB·소유 role·임시 home을
만들고 정리하며, `garmin-unit.test.ts`는 그 DB의 관리자·해당 확장 role·시험
app role만 Python 단위시험에 전달한다. 자격이 없으면 시험은 실패하며 건너뛰지
않는다. 재검증이 필요하면 실패 원인 수정 후 관련 시험을 실행한다:

```sh
pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-native.test.ts apps/cli/python-test/garmin-unit.test.ts
```

기대 관찰: 설치→감독 import→파일 drain→import-verify 성공, schema 16의
모든 표에 대해 행 수·자연키·값·NULL 동일, day/7d/30d/all 폴더 목록과 JSON
값·배열 순서·NULL 동일, crash 뒤 재개·동일 batch 중복 없음, 파일 hash와
중립 metadata 및 선택 revision→file_id 일치, revision 두 행과 최신 view 한 행,
기존 세션·메시지·파일 보존이다. profile 미확인·stale·충돌·불명 provenance는
각 시험이 차단 또는 명시적인 미연결로 확인한다. 새·기존 Garmin 시험과 경로
분류 시험이 모두 실행돼야 한다. `test_normalize_oracle_pg.py`는 격리 DB의
유효한 work/attempt와 확장 role을 사용하며, 고정 합성 `normalize_v8/input.json`을
`tests/normalize_oracle_child.py`의 별도 subprocess에서 고정 SQLite 원본으로
계산한 뒤 실제 PG 처리·0건 재실행·rebuild 결과와 비교한다. 고정 시각과 동일
시간대를 사용하고 원본의 parse_error도 그대로 비교한다. 실제 projection 쓰기
실패 후 pending과 재개 및 기존 항목 crash/재구성 게시 실패 시험도 함께 실행한다.

명령·종료 코드·로그·기준 SHA·시험 DB/role/container 및 home의 소유권,
실패별 처분·관련 재검증 결과를 21.8 증거에 기록한다. 작업이 끝난 뒤 이 실행이
직접 만든 compose 프로젝트만 정리한다:

```sh
unset BRAIN_TEST_DATABASE_URL
docker compose -p brain-garmin-21-8 -f compose.test.yaml down
```

미실행 시험이나 미해결 실패가 있으면 21.8을 built로 처리하거나 21.7을
시작하지 않는다.

기존 schema 10/15·비정상 TEXT·legacy 장부 회귀는 격리 설치본에만 놓는
`tests/preservation_entry.py`가 현재 보존 primitives를 감독 실행하여 유지한다.
운영 manifest는 native 반입과 감독 수집 일감을 제공한다. 새 native tracer와 기존 보존·업그레이드
시험을 모두 실행해 두 계약을 확인하며 어떤 시험도 삭제하거나 skip하지 않는다.

## 감독 수집과 21.8 시험 인계

21.3의 수집 시험 실행은 **21.8로 이관, 미실행**이다. 21.8에서는 위
전용 DB·소유 role/container·격리 home을 준비한 뒤 새 시험을 포함해 `pnpm test`
다음 `pnpm test:python`을 순차 실행한다. 관련 실패의 수정 뒤에는 다음 시험을
재검증한다:

```sh
pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-native.test.ts apps/cli/python-test/garmin-unit.test.ts
```

`garmin-collect.test.ts`는 격리 설치본의 외부 Garmin 어댑터만 fake로 교체하고
실제 manifest→감독자→`collect.py`→계정 락·credential·수집·저장을 사용한다.
합성 요청 장부에서 수집 중 취소 후 프로세스와 자식 종료, 이미 받은 raw 보존,
재개 시 확정 항목 생략, 오래된 attempt 쓰기 거부, 같은 대상 일감 합치기와 다른
연결의 자격 거부, 차단 시 외부 호출 0, 기존 기억 보존을 확인한다.
`garmin-unit.test.ts`의 Python discovery는 `test_collect_oracle_pg.py`를 포함한다.
그 시험은 고정 SQLite oracle과 동일 fake 응답으로 raw·run·coverage·정규화·digest,
NULL·배열·동률·시간대·중단 뒤 pending 복구를 비교한다. DB/role/home·명령·종료
코드·기준 SHA·로그·실패별 처분·관련 재검증을 기록하고 이 실행이 소유한 자원만
위 정리 명령으로 제거한다. 미실행 시험이나 미해결 실패가 있으면 21.8 built 및
21.7 시작을 금지한다.

21.7의 실제 연결 준비는 별도 운영 작업이다. 운영자가 선택된 self·connection과
기존에 확인한 Garmin profile 및 전용 tokenstore의 동일 계정을 직접 확인한 뒤,
소유자 전용 0700 tokenstore에 `brain-account-binding.json`을 0600으로 준비한다.
필드는 `version`(1), `user_id`, `connection_id`, `external_identity`,
`token_sha256`이며 마지막 값은 같은 디렉터리 `garmin_tokens.json`의 바이트에
대한 소문자 SHA-256이다. 토큰과 확인서의 실제 내용·계정 식별자는 저장소나
로그에 넣지 않는다. 확인서는 Garmin 서명이 아닌 로컬 운영자의 명시적 귀속
확인이다. 정상 토큰 갱신은 잠금 아래 보호된 작업 사본과 복구 장부로 처리하며,
중단된 갱신은 다음 동일 계정 실행에서 검증 후 이어간다. 수동 토큰 교체·다른
계정·불일치 증거는 자동 귀속하지 않으므로 운영자가 원인을 확인해야 한다.

## 감독 분석과 21.8 시험 인계

21.4의 시험 실행은 **21.8로 이관, 미실행**이다. 앞의 전용 compose·시험
DB/role·격리 home 준비와 소유권 확인 후 `pnpm test` 다음 `pnpm test:python`을
순차 실행한다. 실패 수정 후 관련 재검증은 다음과 같다.

```sh
pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-report.test.ts apps/cli/python-test/garmin-native.test.ts apps/cli/python-test/garmin-unit.test.ts
```

Python discovery의 `test_report_input_pg.py`는 고정 합성 입력을 각각 별도
SQLite 원본 child와 소유 PG에 넣고 day·7d·30d·all의 파일/JSON, NULL·배열,
cutoff, digest 계산, 모델 프롬프트·schema, 원본 체성분 측정 검증을 비교한다.
`garmin-report.test.ts`는 실제 설치 manifest와 감독 entry부터 fake 모델과
PG 저장까지 중단/재개, 재생성, 경쟁, 취소 및 body 경계를 관찰한다. 분류
시험은 새 child·fixture·감독 관찰자 경로가 Python 실행 대상으로 선택되는지
확인한다. 원본 SQLite child는 제품 PG에서 기대값을 만들지 않는다.

기준 SHA, 명령·종료 코드·로그, 격리 자원 소유권, 실패별 처분과 재검증을
기록한다. 위의 정리 명령으로 이 실행이 직접 만든 자원만 정리한다. 새·기존
시험이 빠지거나 실패가 남으면 21.8 built 및 21.7 시작은 금지한다.

21.4의 body 명령은 모델 호출별 runtime 파일 요청/응답으로 호스트에 전달된다.
모델 프로세스는 PG에 접속하지 않으며 호스트가 선택 계정과 현재 attempt를
검사하고 짧은 fence 안에서 원본 body 검증·확정을 수행한다. 호출이 끝나면
미처리 요청은 다음 scope로 넘기지 않는다. 감독 그룹 소유권이 확인된 경우에만
모델과 후손을 정리하고 다음 scope 전에 종료를 확인한다.

21.8에서 `test_body_runtime.py`의 실제 CLI subprocess→호스트 요청 성공·invalid·
pending·stale·미처리 요청 취소와 sidecar replace 직후/복수 source 첫 이동 뒤
취소 및 재시도를 확인한다. 앞서 확정된 sidecar와 이동된 입력, 남은 pending,
mtime 병합 및 source 목록을 관찰한다. `test_report_supervised.py`의 최초
pending 잔존 성공보고 거부, `test_report_process.py`의 그룹 소유권·정리와
`garmin-report.test.ts`의 timeout 이후 후손 종료 및 daemon 복구 시험도 포함한다.
이 시험 코드는 **21.8로 이관, 미실행**이다.

Execution 12의 추가 관찰도 같은 소유 PG와 격리 home에서 실행한다. 실제 감독
fake가 계정별 합성 steps가 든 digest 파일, pending 사진 순서와 `-i`/프롬프트,
배포 body 명령 문법 및 선택 모델/effort argv를 확인한다. TERM을 무시하는
손자는 다음 scope 전에 종료돼야 한다. `test_store_contract_integration.py`는
실제 fence 안 원본 파일 게시 중 회수 잠금 경합, 취소 후 stale 거부 및 새
attempt 재시도를 관찰하고 `test_body_runtime.py`는 날짜와 source 거부 때 기존
파일 보존을 확인한다. 독립 SQLite oracle도 계산 digest를 파일에 게시해 PG와
비교한다. 이 코드와 fixture 생성·checker·모든 시험 실행은 **21.8로 이관,
미실행**이다. 경로 분류는 기존 Garmin 전체 규칙과 분류 assertion을 사용한다.

## 조회 명령 계약

`brain ext garmin daily-values|period-summary|recent-evaluations --input <JSON> --json`과 MCP 도구는 동일 schema를 쓴다. 모든 입력에 자기 소유 `connection_id`와 해당 연결의 IANA `timezone`이 필요하다. 연결 시간대와 다르면 거부한다. 날짜는 `start_date`, `end_date`의 현지 날짜 양끝 포함이며 선택 `activity_type`, `exercise`는 정확히 일치하는 운동으로 제한한다. 일별 지표는 조건에 맞는 운동이 있는 날짜를 고르고, 운동·운동종목·세트 지표는 해당 행만 고른다. `set.*`은 휴식 세트를 제외한다.

`daily-values`는 `rows`에 날짜·값·단위를 반환한다. `period-summary`는 `aggregation` (`sum` 또는 `mean`)을 받고 `value`, `unit`, `observed_count`, `null_count`, 적용 `start_date`/`end_date`를 반환한다. NULL은 0이 아니며 전부 NULL이거나 행이 없으면 값은 null, 관측 수는 0이다. `recent-evaluations`는 `scope` (day/7d/30d/all), `limit` (1~100)을 받아 최신 revision의 날짜·요지·report `file_id`(미확정이면 null)를 반환한다.

| 지표 | 단위 | 허용 집계 |
|---|---|---|
| `sleep_total_s` | s | sum, mean |
| `sleep_deep_s` | s | sum, mean |
| `sleep_light_s` | s | sum, mean |
| `sleep_rem_s` | s | sum, mean |
| `sleep_awake_s` | s | sum, mean |
| `sleep_score` | score | mean |
| `sleep_hr_min` | bpm | mean |
| `hrv_avg` | ms | 없음 |
| `spo2_avg` | % | 없음 |
| `spo2_min` | % | 없음 |
| `resp_avg` | breaths/min | 없음 |
| `wake_bb` | score | mean |
| `bb_high` | score | mean |
| `bb_low` | score | mean |
| `bb_charged` | score | sum, mean |
| `bb_drained` | score | sum, mean |
| `stress_avg` | score | mean |
| `stress_high_s` | s | sum, mean |
| `steps` | count | sum, mean |
| `active_kcal` | kcal | sum, mean |
| `moderate_min` | min | sum, mean |
| `vigorous_min` | min | sum, mean |
| `resting_hr` | bpm | mean |
| `weight_kg` | kg | mean |
| `workout.duration_s` | s | sum, mean |
| `workout.hr_avg` | bpm | mean |
| `workout.hr_max` | bpm | mean |
| `workout.zone1_s` | s | sum, mean |
| `workout.zone2_s` | s | sum, mean |
| `workout.zone3_s` | s | sum, mean |
| `workout.zone4_s` | s | sum, mean |
| `workout.zone5_s` | s | sum, mean |
| `workout.bb_change` | score | sum, mean |
| `exercise.sets` | count | sum, mean |
| `exercise.reps` | count | sum, mean |
| `exercise.max_kg` | kg | 없음 |
| `exercise.volume_kg` | kg | sum, mean |
| `exercise.set_peak_hr_avg` | bpm | mean |
| `exercise.rest_drop_avg` | bpm | mean |
| `set.reps` | count | sum, mean |
| `set.weight_g` | g | mean |
| `set.duration_s` | s | sum, mean |

예약 기본값은 `Asia/Seoul` 기준 수집 11:00, 분석 11:30이며 두 예약은
사용자 설정 `garmin.connection_id`를 발화 때 고정한다. 21.7 운영자는 해당
연결이 보호 tokenstore binding과 일치하는지 확인하고 이 설정을 지정한다.
분석은 같은 사용자·대상·현지 날짜의 수집 성공 회차를 기다린다. 놓친 회차는
latest로 정산하며 예약 수집의 부분 수집·차단·인증 실패·무실행은 성공이 아니다.
예약 실행은 봉투의 단일 회차 날짜를 사용하며 수동 실행은 기존 날짜 규칙을 쓴다.
시험 코드는 작성했으나 시험 실행은 **21.8로 이관, 미실행**이다.

분석 게시에는 사용자 설정 `garmin.channel_conversation_id`에 자신의 core 채널 대화 UUID가 필요하다. 저장된 평가와 완료된 core 파일로 요약, 두 그래프 묶음과 보고서 문서를 구성한다. 채널 발송·불명 상태·재시도는 core가 관리하며 발송 실패로 평가를 다시 생성하지 않는다. 분석 실패 알림은 같은 날짜와 계정의 `report_failed` 요청으로 중복을 억제한다.

Marketplace 패키지는 `node tooling/package-garmin/build.mjs`로 제품 소스에서 생성한다. 생성된 `plugins/garmin/package/manifest.json`의 파일 목록과 digest가 core 설치기의 검증 대상이며, 독립 oracle·fixture·출처 이력은 패키지에 넣지 않는다. 제품 변경 후에는 이 명령을 다시 실행해 바이트와 목록을 동기화한다.

## 21.5 설치부터 채널·조회까지의 21.8 인계

`apps/cli/python-test/garmin-core.test.ts`는 위 전용 시험 DB와 격리 home에서
marketplace Garmin 패키지의 실제 `--package` 설치와 manifest를 사용한다.
가짜 clock으로 기본 cron 회차를 발화하고 Garmin과 Codex의 외부 경계만
합성 대체하며, 실제 감독자·파일 drain·core 채널 worker를 로컬 가짜 Telegram
서버에 연결한다. 실패한 수집에서 모델 호출 0, 수집 성공 뒤 네 scope 한 번,
파일의 중립 metadata와 평가 revision 관계, 채널 실패/재시도의 평가 보존과
의미 키 중복 억제를 관찰한다. CLI와 MCP의 sum/mean, NULL·0건·운동 필터,
허용 집계 거부·가리기, disable/enable 및 재설치 시 예약 삭제표식·사용자
변경과 native/평가/파일 보존도 확인한다. 별도 `garmin-plugin.test.ts`는 core
부재 안내와 격리 가짜 core에 대한 플러그인 진입점의 패키지 위임을 확인한다.

위 전용 compose와 `BRAIN_TEST_DATABASE_URL`을 준비하고 `pnpm test` 다음
`pnpm test:python`을 순차 실행한다. 실패를 수정한 뒤 관련 재검증은 다음과 같다.

```sh
pnpm exec vitest run tooling/bootstrap/test/garmin-plugin.test.ts tooling/test-db/test/test-changed.test.ts
pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-core.test.ts apps/cli/python-test/garmin-query.test.ts apps/cli/python-test/garmin-report.test.ts apps/cli/python-test/garmin-collect.test.ts
```

실행은 **21.8로 이관, 미실행**이다. 기준 SHA, 소유 DB·role·격리 home과
compose 자원, 명령·종료 코드·로그·실패별 처분 및 재검증을 기록한다.
종료 시 시험 harness가 자신이 만든 DB·role·home을 정리하고, 운영자가 이
실행이 만든 compose 프로젝트만 앞의 `down` 명령으로 정리한다. 하나라도
미실행이거나 해결되지 않은 실패가 있으면 21.8 built 및 21.7 시작은 금지다.
