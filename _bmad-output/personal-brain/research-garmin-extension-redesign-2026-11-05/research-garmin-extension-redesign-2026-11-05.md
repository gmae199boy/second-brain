---
type: codebase
title: 'Garmin 확장 재설계 조사'
commit: '93055d51daef802cc8f836f109840df917818abd'
created: '2026-11-05'
source: 'Orca 읽기 전용 조사 Dispatch ctx_8d9ae6ed181b (Codex gpt-6.1-sol/medium)'
---

# Garmin 확장 재설계 조사

조사일: 2026-11-04. 기준: 브랜치 `gmae199boy/brain-ticket-18-10`, HEAD `93055d5`; 옛 프로그램 `~/github/garmin` HEAD `7fb33dd`. **읽기 전용 조사**이며 지정된 이 보고서만 작성했다. DB·Docker·네트워크·모델·시험을 실행하지 않았고 실제 건강값·계정 식별자는 수집하거나 옮기지 않았다. `AGENTS.md`와 자동화 런북을 읽었으나 자동화를 재개하지 않았다.

## 1쪽 결론 요약

**추천: 이미 있는 공통 실행·확장 설치·파일·채널 기반은 살리고, Garmin의 저장·정규화·분석·조회 의미를 `garmin`으로 돌린다.** 별도 레포 분리는 그 경계가 안정된 뒤 해도 된다. 지금 필요한 것은 scheduler 전체 재작성이나 migration 실행기 추가가 아니다.

- **확인된 사실:** 공통 scheduler는 DB/Store 층에서 간격·매일 현지 시각·one-shot을 처리한다. 공개 CLI와 manifest 기본 예약은 매일만 지원한다. 매주 금요일과 cron은 없다. 주 단위만 우선 추가하고 one-shot·간격의 공개 등록을 열면 충분하다. 놓친 매일 예약은 날짜 범위를 한 일감으로 합치며 DST gap/fold 정책과 원자적 발화가 이미 있다(Q1).
- **확인된 사실:** manifest→확장 subprocess→공통 감독·예약 등록은 이미 구현됐다. 그러나 `brain ext install <name>`은 레포에 동봉된 패키지만 찾는다. marketplace는 `plugins` 배열이므로 같은 레포의 core/Garmin 두 항목으로 구성할 수 있는 모양이다. 실제 여러 에이전트의 `/plugin` 지원은 별도 검증 대상이다(Q2).
- **핵심 차이:** epic 16은 옛 `day_summary`, `workout`, `exercise_log`를 PG `garmin` 표로 만들지 않는다. Python에서 계산한 행을 catalog의 지표별 `brain.health_observations`로 펼쳐 쓴다. 옛 반입 행은 `garmin.preserved_rows`에 원형 보존되지만 SQL로 바로 읽을 옛 표는 아니다. `evaluation`도 core `analyses`로 이전한다. 따라서 옛 report/report_input을 PG 위에서 그대로 실행할 토대는 아직 없다(Q3).
- **확인된 결합:** 18.1은 core에 `$garmin-daily-analysis` 프롬프트와 전용 health worker를, 18.2는 core PG adapter에 `garmin.collect_target_accounts`·`garmin.body_records`·Garmin kind와 건강 pivot을 넣었다. 이름만 중립인 core 건강 표 수준을 넘어 실제 Garmin 의존이 있다. 18.10 미커밋 0031은 이 우회 경로를 빠르게 만드는 작업이며 새 경계의 선행으로 삼지 않는 편이 맞다(Q2·Q3).
- **추천 처분:** 12·13·15는 재사용, 14의 보존 reader/checkpoint/capture는 수정 재사용, 16의 인증·수집·순수 계산·차트는 수정 재사용. core 건강 표/view/집계와 18.1·18.2 전용 분석 경로는 동결 후 제거 후보. 이미 적용된 SQL 파일이나 기존 데이터를 지우지는 않는다. core file_requests·채널은 유지한다(Q3).
- **확인된 한계:** 현재는 한 DB에 여러 Garmin 계정 데이터가 있을 수는 있지만 여러 Brain 사용자를 격리하는 모델이 아니다. settings는 key 단독 PK, schedule/work/channel에 user_id가 없고 extension role은 확장 단위다. 계정 문자열을 사용자 ID처럼 쓰거나 바꿀 수 있는 GUC 하나로 RLS를 끝내면 안 된다(Q4).
- **추천 순서:** 경계/사용자 신원 결정 → 사용자 소유권·작업 권한 → 외부 패키지 설치·예약·조회 ABI → Garmin PG 표/기존 데이터 이관 → 옛 분석 재사용 → 공통 채널 연결 → 설치본 전환. epic 19의 공통 시험 개선은 독립 가치가 있으나 새 Garmin 설계 전체의 필수 선행으로 묶지 않는다(Q5).

**추정과 미확인:** 구현 규모는 아래의 상대 규모/인일 추정이며 새 설계·시험 범위를 확정하기 전 약속이 아니다. 현재 운영 DB에 무엇이 적용됐는지는 조사 금지 범위라 확인하지 않았다. 기존 plan의 blocked 진술을 현재 DB 관찰로 표현하지 않는다. `/plugin`의 여러 호스트 지원과 설치 제거 의미는 로컬 코드만으로 확정할 수 없다.

## 근거 표기

이하 경로는 `<repo>/` 기준이다. 반복되는 긴 경로는 다음 별칭을 사용한다. `파일:행`은 해당 시작 행과 그 아래 관련 블록을 가리킨다.

- **ARCH** = `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`.
- **ROOT** = `_bmad-output/personal-brain/tickets/tickets.toml`.
- **T12/T13/T14/T15/T16/T17/T18/T19** = 각각 `_bmad-output/personal-brain/tickets/epic-{jobs-and-scheduler,extensions,garmin-import,channels,garmin-runtime,search-and-health-query,health-analysis,test-time}/tickets/tickets.toml`.
- **Mnnnn** = `packages/postgres/migrations/nnnn_*.sql`(번호당 파일 하나).
- **OLD** = `~/github/garmin/src/garmin_pipeline/`(소스만 조사). 옛 소스 인용은 이 접두사를 붙인다.
- **상태 근거:** 티켓 상태는 TOML entry가 아니라 해당 `tickets/*plan.md` frontmatter다. 아래 Q5에 직접 적은 상태도 이 기준이다.

## Q1. 스케줄러가 실제 지원하는 것과 최소 확장

### 사실: 지원 층을 나누어 봐야 한다

| 모양 | DB/Store/tick | 공개 CLI·SDK add / manifest | 근거 |
|---|---|---|---|
| 초 간격 | 가능. 양의 interval_seconds, 다음 실행=이번 tick 시각+간격. 고정 벽시계 주기가 아니어서 지연 때 위상이 이동한다 | `schedules add`로는 미지원, manifest도 미지원 | M0001:351, `packages/core/src/queue/schedule-tick.ts:59`, `apps/cli/src/commands/schedules-add.ts:4`, manifest decoder:13 |
| 매일 현지 HH:MM | 가능. IANA timezone, 다음 일의 현지 시각 계산 | 가능. CLI `--at HH:MM`, manifest `default_schedules[].local_time` | M0009:1, `packages/core/src/queue/schedules.ts:11`, `packages/core/src/extensions/manifest.ts:72` |
| one-shot | 가능. local_time/time_zone/interval_seconds=NULL, next_run_at=예약 instant. 발화 뒤 next_run_at=NULL | 전용 공개 등록은 없음. `schedules run`은 기존 예약을 지금 수동 투입하는 명령으로 one-shot 생성과 다름 | `packages/core/src/domain/schedule.ts:12`, tick:59, schedules:21 |
| 매주 금요일 | 지원 없음. 7일 간격을 Store로 넣을 수는 있으나 현지 금요일/DST 보장과 다르다 | 없음 | schedule domain:2, M0009:1, manifest:13 |
| cron·월간·연간 | 표현 필드·parser·계산기 없음 | 없음 | 같은 domain, manifest 및 CLI의 닫힌 필드 집합 |

여기서 `manifest decoder`는 `packages/core/src/extensions/manifest.ts`, `tick`은 `packages/core/src/queue/schedule-tick.ts`, `schedules`는 `packages/core/src/queue/schedules.ts`다. `apps/cli/src/daemon/run.ts:335`는 파일 요청·채널 인계 후 `brain.schedules.tick()`을 호출하고 queue drain으로 이어진다(:349~356). cron OS 서비스가 따로 발화하는 구조가 아니다.

### 사실: 누락·DST·중복 의미

- **놓친 실행:** interval·one-shot은 밀린 횟수만큼 반복하지 않고 한 번 발화한다. daily는 `dailyOccurrenceDates(next_run_at, now)`로 범위를 계산하여 한 work에 넣고 다음 현지 발화로 전진한다. 성공 날짜(`schedule_successes`)를 제외한 첫/마지막 날짜를 work에 전달하므로 순수한 “오늘만 실행” 정책이 아니다. Garmin 분석의 “최신 하루만”은 확장 job의 의미로 정해야 한다(tick:11,48~61; `packages/postgres/src/schedules.ts:136`; `packages/postgres/src/work.ts:879`).
- **DST:** fold는 가능한 instant 중 첫 번째, gap은 전환 instant를 고른다. 고정 UTC offset을 쓰지 않는다. timezone 설정이 달라지면 daily 예약을 last_run_at 또는 created_at 기준으로 다시 계산한다. 현재 시간대는 공통 `readTimeZone()` 하나이므로 사용자별/예약별 독립 zone으로 이미 완성된 상태는 아니다(`packages/core/src/local-time.ts:24,49,57`; tick:18~33).
- **발화 중복 방지:** schedule의 expectedNextRunAt을 조건으로 CAS update하고 `ensureWork`를 같은 write transaction 안에서 실행한다. 동일 미완료 work의 `(kind,target_kind,target_id)`는 재사용하며 성공 날짜는 `(schedule_id,local_date)` PK다. daily 예약 자체는 `(kind,target_kind,target_id)` 부분 UNIQUE라 같은 대상을 서로 다른 시간으로 두 개 만들 수도 없다. 수동 run은 next_run_at을 전진시키지 않는다(M0009:8,24; `packages/postgres/src/schedules.ts:125`; `packages/postgres/src/work.ts:122`; core schedules:21~34).
- **보장의 범위:** 이는 queue 생성/성공 날짜 기록의 중복 억제이며 외부 API 부수효과의 exactly-once 보장이 아니다. 실패·재시도와 외부 전송 중복은 별도 의미키/attempt fencing으로 처리한다(ARCH:510,537).

### 제안: 최소 변경

`trigger`를 `once(at)` / `interval(seconds)` / `calendar(local_time,timezone,weekdays?)`로 명시하고 DB shape·Store·CLI·SDK·manifest를 함께 확장한다. 기존 daily는 weekdays 전부로 호환하고 금요일만 선택할 수 있게 한다. cron은 실제 요구가 생길 때 별도 도입한다. 시간대는 사용자 기본을 설치 시 해석하되 예약의 zone/사용자 변경 정책을 명시한다. 안정적인 `(installation_id,schedule_key,user_id)`를 예약 멱등 키로 삼아 같은 job의 다른 시간 예약도 허용한다.

누락 정책은 최소 `coalesce`(일감 하나에 누락 occurrence 목록/범위)·`latest`·`skip`을 선언하게 하되 job 완료와 발화 회계를 분리한다. 주간 누락을 현재 “연속 날짜 범위 전체 성공 처리”에 그대로 넣으면 예약하지 않은 요일까지 포함하므로, 주간 occurrence ID/날짜 목록을 따로 기록하거나 실제 예약일만 성공 처리해야 한다. 기존 CAS·hold·fence를 유지한다. 규모 추정: 예약 모양 공개+주간+회귀 **중(3~6인일)**, 사용자별 신원까지는 Q4 별도. 근거는 현재 shape·날짜 회계의 제한(M0009, tick:48, work.ts:879)이다.

## Q2. 플러그인·설치·migration의 경계

### (a) 한 레포에서 core와 Garmin 플러그인 둘

**확인된 구조:** `.claude-plugin/marketplace.json:6`은 `plugins` 배열이며 현재 한 항목 `second-brain → ./plugin`만 있다. `plugin/.claude-plugin/plugin.json:2`의 배포 이름/버전은 core 플러그인이고 `plugin/app-ref:1`은 `e33a78718d6fefda38312c98f2ca2428b9bf0b97`이다. `plugin/bin/session-start.sh:127~158`은 이 SHA를 읽어 bootstrap에 전달하고 `plugin/bootstrap.mjs:18,396~455`는 cache 밖 `<home>/app` clone을 해당 ref로 설치한다. `plugin/skills/install/SKILL.md:10~16`은 이미 설치된 brain의 ext 명령으로 확장 설치 단계를 이어간다.

**제안/추론:** 같은 marketplace에 `second-brain-garmin → ./plugins/garmin` 항목과 별도 plugin.json/skills/hook/패키지 ref를 추가할 수 있다. 두 플러그인에 각각 전체 brain bootstrap을 복제하지 말고 core 준비 확인→Garmin package 등록→기존 `ext install`을 호출하는 얇은 진입점으로 만든다. core 없을 때 core 설치 안내/이어가기, core와 확장 호환 버전, 제거 시 “agent skill 제거”와 “DB 확장 disable/데이터 보존”의 차이를 명시해야 한다.

그러나 **현재 CLI로 `brain ext install garmin`만 호출해서 임의 플러그인 cache에 들어 있는 Garmin 패키지를 설치할 수는 없다.** `apps/cli/src/runtime/extensions.ts:166~174`의 resolver는 배포 앱의 `extensions/<name>`와 제한된 시험 폴더만 찾는다. `--package <folder>` 또는 검증된 package source 등록을 추가하고 symlink/경로·digest 검사, 설치 lock, 원자적 복사, 기존 reports/staging/tokenstore 보존을 이어 써야 한다(:136~218). 별도 plugin ref/version은 core app-ref와 분리한다. 기존 app-ref를 바꾸면 AGENTS 규칙대로 이전 SHA를 가리키고 plugin version도 같은 commit에서 올린다.

이 결론은 **레포 구성 가능성**에 대한 추론이다. 현 checkout의 marketplace/SessionStart는 Claude Code용이며, “각 에이전트 `/plugin`”이 동일 포맷/동작을 가진다고 검증하지 않았다. 지원 호스트별 adapter·설치/discovery 시험이 신규 작업이다. 13.10의 실제 Claude discovery도 blocked 증거가 남아 있다(`.../epic-extensions/tickets/story-mac-install-plan.md:84,153`).

### (b) 지금의 DDL 소유와 core 결합

**확인된 적용 경로:** `extensions/garmin/manifest.json`의 `migrations`는 `migrations`다. DDL은 `extensions/garmin/migrations/0001_tracer.sql`~`0012_analysis_reads.sql`이다. core installer가 role/schema provision 후 `runtime.migrator.apply(name, installedDir/manifest.migrations)`를 호출한다(`packages/core/src/extensions/install.ts:160~169`). runtime은 admin 연결로 `runMigrations({owners:[{owner,directory}]})`를 호출한다(`apps/cli/src/runtime/extensions.ts:225~242`).

AD-31(ARCH:478~486)대로 owner별 연속 번호와 한 ledger `brain.schema_migrations`를 쓴다. `packages/postgres/src/migrate.ts:23~38,48~78`은 파일 순번·checksum·기적용 이력을 검증하고 `brain_owner` 아래 파일별 transaction/advisory lock으로 실행한다. 확장 번호 0012와 core 번호 0030은 같은 전역 열이 아니다.

| 현재 소유 | 주요 내용 | 새 모델에서 처리 |
|---|---|---|
| Garmin 0001~0005 | datasets/raw/import mapping, source schema·preserved rows/checkpoint, artifact/input inventory, namespace | 보존 reader·raw·provenance 기반 유지, PG native 표로 연결 |
| Garmin 0006~0011 | collect state/run/meta/targets, normalize ledger·day publication, body와 collect snapshot, notice | 데이터/상태 기능 유지. health 발행 대신 Garmin 표에 쓰도록 변경 |
| Garmin 0012 | `body_records`, `collect_target_accounts`를 **brain_app에게 공개** | core 분석 adapter 제거 후 필요성 재판정. 확장 API로 대체 가능 |
| core 0022 | health_observations, 초기 current view, analyses, file_requests와 공통 attempt/불변 trigger | 건강·분석 부분 동결. 파일 요청은 core 유지. 한 파일을 통째 삭제하면 안 됨 |
| core 0023 | Garmin 표/열 mapping을 담은 health catalog, 지원 버전, authority·resolution·aggregate | Garmin 의미를 core migration에 묶음. 제거/확장 이전 후보 |
| core 0024~0026 | health authority fencing, 원문 인코딩 보존과 reconciliation, JSON/text 비교·resolution | 건강 전용은 동결; 0025에는 채널 원문 보존도 있으므로 분리 판단 |
| core 0027 | legacy analyses의 상세 칸·analysis_artifacts 및 관련 계약 | 이관/일반 문서 참조로 축소. legacy 원본은 삭제 금지 |
| core 0028 | file_requests metadata, attempt result_summary/previous_result, followup 및 predecessor 함수 | 공통 계약은 유지 |
| core 0029~0030 | core analysis_snapshots·analyses 확장·analysis_files, collect/artifacts 입력쌍 unique | 18.1/18.2 전용 경로 동결/이관 대상 |
| 미커밋 core 0031 | resolution view 재작성·lookup 인덱스·identity별 함수 | 보존하되 새 설계 선행에서 제외. 적용 여부 별도 확인 후 처분 |

표의 근거는 각 migration 시작 행, Garmin 0002:1~15·0008:1~18·0012:1~7, core 0022:1~78·0023:1~4,79~92·0025:2~43·0027:2~11·0028:4~22·0029:1~43·0030:1~6·0031:1,34~36이다.

**추가 사실:** core migration 기본 owner는 core 하나이고 모든 core SQL을 적용하므로 Garmin을 설치하지 않아도 core 건강 DDL이 생기는 구조다(`packages/postgres/src/migrate.ts:16,23`). 미커밋 트리의 CORE_SCHEMA_VERSION은 이미 31로 바뀌어 있다(:7). 새 플러그인 분리만으로 이 결합이 해소되지는 않는다.

**판정:** 공통 file/channel 요청·attempt 함수 의존은 확장→core의 정상 경계다. 반대로 core가 Garmin 지표 catalog와 판정/입력 조립을 소유하는 것은 사용자가 원하는 “core는 실행·감독만”과 충돌한다. 결정적 근거는 `packages/postgres/src/analysis-inputs.ts:35~53`의 `garmin.*` JOIN·kind 필터와 `packages/core/src/analysis/day.ts:22`의 `$garmin-daily-analysis`다. schema 이름만 나누는 것으로 독립성이 생기지 않는다. provisioning 역시 건강/분석 컬럼을 하드코딩하므로 해당 경로를 함께 정리해야 한다(`packages/postgres/src/extension-provision.ts:32~50,79~102`).

### (c) 별도 레포면 migration script가 필요한가

**추천: 별도 실행기는 만들지 않는다.** 확장 레포가 소유하는 SQL과 core installer의 공통 실행기를 그대로 쓴다. 별도 레포에서 필요한 것은 package를 고정 ref/digest로 배달하는 resolver/bootstrap과 manifest의 호환성 계약이다. DB 권한·ledger·lock을 두 개로 나누면 AD-31이 막으려던 충돌이 다시 생긴다(ARCH:481~486; migrate.ts:23~78).

기적용 migration은 그대로 보관한다. 현재 실행기는 과거 파일 부재/이름·checksum 차이를 거부하므로 소스 SQL을 옮겨 old core 파일을 지우거나 번호를 다시 매기면 업그레이드가 실패한다(migrate.ts:50~57). 기존 owner 이력은 보존하고 **새 번호의 forward migration**으로 Garmin native 표 생성·copy·관계 mapping·권한 변경을 수행한다. 별도 레포에서도 Garmin owner/기존 0001~0012 파일의 정확한 이력을 이어간다. 최종 core 전용 배포에서 old 건강 DDL까지 물리적으로 빼고 싶으면 신규 설치 baseline과 기존 ledger 업그레이드 호환 정책을 별도 설계해야 하며 이번 전환 초기에 같이 하지 않는다.

## Q3. 버릴 것·남길 것과 옛 프로그램 재사용

### 가장 중요한 사실: epic 16은 Garmin native 정규화 표를 만들지 않는다

`extensions/garmin/src/normalize_store.py:17~24`의 table 이름은 **메모리 row/논리 key 정의**다. `observations():57~84`가 각 열을 metric observation으로 바꾸고 `_insert():101~108`은 `brain.health_observations`에 INSERT한다. `publish_day():248~270`도 이것을 호출한 뒤 `garmin.normalize_days`에 완료 상태만 기록한다. `normalize_runtime.py:15~16`은 catalog까지 core에서 읽는다. Garmin 0008·0009 migration에는 normalize 상태/dirty/revision 표만 있다.

이전 데이터는 `batch_import.py:227~252`가 `garmin.preserved_rows(values_json)`와 import_mapping에 보존하고 :280이 core 건강 표로 변환한다. 옛 `evaluation`은 `extensions/garmin/src/analyses.py:65~75,131~147`가 `brain.analyses`와 파일 요청/관계로 옮긴다. **보존된 옛 행이 있다는 것과 `SELECT * FROM garmin.day_summary/evaluation`이 가능하다는 것은 다르다.** 후자의 native DDL/작성 경로는 없다.

### 산출물별 처분 제안

규모는 분석만의 **추정**이다. 소=1~2인일, 중=3~6인일, 대=1~2주 이상(구현+회귀, 실제 운영 인수 제외). 행마다 독립 합산하면 중복 작업이 있으므로 총기간으로 더하지 않는다.

| 대상 | 분류 | 남길 이유 / 바꿀 것 | 데이터·migration 영향 / 규모 |
|---|---|---|---|
| epic 12 감독자·ABI·lease/attempt·취소·dependency·직렬화·hold | 그대로 사용 | Garmin 분석도 manifest job으로 실행. scope 의존은 확장 orchestration에서 표현 가능 | user ownership/weekly 추가만 공통 확장. 기존 work/audit 유지 / 중 |
| epic 13 manifest·Python env·role·단계 재개·install/disable | 수정해 사용 | 패키지 공급원·예약 shape·query 선언·설치별 소유권 추가 | registry는 package 설치와 사용자 enable/account를 분리. 신규 forward DDL / 중~대 |
| epic 14 capture/read-only reader·hash·checkpoint·보존 원문·충돌·verify | 수정해 사용 | 손실 방지/재개는 유효. health/analysis 목적지 비교를 Garmin native로 변경 | preserved_rows/raw/파일 관계를 이관 근거로 보존. 동일 source-key→새 PK mapping, 이관 검증 필요 / 대 |
| epic 14의 core 건강 의미/authority 전용 계약 | 동결 → 제거 후보 | 독립 Garmin이 스스로 가지는 의미로 이동 | 기존 health 행을 즉시 삭제하지 않음. 선택 데이터셋/계정/버전·원문 메타 이전 뒤 reader 제거 / 대 |
| epic 15 채널 요청·묶음·retry·unknown·resend·legacy audit | 그대로 사용(사용자 지원은 수정) | 사용자가 무조건 core 발신을 요구. Garmin이 Telegram SDK를 직접 쓰지 않게 유지 | channel/대화/요청 소유권 추가, 기존 sent 의미·legacy 비발신 유지 / 중 |
| epic 16 인증/호출 보호·수집·raw·재개 | 수정해 사용 | 이미 옛 보호 규칙 이식. 계정/소유자 문맥·native 정규화 writer 연결 | raw/import/collect provenance 보존. dataset/계정 키에 사용자 경계 / 중 |
| epic 16 normalize/digest/labels/charts 순수 계산·body·file publish | 수정해 사용 | 계산·PNG·실패 격리는 재사용 가치 큼 | core catalog/health writer를 Garmin native 저장기로 교체; file_requests는 유지 / 대 |
| epic 17 완료 17.2·17.3 대화 chunk/search/read | 그대로 사용 | Garmin 독립성과 무관한 core 기억 검색 | 사용자 필터는 추가 필요 / 소~중 |
| epic 17 미구현 건강 query와 상태·회귀의 건강 부분 | 수정해 사용 | manifest query를 CLI/MCP에 노출하는 공통 틀 + Garmin query provider로 재구성 | core SQL health dependency 제거. 리포트 문서는 core 파일/색인으로 보이게 선택 / 중 |
| 18.1(병합됨) core day tracer/모델 worker | 동결 → 제거 후보 | 모델 schema 검증·정리/파일 확정 아이디어는 참고, Garmin 전용 core 실행은 중단 | analyses/analysis_files와 snapshot 원문은 이관/보존. 전용 kind 투입 중단 후 worker 경로 제거 / 중 |
| 18.2(병합됨) core snapshot/pivot/export/equivalence | 동결 → 수정 재사용 일부 | cutoff·입력 스냅샷·필터 fixture는 Garmin 내부 검증에 유용. core pivot 재구현 계속 안 함 | snapshot 바이트/hash와 predecessor·파일 링크 보존; Garmin report_input PG 포트로 대체 / 중~대 |
| 18.10 미커밋 0031·imports/analysis-inputs 수정·health-perf·시험 | 동결(현 checkout 그대로) | 옛 판정 경로의 성능 개선. 새 Garmin native 경로의 필수 조건 아님 | 현재 diff에 손대지 않았음. 미적용이면 배포 제외, 적용됐으면 forward 처리. 일부 파일 통째 revert 금지 / 새 설계 필수 작업 0 |
| brain.health_observations·catalog·authority·resolution/current view | 동결 → 제거 후보 | Garmin 의미를 core 계약으로 강제할 필요 없음 | 기존 데이터와 FK/검증 이력 보존; 새 Garmin 표 확인 뒤 소비 경로→권한→DDL 순서 정리 / 대 |
| brain.health_aggregate_v1 | 제거 후보(먼저 사용 중단) | source/activity만 받으며 user/account/date 범위도 없다. 미래 API의 계약으로 부적합 | M0023:80~92. 정적 검색상 정의·grant 외 호출을 확인하지 못함; 외부 사용 여부 미확인. 즉시 DROP 근거 아님 / 소 |
| brain.analyses 및 이전된 옛 분석·analysis_artifacts | 동결 → Garmin evaluation/분석 보관으로 이관 | 분석 결과 의미는 확장 소유. core 검색용 문서/파일 참조는 유지 가능 | scope/date/내용/모델/누락 flag/revision/dataset/원래 key·file_id mapping 모두 유지. core source 분석과 legacy 경로는 따로 검증 / 대 |
| file_requests·handoff/results·FileStore | 그대로 사용(사용자 키 수정) | 확장 파일을 core 파일·발신/검색에 연결하는 공통 계약 | M0022:16~44, M0028:4. hash/size/미완료 바이트 보존·멱등은 계속 사용 / 소~중 |

핵심 근거: T12:5~142, T13:5~118, T14:5~94, T15:5~82, T16:5~106, T17:5~82; 분석 구현 commit `1a97200`(18.1), `8f63563`(18.2), normalize `149c3e0` 및 후속 `d161259`. 구체 구현은 Q1·Q2의 경로와 위 normalize/analyses 파일을 따른다. 18.10 파일 목록은 이번 조사 시작의 `git status --short`로 확인했고 수행 성공/성능을 판정하지 않았다.

### 옛 report/report_input가 garmin schema에서 돌기 위해 빠진 것

**확인된 입력/출력:** OLD `report_input.py:101~218`은 run, raw_response, activity에서 cutoff/완료 운동을 읽고, :383~403은 evaluation, :419~485는 day_summary/workout/exercise_log 및 월별 집계를 읽는다. OLD `store/migrations/0016_day_values_evaluation.sql:1~31`에 해당 native 표가 있다. OLD `report.py:793~896`은 저장된 scope를 확인하며 이어 돌고 :1030~1045는 evaluation UPSERT다. 단순히 connect 함수만 psycopg로 바꾸어서는 돌아가지 않는다.

1. **native PG DDL/저장기:** garmin.raw_response 호환 view/table, run·activity·daily_metric·sample/exercise_set·day_summary·workout·exercise_log·evaluation을 준비한다. 기존 raw_payloads/collect_runs와 호환 view를 쓸지 실제 native 표를 둘지는 표별 선택한다. dataset/user/account 및 revision을 새 키에 넣되 옛 쿼리는 계정별 store/session wrapper가 한 문맥만 보도록 한다. 과거 다중 dataset 충돌은 명시적 선택 기록을 보존한다.
2. **SQL/driver 어댑터:** `?`→`%s`, Connection.execute/cursor/row factory, sqlite3 예외, PRAGMA table_info/user_version/WAL/읽기 전용 URI, 타입·date·숫자 반환 차이를 바꾼다. 월 집계는 고정 column 목록/PG metadata로 바꾸고 읽기 snapshot은 REPEATABLE READ로 명시한다(OLD store `__init__.py:135~170,442~456`; report_input:417,460~484). SQLite의 BEGIN read snapshot을 PG 기본 READ COMMITTED로 옮기면 같은 의미가 아니다.
3. **계산 재사용:** 기존 normalize/digest/charts의 순수 함수와 필터를 유지한다. 현재 `normalize_runtime.py:41~62`가 생성하는 row를 native 표에 저장하면 다시 EAV→pivot을 구현할 이유가 줄어든다. report_input의 JSON 파일/날짜·운동 cutoff·선행 선택 fixture를 Garmin 패키지 안에서 비교한다. 18.2의 “새 core snapshot이 옛 형식과 같아야 함”을 “PG 어댑터로 옛 report_input 의미가 보존됨”으로 바꾼다.
4. **분석·scope 재개:** 옛 evaluation은 `(report_date,scope)` 한 행을 UPSERT한다. 현재 시스템의 평가 비삭제/revision 보존까지 유지하려면 append-only evaluation_revisions + 최신 view/UPSERT adapter를 둔다. 옛 덮어쓰기 동작을 무심코 복원하면 이전 분석을 잃는다. 확장 내부 scope 순서·저장 직후 다음 scope 실행을 재사용하며 core에는 전체 supervised job 또는 범용 child-work 요청만 보인다(OLD report.py:810,849,875~896,1030; ARCH:535).
5. **통합 경계:** Config facade는 core snapshot의 `garmin.*`만 읽는다. 옛 자체 cron/launchd·Telegram sink는 제거/비활성화하고 manifest schedule 및 core channel/file request adapter를 쓴다. 기존 `ReportSink`를 core 요청을 만드는 구현으로 대체하면 report 조립은 유지할 수 있다(OLD report.py:781; 현재 `runtime_files.py:17~57`; T16:77). Slack은 같은 core channel port에 adapter를 추가하는 별도 작업이며 현재 Telegram 구현이 Slack까지 지원한다는 증거는 없다(`apps/cli/src/workers/channel-send.ts:4,23`).
6. **process 책임:** 옛 writer가 model subprocess를 직접 띄우더라도 core 감독자가 손자까지 종료/reap하도록 ABI/프로세스 그룹 경계를 맞춘다. 오래 실행되는 model 동안 PG transaction을 열어 두지 않는다. attempt가 무효가 된 뒤 evaluation/발신 요청이 쓰이지 않게 Garmin 자체 표에도 fence가 필요하다(OLD report.py:200~233,366~409; 현재 `collect_store._write` 사용 예 normalize_store:128~140).

**이관 추천:** 원본→preserved/raw→native 표 재구성, legacy analyses→evaluation history, 파일 요청·file_id 관계 매핑 순서로 만들고 값/원문 hash·행/자연키·scope/선행 관계를 비교한다. 기존 health EAV만 역변환하면 삭제/정규화 전 원문·NULL/미선택 provenance를 잃을 수 있으므로 raw·preserved·기존 analyses를 우선 근거로 삼는다. 새 표/독립 API 검증 뒤 읽기 경로를 전환하고 옛 표는 보존 기간/백업 정책을 별도 결정한 뒤 정리한다. 전체 PG 저장·분석 포팅은 **대**, 단순 DB 접속 변경 규모로 산정하면 안 된다.

## Q4. 여러 사용자: 현재 상태와 최소 설계

### 사실: 계정 구분은 사용자 권한 구분이 아니다

| 영역 | 현재 구분 | 빠진 사용자 경계와 근거 |
|---|---|---|
| users·sessions | users UUID, sessions.user_id; `is_self=1`은 DB 전체 유일 | 사용자 신원 인증/실행 문맥과 동일하지 않음. M0001:11~17,34~54,222; `packages/postgres/src/users.ts:113~116` |
| schedules·성공 기록 | schedule ID·kind/target; timezone 있음 | user_id 없음, daily UNIQUE가 전역. M0001:351~363, M0009:8~28 |
| work_items/직렬화/hold | 대상 문자열·kind·serialization_key·extension hold group | user_id 없음. 같은 target default가 사용자 사이에서 합쳐질 수 있음. M0001:132~149; work.ts:122~124; `core/queue/schedules.ts:55` |
| settings | key 하나 PK | garmin.*·timezone·analysis.*가 DB 공통 값. M0001:364~368; ARCH:320 |
| channels/conversations/requests | channel·외부 대화/스레드 ID·semantic key | user_id/대화 접근 멤버십 없음. M0017:1~9 |
| 건강/분석 | source·account·dataset(health), legacy dataset/원래 key 및 snapshot(analyses) | account와 brain.users 사이 FK 없음. analyses 자체에는 account도 없음. M0022:2~26, M0029:1~16 |
| Garmin raw/정규화/collect | datasets(account), raw dataset/account, collect targets 및 normalize dataset | Brain 소유자 없음. 동일 외부 계정 공유/이전 주체 불명. Garmin 0001:1~5,0007:22~26,0008:2~17 |
| extension registry/role/설치 | 확장 이름 단위 DB role·schema·default target | `brain_ext_garmin`이 모든 garmin 표에 전권. 사용자별 auth/tokenstore 격리 아님. `extension-provision.ts:7,63~72`; runtime/extensions.ts:133; manifest 기본 target `default` |

채널 런타임 역시 현재 환경 변수의 bot token/chat ID 한 쌍과 conversation.externalRef 일치를 검사하므로, 여러 대화 행을 저장할 수 있다는 사실만으로 사용자별 Telegram 발신이 동작하지 않는다(`apps/cli/src/workers/channel-send.ts:22~26`). 사용자/connection별 core credential 및 routing resolver가 필요하다.

현재 RLS는 role→출처 결합이고 brain_app 정책은 `using(true)`인 부분도 있다(M0022:62~64, M0029:5~6). 여러 계정 데이터가 공존한다는 것만으로 여러 사용자가 안전하게 조회/실행할 수 있다고 판단하면 안 된다.

### 제안: 최소한의 일관된 사용자 문맥

- **안정된 Brain user_id와 연결 신원:** CLI/MCP/daemon에 user context를 명시한다. 로컬 한 사용자 기본은 machine 설정의 기본 user ID로 호환하고 다중 사용자 접속에는 인증 principal→user_id 매핑을 둔다. `is_self`는 DB 전역 사용자 선택 기준에서 물러나 기계/접속 문맥의 “나”로 옮긴다. 사용자 ID를 입력 인자만 바꿔 남의 데이터에 접근할 수 없어야 한다.
- **settings:** `(user_id,key)`를 PK로 하고 machine/global defaults는 별도 scope로 둔다. 확장 계정을 여러 개 연결할 수 있으므로 계정별 값은 `(user_id,extension,account_connection_id,key)` override로 분리한다. 키 이름은 계속 `garmin.*`다. timezone/알림 대화/model 설정도 user별로 읽는다. 비밀은 core secret reference를 반환하고 tokenstore는 사용자/connection별 private 디렉터리로 나눈다.
- **예약·작업:** schedules/work_items에 user_id, extension_instance/account_connection_id를 넣고 claim·일감 생성·후속 의존·성공 기록까지 유지한다. 업무 멱등 키는 user 포함, 직렬화는 실제 외부 계정 credential 보호 의미에 맞춰 connection별로 정한다(같은 외부 계정을 의도적으로 공유하면 계정 단위 잠금도 필요). 전체 package disable과 사용자 instance disable을 분리한다. 설치 기본 예약은 각 instance마다 같은 stable schedule_key로 생성한다.
- **채널:** channel은 bot/adapter credential의 기술 단위로 두고 channel_conversations에 owner user_id 또는 명시 membership을 둔다. Garmin instance→conversation의 사용자별 routing을 core 설정/관계로 둔다. channel request의 owner는 work에서 유도하고 대화 소유/멤버십과 일치해야 한다. ID만 아는 다른 사용자의 대화로 발신할 수 없게 DB/API에서 검증한다. semantic key에도 user/producer instance가 포함돼야 한다.
- **Garmin:** `garmin.account_connections(id,user_id,external_account_identity,secret_ref,timezone,...)`와 dataset 연결을 만든다. native 표는 user_id/connection_id를 통해 소유권을 명확히 한다. evaluation/snapshot/file mapping도 같은 context를 갖고 day/scope 단독 uniqueness를 피한다. 동일 외부 계정 문자열을 서로 다른 사용자의 권한으로 자동 합치지 않는다.
- **파일·검색:** file_requests·파일 metadata/문서 색인에도 소유권을 연결한다. user_id 있는 schedule만 고쳐 놓고 파일/리포트 search가 전역이면 사용자 지원이 완성되지 않는다. 동일 content hash blob을 공유하더라도 metadata/열람 권한은 분리한다. sessions의 기존 user_id도 검색 필터까지 일관되게 적용한다.

### DB에서 권한을 어떻게 묶을 것인가

**최소 추천:** 설치자 `brain_owner`는 DDL만, runtime은 비소유자/NOBYPASSRLS를 유지한다. 사용자별 runtime principal 및 확장 실행 principal을 user/extension instance에 서버 관리 매핑으로 결합하고, 모든 사용자 표에서 RLS·쓰기 trigger가 work 소유자/attempt와 함께 확인한다. 확장 runtime에 DDL/타 사용자 표 전권을 주지 않는다. 지금 `grant all ... garmin` 정책은 multi-user 전환 때 분리해야 한다.

단일 신뢰 daemon이 전 사용자 데이터를 처리하는 배치 계정은 별도로 둘 수 있다. 다만 사용자 요청의 claim 결과에서 확정된 user_id를 전달하고, DB 함수는 `work_id+token+caller role`이 그 사용자 작업인지 검증해야 한다. **확장에게 `SET app.user_id` 권한을 주고 그것만 믿는 정책은 사용자 격리가 아니다.** role/권한을 더 간단히 유지하려면 shared extension DB 자격증명 대신 core data gateway를 택할 수 있지만, 그것은 “확장 직접 PG 접근”보다 큰 실행 모델 변경이다.

이 설계는 제안이며 현재 코드로 검증된 기능이 아니다. 규모는 **대(공통 소유권/인증·RLS·설치/발신·검색 전반)**다. 첫 이행은 기존 self 사용자를 owner로 backfill하되, 출처 미확인 dataset을 임의 귀속하지 않고 blocked/quarantine으로 남긴다. 기존 14.8의 strict 계정 확인 원칙도 유지한다(`.../epic-garmin-import/tickets/story-mac-garmin-capture-a-plan.md:77,134`).

## Q5. 티켓 재정리 제안과 의존 순서

**여기서는 제안만 한다.** TOML/plan/status를 바꾸지 않았다. done/built 기록을 새 요구로 소급 실패 처리하지 않으며, 이미 dropped된 항목을 부활시키지 않는다. 아래 신규 N 번호는 설명용이며 실제 티켓 ID가 아니다.

### 새 최소 작업 묶음

| 새 항목 | 범위/완료 기준 요지 | 선행 |
|---|---|---|
| N0 경계·이행 결정 | AD-29/30/32/35와 소유권·평가 revision·호환 기간을 문서로 확정. 기존 migration 적용 상태는 운영자가 허용한 별도 단계에서 확인 | 없음 |
| N1 사용자 문맥과 권한 | 사용자 principal→DB 소유권, work/settings/schedule·파일·채널 경계, Garmin connection 모델. 다른 사용자 조회/발신/실행 차단을 검증 | N0 |
| N2 독립 package와 `/plugin` | core/garmin 두 배포 항목, package resolver·고정 ref/digest·호환성·멱등 설치·갱신 보존. 호스트별 discovery와 uninstall/disable 의미 | N0; 사용자 instance 등록은 N1 |
| N3 예약 계약 확장 | once/interval 공개·calendar weekdays·누락 정책·instance stable key. 기존 DST/CAS/성공 회계 보존 | N0,N1 |
| N4 Garmin PG native 저장/이관 | 옛 표 호환·정규화 writer·read snapshot·legacy evaluation revision/파일 mapping·계정 gate 검증. health core에 새 데이터 넣지 않음 | N0,N1,N2 |
| N5 옛 분석 재사용 | report/report_input PG adapter·네 scope·재개·모델/체성분 설정. 순수 계산·옛 fixture 의미 보존. Garmin manifest job으로만 실행 | N4, 공통 ABI(완료 12) |
| N6 확장 query 계약 | manifest input/output schema·read-only query handler·user context·시간/행/바이트 제한·CLI/MCP guide·출력 코덱. Garmin query 제공 | N0,N1,N2; Garmin provider는 N4 |
| N7 채널/예약 통합·인수 | core 파일·요약/앨범/전문/실패 요청, instance routing, 수집 후 분석·최신 누락 정책, 실제 설치본 전환/옛 예약 해제 | N3,N4,N5; 전환은 N2,N6 및 운영 계정 확인 |
| N8 옛 core 경로 퇴역 | 사용 중단/이관 증거 후 health 분석 worker·PG direct read 제거, 권한/DDL forward 정리. old migration checksum/데이터 보존 | N4,N5,N6,N7 인수 |

N1은 다중 사용자 보안을 완성해 가는 공통 선행이다. “이번에는 한 사용자만”으로 출시하더라도 새 키에는 user/connection 소유권을 처음부터 넣고 shared DB 다중 사용자 사용은 권한 검증이 완료된 뒤 열어야 한다. N2와 N3의 사용자 비의존 부분은 N1과 독립 작업 가능하다.

### epic 12~17의 남은 entry 각각

완료 근거: epic 12 `tickets/*plan.md`는 1~12 모두 done. 13.1~8·14.1~6·15.1~5 및 17.2~3은 done, 16.2~7은 built(16.1 done). 이 완료 산출물은 Q3 처분을 따르며 새 delta ticket으로 바꾼다.

| entry | 제안 | 이유 / 새 의존 |
|---|---|---|
| 12 | 미완료 entry 없음; N3 신규 | 기존 daily runtime를 다시 구현하지 않음. T12:89~95와 Q1 |
| 13.10 blocked | **수정 유지** | 두 플러그인/외부 package/호스트별 discovery 인수로 재작성. 기존 외부 전송 승인 차단을 해결한 척하지 않음. N1,N2 뒤. plan `story-mac-install-plan.md:6,84,153`; T13:112~118 |
| 14.8 blocked | **수정 유지** | 새 capture·strict 계정 gate 유지, 반입 목적지를 native PG+evaluation/파일 mapping으로 변경. N4 뒤, N7 실수집 전. plan `story-mac-garmin-capture-a-plan.md:6,77,134`; T14:88~94 |
| 15.7 blocked | **유지+소유권 인수 보강** | 실제 Telegram 발신 증거 필요는 그대로. N1 대화 routing 뒤 또는 독립 단일 사용자 probe로 명시 축소. 토큰/chat 설정 미완료를 티켓 완료로 바꾸지 않음. plan `story-mac-plan.md:6,26`; T15:76~82 |
| 16.9 blocked | **수정 유지** | 옛 예약 해제·한 번 수집 인수는 유효. “core 권위 v2” 선행을 새 native 이관/connection 인수로 바꿈. N2,N3,N4,14.8 뒤. plan `story-mac-garmin-plan.md:6,35,191`; T16:100~106 |
| 17.1 | **수정 유지** | 리포트 검색·원문은 core 일반 문서/파일 검색으로 구현; core analyses 필수 의존을 제거. 완료 17.3 + N4 파일 mapping/N6 리포트 API 뒤. T17:29~35 |
| 17.4 | **수정 유지** | `brain health query` core SQL 계약 대신 manifest query의 Garmin provider. 지표/NULL/단위는 Garmin이 소유. N6,N4 뒤. T17:41~47 |
| 17.5 | **수정 유지** | 미설치/비활성/0건/오류·recall skill 유지, 건강 fixture/계획은 provider 소유로 이동. 17.1·17.4,N2,N6 뒤. T17:53~59 |
| 17.7 | **수정 유지** | 실제 질문 검색 성공 기준 유지하되 Garmin 숫자는 provider API. 17.1·17.4·17.5 및 native 이관 뒤. T17:76~82 |
| 기존 sweep 13.9·14.7·15.6·16.8·17.6 | **기존 dropped 유지** | 해당 `story-refactor-sweep-plan.md:4`의 frontmatter에서 dropped. 새 경계 정리는 N8로 구체 범위를 정함 |

### epic 18의 entry 각각

근거는 T18에 적힌 title/after 및 18.1 plan `story-tracer-snapshot-day-core-fake-analyses-plan.md:6`, 18.2 plan `story-snapshot-fixture-snapshot-export-report-input-plan.md:6,33~39`, 18.10 미커밋 plan `story-snapshot-plan.md:6`이다.

| entry | 제안 | 이유 / 새 의존 |
|---|---|---|
| 18.1 built·병합 | **완료 이력 유지, 구현 동결** | core day tracer를 더 확장하지 않음. 검증 schema/프로세스 원칙은 N5가 참조. N8이 전용 경로 퇴역 |
| 18.2 built·병합 | **완료 이력 유지, 구현 동결** | core 재구성 oracle를 제품 설계로 계속 키우지 않음. Garmin PG port fixture로 일부 이전(N4,N5). T18:17~23 |
| 18.10 in-progress·미커밋 | **dropped 제안, 미커밋 작업 별도 보존** | core 판정 성능을 새 native 분석의 선행으로 삼지 않음. 실제 변경을 지우거나 built로 오인하지 말고 checkpoint/patch 보존 후 소유자가 채택 여부 결정. 기존 경로를 오래 병행 운영할 경우에만 축소된 호환 성능 티켓을 별도 유지. T18:29~35 |
| 18.3 | **수정(확장 분석 이식 N5로 대체)** | day→7d→30d→all과 scope별 즉시 저장·재개는 유효. core graph 구현 대신 옛 report 흐름/확장 내부 orchestrator. N4→N5; 18.10/19 전체 gate 삭제. T18:42~48 |
| 18.4 | **수정(확장 모델 실행)** | core에 Garmin schema/프롬프트를 두지 않음. Codex·Claude 선택은 Garmin 설정; 범용 process runner만 공유 가능. N5, 공통 supervisor 뒤. T18:55~61 |
| 18.5 | **수정(확장 body intake)** | 이미지 intake 결과는 garmin body/native storage로. core는 파일·감독만. N4,N5, 공통 FileStore 뒤. T18:67~73 |
| 18.6 | **수정 유지** | 채널 통합 N7로 이동. 발신 실패가 평가를 지우지 않는 의미 유지. 확장 평가 성공+완료 파일→core bundle 요청. N5,15.4(완료),N1 routing 뒤. T18:79~85 |
| 18.7 | **수정 유지** | manifest 분석 예약·수집 완료 gate·최신 누락 날짜 정책을 N3/N7로 표현. core가 Garmin collect kind를 직접 알지 않음. N3,N5,N7 발신 뒤. T18:91~97 |
| 18.8 | **기존 dropped 유지** | 포괄 sweep 대신 N8 사용. T18:103~109 및 dropped plan |
| 18.9 | **수정 유지** | 최종 실계정 분석·옛 예약 해제는 필요. 새 package·native 이관/분석·채널·query 인수와 운영 인증 뒤. N7 최종 단계. T18:114~120 |

epic 18의 이름/Outcome을 “Garmin 확장 분석 재사용·전환”으로 바꾸고, built 18.1/18.2는 역사로 보존한다. 새 작업의 ID/범위를 명확히 하려면 기존 미완료 entry를 dropped 후 N5/N7 티켓으로 새로 만드는 방식도 가능하지만, **같은 ID에 기존 수락 기준과 새 기준을 혼합하지 않는 것**이 우선이다.

### epic 19의 남은 entry 각각

현재 T19에는 **5,6,1,2,3,7,10,8,9의 9개 entry**가 있고 19.4는 없다. 18.10 의존은 T19:11, 18.3의 시험 선행 묶음은 T18:48과 ROOT:93에 있다. 이 조사에서는 기존 성능 보고서를 새 측정 결과로 재확인하지 않았다.

| entry | 제안 | 이유 / 새 의존 |
|---|---|---|
| 19.5 Python slot 병렬화 | **수정 유지** | 확장 분리 후에도 공통 role/DB 격리 가치 있음. 18.10 after 제거, N0에서 남길 suite 경계 확정 후 착수; slot/template는 새 migration 집합으로 재측정. T19:5~15 |
| 19.6 hook 중복 제거 | **유지** | 두 suite 공통 비용. 기존 19.5 뒤 유지; N2가 hook 배치를 바꾸면 그 최종 배치와 합쳐 범위를 재확인. T19:18~27 |
| 19.1 DB 준비 | **수정 유지** | template/hash/role 격리는 core·native 확장 모두에 필요. 19.5 뒤; migration 자체 시험은 fresh DB 유지. N4 새 DDL에 대해 template invalidation 확인. T19:31~41 |
| 19.2 폰트 cache | **수정 유지(후순위)** | native 재사용 뒤에도 matplotlib/새 home 비용은 있을 수 있음. 19.1과 N4/N5의 chart 경로 확정 뒤 새 기준 측정. 사전 절감량 약속 금지. T19:44~54 |
| 19.3 file registration wait | **수정 유지(후순위)** | file_requests를 유지하므로 유효. N7 publication adapter 확정 +19.2 뒤. 기존 runtime_artifacts 루프를 폐기하면 새 루프에 목표를 적용. T19:57~67; runtime_artifacts.py:48~51 |
| 19.7 import-verify 불안정 | **수정 유지** | 실제 남는 importer/가림/UUID·실패 envelope 원인과 native verify 시험을 대상으로. 19.1,N4 뒤; 옛 health verify 전체를 유지하려고 확장하지 않음. T19:70~80 |
| 19.10 normalize cancel/fence 순서 | **수정 유지** | core supervisor/fence 의미는 그대로 필요. EAV 500행 조건은 native chunk/재개 의미로 수정; barrier 원칙 유지. 19.1,N4 writer 뒤. T19:83~93 |
| 19.8 changed 실행 기록 | **유지, 앞당길 수 있음** | 설계 전환 후 선택/시간을 확인하는 근거. 현재 공유 파일 제약인 19.6 뒤를 유지해도 되며 기능적으로 N4/N5를 막지 않음. T19:96~104 |
| 19.9 선택 범위 좁히기 | **유지(경계 확정 뒤)** | runtime/spawn/SQL 의존을 새 core·Garmin 패키지에 맞춰 감사. 19.8+N2/N4 뒤. assertion·마무리 전체 회귀는 유지. T19:108~118 |

epic 19를 제품 분석의 필수 선행 에픽에서 개발 생산성 독립 에픽으로 바꾼다. 19.5→19.1 같은 내부 의존은 남기되 ROOT의 `19 after 18` 및 `18 after 19` 강결합과 18.3의 7개 시험 티켓 전체 gate는 제거한다. 기존 “order_conflict 승인 예외”는 그 원인이 사라지면 Notes에서도 종료 근거를 남긴다(ROOT:80~93; epic-test-time.md:17,45~48). 실패 재현/필수 회귀를 생략하자는 뜻은 아니다.

### 관련 root entry와 다른 남은 에픽에 미치는 영향

ROOT:48~101의 13/14/16/17/18 의존 설명에서 “core 건강 계약/current view/analyses가 확장의 필수 토대”를 N4/N6의 native/API 계약으로 바꾼다. 12·15는 공통 기반으로 유지하고 19는 독립화한다. ROOT:104~143의 Drive/운영/로그/미러/복제/임베딩 entry 자체는 이 조사 대상 기능을 이유로 삭제하지 않는다. 다만 8·3·4가 기다리는 17의 일반 검색/스킬 계약은 17 건강 provider와 분리해 불필요한 Garmin 분석 대기를 없애고, 5의 backup/restore는 확장 package ref+owner별 schema/사용자 데이터·secret 참조를 포함하도록 보완한다. 이는 각 에픽 전체 재정제 제안이며 본 조사에서 그 모든 하위 entry를 재평가한 것은 아니다.

### 바꿔야 할 아키텍처 결정 문장

| AD / 위치 | 수정 요지 |
|---|---|
| AD-29 ARCH:454~464 | “connector, core 중립 건강 계약”을 “확장은 수집·계산·분석·조회까지 소유하고 core는 manifest 실행·감독/공통 인프라만 제공”으로. 기본 예약에 trigger/user instance, query 선언, 독립 package 설치를 명시 |
| AD-30 ARCH:466~476 | 건강/legacy analyses를 core 필수 INSERT 계약에서 뺀다. 파일·채널 요청/범용 실행 계약은 남긴다. core는 고정 Garmin view를 JOIN하지 않고 manifest query를 호출. schema/role·사용자 권한·attempt fence 결합을 함께 명시 |
| AD-35 ARCH:525~537 | “분석은 core 일감, core 데이터만 읽고 core analyses에 저장”을 “분석은 확장 manifest의 supervised job, 확장 schema에 결과 저장”으로. scope 순서/스냅샷/모델 선택은 Garmin 소유. 발신·파일은 core 계약을 유지 |
| AD-18 ARCH:314~323 | settings의 `(key,value)`를 사용자/instance scope로 확장. garmin.* namespace 유지, secret/tokenstore reference는 사용자 connection별. 기계 값/사용자 설정/비밀 분리 유지 |
| AD-31 ARCH:478~487 | 실행기 하나·owner별 번호·checksum·forward 원칙 유지. 외부 package migrations 배달/호환·기존 이력 보존을 보강. old baseline 운영 PG 없음 진술은 현재 상태 확인 없이 전환 근거로 재사용 금지 |
| AD-32 ARCH:489~497 | core 건강 EAV/authority 규칙을 공통 계약에서 제거하고 Garmin 내부 version/legacy 보존 정책으로 이동. evaluation revision·모호한 dataset 선택 보존은 별도 확장 계약에 남김 |
| AD-19·20 / ARCH:325 이후 | core와 확장 `/plugin` 패키지의 설치/업데이트 ref·호스트 adapter·캐시·제거 의미를 분리. core app clone과 확장 package 공급을 구분 |
| AD-12·25·29·33 관련 | DB 전역 “나”에서 접속 사용자 문맥으로 전환; daemon claim→자식 ABI에 소유권 전달, hold/직렬화의 사용자/connection scope, 손자 process cleanup 책임을 명시 |
| Table Contract ARCH:584~588 및 mappings:743~744 | core 건강/analyses 행의 필수 계약을 폐기/호환 보관으로 표시하고 files/channel/query/확장 소유 표로 대응표 갱신 |

## 조사 한계와 인계

확실한 사실은 정적 소스·SQL·manifest·plan frontmatter·로컬 Git 이력에서 얻었다. 제안은 아직 적용/시험하지 않았다. 실제 DB 내용·migration 적용 여부·계정 귀속·호스트별 `/plugin` 동작·성능 수치는 이번 조사로 확인하지 않았으며 다음 구현 티켓의 검증 항목으로 남는다.

18.10의 기존 미커밋 구현·시험·plan은 그대로 두었다. 이 보고서 외 소스·티켓·계획 변경은 없고 commit/push·자동화 상태 변경도 하지 않았다. 코디네이터는 먼저 N0 경계와 미커밋 18.10의 보존/채택 여부를 사용자와 확정한 뒤 티켓을 재정리하면 된다.
