# Epic 12 코드 조사 — 공통 작업 runtime과 스케줄러

조사일 2026-10-28, 브랜치 `plan/epics-12-on`, HEAD `cc27fff`. 정적 조사만 했다. 테스트·빌드·Docker·네트워크·설치·패키지 추가·Garmin 실행·커밋은 하지 않았다. 아래 시험은 **기존 소스의 검증 범위**이며 통과 실측이 아니다.

인용 약칭(이하 `약칭:행`은 아래 파일의 행):

- **에픽**: `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md`
- **이니셔티브**: `_bmad-output/personal-brain/initiative-personal-brain.md`
- **spine**: `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`
- **PG 계획**: `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml`
- **PG 에픽**: `_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md`
- **Garmin**: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` 내부 `garmin-source/`. `Garmin/src/…:행`은 archive 안 파일의 행이며 저장소의 실행 코드가 아니다. 새 빈 임시 디렉터리에 관련 파일만 풀어 읽었다.

판단의 기준은 R8(독립 작업 병렬·입력 의존·계정 직렬), R9(긴 정상 작업 소유권·사망/오류/정체/취소), R10(설정 시간대 예약과 수동 실행의 같은 계약)이다(이니셔티브:34, :35, :36). 놓친 날짜가 있을 때 한 번, 진행 없는 기본 15분/모델 25분 정체, 토큰·시간 표시와 상한 없음, 확장 끄기 시 진행 취소·대기 보류, 예약 `<ns> <verb>`, ABI v1의 epic 12 소유는 확정 사항이다(에픽:57, :58, :59, :60, :61, :62; 이니셔티브:164). 아래의 저장 구조·스토리 분할은 그 결정을 구현할 **선택지**이며 새 결정을 내리지 않는다.

## 1. 지금의 일감 경로와 epic 11 인계

### 행·청구·재시도

SQLite `work_items`는 `id`, `kind`, `target_kind`, `target_id`, `created_at`, `attempts`, `next_attempt_at`, `claimed_at`, `claim_expires_at`, `claimed_by`, `last_error`, `completed_at`다. 청구 세 칸은 모두 null 또는 모두 값이며, 미완료 `(kind,target_kind,target_id)`에 partial UNIQUE가 있다(`packages/sqlite/migrations/0002_files_and_work.sql:40`, :54, :78). 청구 색인은 0004에서 `(attempts,id,next_attempt_at) WHERE completed_at IS NULL`로 바뀐다(`packages/sqlite/migrations/0004_capture_columns.sql:407`). Core 대응 타입은 `packages/core/src/domain/work-item.ts:29`다.

`addWork`는 열린 대상 행을 재사용하고 완료 뒤에는 새 행을 만든다. `claimCandidateQuery`는 미완료·due·임대 없음/만료·지원 kind 조건, `(attempts,id)` 순서로 하나를 고른다. 청구 쓰기는 짧은 `withWrite` 안에서 attempts +1과 청구 세 칸을 함께 쓴다. 완료/재시도/반환은 `id + claimed_by` CAS로 오래된 소유자를 `lost` 처리한다(`packages/sqlite/src/work.ts:76`, :96, :136, :202, :254). **어긋남:** 현재는 만료 시간만 지나면 살아 있는 긴 작업도 재청구할 수 있다. AD-33의 종료 확인·attempt token DB fencing까지 갖춘 계약은 아니다(spine:504, :507).

| 항목 | 실제 상수·분기 |
|---|---|
| 임대 | 기본 `600_000ms`, kind별 override 표는 비어 있음(`packages/core/src/domain/work-item.ts:111`, :126) |
| 시도 상한 | 청구 때 소비, 최대 10회(`packages/core/src/domain/work-item.ts:59`; `packages/sqlite/src/work.ts:225`) |
| 미분류 오류 | `min(1000 * 2^(attempt-1), 3_600_000)ms`(`packages/core/src/domain/work-item.ts:95`) |
| 일시 오류 | adapter `retryAfter` 우선, 없으면 기본 900초(`packages/core/src/queue/drain.ts:146`, :153; `packages/core/src/domain/work-item.ts:114`) |
| 영구 오류/상한 | 첫 영구 오류 또는 상한에서 failure 기록과 work 닫기를 같은 transaction으로(`packages/core/src/queue/drain.ts:146`, :151, :404) |
| DB 불가/잠금 | 일반 작업 실패와 구분해 release, attempts 반환 후 drain 정지(`packages/core/src/queue/drain.ts:142`, :295) |
| drain 예산 | 명령 30초, 기회적 2초. 진행 중 handler를 끊는 시간이 아님(`packages/core/src/domain/work-item.ts:135`, :147) |

상수 주석에는 지수 대기 8번째가 한 시간이라는 문장이 있지만 실제 수식의 8번째는 128초다. 구현 근거는 수식이며 정제 시 주석 정리 후보다(`packages/core/src/domain/work-item.ts:89`, :95). 10회 상한이므로 기본 재시도의 실제 대기는 한 시간까지 도달하지 않는다(:59, :95).

### verb와 계약

WorkStore 10 verb는 `addWork`, `hasDueWork`, `claimWork`, `completeWork`, `retryWork`, `releaseWork`, `recordFailure`, `listOpenWorkTargets`, `listFailures`, `resolveFailures`다(`packages/core/src/ports/store.ts:631`, :669). ScheduleStore 3 verb는 `addSchedule`, `listDueSchedules`, `fireSchedule`다(:1348). 갱신·취소·상태별 전체 작업 목록·의존성·키 잠금·예약 삭제 verb는 이 인터페이스에 없다.

공유 suite는 `packages/core/src/testing/contracts/work-store.ts:16`(열린 대상 멱등, 청구 순서·attempts·만료·CAS·실패 기록/해결)와 `packages/core/src/testing/contracts/schedule-store.ts:6`(due 정렬·limit·one-shot·CAS 패배 무쓰기·기존 열린 work 재사용·시각 거부)다. 메모리 구현은 `packages/core/src/testing/fakes/store.ts`, 현재 SQLite runner는 `packages/sqlite/test/work-store.test.ts:68`, `packages/sqlite/test/schedule-store.test.ts`에 있다.

### drain과 handler

drain은 지원 handler 이름을 kinds 필터로 만들고 `hasDueWork → claimWork → await attempt(handler,item) → 결과 쓰기`를 반복한다. **직렬 await 지점은 `packages/core/src/queue/drain.ts:258`**이다. handler 타입은 `(item: WorkItem) => Promise<WorkHandlerResult>`뿐이며 AbortSignal이 없다(:73). 호출 직전 예산 검사만 하고 이미 시작한 작업은 기다린다(:237). Brain의 상위 drain은 spool 재주입·스캔·파일 이름·재추출 enqueue 뒤 남은 예산으로 이 루프를 부른다(`packages/core/src/brain.ts:475`, :489).

등록부는 `packages/core/src/brain.ts:264`의 core handlers에 외부 `workHandlers`를 합치는 곳(:281)이다. 현재 5종은 `schedule_probe`(`packages/core/src/queue/schedule-probe-work.ts:4`), `session_identity`(`packages/core/src/capture/session-identity-work.ts:12`), `session_ingest`(`packages/core/src/capture/session-ingest-work.ts:30`), `document_extract`(`packages/core/src/files/extract-work.ts:45`), `blob_delete`(`packages/core/src/files/blob-delete-work.ts:25`)다. 외부 등록이 같은 이름을 덮을 수 있는 단순 record merge이므로, 앞으로 실행 주체/core·supervised 분류를 kind 이름만으로 추정하면 안 된다(:281; spine:501).

### epic 11이 끝나면 달라지는 기반

현재 checkout PG factory는 `HealthStore & SchemaStore`뿐이다(`packages/postgres/src/store.ts:49`). 현재 PG 0001을 epic 12의 기준선으로 삼지 않는다. 11.1은 work 포함 수집 baseline·비동기 외부 runner·마이그레이션 실행기를, 11.2는 schedules/settings 포함 나머지 baseline을, 11.3은 WorkStore 10/ScheduleStore 3과 `SKIP LOCKED`, 동시 drain/CAS 통합 시험을 만든다(PG 계획:5, :29, :41). **임대 갱신·의존성·현지 예약은 11.3의 범위 밖**이다(:44).

11.6은 settings/timezone, 11.9는 PG 데몬 재연결과 compose backoff, 11.10은 PG만 쓰는 조립과 0001 checksum 고정, 11.11은 SQLite 삭제다(PG 계획:77, :113, :125, :137). 따라서 위 SQLite 파일은 동작을 설명하는 역사적 근거이고 epic 12 수정 대상은 인계받은 PG adapter다. 착수 시 11이 만든 실제 파일명·runner 시그니처·계약 runner를 다시 대조해야 한다(PG 에픽:97).

## 2. 데몬 루프·예약 틱·감독자를 붙일 자리

`brain daemon run` 명령이 AbortController를 만들고 SIGTERM/SIGINT를 받아 abort한 뒤 listener를 제거한다(`apps/cli/src/commands/daemon-run.ts:45`). `runDaemon`은 config 확인 → 단일 잠금 → heartbeat → transcript watcher → 반복을 시작한다(`apps/cli/src/daemon/run.ts:107`, :118, :131, :149). 각 회차는 config 재읽기, Store 열기, schema guard, `brain.schedules.tick()`, `brain.queue.drain()` 순이며 Store는 finally에서 닫는다(:163, :258, :277, :284, :308).

drain 예산은 10초, 빈 큐/오류 회차 pause는 10초이며 budget 소진이면 즉시 다음 회차다. watcher batch는 pause를 깨우고 중복 batch를 합친다(`apps/cli/src/daemon/run.ts:57`, :68, :155, :194). heartbeat 기본 30초, 3배 초과를 낡음으로 보는 코드는 `apps/cli/src/daemon/liveness.ts:7`에 있고 heartbeat 자체는 `apps/cli/src/daemon/heartbeat.ts`가 관리한다. 현재 heartbeat는 데몬 파일 mtime이므로 개별 작업의 진행 증거가 아니다(spine:413; 에픽:58).

종료 시 watcher → heartbeat timer의 진행 중 쓰기 대기 → 종료 로그 → 잠금 해제 순이다(`apps/cli/src/daemon/run.ts:204`). AbortSignal은 회차 경계와 pause에만 쓰고 `brain.queue.drain({budgetMs})`에는 전달하지 않는다(:269, :283, :284, :359). **어긋남:** 긴 작업이 끝날 때까지 이 루프와 종료가 기다리며, AD-33 그룹 취소·reap은 없다(:52; spine:504).

잠금은 `<home>/run/daemon.pid`에 `{pid,boot_at,started_at,commit}`을 임시 파일+hard link로 원자 생성한다(`apps/cli/src/daemon/lock.ts:38`, :110, :202). 이전 부팅(10분 보정 허용)·PID 생존으로 죽은 소유자만 회수하고 생존 소유자에는 나이 제한이 없다(:59, :82, :121). **PID 시작 신원 어긋남:** `started_at`은 잠금을 잡은 Clock 시각이지 OS가 조회한 process birth identity가 아니다(:207). 같은 부팅의 PID 재사용을 판별하는 OS 시작 신원 조회는 현재 `ownerIsAlive`에 없다(:82). 이를 자식 그룹 복구 증거로 그대로 쓰면 AD-27/33의 PID 재사용 구분을 만족하지 못한다(spine:432, :507).

예약은 0009의 interval 또는 one-shot이다(`packages/sqlite/migrations/0009_schedules.sql:3`). tick은 due 최대 100개를 읽고 `expectedNextRunAt`를 전달하며, 다음 시각을 **지금+interval**로 잡아 여러 번 놓친 interval을 한 번으로 접는다(`packages/core/src/queue/schedule-tick.ts:5`, :16, :20). adapter는 한 `withWrite` 안에서 읽은 next 시각 CAS → `ensureWork` → last=발화 시각/next 변경을 한다(`packages/sqlite/src/schedules.ts:53`). 같은 대상 열린 일감이 있으면 발화는 전진하되 새 일감은 만들지 않는다(:62). `last_run_at`은 성공 시각이 아니다(spine:575).

감독자 삽입 후보는 `runDaemon` 잠금 획득 후/첫 청구 전의 이전 incarnation 정리 단계, 회차의 별도 supervised dispatch/poll, 종료 finally의 그룹 정리다(`apps/cli/src/daemon/run.ts:118`, :160, :204). 긴 child 수명을 회차 Store의 finally-close와 묶으면 회차가 자식 종료를 기다리게 되므로, 감독자 수명·DB 접근과 짧은 core drain을 분리할 필요가 있다(:258, :308). 외부 일감은 감독자만 청구하고 기회적 drain은 core만 청구하도록 capability/실행 분류를 도입하는 선택지가 있다(spine:174, :501). 이것은 별도 큐를 만드는 뜻이 아니다(spine:355).

11.1 runner는 **재사용 후보**다. 11.9도 같은 runner로 compose를 부르도록 계획했다(PG 계획:9, :117). 다만 계획은 비동기·fake 교체만 보장하며 streaming stdout/그룹 spawn·종료 신원·signal·close/reap 핸들을 보장하지 않는다. 현재 launchctl wrapper도 `execFile` 완료형이며 timeout 10초/SIGKILL이다(`apps/cli/src/daemon/launchd.ts:57`). 인계 runner가 이 기능을 제공하면 확장하고, 완료형이면 공통 실행 기반 아래에 장수 process handle port를 추가하는 선택지가 있다. 단순 `Promise<exit>`만으로 ABI 감독은 충족할 수 없다(spine:502, :504, :507, :508).

## 3. 현지 시각·DST·놓친 날짜

지금 timezone은 `config.toml`에서 읽으며 IANA 수용 여부는 `Intl.DateTimeFormat` 생성으로 검증한다(`apps/cli/src/config/codec.ts:190`, :736). 11.6 뒤에는 `brain.settings`의 `timezone`(기본 Asia/Seoul)을 읽고 남은 TOML 키는 doctor 경고다(PG 에픽:40; PG 계획:77). 예약이 기존 config 값을 계속 읽으면 **어긋남**이다(이니셔티브:167).

AD-13은 순간=`timestamptz` UTC 밀리초, 현지 날짜=`date + IANA zone`, 외부 텍스트=`YYYY-MM-DDTHH:MM:SS.sssZ`이고 날짜 범위는 설정 시간대에서 반열린 UTC 구간으로 바꾸도록 정한다(spine:249). 현재 재사용 가능한 것은 `formatInstant`/`parseInstant`의 정확한 정규형과 왕복 검사다(`packages/core/src/instant.ts:14`, :33, :58). `packages/core/src`·`apps/cli/src`의 `localDate/formatToParts/DateTimeFormat` 정적 검색에서 현지 날짜/월 버킷 변환 구현은 찾지 못했으며 유일한 DateTimeFormat 사용은 위 zone 검증이다. `Schedule`도 interval·절대 next/last뿐이다(`packages/core/src/domain/schedule.ts:2`). DST 중복/없는 시각, 시간대 변경에 따른 next 재계산은 새 코드와 fixture가 필요하다. 24시간 더하기로 현지 다음 날을 만들 수 있다는 근거는 현재 코드에 없다(:7; spine:254).

놓친 실행 결정은 발화 횟수가 아니라 **대상 현지 날짜의 성공 여부**를 요구한다(에픽:57). 저장 후보는 다음과 같다.

- 예약 정의: 현지 시각, 적용 timezone 또는 DB timezone을 따르는 정책, 평가 시작 날짜/마지막 평가 경계. `next_run_at`만으로는 여러 날 공백 범위를 알 수 없다(`packages/core/src/domain/schedule.ts:7`; spine:254).
- 성공 증거: `(kind,target,local_date,timezone/설정 세대)`별 성공과 이를 확정한 work/attempt. 수동 성공도 같은 키로 조회해야 한다. 별도 `work_success_dates` 형태 또는 work에 연결한 대상 날짜 집합이 후보이며 표 이름은 미확정이다. 현재 `completed_at`은 영구 실패로 닫힐 때도 채워져 성공 증거로 쓸 수 없다(`packages/core/src/queue/drain.ts:283`, :404).
- catch-up 일감이 맡은 빠진 날짜 집합/범위와 재검사 경계. 여러 날을 한 work로 합쳐도 단지 work 성공만으로 모든 대상 날짜를 처리했다고 간주할 수는 없다. 담당 작업이 실제 처리한 날짜를 확정하거나 범위 전체 성공 의미를 갖춰야 하며, 확정 transaction은 현재 attempt fencing을 따라야 한다(에픽:57; spine:507).

위 데이터로 오늘 이미 성공했으면 생략, 수일 공백은 한 번 enqueue, 재시작/수동 경합은 같은 열린 대상 합치기를 검증할 수 있다. timezone 변경 전 성공의 날짜를 새 timezone으로 조용히 재해석하지 않도록 당시 zone/세대를 보존하고 next 평가를 다시 할 수 있어야 한다(spine:254; `packages/sqlite/src/work.ts:108`). DST gap/fold 시각을 어떤 instant에 대응시킬지는 구현 전 명시할 기술 선택지이며, 놓친 실행이라는 사용자 결정 자체를 다시 여는 문제가 아니다.

옛 Garmin은 공통 스케줄러 구현이 아니다. `schedule.py`는 system zone과 config zone 불일치면 거절하고 collect/retry/report의 launchd `StartCalendarInterval`을 만든다(`Garmin/src/garmin_pipeline/schedule.py:83`, :104, :128, :151). 이것을 가져오면 AD-25(launchd는 데몬만)의 **어긋남**이다(spine:403). 설정은 ZoneInfo 검증, 모델 timeout 기본 20분이다(`Garmin/src/garmin_pipeline/config.py:39`, :44, :259). 수집은 시작 때 `dates.today(cfg)`를 잡고 coverage에서 빠진 날짜를 유도한다(`Garmin/src/garmin_pipeline/collect.py:4`, :35, :189, :276). archive의 날짜 함수 `today`/`day_key`는 UTC 순간을 `ZoneInfo(cfg.timezone)`으로 변환한다(`Garmin/src/garmin_pipeline/dates.py:47`, :52). `day_start_ms`는 현지 자정을 UTC epoch ms로 바꾸므로 DST 날짜 경계 fixture의 참고가 된다(:100). 다만 임의 현지 예약 시각의 gap/fold 선택을 해결하는 공통 TS 구현은 아니다. coverage는 Garmin 작업 내부의 날짜 채움 근거이며 core 공통 성공 기록을 대체하는 표는 아니다(에픽:57).

## 4. 의존성·같은 키·병렬 용량의 저장 후보

현재 유사성은 열린 대상 UNIQUE와 짧은 청구 transaction뿐이다. 이것은 **서로 다른 종류/대상의 같은 계정**을 직렬화하지 않고, prerequisite 성공도 검사하지 않는다(`packages/sqlite/src/work.ts:76`, :108). 문서 추출에는 claim과 연결된 세대의 stale 완료 방어가 있지만 공통 attempt fencing이 아니다(`packages/core/src/ports/store.ts:1019`, :1271). 11의 세션 advisory transaction lock도 짧은 세션 쓰기용으로, 몇 시간짜리 작업 전체의 계정 잠금을 대신할 수 없다(PG 에픽:37; spine:170).

| 필요한 계약 | 컬럼/표 선택지와 주의점 |
|---|---|
| 선행 성공 | work 간 edge 표 또는 단일 prerequisite 칸. 여러 선행이면 edge 표가 자연스럽다. 단순 completed_at 검사 금지, 성공 결과를 별도 식별해야 함(`packages/core/src/queue/drain.ts:283`; spine:366) |
| 같은 계정 키 | work의 serialization key + 현재 소유 claim의 DB 보호. 출처+계정을 공유하고 인증/수집 kind가 달라도 충돌해야 함(spine:366) |
| 병렬 용량 | kind/실행 class별 정책·supervisor active set. 다중 drain에서도 같은 키와 용량을 보장할 DB 청구 조건 또는 슬롯 소유권 필요(`packages/core/src/queue/drain.ts:224`, :258; spine:366) |
| 임대/쓰기 fencing | attempt token·incarnation·child PID/PGID·OS 시작 신원·진행 시각·갱신 시각. 현재 claimedBy는 drain마다 하나라 per-attempt token이 아님(`packages/core/src/queue/drain.ts:224`; spine:507) |

새 core migration은 **11의 고정된 PG 0001 다음 연속 번호**를 할당한다. SQLite 0010이나 기존 PG baseline 재편집으로 시작하지 않는다(spine:475; PG 계획:125). 선행 성공 edge, 키 소유, 상태/attempt, 성공 날짜의 서로 다른 생애주기를 한 표에 모두 넣을지 별도 표로 둘지는 정제 선택지다. terminal work 정리 시 의존/성공 증거가 지워지지 않도록 FK·보존 규칙을 함께 잡아야 한다(spine:574).

## 5. 상태·failures·doctor·작업 목록

현재 work에는 상태 enum이 없다. 청구 여부·completedAt·lastError로만 상태를 추론하며 성공 완료와 failure 종료도 completedAt을 공유한다(`packages/core/src/domain/work-item.ts:29`; `packages/core/src/queue/drain.ts:264`, :404). `lost`는 CAS 패배이지 사망 판정이 아니다(:320). 따라서 다음은 새 영속 상태/attempt 결과와 조회 계약이 필요한 부분이다.

| 구분 | 담을 곳 후보·처리 의미 | 근거 |
|---|---|---|
| 작업자 사망 | attempt 종료 원인, 그룹 종료 증거 후 재시도 | spine:507; 에픽:34 |
| 오류 | ABI 분류 코드/재시도 가능 여부·마지막 오류·attempt 결과 | `packages/core/src/queue/drain.ts:134`; spine:503 |
| stalled | 마지막 progress와 heartbeat를 분리 저장, 판정 사유와 정리 결과. 기본 15분, 모델 20+5분 뒤 일시 오류 재시도 | 에픽:58 |
| 사용자 취소 | durable cancel 요청, 현재 attempt 취소 결과와 종료 시각 | 에픽:22, :34 |
| 불명 | 이전 그룹 종료를 증명 못 한 상태, 재청구 차단 | spine:507 |
| extension_disabled | 대기 work 보류 원인. 켜면 재개, 진행 work는 그룹 취소 | 에픽:60 |
| 모델 관찰 | work에 elapsed와 선택 usage(입력/캐시/출력), 값 없음과 0 구분 | 에픽:59 |

행의 최신 상태만 바꾸면 stalled→retry에서 이력이 사라진다. work 최신 상태+attempt 이력을 나누는 선택지가 관찰 요구와 맞지만 표 설계는 미확정이다(에픽:34, :58, :59). 확장 registry/설정 snapshot은 epic 13 소유이므로 12는 disable/pause/cancel을 받을 계약과 fake까지만 만들고 실제 registry가 있는 척하지 않아야 한다(에픽:43, :60, :62).

`failures`는 최종 오류 기록이고 큐가 아니다. `recordFailure(closeWork)`는 기록+닫기를 원자화하며 기록도 DB 불가면 failure spool을 남기고 work는 닫지 않는다(`packages/core/src/queue/drain.ts:377`, :404, :414). 키는 대상+stage+fingerprint, 재발 시 reopen/occurrences 누적이다(spine:565). 진행·보류·취소·불명을 전부 failures로만 표현하면 runnable 여부를 결정할 수 없다. terminal failure 기록과 운영 상태를 구분하고, 자동 재시도 중 stalled도 doctor가 읽을 상태를 따로 남길 필요가 있다(에픽:58; spine:363).

Core doctor의 확장점은 `DoctorCheckSource {id,run}` 및 options.checks이고 결과는 ok/warn/fail/skip이다(`packages/core/src/doctor/doctor.ts:28`, :82, :120, :173). DB 작업 상태는 DoctorReadStore를 넓혀 DB 의존 skip을 함께 추가하거나, runtime 등록 check가 새 읽기 capability를 받는 선택지가 있다(:98, :158). CLI 등록부는 `apps/cli/src/doctor/checks.ts:121`이고 assembly에서 주입한다(`apps/cli/src/assembly.ts:94`). DB 불가일 때 check가 거짓 ok를 내지 않도록 11.8이 바꿀 선행 검사 순서와 합쳐야 한다(PG 계획:101; PG 에픽:97).

**현재 전체 작업 목록/취소 명령은 없다.** 있는 명령은 `queue drain`, `failures list|retry`, `daemon status`이며 실패 목록과 데몬 상태는 작업 목록을 대신하지 못한다(`apps/cli/src/commands/index.ts:36`). `listOpenWorkTargets`도 kind별 대상만 읽는 API다(`packages/core/src/ports/store.ts:670`). 새 list에는 상태·attempt·최근 진행·경과 시간·선택 usage를 보여 줄 read verb와 출력 코덱이 필요하다(에픽:59).

오류 코드 진실의 원천은 `packages/core/src/codes.ts:164` 이후 표이며 분류 함수는 그 retryable을 읽는다(`packages/core/src/queue/drain.ts:146`). spine Conventions도 코드 목록 하나와 guide 대조를 요구한다(spine:630). 기존 `HANDLER_THREW/MISSING`는 공용 코드 표 바깥의 내부 오류다(`packages/core/src/queue/drain.ts:87`, :95). 새 ABI 오류·정체·불명·취소 코드를 추가할 때 상태 이름과 retryable error를 혼동하지 말고 codes/guide/출력 매핑까지 함께 정해야 한다. `SETUP_CANCELLED`는 설치 취소용이므로 작업 취소로 재사용할 근거가 없다(`packages/core/src/codes.ts:301`).

## 6. 프로세스 ABI v1·fixture·Garmin Codex 출력

현재 packages/apps/tooling의 TS·package.json 및 pnpm-lock에서 ajv/zod/jsonschema/JSON Schema 검증기 의존을 찾지 못했다. Core는 TS-only 개발 의존이고, 현재 JSON 입력 검증 사례는 직접 작성한 spool/instant 코덱이다(`packages/core/package.json:22`; `packages/core/src/domain/spool-record.ts:379`; `packages/core/src/instant.ts:58`). `brain guide schema`는 명령 메타 목록이지 JSON Schema validator가 아니다(`apps/cli/src/commands/guide-schema.ts:22`). 검증기 선정·추가 여부는 구현 시 선택이며 이 조사에서는 추가하지 않았다.

배치 후보는 `packages/core/schemas/process-abi/v1/*.schema.json`과 `packages/core/fixtures/process-abi/v1/`이다(신규 경로 제안). 이유는 ABI가 언어 중립 core 계약이고 TS/Python 동일 fixture가 요구되기 때문이다(spine:508). 지금 core package는 `dist`만 배포하므로 schemas/fixtures를 package files 또는 별도 export로 실어야 한다(`packages/core/package.json:6`, :16). TS는 package URL/파일로, 후속 `extensions/garmin` Python fixture는 같은 배포 파일 경로를 받아 읽는 선택지가 있다. repo 안 상대 경로만 하드코딩하면 별도 설치된 확장에서 깨진다(spine:679; `packages/core/package.json:16`). schema를 언어별로 복사해 따로 고치지 않는 배포 방법을 정제해야 한다.

fake worker 후보는 `apps/cli/test/fixtures/process-worker.mjs`이며 실행·stdio·signal 경계를 검증하고, JSON valid/invalid 예제는 위 공통 fixture를 소비하게 한다. 기존 child fixture 패턴은 `packages/sqlite/test/fixtures/drain-worker.mjs`/`packages/sqlite/test/work-store.test.ts:457`이나 11에서 SQLite가 삭제되므로 새 fake worker의 소유 위치를 CLI 또는 공통 tooling에 둔다(PG 계획:137).

ABI v1에서 고정할 표면은 버전, progress/heartbeat/result/error discriminator·필수 필드, 재시도 분류, 입력 account/target/범위/실행 세대/attempt token과 DB URL·work id 환경 변수, 최종 이벤트/exit 우선순위, 잘린 JSONL/비정상 EOF/모르는 버전/stderr 처리다(spine:502, :503, :508; 에픽:23). result에 선택 `usage`를 두고 work에 보존하는 것은 확정이다. 숫자 타입·음수 거부·누락을 unknown으로 내보내는 fixture가 필요하며 모델 adapter의 실제 채움은 epic 18이다(에픽:59). stdout/stderr의 비밀 원문을 그대로 failure에 남기지 않고 기존 `failureText` 경계를 적용할 자리가 있다(`packages/core/src/queue/drain.ts:438`; spine:508).

옛 Garmin `CodexWriter`는 다음을 이미 한다.

- `codex exec --json --output-schema <schema> -o <analysis.json>`으로 stdout 이벤트와 최종 구조화 파일을 분리한다(`Garmin/src/garmin_pipeline/report.py:175`). `_read_output`은 JSON Schema Draft 2020-12로 구조화 파일을 검증한다(:234, :257). 이 schema는 모델 출력용이며 Brain 프로세스 ABI가 아니다.
- stdout을 임시 `events.jsonl`로 받고 analysis 파일을 읽은 뒤 usage를 붙이고 finally에 임시 폴더를 지운다(:355, :358, :360, :362). stderr는 DEVNULL이다(:383).
- **토큰 사용량을 읽는다.** `_usage`는 JSONL의 `turn.completed`만 골라 `input_tokens/cached_input_tokens/output_tokens` 셋 모두 비음수 정수일 때 합산하고 없으면 None이다(:965). 세션별·전체 elapsed와 token/unknown 로그도 있다(:907, :988). 따라서 “옛 코드는 usage를 읽지 않는다”는 설명은 실제 archive와 어긋난다.
- Popen `start_new_session=True`, monotonic elapsed, timeout wait, finally에 그룹 SIGTERM→5초 리더 wait→그룹 SIGKILL→리더 reap을 한다(:59, :224, :375, :384, :395, :397). 정상 리더 종료 때도 그룹에 남은 자식을 정리한다(:224). 단 PermissionError도 억제하므로 이 코드를 종료 확인의 증거로 그대로 승격할 수 없다(:219; spine:507). timeout 기본은 config의 20분이며 Brain의 25분 무진행 판정과 역할이 다르다(`Garmin/src/garmin_pipeline/config.py:44`; 에픽:58).

## 7. CLI·SDK의 추가 경로와 failures retry

명령은 `apps/cli/src/dispatch.ts:250` CommandSpec(ns/verb/options/arguments와 CommandMeta) → `apps/cli/src/commands/index.ts:36` 등록 → dispatcher의 config/schema/envelope → Core Brain SDK 호출 순이다. `guide schema`가 같은 등록부를 읽으므로 별도 정적 명령 목록을 작성하지 않는다(`apps/cli/src/commands/guide-schema.ts:47`). SDK 현재 표면은 Brain.queue와 tick뿐인 Brain.schedules다(`packages/core/src/brain.ts:212`).

추가 후보는 `commands/schedules-add.ts`, `schedules-list.ts`, `schedules-remove.ts`, 작업 list/cancel 명령 파일, Core의 대응 use case/Brain interface, ports, PG verb, `packages/core/src/output/codecs.ts`, `packages/core/src/index.ts` 및 묶음 재export다. 예약은 에픽 Notes의 `schedules add|list|remove` 안을 SDK 1:1로 정제한다(에픽:61). 작업 명령은 `queue list|cancel`로 기존 namespace를 넓히거나 별도 work namespace를 택할 수 있고 지금 결정하지 않는다(`apps/cli/src/commands/queue-drain.ts:1`; spine:790). read list는 Store 쓰기 없이, cancel은 요청을 DB에 남겨 감독자가 실행하도록 연결하면 CLI가 직접 잘못된 PID를 죽이는 경로를 피할 수 있다(spine:507).

기존 `failures retry`는 unresolved 실패를 읽고 stage 우선/targetKind fallback으로 kind를 골라 즉시 due work를 add한다. 성공 전 failures를 지우거나 resolve하지 않는다(`packages/core/src/failures/retry.ts:8`, :97, :110, :146). 알려지지 않은 대상은 skipped, redacted/원본 불가 파일은 재큐잉하지 않는다(:120, :125). 새 supervised kind 재시도는 같은 등록부/실행 분류·보류 규칙을 따라야 하고, retry 명령 끝 기회적 drain이 확장·모델을 실행하면 AD-33 위반이다(spine:501). 작업 취소와 failure retry가 계정 보류나 extension_disabled를 우회하지 않는 계약도 필요하다(에픽:60).

## 8. 공유 파일 레인과 세션 크기 위험

| 공유 표면 | 함께 수정할 후보 파일 | 충돌/순서 근거 |
|---|---|---|
| 데몬 loop/lifecycle | `apps/cli/src/daemon/run.ts`, 신규 supervisor/process port, `commands/daemon-run.ts` | 회차 Store close·종료·tick·11의 backoff 모두 겹침(:118, :277, :308; PG 계획:113) |
| drain/handler 분류 | `packages/core/src/queue/drain.ts`, `brain.ts`, `domain/work-item.ts` | core 기회적 처리와 감독자 전용 청구를 함께 지켜야 함(:73, :258; spine:501) |
| WorkStore·fake·계약 | `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/work-store.ts`, 11이 만든 PG work 모듈 | 임대·취소·의존·키·목록 모두 같은 port/claim predicate를 바꿈(:631) |
| core migrations | `packages/postgres/migrations/0002_*.sql` 이후 실제 다음 번호, PG migrate/schema 기대 버전 | 번호는 인계 HEAD에서 확인. 0001 checksum 고정 후 수정 금지(PG 계획:125; spine:475) |
| 예약·성공 날짜 | `domain/schedule.ts`, `queue/schedule-tick.ts`, ScheduleStore·fake·계약·PG schedules 모듈, 신규 날짜 함수 | 발화 CAS와 성공 증거는 다른 transaction 의미(:1348; spine:575) |
| doctor·출력 | `packages/core/src/doctor/doctor.ts`, `output/codecs.ts`, `codes.ts`, `apps/cli/src/doctor/checks.ts` | read capability·DB skip·실행 상태·usage의 소유권 합의 필요(:98, :158; 에픽:59) |
| CLI 조립 | `apps/cli/src/commands/index.ts`, `dispatch.ts`, `assembly.ts`, `packages/core/src/brain.ts`, export 파일 | ABI/예약/작업 목록 스토리 모두 같은 registry·SDK 경계를 만짐(:36, :250, :212) |

가장 넓은 변경은 **claim/attempt token·DB 직접 쓰기 fencing + 장수 감독자 + 재시작 복구 + 종료 확인**의 묶음이다. 단순 “병렬 drain” 한 스토리로 잡으면 core handler·PG transaction·OS process·doctor까지 한꺼번에 바뀐다(spine:507; `apps/cli/src/daemon/run.ts:258`). 반대로 token만 추가하고 supervisor의 살아 있는 이전 child를 방치하면 만료 후 중복 실행 위험이 남는다. 하나의 얇은 관통 스토리로 안전한 정상 경로를 잇고, 사망/재시작·정체/취소 같은 장애 행렬을 다음 세션으로 넓히는 분할이 후보이나 각 중간 단계가 외부 모델/확장 실행을 열어서는 안 된다(spine:501, :507).

WorkStore·migration·drain 레인은 한 줄로 가는 편이 충돌이 적다. ABI 문서/fixture를 먼저 고정하면 process adapter와 날짜 함수의 내부 구현을 분리할 여지는 있으나, 스토리마다 같은 `brain.ts/ports/store.ts/commands/index.ts`를 동시에 고치게 배분하면 병합 지점이 넓어진다(위 표; PG 에픽:97의 같은 레인 사례). 이것은 에이전트 병렬 실행 지시가 아니라 정제 시 선택할 파일 소유 경계다.

## 9. Done when 1~5와 기존 시험 기반·빈틈

현재 가짜 Clock은 fixedClock/steppingClock이며 시간이 흐른 듯한 반환을 만들 뿐 OS timer를 진행시키지 않는다(`packages/core/src/testing/fakes/clock.ts:4`, :13). daemon은 clock/createStore/workHandlers/watch/isAlive/bootAt 및 짧은 heartbeat/pause/budget 주입 seam이 있다(`apps/cli/src/daemon/run.ts:70`). 기존 daemon 시험에는 지연 handler·AbortController·실제 Node child와 close 관찰, 예약 틱 실패 회복이 있다(`apps/cli/test/daemon-run.test.ts:130`, :181, :208, :666). launchctl fake도 있다(`apps/cli/test/fixtures/fake-launchctl.sh`; `apps/cli/test/daemon-stop-start.test.ts:29`). 이것은 ABI용 fake process port나 process-group fixture가 이미 있다는 뜻은 아니다.

| Done when | 재사용할 소스 기반 | 빠진 증명 |
|---|---|---|
| 1. 600초 이상 갱신·수집 병행 | WorkStore 만료/CAS 계약(`packages/core/src/testing/contracts/work-store.ts:188`, :251), drain 분류 시험(`packages/core/test/queue-drain.test.ts`), daemon seam(:70) | 제어 가능한 timer+process port로 600초 초과 진행/갱신, 동시 core ingest 성공, 중복 claim 없음. heartbeat만 오는 작업은 progress 아님도 검증 |
| 2. 사망·취소·오류·정체/doctor | Node child/close(`apps/cli/test/daemon-run.test.ts:670`), doctor checks 계약(`packages/core/src/doctor/doctor.ts:82`), 기존 failure suite(`packages/core/test/failures.test.ts`) | TERM 무시 child·손자, TERM→grace→KILL→reap, supervisor SIGKILL 뒤 child 생존/재시작, PID 재사용·EPERM/불명 차단, stale token 직접 SQL 쓰기 거부, stalled 15/25분과 disable 보류/재개 |
| 3. 의존 성공·계정 직렬 | 열린 대상 멱등 계약(`packages/core/src/testing/contracts/work-store.ts:16`), 두 worker 중복 없음 시험(`packages/sqlite/test/work-store.test.ts:412`) | PG 두 프로세스에서 다른 kind 같은 계정 상호배제, 다른 계정 병렬, 선행 실패/취소는 후행 시작 불가, 성공만 해제, 용량·잠금 회수와 stale 완료 경합 |
| 4. 현지 예약·수동/놓침 | schedule 공유 계약(`packages/core/src/testing/contracts/schedule-store.ts:6`), tick 단위(`packages/core/test/schedule-tick.test.ts`), daemon 예약(:181, :752) | DST gap/fold, timezone 변경, 오늘 수동 성공 뒤 생략, 며칠 잠든 뒤 한 work만 생성, 빠진 날짜 처리 성공 기록, 재시작/수동 동시 발화, 날짜 경계 CAS 경합 |
| 5. 플러그인 설치본 | 설치본 Node spawn/doctor 흐름(`apps/cli/test/daemon-run.test.ts:752`), app-ref/version 릴리스 규칙(`AGENTS.md:11`) | 기능 묶음의 앞선 commit ref+같은 변경의 version 증가 후 실제 Mac 설치본에서 확인. 이 보고서는 배포하지 않음(에픽:37) |

ABI 전용 fixture에는 valid/invalid version, split JSONL·큰/깨진 줄, stderr, error retryable, 결과 없이 exit 0, 결과 뒤 nonzero exit, 중복 final, EOF, usage 누락/0/잘못된 숫자, token 불일치와 출력 마스킹을 추가할 수 있다(spine:508; 에픽:23, :59). fake port만으로 OS 그룹 kill/reap을 증명하지 못하므로 timer를 가속한 계약 시험과 실제 Node child/손자 통합 시험을 구분할 필요가 있다(`apps/cli/test/daemon-run.test.ts:670`; spine:507).

실행 방법은 기존 `package.json:15`의 `pnpm test`(build→typecheck→vitest), 빌드된 cross-package export를 사용하는 `vitest.config.ts:5`, 프로젝트 선택 `pnpm exec vitest run --project core`, `--project cli`, `--project postgres`다(`vitest.config.ts:10`, :17, :25). 특정 파일은 선택 project에 파일 필터를 붙인다. PG global setup은 test-db를 사용하고 환경 URL이 없으면 Compose를 시작할 수 있으므로 이번 조사에서는 **아무 시험도 실행하지 않았다**(`packages/postgres/test/global-setup.ts:1`; `tooling/test-db/src/global-setup.ts:86`). 11.10 뒤 CLI/Store fixture는 PG로 바뀌므로 위 SQLite 두 worker 시험은 재사용할 시나리오이며 실행 경로는 11의 새 PG fixture로 바꿔야 한다(PG 계획:125, :137).

## 스토리 후보

아래는 순서와 파일 경계의 후보이며 확정 티켓이 아니다. 신규 경로와 번호는 제안으로, 11 완료 뒤 실제 구조를 보고 배정한다(PG 계획:125; spine:475).

| 후보 | 얇은 결과와 경계 | 고칠 파일 후보·근거 |
|---|---|---|
| T1 tracer: PG work 한 건을 fake child로 실행하며 갱신하고 core 수집 한 건이 동시에 끝남 | ABI v1의 최소 정상 progress→result와 attempt token, DB 결과 fencing, supervisor 수명/종료를 한 경로로 잇는다. 모델/실계정·manifest는 열지 않음. 600초를 넘긴 fake 시간에도 같은 work가 재청구되지 않음을 관찰 | `domain/work-item.ts`, `ports/store.ts`, fake/계약, PG work 모듈·새 migration, 신규 `core/schemas/process-abi/v1/`, `core/fixtures/process-abi/v1/`, 신규 CLI supervisor/process port·fake worker, `daemon/run.ts`, `brain.ts` (에픽:33; spine:501, :507, :508) |
| T2 supervisor 장애·취소·정체·불명 | T1 다음 process group 정리·reap·incarnation 복구·OS 시작 신원, durable cancel, 15/25분 progress 판정, 오래된 직접 SQL 거부를 완성. ABI 비정상 행렬도 여기 또는 T1의 후속으로 분할 가능 | supervisor/process port, `daemon/lock.ts`, `daemon/run.ts`, PG attempt/guard migration·계약, `codes.ts`, fake process/실제 child fixture (에픽:34, :58; spine:507) |
| T3 의존·계정 키·실행 용량 | 성공 prerequisite gate와 계정 키 원자 청구, 독립 계정 병렬, terminal/unknown 동안 키 해제 규칙 검증 | work 타입/Store/fake/계약/PG claim query·migration, supervisor capacity 정책, `queue/drain.ts` (에픽:35; spine:366) |
| T4 현지 시각·성공 날짜·catch-up | DB timezone과 날짜 함수, schedule 정의/성공 증거, 예약·수동 같은 대상 합침과 빠진 날짜 한 번 실행. DST 기술 규약을 fixture로 고정 | 신규 Core 날짜 함수, `domain/schedule.ts`, `queue/schedule-tick.ts`, ScheduleStore/fake/계약/PG schedules·성공 날짜 migration, Brain 예약/수동 enqueue use case (에픽:36, :57; spine:254, :575) |
| T5 관찰·사용자 제어 | 작업 list/cancel, schedules add/list/remove SDK 1:1, doctor에 오류/정체/불명·시간·선택 usage, failures retry 등록 확장, disable 계약과 fake. 실제 확장 registry는 13에 남김 | `brain.ts`, `output/codecs.ts`, `codes.ts`, `doctor/doctor.ts`, `failures/retry.ts`, CLI 명령 파일/등록부·assembly·doctor/checks, PG 읽기 verb (에픽:59, :60, :61, :62) |
| T6 기능 묶음 배포·Mac 확인 | 이전 완료 commit을 app-ref로, plugin version과 함께 배포하고 fake 긴 작업·수집 병행·취소·현지 예약·doctor를 설치본에서 관찰 | `plugin/app-ref`, `plugin/.claude-plugin/plugin.json`, 해당 story plan의 검증 증거(에픽:37; `AGENTS.md:11`) |

T5를 마지막에 한꺼번에 두는 대신 T1에 최소 작업 목록/doctor 행을 넣고 T2~T4가 자기 관찰/CLI를 함께 넓히는 선택지도 있다. 전자는 공용 CLI 조립 충돌을 줄이고 후자는 각 세션 결과를 사용자가 즉시 볼 수 있게 한다(`apps/cli/src/commands/index.ts:36`; `packages/core/src/doctor/doctor.ts:82`). T3와 T4의 내부 정책은 분리할 수 있어도 WorkStore/migration/Brain 조립 수정이 겹치므로 독립 병렬 레인으로 단정하지 않는다(8절). 가장 먼저 검증할 새 불확실성은 11 runner의 장수 process 기능과 token 직접 SQL fencing의 구현 경계이며, 이미 정해진 놓침·정체·usage·disable 정책은 그대로 전제한다(PG 계획:9; spine:507; 에픽:57).
