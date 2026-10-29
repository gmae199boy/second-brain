---
title: '이 Mac에서 확인: 플러그인 배포로 긴 작업·취소·현지 예약이 설치본에서 돈다'
type: 'chore'
ticket: '12'
created: '2026-10-29'
status: blocked
baseline_revision: 'cdaba2248c6a8ac20ec0dd78bc6a188f24372b8d'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
operator_actions:
  - "`git push origin main`으로 배포 커밋 `0c309e8`(plugin `app-ref` = `cdaba22`, `version` 0.1.10)과 그 앞의 로컬 커밋들(epic 11 배포 `dd49f71` 포함)을 원격에 올려, 원격 marketplace가 0.1.10을 내주게 한다."
blocked_at: "2026-10-29"
blocked_reason: "awaiting operator: `git push origin main`으로 배포 커밋 `0c309e8`(plugin `app-ref` = `cdaba22`, `version` 0.1.10)과 그 앞의 로컬 커밋들(epic 11 배포 `dd49f71` 포함)을 원격에 올려, 원격 marketplace가 0.1.10을 내주게 한다."
---

<intent-contract>

## Intent

**Problem:** epic 12(긴 작업 감독자·취소·현지 시각 예약·명령·doctor)가 실제 설치본에서 도는지 아직 아무도 보지 않았다(Done when 5). 이 Mac의 설치본은 epic 11 확인 때의 `7c7a086`(core 스키마 1, plugin 0.1.9)이고, epic 12는 core 마이그레이션 0002~0010을 더했다.

**Approach:** 배포 커밋(`plugin/app-ref` = 기준 리비전 `cdaba22…`, `version` 0.1.9 → 0.1.10)을 만들고, push 없이 `~/.second_brain/app` 클론에 로컬 객체를 넣은 뒤 플러그인의 SessionStart 명령으로 bootstrap이 설치본을 올리게 한다(epic 11 확인 `epic-postgres-primary/tickets/story-mac-pg-plan.md`과 같은 길). 그 설치본에서 확인 목록을 한 번 돌리고, 증거와 다시 돌릴 때의 정리 절차를 이 plan에 남긴 뒤 정리를 실제로 해 둔다. 원격 push는 사람 몫으로 남긴다.

## Boundaries & Constraints

**Always:**
- 배포 커밋은 `plugin/app-ref`(40자 소문자 hex `cdaba2248c6a8ac20ec0dd78bc6a188f24372b8d`)와 `plugin/.claude-plugin/plugin.json`의 `version`(`0.1.10`) 두 줄만 바꾼다. 메시지 예: `chore(plugin): deploy cdaba22 as 0.1.10`, 끝 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. push하지 않는다. 이 plan 파일은 배포 커밋에 섞지 않는다.
- 클론 준비: `git -C ~/.second_brain/app fetch "<repo>" main`으로 객체만 넣는다. `origin`은 GitHub 주소 그대로 둔다. 그 뒤 bootstrap이 `fetch origin` → ref 확인 → 조상 확인 → detach → build → 설치기를 그대로 탄다.
- 플러그인 루트는 `claude plugin list`(또는 `--json`)가 보이는 second-brain 0.1.10의 경로다. 0.1.9로 보이면 `claude plugin marketplace update second-brain`·`claude plugin update second-brain@second-brain`으로 맞춘다. 설치는 `CLAUDE_PLUGIN_ROOT=<root> sh <root>/bin/session-start.sh`로 한다.
- 모든 brain 명령은 `~/.second_brain/bin/brain`이다. 시각은 이 Mac의 설정 시간대(`brain config get timezone`, 지금 `Asia/Seoul`) 기준이다.
- probe 일감은 `process_probe` 종류이고 `--target-kind probe --target-id <밀리초>`가 길이다(`apps/cli/src/workers/process-probe.ts`). 같은 대상(kind·target-kind·target-id)의 매일 예약은 하나뿐이므로 확인마다 다른 target-id를 쓴다.
- 데몬을 멈추는 단계 뒤에는 반드시 `brain daemon start`로 되돌린다(실패해도 마지막에). 데몬 멈춤은 긴 probe를 취소한 뒤에만 한다(멈춤은 진행 중 자식을 끊는다).
- 증거로는 명령, 종료값, 시각, 건수, 일감·예약 ID, `queue list`·`schedules list`·doctor의 해당 필드만 남긴다. transcript 본문, `.env` 값, 비밀번호, 접속 URL은 쓰지 않는다. 문서·커밋·보고에 절대 홈 경로를 쓰지 않고 `~/…`, `<repo>/…`로 쓴다. DB 조회가 필요하면 `docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml exec -T postgres psql -U postgres -d brain -At -c '…'`(읽기, 정리 때만 쓰기).
- 끝나면 확인용 예약이 남지 않는다(남으면 매일 probe가 돈다).

**Never:**
- 원격 push, GitHub 원격 marketplace 등록, `--no-verify`.
- 제품 소스·시험 수정. 확인이 제품 결함으로 실패하면 고치지 않고 상태를 되돌린 뒤 실패 항목과 증거를 남긴다.
- 운영 볼륨 `second-brain-pg` 삭제, `docker compose down -v`, 시험 컨테이너 `second-brain-test-postgres-1` 건드리기, 확인용이 아닌 일감·예약·세션 행 지우기.
- 모델·실계정 호출(probe만 쓴다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 갱신 배포 | 0.1.9 설치본, 미리 넣은 객체 | SessionStart 종료 0, `installed.json` commit = 기준 리비전, core 스키마 10, `daemon status` 빌드 `cdaba22`, doctor fail 없음 | 실패면 `bootstrap.log` 끝 줄을 증거로 남기고 멈춘다 |
| 긴 probe | `schedules add --kind process_probe --target-kind probe --target-id 720000 --at <지금+3시간>` → `schedules run <id>` | `created: true`, 감독자가 청구, `queue list`에 `state: running`, `last_progress_at`이 앞으로 가고 `elapsed_ms`가 는다 | 1분 안에 running이 아니면 데몬 로그·doctor를 남긴다 |
| 수집이 밀리지 않음 | probe 도는 중 임시 폴더에서 `claude -p` 한 번 | 그 세션 ID의 세션·메시지가 몇 분 안에 PG에 있다 | 없으면 실패로 기록 |
| 임대 600초 넘김 | `elapsed_ms` > 610000까지 둠 | `attempts: 1` 그대로, 같은 일감의 attempt 이력 1행 | 2 이상이면 실패로 기록 |
| 취소 | `queue cancel <work_id>` | 곧 `state: cancelled`, `attempt_outcome: cancelled`, 기록된 PGID의 `ps -g <pgid>`가 종료 1·빈 출력 | 1분 안에 안 끝나면 실패로 기록 |
| 현지 시각 예약 | `--target-id 5000 --at <지금+3~4분 HH:MM>` | 그 시각 뒤 일감 정확히 1건 `succeeded`, `schedules list`의 `last_run_at` 설정·`next_run_at` 다음 날 같은 시각, 성공 기록 1행(오늘 날짜) | 5분 넘게 발화 없으면 실패 |
| 놓친 예약 | `--target-id 6000 --at <지금+3분>` 직후 `daemon stop`, 그 시각 + 1분 넘겨 `daemon start` | 데몬이 일감 정확히 1건을 만들고 `local_date_from = local_date_to = 오늘`, `succeeded`, 성공 기록 1행; 멈춘 동안에는 일감이 생기지 않는다 | 0건·2건이면 실패 |
| doctor | 각 단계 뒤 `doctor run` | work 관련 check(정체·사망·불명·마지막 오류, `work-model-usage`)가 보이고 fail 없음 | fail이면 그 줄을 남긴다 |

</intent-contract>

## Code Map

- `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 배포 커밋이 바꾸는 두 파일(README "릴리스", AGENTS.md 정책). 지금 `7c7a086…`·`0.1.9`.
- `plugin/bin/session-start.sh`, `plugin/bootstrap.mjs` -- SessionStart가 부르는 bootstrap. 기존 클론이면 `fetch origin` → ref 확인 → HEAD가 ref의 조상이면 detach. 원격(`origin/main` `608a5d5`)은 로컬보다 72 commit 뒤라 객체를 미리 넣어야 한다. 진행 로그 `~/.second_brain/log/bootstrap.log`.
- `apps/cli/src/commands/schedules-{add,list,remove,run}.ts`, `queue-{list,cancel}.ts`, `doctor-run.ts`, `daemon-{start,stop,status}.ts` -- 확인에 쓰는 명령. `--json`이 있다. `queue list` 기본은 열린 일감, `--all`로 닫힌 것까지, `--kind process_probe`로 거른다. 행 필드: `state`, `attempts`, `attempt_outcome`, `attempt_started_at`, `last_progress_at`, `elapsed_ms`, `cancel_requested_at`.
- `apps/cli/src/workers/process-probe.ts` -- probe 자식: 1초마다 progress, `target_id` 밀리초 뒤 result.
- `apps/cli/src/daemon/run.ts:332` -- 예약 tick은 데몬 회차에서만 돈다(명령·hook은 tick하지 않는다). 그래서 데몬을 멈추면 예약이 놓친다.
- `packages/core/src/queue/schedule-tick.ts`, `packages/core/src/local-time.ts:65` `dailyOccurrenceDates`, `packages/postgres/src/schedules.ts:130-136` -- 놓친 발화는 한 번으로 모이고, 성공 기록 없는 날짜 범위를 일감의 `local_date_from/to`에 싣는다.
- `packages/postgres/migrations/0009_local_schedules.sql` -- `brain.schedules`(local_time, time_zone), `brain.work_items`(schedule_id, local_date_from/to), `brain.schedule_successes`(예약 삭제 때 cascade, `work_id`는 cascade 없음). 정리 SQL은 이 FK와 0002·0007·0008·0010의 attempt·선행·보류 표 FK 순서를 따른다.
- `packages/core/src/domain/work-item.ts:163` -- `process_probe`는 `supervised`(데몬 감독자만 청구).
- `epic-postgres-primary/tickets/story-mac-pg-plan.md` -- 이전 확인의 명령·함정: 사전 클론, `pnpm` 필요, compose에는 `-p second-brain --env-file ~/.second_brain/.env`가 필요.
- 이 Mac 상태(착수 때): 설치본 `7c7a086`·core 스키마 1, 플러그인 `second-brain@second-brain` 0.1.9(user scope, 로컬 marketplace, 출처 `<repo>/plugin`), 작업 트리 clean, 브랜치 `main`.

## Tasks & Acceptance

**Execution:**
- [x] `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 배포 커밋 -- 설치할 commit과 캐시 키를 함께 올린다.
- [x] (이 Mac) 클론·플러그인 -- 객체 fetch, 플러그인 0.1.10 루트 확인 -- push 없이 bootstrap이 ref를 찾게 한다.
- [x] (이 Mac) 갱신 설치 -- SessionStart 명령 실행, 종료값·걸린 시간·`bootstrap.log` 설치 줄(스키마 적용 건수, 데몬 재시작 여부)·`installed.json`·`daemon status` 빌드·doctor 기록.
- [x] (이 Mac) 긴 probe·수집·600초·취소 -- 긴 probe·600초·취소는 앞선 확인에서 통과했고, 동시 수집은 아래 추가 확인에서 통과; `queue list --kind process_probe --json`을 두 번 이상(진행이 늘어남), 취소 전 attempt 이력의 PID·PGID, 취소 뒤 `ps -g` 결과.
- [x] (이 Mac) 현지 시각 예약·놓친 예약 -- 매트릭스 순서대로; 발화 전후 `schedules list --json`, 일감과 성공 기록 조회, 데몬 로그의 `예약 N건 발화` 줄.
- [x] (이 Mac) doctor -- 마지막 상태의 `doctor run` 요약(통과·경고·실패 수와 work check 줄).
- [x] (이 Mac) 정리 -- 아래 정리 절차를 실제로 돌리고, 확인용 예약 0건·확인용 probe 일감 0건·데몬 running·doctor fail 없음을 확인.
- [x] 이 plan -- `## Implementation Notes`에 확인 표(확인 | 결과 | 근거)와 "다시 돌릴 때의 정리 절차"(실제로 돈 명령·SQL 그대로, 지울 대상을 확인용 target-id로 한정)를 쓴다.

**Acceptance Criteria:**
- Given 배포 커밋과 미리 넣은 객체, when SessionStart 명령을 돌리면, then 종료 0, `installed.json` commit이 기준 리비전, `daemon status`가 살아 있고 빌드가 `cdaba22`이며 doctor에 fail이 없다.
- Given 확인 목록을 모두 돈 뒤, when 이 plan을 읽으면, then 매트릭스 각 행의 결과와 그 근거(명령 출력의 해당 필드, doctor 출력)가 있다.
- Given 정리 절차를 돈 뒤, when `brain schedules list --json`과 `brain queue list --all --kind process_probe --json`을 보면, then 확인용 target-id(720000·5000·6000)의 행이 없고, 데몬은 running, 컨테이너 healthy다.
- Given 배포 커밋, when `git show --stat <커밋>`을 보면, then 두 파일만 바뀌었고 push되지 않았다(`git status`의 ahead).

## Implementation Notes

- 실행일은 2026-10-29이며, 아래 현지 시각은 `Asia/Seoul`이다. `context: []`를 확인했으며 추가로 불러올 frontmatter 파일은 없었다.
- 배포 커밋은 `0c309e8cbce5dbae80c797c8991e4a0ef37a65e8`이다. `git show --stat HEAD`에서 `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` 두 파일만 각각 한 줄 바뀌었고 `git status --short --branch`는 `main...origin/main [ahead 73]`였다. push하지 않았다.
- 실행한 준비 명령은 `git -C ~/.second_brain/app fetch "<repo>" main`, `claude plugin marketplace update second-brain`, `claude plugin update second-brain@second-brain`, `claude plugin list --json`이다. 모두 종료 0이었다. `git -C ~/.second_brain/app remote get-url origin`의 결과는 기존 `https://github.com/gmae199boy/second-brain.git` 그대로였다. 플러그인 목록에서 `version: 0.1.10`, 설치 루트 `~/.claude/plugins/cache/second-brain/second-brain/0.1.10`을 확인했다.
- 설치 명령은 `CLAUDE_PLUGIN_ROOT=~/.claude/plugins/cache/second-brain/second-brain/0.1.10 sh ~/.claude/plugins/cache/second-brain/second-brain/0.1.10/bin/session-start.sh`이며 종료 0, 2.31초였다. `bootstrap.log`: `PostgreSQL second-brain: 스키마 10, 적용 9건`, `데몬을 새 빌드로 다시 띄웠습니다`, `~/.second_brain/installed.json에 완료 기록을 썼습니다`.

| 확인 | 결과 | 근거 |
|---|---|---|
| 갱신 배포 | 통과 | `installed.json`: `commit: cdaba2248c6a8ac20ec0dd78bc6a188f24372b8d`, `schema_versions.core: 10`, `installed_at: 2026-10-29T04:01:32.123Z`; `brain daemon status`: 빌드 `cdaba22`, pid `60173`, 살아 있음. 설치 직후 doctor 종료 0, 통과 23·경고 1·실패 0. |
| 긴 probe·진행 갱신 | 통과 | `brain schedules add --kind process_probe --target-kind probe --target-id 720000 --at 16:01 --json`와 `brain schedules run 01a185d2-202f-7271-a1e7-86747a90f4a0 --json` 모두 종료 0. 예약 ID `01a185d2-202f-7271-a1e7-86747a90f4a0`, 일감 ID `01a185d2-37ad-7754-b857-b8b201f0ce34`, `created: true`. 13:02:02의 `queue list --kind process_probe --json`: `state: running`, `attempts: 1`, `last_progress_at: 13:01:53.240+09:00`, `elapsed_ms: 9906`; 13:06:54: `state: running`, `attempts: 1`, `last_progress_at: 13:06:53.905+09:00`, `elapsed_ms: 302316`. 13:05:10 doctor는 통과 23·경고 1·실패 0. |
| 임대 600초 넘김 | 통과 | 13:12:25.458의 `queue list --kind process_probe --json`: `state: running`, `elapsed_ms: 633329`, `attempts: 1`, `attempt_started_at: 13:01:52.128+09:00`. 취소 직전 `SELECT count(*), min(pid), min(pgid) FROM brain.work_attempts WHERE work_item_id='01a185d2-37ad-7754-b857-b8b201f0ce34'`는 `count: 1, pid: 60527, pgid: 60527`, 종료 0. |
| 취소 | 통과 | `brain queue cancel 01a185d2-37ad-7754-b857-b8b201f0ce34 --json` 종료 0, 요청 `13:12:30.262+09:00`, 완료 `13:12:30.690+09:00`. 13:12:35 목록에서 `state: cancelled`, `attempt_outcome: cancelled`, `attempts: 1`, `elapsed_ms: 638535`. `ps -g 60527` 종료 1·프로세스 행 없음(BSD 표제만 출력); 표제를 뺀 `ps -g 60527 -o pid=`는 종료 1·빈 출력. 13:12:42 doctor 통과 23·경고 1·실패 0. |
| 현지 시각 예약 | 통과 | `brain schedules add --kind process_probe --target-kind probe --target-id 5000 --at 13:16 --json` 종료 0. 예약 ID `01a185dc-13c4-76f7-a981-69c5fd05e52a`. 13:12:35의 `schedules list --json`: `last_run_at: null`, `next_run_at: 2026-10-29T13:16:00+09:00`; 13:16:03까지 대상 일감 0건. 13:16:14 목록은 일감 `01a185df-44a8-77dd-944b-29294cb46744` 정확히 1건, `state: succeeded`, `attempts: 1`, `completed_at: 13:16:11.153+09:00`. 발화 뒤 예약은 `last_run_at: 2026-10-29T13:16:04.253+09:00`, `next_run_at: 2026-10-30T13:16:00+09:00`. DB 성공 기록은 `local_date: 2026-10-29` 1행. 데몬 로그 `2026-10-29T04:16:04.317Z 예약 1건 발화, 새 일감 1건`. 13:16:14 doctor 통과 23·경고 1·실패 0. |
| 놓친 예약 | 통과 | `brain schedules add --kind process_probe --target-kind probe --target-id 6000 --at 13:19 --json` 종료 0, 예약 ID `01a185df-7dd3-7652-9260-1cf4511facc1`. 13:16:19의 목록에서 `last_run_at: null`, `next_run_at: 2026-10-29T13:19:00+09:00`. 이어 `brain daemon stop` 종료 0. 중지 중 13:16:27~13:20:05.154의 `queue list --all --kind process_probe --json`에서 대상 일감 0건. 예약 시각보다 65초 지난 뒤 `brain daemon start` 종료 0. 데몬 로그 `2026-10-29T04:20:05.442Z 예약 1건 발화, 새 일감 1건`. 일감 `01a185e2-f2a2-7557-b304-d851d0843d22` 정확히 1건, 13:20:17 목록에서 `state: succeeded`, `attempts: 1`, `completed_at: 13:20:16.546+09:00`. DB `local_date_from = local_date_to = 2026-10-29`, 같은 날짜 성공 기록 1행. 발화 뒤 `last_run_at: 2026-10-29T13:20:05.398+09:00`, `next_run_at: 2026-10-30T13:19:00+09:00`. 13:20:32 doctor 통과 23·경고 1·실패 0. |
| 마지막 doctor | 통과, 기존 경고 1건 | 13:20:33의 `brain doctor run --json` 종료 0: `passed: 23`, `warned: 1`, `failed: 0`, `skipped: 0`. `work-stalled`, `work-died`, `work-unknown`, `work-last-error` 모두 `ok: 0건`; `work-model-usage: ok 입력 0 토큰, 캐시 0 토큰, 출력 0 토큰, 걸린 시간 0초`. 경고는 기존 `last-hook: PLUGIN_DUPLICATE`이며 마지막 hook이 기록한 `<repo>/plugin`과 현재 캐시 플러그인 루트가 다르다는 내용이다. |
| 정리·복구 | 통과 | 아래 SQL 종료 0: 확인용 일감 3건, 성공 기록 2건, 예약 3건, attempt 3건을 정리했고 선행 관계 삭제는 0건. 13:20:32의 `schedules list --json`은 `schedules: []`, `count: 0`; `queue list --all --kind process_probe --json`은 `items: []`, `count: 0`. `brain daemon start` 종료 0(이미 올라 있음), `daemon status`: 빌드 `cdaba22`, pid `72631`, 살아 있음. Compose의 `second-brain-postgres-1`은 `healthy`. |
| 수집이 밀리지 않음 | 통과 | 추가 확인 13:24~13:25 KST. `brain schedules add --kind process_probe --target-kind probe --target-id 720000 --at 16:24 --json` → `brain schedules run 01a185e6-a29a-724f-b915-e6ce60e8c4b9 --json` 모두 종료 0, `created: true`. 예약 ID `01a185e6-a29a-724f-b915-e6ce60e8c4b9`, 일감 ID `01a185e6-ae98-7215-a299-7b29d597e2a8`. 13:24:27의 `queue list --kind process_probe --json`: `running`, `attempts: 1`, `last_progress_at: 13:24:13.060+09:00`, `elapsed_ms: 15051`. `mktemp -d` 임시 폴더에서 `claude -p 'Reply only OK. Do not use tools.' --output-format json`을 한 번 실행: 13:24:32.840 시작, 13:24:36.157 종료, 종료값 0, 3.317초. 세션 ID `72185853-1a45-4a05-b5e0-6af493de50d7`. 13:24:43 PG 조회에서 `brain.sessions` 1건(내부 ID `01a185e7-11bb-72e2-85eb-9b753f693182`), `brain.messages` 2건, `started_at: 13:24:33.342+09:00`, `ingested_at: 13:24:35.555+09:00`, `ingest_source: live` 확인: 세션 시작 약 2.2초 뒤 수집. 그 직후 13:24:43에도 probe는 `running`, `elapsed_ms: 31261`; 13:25:26에도 `running`, `attempts: 1`, `last_progress_at: 13:25:13.197+09:00`, `elapsed_ms: 74492`로 진행 갱신. transcript 본문은 출력·기록하지 않았다. |

### 동시 수집 추가 확인과 정리

- 2026-10-29 오케스트레이터의 해석을 반영했다. 모델·실계정 호출 금지는 Brain에 넣는 일감 종류를 제한하며, 티켓이 직접 요구한 새 `claude -p` 세션 실행은 허용된다. 앞선 충돌 판단을 정정하고 동시 수집 행만 실행했다. 앞서 통과한 배포·600초 임대·현지 예약·놓친 예약은 다시 실행하지 않았다.
- 수집 경로 근거: `~/.second_brain/run/last-hook-claude-code`의 수정 시각은 `13:24:35.500+09:00`, 내용은 `<repo>/plugin`이었다. `daemon.log`에는 `2026-10-29T04:24:35.570Z 되넣음 0건, 실패로 옮김 0건, 새 일감 1건, 다시 못 읽음 0건, 다시 추출 건너뜀 원본 불가 0건, 청구 1건, 완료 1건, 다시 시도 0건, 실패 0건, 돌려줌 0건, 놓침 0건, spool 0건.`이 있었다. PG의 `ingest_source: live`와 hook 도착은 실제 hook 수집 경로를 뒷받침하고, 같은 시각 데몬의 완료 기록도 확인했다. 데몬 로그에는 세션 ID가 없어 그 완료 1건을 이 세션으로 단정하지 않는다.
- 취소 전 attempt 조회는 `count: 1`, PID·PGID `76876`이었다. `~/.second_brain/bin/brain queue cancel 01a185e6-ae98-7215-a299-7b29d597e2a8 --json` 종료 0, 요청 `13:25:26.699+09:00`, 완료 `13:25:27.478+09:00`. 13:25:33 목록에서 `state: cancelled`, `attempt_outcome: cancelled`였고 `ps -g 76876 -o pid=`는 종료 1·빈 출력이었다.
- 아래 정리 절차의 SQL을 변경 없이 다시 실행해 종료 0을 확인했다. 확인용 예약 1건·일감 1건·attempt 1건을 삭제했으며 성공 기록·선행 관계 삭제는 각각 0건이었다. 임시 작업 폴더도 삭제했다. 새 세션과 메시지는 PG의 수집 증거로 유지했다.
- 최종 확인 `13:25:40+09:00`: `schedules list --json`의 예약 0건, `queue list --all --kind process_probe --json`의 일감 0건, `daemon status --json`의 `alive: true`, pid `72631`, 기준 commit 유지. PostgreSQL 컨테이너 `second-brain-postgres-1`은 `healthy`였다. 모든 확인 명령은 종료 0이었다.
- 최종 `doctor run --json`은 `13:25:40.892+09:00`, 종료 0, 통과 24·경고 0·실패 0·건너뜀 0이었다. `work-stalled`, `work-died`, `work-unknown`, `work-last-error`는 모두 `ok: 0건`, `work-model-usage`도 입력·캐시·출력 0 토큰으로 `ok`였다. `last-hook`은 `ok`, 도착 시각 `13:24:35.500+09:00`이며 이전 `PLUGIN_DUPLICATE` 경고는 해소됐다. 새 세션의 SessionStart가 기록한 `run/plugin.json`의 `plugin_root`와 마지막 hook 루트가 모두 `<repo>/plugin`으로 같아졌고, `app_ref`는 기준 리비전 그대로였다.
- PG 확인은 다음 읽기 전용 조회로 세션 ID·시각·건수만 읽었다. 종료값은 0이었다.

```sh
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml exec -T postgres psql -U postgres -d brain -At -c "SELECT s.id,s.harness_session_id,s.started_at,s.ingested_at,s.ingest_source,(SELECT count(*) FROM brain.messages m WHERE m.session_id=s.id) AS messages FROM brain.sessions s WHERE s.harness='claude-code' AND s.harness_session_id='72185853-1a45-4a05-b5e0-6af493de50d7';"
```

### 다시 돌릴 때의 정리 절차

착수 시 확인용 target-id `720000`·`5000`·`6000`의 예약과 일감은 모두 0건이었다. 아래 SQL은 `kind = process_probe`, `target_kind = probe`, 이 세 target-id만 대상으로 하며 운영 세션은 건드리지 않는다. 실행 중인 probe는 먼저 `queue cancel`로 취소하고, `queue list`에서 닫힘 및 해당 PGID 소멸을 확인한 뒤 정리한다. 이번 실행에서 실제 사용한 취소 명령은 `~/.second_brain/bin/brain queue cancel 01a185d2-37ad-7754-b857-b8b201f0ce34 --json`이었다. 정리 시점에는 세 일감 모두 닫혀 있었다.

실제로 실행한 SQL과 마지막 확인 명령은 다음과 같다. 성공 기록의 `work_id` FK를 먼저 풀고, 예약 삭제의 cascade 및 attempt와 현재 attempt 사이의 FK 순서를 따른다. 별도 보류 그룹은 생성하지 않아 삭제할 행이 없다.

```sh
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d brain <<'SQL'
BEGIN;
CREATE TEMP TABLE mac_probe_work_ids AS
SELECT id FROM brain.work_items
WHERE kind = 'process_probe' AND target_kind = 'probe'
  AND target_id IN ('720000', '5000', '6000');
DELETE FROM brain.schedule_successes
WHERE work_id IN (SELECT id FROM mac_probe_work_ids);
DELETE FROM brain.schedules
WHERE kind = 'process_probe' AND target_kind = 'probe'
  AND target_id IN ('720000', '5000', '6000');
DELETE FROM brain.work_dependencies
WHERE work_item_id IN (SELECT id FROM mac_probe_work_ids)
   OR prerequisite_id IN (SELECT id FROM mac_probe_work_ids);
UPDATE brain.work_items SET current_attempt_token = NULL
WHERE id IN (SELECT id FROM mac_probe_work_ids);
DELETE FROM brain.work_attempts
WHERE work_item_id IN (SELECT id FROM mac_probe_work_ids);
DELETE FROM brain.work_items
WHERE id IN (SELECT id FROM mac_probe_work_ids);
COMMIT;
SQL
~/.second_brain/bin/brain daemon start
~/.second_brain/bin/brain schedules list --json
~/.second_brain/bin/brain queue list --all --kind process_probe --json
~/.second_brain/bin/brain daemon status
~/.second_brain/bin/brain doctor run --json
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml ps
```

DB 근거는 모두 다음 명령 형태로 읽었으며 본문·접속 정보는 출력하거나 기록하지 않았다.

```sh
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml exec -T postgres psql -U postgres -d brain -At -c "SELECT w.id,w.target_id,w.outcome,w.local_date_from,w.local_date_to,(SELECT count(*) FROM brain.schedule_successes s WHERE s.work_id=w.id) FROM brain.work_items w WHERE w.kind='process_probe' AND w.target_kind='probe' AND w.target_id='6000'; SELECT schedule_id,local_date,work_id FROM brain.schedule_successes WHERE schedule_id='01a185df-7dd3-7652-9260-1cf4511facc1';"
```

남은 일은 사람의 원격 push다. 실제 `claude -p`를 통한 동시 수집 확인까지 완료했다. 제품 결함은 발견하지 않았고 제품 소스·시험은 수정하지 않았다. 설치본과 플러그인은 검증한 새 버전을 유지했다.

## Plan Change Log

## Review Triage Log

| 판정 | 지적 | 확인 근거와 처리 |
|---|---|---|
| 중간, 미완료 유지 | 동시 수집 확인이 없어 전체 확인 목록 실행 기준이 충족되지 않았다. | 지적을 확인했다. `plugin/hooks/hooks.json`의 Stop·SessionEnd는 별도로 `sessions ingest claude-code`를 호출하므로 probe와 doctor 결과만으로 동시 수집을 증명할 수 없다. 계획의 모델 호출 금지를 유지했고, 요구된 `claude -p` 검증은 미실행이다. 대체 검증이나 범위 제외는 계획 변경이 필요하므로 자동 수정하지 않았다. 당시 해당 작업은 미체크 상태로 유지했다. 아래 추가 확인에서 해소했다. |

- 최종 재확인(13:22:00 KST): `daemon status --json`은 기준 commit·`alive: true`·pid `72631`, `schedules list --json`과 `queue list --all --kind process_probe --json`은 각각 0건이었다. `doctor run --json`은 종료 0, 통과 23·경고 1·실패 0이며 기존 `PLUGIN_DUPLICATE` 경고가 유지되었다.

- 동시 수집 지적 해소(13:25 KST): 오케스트레이터가 금지 조건의 적용 범위를 명확히 했고, 새 `claude -p` 세션이 긴 probe 실행 중 PG에 수 초 안에 저장됨을 확인했다. 수집 행과 작업 체크를 통과로 갱신했다. frontmatter `status`는 요청대로 변경하지 않았다.
- 위 표와 두 줄은 구현 세션(codex)이 스스로 남긴 점검 기록이다. 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 0, false 1, maybe-false 0
- findings:
  - `[false]` `[reject]` `story-mac-plan.md:115-119`: 동시 수집 hook이 설치에 쓴 캐시 루트(`~/.claude/plugins/cache/second-brain/second-brain/0.1.10`)가 아니라 `<repo>/plugin`에서 돌았으므로 지정된 설치본의 수집은 입증되지 않았다(리뷰어 세션 `01a185e9-c8b3-7f53-9863-0a310f7e5b37`) — 반박: 이 Mac의 플러그인은 로컬 marketplace라 Claude Code가 `readFromFolder`(`<repo>/plugin`)에서 hook을 돌린다(`claude plugin list --json`, README "릴리스"). 캐시 루트로 hook이 도는 경로는 이 Mac에 없다. 두 루트는 `diff -r`로 내용이 같고(0.1.10, `app-ref` `cdaba22`), `plugin/bin/brain.sh`는 루트와 무관하게 같은 설치본 shim `~/.second_brain/bin/brain`(빌드 `cdaba22`)을 부른다. 세션은 그 경로로 `ingest_source: live` 수집되었다. 원격 marketplace 캐시 경로는 push 뒤의 일이라 `operator_actions`로 남는다.

## Design Notes

- 확인용 예약을 쓰는 이유: 티켓이 "예약 명령으로 넣은 긴 probe"라 한다. CLI에는 임의 일감을 넣는 명령이 없고 `schedules add` + `schedules run`(수동 실행)이 같은 일감 계약을 쓴다. 긴 probe 예약의 `--at`은 확인 중 발화하지 않을 만큼 멀리(지금+3시간) 둔다.
- 600초를 넘겨 두는 이유: 기본 임대가 600초다. 실제 설치본에서 갱신 없이 다시 청구되지 않는지(`attempts: 1`)를 그대로 볼 수 있다. 12분 probe를 다 기다리지 않고 그 전에 취소해 취소도 함께 본다.
- 정리를 실제로 하는 이유: 매일 예약이 남으면 이 Mac에서 매일 probe가 돈다. 정리 절차는 실제로 돌려 본 것만 plan에 적는다.
- 놓친 예약 시험에서 데몬 멈춤은 `brain daemon stop`(LaunchAgent를 내림)이다. 멈춘 동안 hook·명령은 tick하지 않으므로 일감이 생기면 안 된다.

## Verification

**Commands:**
- `git show --stat HEAD` -- expected: 배포 커밋이 두 파일만 바꿈
- `cat ~/.second_brain/installed.json` -- expected: commit `cdaba2248c6a8ac20ec0dd78bc6a188f24372b8d`
- `~/.second_brain/bin/brain daemon status` -- expected: 살아 있음, 빌드 `cdaba22`
- `~/.second_brain/bin/brain doctor run` -- expected: fail 없음
- `~/.second_brain/bin/brain schedules list --json` -- expected: 확인용 예약 없음
- `~/.second_brain/bin/brain queue list --all --kind process_probe --json` -- expected: 확인용 probe 일감 없음
- `docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml ps` -- expected: postgres healthy

## Auto Run Result

Status: awaiting-operator

- 요약: epic 12 기능 묶음을 플러그인 배포 커밋 `0c309e8cbce5dbae80c797c8991e4a0ef37a65e8`(`plugin/app-ref` → `cdaba2248c6a8ac20ec0dd78bc6a188f24372b8d`, `version` 0.1.9 → 0.1.10)로 이 Mac의 설치본에 넣고 확인 목록을 한 번 돌렸다. push 대신 `~/.second_brain/app` 클론(origin은 GitHub 그대로)에 로컬 객체를 넣고, 로컬 marketplace 플러그인을 0.1.10으로 올린 뒤 SessionStart 명령으로 bootstrap이 갱신 설치했다(스키마 1 → 10, 적용 9건, 데몬을 새 빌드로 다시 띄움).
- 확인 결과(모두 통과): 갱신 설치(설치본 commit = 기준 리비전, 데몬 빌드 `cdaba22`), 예약 명령으로 넣은 12분 probe가 감독자에서 running·진행 갱신, 그 사이 `claude -p` 새 세션이 hook으로 약 2.2초 만에 PG에 수집(`ingest_source: live`), 600초 임대를 넘긴 633초에도 `attempts: 1`, `queue cancel`로 0.4초 안에 `cancelled`·프로세스 그룹 소멸, 현지 시각 예약(13:16) 정확히 1회 발화·성공 기록 1행·다음 발화 내일, 데몬을 멈춘 채 예약 시각(13:19)을 넘긴 뒤 다시 켜자 정확히 1회 발화(`local_date_from = local_date_to = 2026-10-29`), 멈춘 동안 일감 0건, 각 단계 doctor 실패 0.
- 변경 파일: `plugin/app-ref` — 설치할 commit; `plugin/.claude-plugin/plugin.json` — `version` 0.1.10; 이 plan — 확인 증거와 다시 돌릴 때의 정리 절차. 제품 소스·시험 변경 없음.
- 정리: plan의 정리 SQL(확인용 target-id `720000`·`5000`·`6000`로 한정)을 두 번 실제로 돌렸다. 확인용 예약·일감 0건.
- 리뷰: Quick 1건 — false 1(reject, 로컬 marketplace는 `<repo>/plugin`에서 hook을 돌리며 캐시 사본과 내용이 같고 같은 설치본 shim을 부른다). patch 0, defer 0. 후속 리뷰 권고 `false`(patch 없음).
- 검증(오케스트레이터 재확인 13:27 KST): `installed.json` commit `cdaba22…`, `brain daemon status` 빌드 `cdaba22`·살아 있음(pid 72631), `brain doctor run` 통과 24·경고 0·실패 0, `schedules list`·`queue list --all --kind process_probe` 0건, postgres healthy, spool 0개, 배포 커밋이 두 파일만 바꿈, `main`은 `origin/main`보다 앞섬(push 안 함).
- 이 Mac에 남은 변경: 설치본 `cdaba22`·core 스키마 10, 플러그인 `second-brain@second-brain` 0.1.10(로컬 marketplace), 확인 중 만든 Claude Code 세션 2건(`claude -p`)이 Brain에 수집됨.
- 남은 위험: push 전에는 원격 marketplace가 0.1.8(SQLite 빌드)을 내준다. 원격 marketplace 캐시 경로의 설치는 이번에 보지 않았다.
- 사람 몫(`operator_actions`): 원격 push. 티켓 완료 표시는 오케스트레이터가 한다.
