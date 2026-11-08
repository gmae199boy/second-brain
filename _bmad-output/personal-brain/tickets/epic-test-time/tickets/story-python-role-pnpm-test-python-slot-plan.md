---
title: 'Python 통합 시험 slot 병렬 runner (19.5)'
type: 'feature'
ticket: '5'
created: '2026-11-08'
status: 'built'
baseline_revision: 'cb5214293d3169977a6e006940b41da52a305dc8'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-test-time/tickets/story-python-role-pnpm-test-python-slot.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-test-time/tickets/story-python-role-pnpm-test-python-slot-refinement.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `pnpm test:python`은 `fileParallelism: false`로 CLI Python 15파일 + hook 1파일을 한 프로세스에서 직렬 실행해 회귀 시간의 대부분을 차지한다. 확장 role(`brain_ext_*`)이 PG cluster 전역이라 DB·home만 나눠서는 병렬화할 수 없고, 실패·timeout 뒤 자원 소유·정리를 보장하는 실행기가 없다.

**Approach:** 새 slot coordinator가 실행 ID별로 slot마다 독립 PostgreSQL 18 cluster(동적 loopback port, 고유 label)를 소유하고, 파일을 slot에 하나씩 배정해 파일마다 별도 Vitest 자식(자기 process group)으로 순차 실행한다. 파일 경계마다 자식 종료·DB/role/container 잔존 0을 확인한 cluster만 재사용하고, 불명이면 폐기·재생성 또는 quarantine한다. hook은 호스트 공통 잠금의 전용 lane에서 실행한다. 모든 진입점(`pnpm test:python`, 직접 Vitest, `test:changed`)이 같은 slot lifecycle을 쓴다.

## Boundaries & Constraints

**Always:**
- 시험 case·단언·fixture 의미·기존 `testTimeout 120_000`/`hookTimeout 60_000`/hook `SLOW=900_000`·`BRAIN_PYTHON_UPDATE_TEST=1`·조건부 skip을 그대로 둔다. 실제 PG/Python/설치 검증 유지, mock·결과 캐시 금지.
- 생산 role 이름, marker `second-brain extension:<DB>`, advisory lock `4919270912`, grant, `homeResources` 알고리즘, schema 41·migration 0001~0041은 불변.
- 같은 파일 안 동시 extHome은 서로 다른 cluster를 받는다(slot lease는 동시에 한 fixture만). marker 잔존 cluster에는 새 fixture를 배정하지 않는다.
- 자기 장부(run/slot/file/fixture/lease ID, container 전체 ID·name·label, port, 자식 PID/PGID·시작 시각)에 기록된 자원만 정리한다. 이름 접두사·port만 보고 삭제/kill하지 않는다. `no such object`와 transport/권한 오류를 구별한다.
- 원래 실패와 정리 실패를 둘 다 보존하고 exit nonzero. 실패 파일 재시도로 원래 실행을 덮지 않는다.
- slot URL은 54329·54320·운영 URL을 거부한다. Python suite는 공용 compose 54329로 fallback하지 않는다. 기본 suite의 기존 외부 URL/compose 동작은 호환 유지.
- 각 fixture는 private venv/scratch·빈 harness 환경·Python pin(Garmin 3.14.10, pyfixture/pyresume 3.12.13)을 그대로 소유한다. 실제 HOME의 uv cache는 공유 가능하나 실행기가 지우지 않는다.
- 개발·리뷰 수정 중 시험/vitest list/eval/측정 실행 금지, `pnpm build`·`pnpm typecheck`·`git diff --check`만 허용.

**Never:** hook 파일 분할·case 병렬화, hook 중복 제거(19.6), DB template(19.1), 선택 범위 축소·broad rule 축소(19.9), normalize 순서(19.10), 제품/Drive/search SQL/공통 API 기능 변경, 전역 Docker context·`DOCKER_HOST` 변경, 공용 54329·운영 DB·실데이터·credential 사용, 타인 자원 삭제·잠금 탈취, 과거 serial 시간·재배치 모델을 비율 분모로 사용.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 N slot | `--slots N`, manifest 16파일 | 각 파일 정확히 1회, hook은 lane에서 1회, 결과 JSON에 파일/case/pass/fail/skip, exit 0, run 자원 0 | 없음 |
| 파일 assertion 실패 | 주입 fixture가 실패 | 실패 보존·exit nonzero, slot cluster 폐기→새 cluster로 다음 파일, 다른 slot sentinel 통과 | 정리 오류는 별도 기록 |
| 파일 timeout | 주입 fixture가 `--file-timeout` 초과 | 자식 group TERM→deadline→KILL, 실제 종료 확인, 원인 timeout 기록, nonzero | 종료 미확인 → slot quarantine, run 실패 |
| 부분 시작 실패 | create 응답 손실·start 실패 | 고유 name+label+전체 ID로 복구 후 자기 것만 제거 | 생성 여부 불명 → AggregateError, quarantine |
| 경계 불결 | 파일 뒤 비표준 DB·marker role·연결·run label container 잔존 | 해당 cluster 재사용 금지, 폐기·재생성; 성공 파일이면 cleanup 오류로 nonzero | 폐기 불확정 → quarantine |
| coordinator SIGTERM/SIGINT | 실행 중 신호 | 자식 종료·자원 정리 후 128+signal | 정리 실패 함께 보고 |
| coordinator SIGKILL | 장부만 남음 | 다음 실행 시작/`--recover`가 PID+시작시각으로 죽음을 확인한 run의 장부 자원만 정리 | 생존·불명 run은 손대지 않고 보고 |
| 동시 fixture | 한 파일에 extHome 2개 동시 | 첫째는 slot lease, 둘째는 fixture 전용 cluster | lease 반납 전 재획득 불가 |
| 외부 URL 직접 실행 | `BRAIN_TEST_DATABASE_URL` 설정, lease 없음 | 비소유로 취급, lease 없이 fixture 전용 cluster만 사용, 삭제 안 함 | 없음 |
| hook lane 경합 | 두 suite hook 동시 | 호스트 잠금으로 순차, 대기 시간은 wall 포함 | 소유자 생존·불명이면 대기(탈취 금지) |
| hook port 충돌 | `homeResources(home).port` 점유 또는 project/volume 존재 | 새 임시 home 재선택(최대 5회) 후에도 충돌이면 명시 거부 | 타인 자원 보존 |

</intent-contract>

## Code Map

- `apps/cli/python-test/vitest.config.ts` -- include(CLI `**/*.test.ts` + `tooling/bootstrap/test/hook.test.ts`), `fileParallelism:false`, globalSetup `apps/cli/test/global-setup.ts`, env/timeout. globalSetup만 새 Python setup으로 교체, 나머지 불변.
- `apps/cli/test/global-setup.ts` -- `setupTestDatabase` 재수출(기본 apps/cli project도 사용). 기본 suite용으로 그대로 둔다.
- `tooling/test-db/src/global-setup.ts` -- `prepareTestDatabase`: URL 있으면 사용, 없으면 compose 54329 up/down. 기본 suite 계약, 변경 금지(호환).
- `tooling/test-db/src/index.ts` -- `createTestDatabase`/`createDatabaseAt`, `createIsolatedTestDatabase`(fixture `docker create --name brain-fixture-<nonce> --label brain.fixture=<nonce> --tmpfs ... -p 127.0.0.1::5432 postgres:18`, inspect port, TCP 대기 30초, 부분 생성 복구, `fixtureContainerRemoved`/`fixtureDatabaseDropped`). 재사용: docker 래퍼·복구 패턴. 추가: run/slot/file label, slot lease 소비 함수.
- `apps/cli/test/pg-home.ts` -- `pgHome(home, self, createDatabase)`: prepareDatabase→runMigrations→self user→shim/config/.env. createDatabase 인자 주입점.
- `apps/cli/test/ext-fixture.ts` -- `extHome()`가 `createIsolatedTestDatabase`를 pgHome에 전달, brain_owner 소유 변경, cleanup에서 marker 확인 role drop→db.drop→home 정리. 15개 Python 파일 전부 이 경로만 쓴다(`createTestDatabase` 직접 사용 0).
- `packages/postgres/src/extension-provision.ts` -- 읽기 전용: 전역 role·marker·lock 계약 근거.
- `tooling/bootstrap/test/hook.test.ts` -- 동기 `beforeAll`에서 `mkdtemp(tmpdir(),'brain-hook-')`, home=`root/home`, snapshot build; `afterAll`에서 compose `down -v`·inspect 부재 확인. 실제 PG port는 `homeResources(home)`.
- `apps/cli/src/config/resources.ts` -- 읽기 전용: `20000 + hash % 30000` port, project/volume 이름.
- `tooling/test-changed/run.mjs` -- Python 전체/선택을 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts [files]`로 직접 실행 → 새 runner 호출로 교체. `rules.mjs` -- `tooling/test-db/` prefix·`apps/cli/test/global-setup.ts` exact 등 Python 전체 규칙; 새 경로 추가만, 축소 금지. 시험 `tooling/test-db/test/test-changed.test.ts`.
- `package.json` -- `test:python = pnpm build && vitest run --config ...` → runner 호출. `tooling/test-db/package.json` -- tsc build(src→dist), 새 모듈도 여기서 build.
- `.gitignore` -- 장부 디렉터리 추가.

## Tasks & Acceptance

**Execution:**
- [x] 1 `tooling/test-db/src/slots/cluster.ts` -- slot cluster 생성(`docker create --name brain-slot-<run>-<slot>-<gen> --label brain.test-run=<run> --label brain.test-slot=<slot> --tmpfs /var/lib/postgresql -p 127.0.0.1::5432 postgres:18`, 고정 관리자 암호), start·port inspect(127.0.0.1·54329/54320 거부)·TCP 인증 대기, 부분 생성 복구(name+label+64자 ID), 경계 검사(비표준 DB, `second-brain extension:` marker role, 자기 외 연결 수), 정확 ID 제거와 부재 확인(`no such object` 판별) -- 소유 cluster 수명의 단일 원천.
- [x] 2 `tooling/test-db/src/slots/ledger.ts`, `lock.ts`, `processes.ts` -- 장부: `<repo>/.brain-test-runs/<runId>.json` 원자적 rename, coordinator PID+시작시각, slot/파일/자원/정리 시도·오류; 잠금: `/tmp/second-brain-test-locks-<uid>/<name>.lock`(TMPDIR 무관) 원자 생성·소유 PID+시작시각·runId 기록, 소유자 사망이 확인될 때만 회수, timeout으로 탈취 금지, 대기 시간 반환; 프로세스: 단일 1초 `ps -A -o pid=,ppid=,pgid=,lstart=,%cpu=,time=` sampler로 slot별 자손 집합(PID+시작시각) 누적·CPU 집계, group TERM→deadline→KILL·생존 확인 -- 소유권·실패 정리 원천.
- [x] 3 `tooling/test-db/src/slots/lease.ts`, `tooling/test-db/src/index.ts` -- lease 파일(`BRAIN_TEST_SLOT_LEASE` 경로: runId·slotId·fileId·url·container ID·port) 검증과 `acquireTestDatabase()`: lease가 있고 미점유·경계 깨끗하면 slot cluster에 `brain_test_*` DB 생성(drop은 DB만, `fixtureDatabaseDropped` 설정, `fixtureContainerRemoved`는 undefined 유지, 반납 시 점유 해제), 아니면 `createIsolatedTestDatabase`. isolated container에 `BRAIN_TEST_RUN_ID`/`BRAIN_TEST_SLOT_ID`/`BRAIN_TEST_FILE_ID` env가 있으면 같은 label 추가. index에서 재수출 -- slot URL handoff(19.1 소비점).
- [x] 4 `apps/cli/test/ext-fixture.ts`, `apps/cli/test/pg-home.ts` -- extHome이 `acquireTestDatabase` 사용; cleanup의 role 정리 조건을 slot lease에도 맞게(container 미제거·DB 미drop일 때 role drop 먼저) 유지; 오류 보존 불변 -- 파일 내 동시 fixture 별도 cluster.
- [x] 5 `apps/cli/python-test/global-setup.ts`(신규), `apps/cli/python-test/vitest.config.ts` -- lease env가 있으면 lease 검증 후 `BRAIN_TEST_DATABASE_URL`을 slot URL로(소유는 coordinator); 외부 URL만 있으면 비소유 사용; 둘 다 없으면 직접 실행용 1 slot cluster를 자기 runId·장부로 만들고 teardown에서 정확 ID 제거·부재 확인. 54329 fallback 없음 -- 직접 Vitest 진입점.
- [x] 6 `tooling/test-db/src/python-slots.ts`(bin, dist 실행) -- `--slots N`(기본 4, Task 10 측정의 선택 구성으로 확정), `--files ...`, `--file-timeout ms`(기본 1_800_000), `--report <json>`, `--metrics`, `--recover`; manifest는 `vitest list --config apps/cli/python-test/vitest.config.ts --filesOnly --json`; hook 파일은 lane, 나머지는 큐(이전 report의 파일 시간이 있으면 긴 순, 없으면 경로순)로 slot에 배정; 파일마다 `vitest run --config ... <file> --reporter=default --reporter=json --outputFile` 자식(detached, 격리 TMPDIR, lease env); 경계 검사·폐기/재생성·quarantine; 시작 시 dead run 복구; SIGTERM/SIGINT 처리; report에 UTC/monotonic, 파일/case/pass/fail/skip, exit/signal/원인, 정리 증거, CPU/PG 연결 peak, 환경 지문(Node/pnpm/Vitest/uv python find 출력/lock hash/PG image ID/Docker CPU·RAM/SHA) -- 단일 runner.
- [x] 7 `tooling/bootstrap/test/hook.test.ts` -- beforeAll 맨 앞에서 호스트 `hook-lane` 잠금 획득(별도 `beforeAll(..., SLOW)`), afterAll 마지막 해제; home 결정 후 `homeResources(home)`의 port bind 가능·project container·volume 부재 확인, 충돌이면 새 root 재선택(최대 5회) 후 명시 실패; case·순서·SLOW·Python flag 불변 -- 두 suite hook 경합·port 충돌 차단.
- [x] 8 `package.json`, `tooling/test-changed/run.mjs`, `tooling/test-changed/rules.mjs`, `tooling/test-db/test/test-changed.test.ts`, `.gitignore` -- `test:python = pnpm build && node tooling/test-db/dist/python-slots.js`; test:changed Python 전체/선택을 runner(`--files`)로; rules에 `apps/cli/python-test/global-setup.ts` exact와 runner 경로 이유 추가, 기존 규칙 유지; 규칙 시험 추가; `.brain-test-runs/` ignore -- 모든 진입점 연결.
- [x] 9 시험 코드: `tooling/test-db/test/slots-*.test.ts`(cluster/ledger/lock/processes/lease 단위, docker 주입), `tooling/test-db/test/python-slots.test.ts`(실 docker 통합: 합성 fixture `tooling/test-db/test/fixtures/slot-runner/`의 pass/fail/timeout/hang-child/leak/partial-start/SIGTERM/SIGKILL-recover/sentinel 파일과 전용 config로 runner 실행, 다른 slot·같은 slot 후속·새 run sentinel 통과와 run label 자원 0 단언) -- I/O Matrix 전 행 덮음.
- [x] 10 (지휘자, 모든 구현·리뷰 수정 뒤) Verification 절차 수행·증거를 `.brain-automation/verify/`에 보존, 계획에 결과·선택 slot 수 기록 -- AC5·AC6.
- [x] 11 `tooling/test-db/src/slots/case-shards.ts`(신규), `tooling/test-db/src/python-slots.ts` -- (2026-11-08 중앙 조건부 승인 A) 배정 단위를 "파일 또는 독립성이 정적으로 입증된 파일의 case shard"로 넓힌다. 정적 allowlist(`CASE_SHARD_FILES`: 경로·독립성 근거; 현재 `apps/cli/python-test/garmin-report.test.ts`만 — 각 case가 자기 extHome/서버/DB와 finally 정리를 소유, 공유 beforeAll·순서 의존·전역 가변 fixture 없음)만 shard하고, 나머지는 파일 단위. 분할 정책은 "allowlist 파일의 case마다 1 job"으로 고정해 1/2/3/4 slot 모두 같다. case ID는 실행 없는 수집(`vitest run <file> -t <절대 불일치 패턴> --reporter=json`, 비소유 더미 URL, 모든 결과가 skipped인지 확인)으로 it.each 확장 fullName을 얻고, 중복·빈 이름·0개는 거부한다. 각 job은 `-t '^<regex escape(fullName)>$'`로 실행하고 reporter JSON에서 선택 case가 정확히 1개 실행(passed/failed, 또는 기존 조건부 skip)됐는지, 나머지는 필터 제외로 집계에서 빠지는지 검증한다(선택 case 누락·0 match·복수 match는 실패). report는 원 파일별로 case 결과를 합쳐 manifest case 수와 대조하고 job별 slot·wall·로그를 남긴다. `--order`는 job ID(`file#fullName`) 시간도 받는다. 시험 파일·단언·timeout 불변. 직접 Vitest 경로는 파일 단위 그대로, runner의 전체·`--files`(test:changed 포함) 경로는 같은 정책. 시험: 단위(수집 파싱·중복 거부·패턴 escape·결과 검증·집계)와 합성 통합(독립 case 3개 fixture를 시험용 allowlist override로 shard, 1·2 slot에서 각 case 1회·자원 0).

**Acceptance Criteria:**
- Given baseline manifest(파일·case·조건부 skip)가 고정됨, when `pnpm test:python`·직접 Vitest·`pnpm test:changed`의 Python 경로를 실행, then 선택 파일·case가 정확히 1회 실행되고 pass/fail/skip이 baseline과 같으며 Python 하위 unittest 출력이 파일 로그에 남는다.
- Given 1·2·3·4 slot이 동일 SHA·환경·좁은 묶음(최장 CLI 6파일+hook)으로 고정됨, when 각 warm-up 1+유효 3표본, then 선택 구성 `median(N)/median(1) <= 0.5`이고 결과 동등·자원 0이다. 미달이면 built 금지.
- Given 성공·실패·timeout·SIGTERM·SIGKILL 각 실행 뒤, when `docker ps -a --filter label=brain.test-run=<run>`·장부·`ps`를 확인, then 자기 container/volume/port/자식 잔존 0이고 실패 경로는 nonzero와 원인·정리 오류를 보존한다.
- Given 기본/Python Vitest를 build 뒤 1회 병행, when 둘이 끝남, then 서로 다른 cluster, hook 순차(lane 잠금 기록), 두 결과 정상이고, 이후 `pnpm test` → `pnpm test:python` 각 1회 순차 통과와 시간·CPU·PG 연결·정리 결과가 남는다.

## Implementation Notes

- 2026-11-08 지휘자: 구현은 Terra 워커 1개(Run `run_41e963c37378`, 최초 Dispatch `ctx_c1c5a154488a` ready·depth 1)에 Task 1~6으로 순차 전달했다(Task 1=Execution 1·2, 2=Task1 보완+3, 3=4·5, 4=6, 5=7·8, 6=9+`--config`). 각 Task 보고는 `.brain-automation/reports/impl-task{1..6}.md`(로컬 비공개).
- Task 1 부분 결과 뒤 지휘자 리뷰로 공유 `ps` sampler, `pg_stat_activity` 배경 프로세스 제외(`backend_type='client backend'`), `LC_ALL=C`, PID 재사용 판정, group 이탈 자손 신호를 Task 2에서 보완했다.
- Task 2는 Codex 주간 한도(`usageLimitReached`)로 한 번 중단됐고, 사용자 한도 재설정 뒤 같은 Dispatch로 재개했다(편집 0건 상태에서 재시작).
- 22.3 측정 창(T49 03:52:54Z~, 조기 해제) 동안 Task 2·3은 compile을 금지했고, Task 4에서 누적 build/typecheck를 확인했다(최종 종료 코드 0).
- 결정: manifest 수집은 lease/run 변수를 지우고 비소유 `127.0.0.1:1` URL을 줘 global setup이 cluster를 만들지 않게 한다. 직접 실행 global setup은 runId별 장부·lease를 `.brain-test-runs/`에 둔다. hook 자원 검사는 `tooling/bootstrap/test/hook-resources.ts`로 분리했다. 합성 fixture는 `*.fixture.ts`로 기본 suite include(`test/**/*.test.ts`)에 걸리지 않는다.
- 개발 중 시험·`vitest list`·runner 실행·docker PG 생성은 하지 않았다(AGENTS). Verification의 시험·측정은 모든 리뷰 수정 뒤 실행한다.
- 지휘자 확인 결함(리뷰 triage에 포함): 완료된 장부가 남아 매 실행 복구 대상이 되고, 직접 실행 장부의 PID 없는 `direct` 파일 항목이 `recorded child identity is unknown` 오류로 이후 모든 runner 실행을 nonzero로 만든다(`tooling/test-db/src/python-slots.ts` recoverRuns·`apps/cli/python-test/global-setup.ts`).
- 2026-11-08 리뷰 수정(F1~F9·지휘자 lock 2줄)과 리뷰 round 1~7로 수렴. 수정 구현자: Terra `ctx_268443d51e89`(F1~F5), Terra `ctx_269af39d476e`(S1·S2·F6~F9).
- 2026-11-08 검증 중간(체크포인트 커밋 시점, **built 아님**): `pnpm build`·`pnpm typecheck`·`git diff --check` 0; `pnpm exec vitest run --project test-db` 13파일 81시험 통과(05:40:13Z~05:42:41Z); 1 slot 선정 진단 `v4-select-1slot`(05:02:45Z~05:13:30Z, wall 644.7초, 15/16 통과, garmin-core 2 case 실패 = 별도 bug 19.11, 기존 경로에서도 재현); garmin-report 실제 shard 4 slot 15/15 통과·wall 139.9초(기능 확인, 성능 표본 아님). 미완료: 19.11 수정 source 통합 뒤 core·native 영향 시간 대조와 묶음 동결, 1/2/3/4 slot 확정 실측(중앙 창 조율), 기본/Python 병행 1회, 최종 `pnpm test` → `pnpm test:python`. 원시 증거는 로컬 `.brain-automation/verify/`(비공개).
- 2026-11-08 측정 진행(source `65792e86acb92ed121a224026a938731249809bd` = 19.5 checkpoint e8baaad + main 7c72cbf; 동결 묶음 `.brain-automation/verify/frozen-bundle.json` = garmin-report(case shard 15 job)·core·artifacts·import-verify·native·batch-import + hook; driver `.brain-automation/verify/tools/measure.mjs` 독립 확인 impact r1·driver r2~r5). 1 slot: warmup1 656.3초(표본 아님), sample1 660.3·sample2 650.1·sample3 650.2초 → 중앙값 650.2초(분모), 모두 exit 0·정책/환경 일치·run 자원 0·quarantine 0. 각 호출은 중앙 명시 창(W1~W4) 안에서 1회씩. 2/3/4 slot은 창 승인 대기.
- 2026-11-08 측정 계속(같은 source 65792e8, 창 W5~W9): 2 slot warmup1 344.1초, sample 351.2/347.2/343.0 → 중앙값 347.2초, 비율 0.534(>0.5, 미달). 3 slot warmup1 257.0초, sample 256.9/254.0/256.9 → 중앙값 256.9초, 비율 0.395(≤0.5). 4 slot warmup1 **exit 1**(09:37:54Z~09:41:23Z, 208.2초): garmin-artifacts "재발행 staging과 core 정리는 같은 locator 잠금으로 직렬화된다" 1 case 실패(374행 세 번째 Python exit1, stderr 미기록), 나머지 50/51 pass, 자원 0 — 규칙대로 sample 미실행. 결과: 1/2/3 slot valid, 4 slot invalid → 네 구성 전체 gate **미충족**(E19-5 미판정).
- W9 원인 조사(중앙 A안): 4 slot 진단 1회(artifacts+동시 3 job, 관측기) 재현 안 됨; 독립 정적 추적(`.brain-automation/review/w9-trace.md`)은 slot 간 DB·lock·staging 직접 공유 경로 없음, 후보는 보존 어댑터 DB 제한(1.5/1.9/2초) 초과 또는 core cleanup의 cleaned_at 커밋 뒤 별도 unlock 경합(미확정). 중앙이 별도 bug 19.12로 분리(소유: 시험/보존 어댑터, 필요 시 제품). 19.12 수정 수락 뒤 고정 새 source에서 1/2/3/4 전 구성 재측정 필요 — 위 표본은 다른 source 이력으로만 보존, 재사용 안 함. 기본 `--slots`(현재 4) 최종 선정은 전 구성 gate 뒤.
- 2026-11-08 재측정 1차(source fb0cd31 = 19.5 + main 2f23d30: 8.4·19.12·22.3·22.6, schema 43; 동결 v2 `.brain-automation/verify/frozen-bundle-v2.json`, out `measure-v2/`): V1 1 slot warmup1 exit 0 700.0초(21 job·54 case, 표본 아님); V2 1 slot sample1 **exit 1** — 시험 54 case 전부 pass였으나 `--metrics`의 `docker stats`가 stderr `EOF`로 실패해 측정기가 실행 실패로 판정(무효, 재시도 없음, 원인 미확정). 중앙 A안으로 F10/F10b(측정기 소멸 판정: 정확 ID inspect 부재만 근거, 일부 부재는 생존 ID 재수집 1회·값 개수 일치 시만 recovered, 처분 `dockerStatsRecoveries` 기록) — 독립 확인 `f10-review.md`→`f10b-review.md` resolved, test-db project 13파일 82시험 통과. measure-v2는 이력 전용, 새 source로 전 구성 재측정.
- 2026-11-08~09 재측정 v3(source `87f7b3e79e74b3da7a1de055259ed0016a989567`, 동결 v3, out `measure-v3/`, 중앙 창 V1~V10): 16호출(warmup 4 + 표본 12) 전부 exit 0, 모두 같은 21 job·54 case 선정·전부 pass, 정책·환경 일치, run 자원·quarantine·cleanup·metrics 오류 0, `dockerStatsRecoveries` 1건(1 slot warmup1, recovered). 중앙값 1/2/3/4 slot = 694.5/350.0/268.0/215.5초, 비율 1/0.504/0.386/0.310(원시 0.310365964) → **E19-5 gate 충족, 선택 4 slot**(≤0.5 중 중앙값 최소), 기본 `--slots` 4 유지. 원시 대조 `.brain-automation/verify/measure-v3/gate-result.md`·`audit-v3.json`. V9 결과 보고는 지휘자 세션 지연으로 실행 종료(16:46:15Z) 뒤 19:10Z.
- 2026-11-08 기본/Python Vitest 병행 1회(build 뒤 Vitest process만, 서로 다른 소유 PG): Python 직접 실행 exit 0(16파일 76시험); 기본 exit 1 — install-legacy-manifest 4건은 지휘자가 검증 PG 관리자 암호를 `postgres`가 아닌 값으로 띄운 환경 오류(암호 `postgres` PG 단독 재실행 통과), Drive 10건(tracer 30초 timeout 9 + parser 단언 1)은 main 2f23d30 사본에서도 재현 → 19.13 분리. 자원 정리 0, 장부 completed. hook lane 실제 직렬화는 이 실행 로그로 입증 불가(필수 미확인) → 표적 관측 1회(`.brain-automation/verify/parallel/hook-lane-observed.md`): 같은 `hook-lane` 잠금, 다른 PID 81604/81709, 기본 waitMs 4 → Python waitMs 68303(기본 보유 68.97초와 일치), owner 표본 142개 동시 소유 0, 두 경로 hook 통과 — 직렬화 동적 근거로 채택(정확한 해제 시각 미기록·1초 표본 한계).
- 2026-11-08 최종 순차 회귀(`.brain-automation/verify/final/final-regression.md`): `pnpm test` **exit 1**(5007 중 11 실패: Drive 10 = 19.13 소유 기존 결함, `redaction.test.ts` 1 = `brain.failures` 1 기대/2 실제, 단독 39/39 통과는 원인 해결 아님 → 중앙이 19.14 후보로 분리, 증거 `redaction-evidence.md`), `pnpm test:python` **exit 0**(runner 4 slot, 16파일 76 case, 226.7초, 자원 0). AC6의 "마지막 pnpm test 통과"는 **미충족** — 19.13/19.14 수정 source 인계 뒤 통합·독립 영향 확인·관련 재검증(test:changed/관련 시험)으로 닫는다. **built 아님.**
- 2026-11-08 최종 통합·재측정 v4(source `8f553a31da3bc19defbddea575c896a15d26572a` = 19.5 + 수락 main 4d636c6: 19.13 Drive·HOME 후속, 19.14 redaction): 통합 독립 영향 확인 r3·r4 발견 없음, 관련 재검증 Drive 두 파일 45/45, `pnpm test:changed -- 87f7b3e…` exit 0(기본 --changed 3파일 86, Python 전체 16파일 76). 측정 16호출 전부 exit 0·같은 21 job·54 case·정책/환경 일치·자원/quarantine/cleanup/metrics 오류 0. 중앙값 1/2/3/4 slot = 650.1/347.1/256.0/209.1초, 비율 1/0.5339085/0.3937997/0.3216633 → **E19-5 gate 충족, 선택 4 slot**, 기본 `--slots` 4 유지(`.brain-automation/verify/measure-v4/gate-result-v4.md`). v3(87f7b3e, 0.3103660) 등 이전 표본은 각 source 이력.
- AC6 상태: 최초 필수 전체 `pnpm test`(87f7b3e) exit 1은 19.5 밖 기존 결함(Drive 10 → 19.13, redaction 1 → 19.14)이며 두 수정 수락 뒤 관련 재검증·test:changed 통과로 닫혔다. 최초 결과를 소급해 통과로 표기하지 않는다. `pnpm test:python` exit 0. hook lane 직렬화는 표적 관측으로 동적 근거 확보(해제 시각 미기록 한계).
- 위생: 시험 실행이 저장소에 이미 추적 중인 `extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc`를 바꾼다(기존 커밋의 위생 문제, 19.5 범위 밖). 실행 뒤 `git checkout`으로 되돌리고 커밋하지 않는다.

## Plan Change Log

- Decision(2026-11-09, 중앙 msg_4cf6d1210e79): AC6 실패 처분 수락 해석 — 최초 필수 전체 순차 회귀(source 87f7b3e) `pnpm test` exit 1(19.5 밖 기존 결함: Drive tracer timeout 9·parser 단언 1, redaction 1)·`pnpm test:python` exit 0을 그대로 보존한다. 실패는 19.13·19.14로 분리·수정·수락됐고, 수락 main 통합 뒤 독립 영향 확인 r3/r4, 관련 재검증(Drive 45/45), `pnpm test:changed -- 87f7b3e…`(기본 --changed 86: Drive 45·redaction 41, Python 76) 통과로 AC6 실패를 닫는다(AGENTS "시험 실행 범위": 최초 전체 각 1회 뒤 교정 재검증은 관련 시험·test:changed; 정제 문서 기능 검증 5 동일). 원 AC6 문구·최초 결과는 지우지 않으며, 결합 source(8f553a3)에서 전체 `pnpm test`→`pnpm test:python`은 실행하지 않았다는 한계를 남긴다.

### 2026-11-08 — 선정 진단 뒤 배정 단위 확장 (중앙 승인, 사용자 의도 불변)
- 계기: 1 slot 선정 진단(`.brain-automation/verify/v4-select-1slot.json`, 05:02:45Z~05:13:30Z)에서 garmin-report 단일 파일 349.0초 — 동결 규칙의 최장 CLI 6파일 합 ≈527초 중 66%라 파일 단위 slot으로는 비율 ≤0.5가 구조적으로 불가(하한 추론, 성능 달성 증거 아님). 질문 `msg_a75cff2f9011`, 중앙 회신 `msg_a45245c69050`(판단1 A 조건부 허용).
- 변경: Execution 11 추가(독립성 입증 파일의 case shard, 정적 allowlist, case별 1 job 고정 정책, 확장 fullName ID 수집·검증, 원 파일별 집계). Design Notes에 근거 추가. "slot 안 파일은 순차" 의미는 job(파일 또는 case shard) 단위 순차로 읽는다. intent-contract는 수정하지 않았다.
- 피한 나쁜 상태: N에 따라 분할을 바꾸거나 분모에만 낭비를 넣어 목표를 맞추는 것, 선택 case 누락·필터 skip을 성공/skip으로 세는 것, 공유 상태가 있는 파일을 shard하는 것.
- KEEP: Execution 1~10의 구현·리뷰 수렴 결과(round 1~4)와 slot/lease/장부/복구/hook lane/lockf 잠금 계약 전부 유지. 기존 시험 파일·단언·timeout 불변.
- 별건: garmin-core 2 case 실패(sendPhoto 0/sendMediaGroup 1)는 slot 미사용 기존 경로로도 재현(`v5-garmin-core-isolated-path.log`)되어 중앙이 별도 버그로 분리·배정한다. 19.5는 실패 case 제외·단언 완화·실패 표본 분모 사용·built 면제 없이, 그 수정의 main 통합과 관련 재검증 뒤 최종 전체 회귀 통과가 필수다.

## Review Triage Log

### 2026-11-08 — Review pass (round 1)
- 리뷰: Sol gpt-6.1-sol/medium 4렌즈(Run `run_41e963c37378`; blind-hunter `ctx_14fe5f7de43c`, edge-case-hunter `ctx_aa2905a5d6d0`, verification-gap `ctx_e293f8823fc7`, intent-alignment `ctx_d7260ec7250d`), diff `.brain-automation/review/diff-r1.patch`(114,400B), 원문 `.brain-automation/review/r1-*.md`(로컬).
- verdicts: 22 findings — high 7, medium 10, low 2, false 3, maybe-false 0 (VG 2, ECH 5, BH 10, IA 5 관찰 중 B·C는 결함, A·D·E는 비결함)
- 묶음: G1 직접 실행 장부·복구(VG1·ECH2·BH1·IA-B), G2 manifest, G3 경계 조회 timeout(ECH3·BH4), G4 잠금 게시/회수(ECH4·BH3), G6 hook Compose 자원(BH2·IA-C).
- findings:
  - `[high]` `[patch]` VG1 직접 Vitest 장부→다음 runner 복구 연결 시험 없음 — 사전 검증 gap. 조치: setup→teardown→사망 주입→실제 `recoverRuns` 시험 추가(G1).
  - `[medium]` `[patch]` VG2 `--metrics` 보고 필드 검증 없음 — 사전 검증 gap. 조치: 연결 유지 fixture로 세 peak·errors 단언 시험 추가.
  - `[high]` `[patch]` ECH1 `vitest list --filesOnly --json`이 `{file, projectName}[]`를 반환(설치본 `formatFilesAsJSON` 확인)하는데 runner는 문자열만 허용 → 모든 runner 실행이 invalid manifest로 실패. 조치: 객체 `file` 파싱.
  - `[high]` `[patch]` ECH2 직접 장부 `files:[{fileId:'direct'}]`가 복구에서 `recorded child identity is unknown` → 이후 모든 실행 nonzero(G1, `python-slots.ts` recoverRuns·`global-setup.ts`). 조치: 장부 `kind`·`state(completed)` 도입, 완료 장부 건너뜀, direct는 자식 종료 대신 container만 복구.
  - `[medium]` `[patch]` ECH3 `checkClusterBoundary`의 connect가 try 밖·timeout 없음 → 경계 검사가 무기한 대기(G3). 조치: 연결/쿼리 timeout, connect를 try 안으로, 실패 시 quarantine.
  - `[medium]` `[patch]` ECH4 회수 guard 디렉터리 생성 뒤 SIGKILL 시 영구 EEXIST(G4). 조치: guard에 소유 신원 기록, 사망 확인 시 회수.
  - `[low]` `[patch]` ECH5 pnpm spawn 실패 시 `completion` 거부 미처리 → 프로세스 비정상 종료. 조치: 생성 즉시 catch 연결(직접 수정).
  - `[high]` `[patch]` BH1 = ECH2(G1).
  - `[high]` `[patch]` BH2 hook을 강제 종료하면 afterAll 미실행으로 Compose container·volume이 runner 소유 기록 밖에 남음(G6). 조치: runner가 hook 자원 기록 파일 env를 주고 hook이 home/project/volume을 기록, lane 종료·복구에서 정확 project/volume만 제거·부재 확인. 제품 `homeResources` 불변.
  - `[medium]` `[patch]` BH3 잠금 파일을 만든 뒤 JSON을 쓰는 사이 중단되면 빈/부분 JSON이 영구 대기를 만듦(G4). 조치: 완성된 내용을 임시 파일에 쓴 뒤 `link`로 원자 게시, 해석 불가 잠금은 명시 오류 보고(시간 기반 삭제 금지).
  - `[medium]` `[patch]` BH4 = ECH3(G3).
  - `[medium]` `[patch]` BH5 일시적 `ps` 실패가 `samplingFailed`를 영구화해 이후 TERM을 아예 시도하지 않음. 조치: 종료 시도는 현재 표본으로 계속 수행, 과거 실패는 quarantine 판정에만 사용.
  - `[medium]` `[patch]` BH6 metrics 표본이 정상 fixture/slot 삭제와 경합해 `metricErrors`로 성공 실행을 실패시킴. 조치: 표본 중 사라진 container·끊긴 연결은 오류가 아닌 관측 종료로 분류.
  - `[low]` `[patch]` BH7 manifest `vitest list` 자식에 timeout·신호 연동 없음. 조치: timeout과 interrupt 시 kill.
  - `[medium]` `[patch]` BH8 case 실패 집계가 timeout/signal 원인을 `fail`로 덮음. 조치: 원래 reason 유지, case 실패는 별도 필드.
  - `[medium]` `[patch]` BH9 PG 연결 peak가 slot cluster만 집계하고 run-label fixture cluster를 빼 범위가 Docker CPU와 다름. 조치: run-label fixture cluster 포함, hook 제외 범위를 report에 명시.
  - `[medium]` `[patch]` BH10 `pnpm test:python` 실패 시 터미널에 실패 파일·보고서·로그 위치가 출력되지 않음. 조치: 시작/종료 요약과 실패 파일 로그 경로·꼬리를 stderr로 출력.
  - `[false]` `[reject]` IA-A 실제 baseline case 동등성 증거가 diff에 없음 — 코드 결함 아님. Verification 1·2에서 baseline/HEAD case 목록과 runner report를 대조해 생성할 증거.
  - `[high]` `[patch]` IA-B = ECH2(G1).
  - `[high]` `[patch]` IA-C = BH2(G6).
  - `[false]` `[reject]` IA-D 외부 URL 54329 보존 — Python fixture는 lease가 없으면 항상 fixture 전용 cluster를 쓰고 `BRAIN_TEST_DATABASE_URL`에는 연결하지 않는다(`requireAdminDatabaseUrl` 존재 확인만, python-test 직접 사용 0건). 공용 54329 사용이 발생하지 않음.
  - `[false]` `[reject]` IA-E 성능 비율·병행·최종 회귀 결과 부재 — 개발 종료 뒤 Verification 4~6에서 생성할 증거이며 코드 결함 아님.
- 계: patch 19행(묶음 G1·G2·G3·G4·G6 + 단독 9건), reject 3행, defer 0. 수정은 새 Terra 구현자(기존 워커 Task 6개 도달)에게 F1~F3로 나눠 보낸다.

### 2026-11-08 — Review pass (round 2, 후속)
- 리뷰: Sol gpt-6.1-sol/medium 2렌즈 — resolution(round 1 patch 19행 해결 판정+수정 회귀, `ctx_fd7daefd284b`), edge-case-hunter(`ctx_2a69c4875083`). diff `.brain-automation/review/diff-r2.patch`(140,977B), 원문 `.brain-automation/review/r2-*.md`. round 1 행 판정: resolved 17, partially 2(ECH4·BH7), unresolved 0.
- verdicts: 7 findings — high 2, medium 3, low 1, false 0, maybe-false 0 (+ partially 판정 2행은 아래 B1·BH7 행으로 처리)
- findings:
  - `[high]` `[patch]` R2-ECH1 파일 장부 저장 뒤 spawn이 ENOENT/EACCES로 실패하면 PID 없는 항목이 남아 이후 `recoverRuns`가 매번 예외 → 모든 실행·`--recover` 실패. 조치(F4): 자식 미생성 확정 시 `processState:'gone'`(또는 `notStarted`) 기록.
  - `[high]` `[patch]` R2-ECH2 직접 Vitest의 추가 동시 fixture cluster(run·slot label 보유)가 SIGKILL 뒤 복구 owned 집합에 없어 remaining으로 남고 이후 실행 실패. 조치(F4): direct 장부 복구에서 `brain.test-run=<그 runId>`와 `brain.fixture` label을 모두 가진 container를 소유로 인정(runId는 무작위 고유값).
  - `[medium]` `[patch]` B1(ECH4 partially) rename 기반 회수가 살아 있는 소유자 경로를 일시 제거해 동시 진입 가능. 조치(F5): 잠금을 커널 잠금(`/usr/bin/lockf -k` 보유 helper, 부모 사망 시 stdin EOF로 자동 해제)으로 교체해 stale 회수 로직 자체를 제거.
  - `[medium]` `[patch]` B2 hook 강제 종료 복구가 Compose 기본 network(`<project>_default`)를 남기고 정리 완료로 보고. 조치(F4): project label 확인 후 network 제거·부재 확인.
  - `[medium]` `[patch]` B3 복구 성공 장부를 completed로 전이하지 않고 direct lease를 남김 → 반복 복구·Docker 장애 시 새 실행 실패. 조치(F4): 정리·부재 확인 성공 시 completed 기록, direct lease 정확 경로 삭제, 재복구 무작업 시험.
  - `[low]` `[reject]` BH7 partially — manifest `vitest list` 자식이 장부/추적에 없음. 이 자식은 비소유 더미 URL로 cluster를 만들지 않고 스스로 종료하며, timeout·abort 연동은 이미 있다. coordinator SIGKILL 직후 잠시 남는 자원 없는 프로세스는 일상 사용에서 해가 작고 추적 추가는 복잡도가 커 기각.
  - `[medium]` `[patch]` R2-ECH2·B3 연관 시험 공백 — `python-global-setup.test.ts`가 복구 후 state·lease 부재·재복구 무작업을 단언하지 않음. 조치(F4) 시험 추가.
- 계: patch 6행(F4: R2-ECH1·R2-ECH2·B2·B3·시험, F5: B1), reject 1행, defer 0.

### 2026-11-08 — Review pass (round 3, 후속 해결 확인)
- 리뷰: Sol resolution `ctx_acde9c4ad799`, diff `.brain-automation/review/diff-r3.patch`(145,644B), 원문 `.brain-automation/review/r3-resolution.md`. round 2 patch 6행 모두 resolved.
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R3-1 lockf 획득과 timeout이 경합하면 timeout 경로가 stdin을 닫지 않아 이미 시작된 `cat`이 남고 `close` 대기가 끝나지 않을 수 있음(`tooling/test-db/src/slots/lock.ts`). 조치: kill 전에 `child.stdin.end()` — 지휘자 직접 적용(구현 워커가 Task 6개 상한, 수정 2줄).
  - `[low]` `[patch]` R3-2 release가 커널 잠금을 푼 뒤 owner 진단 파일을 지워 다음 owner의 파일을 지울 수 있음. 조치: owner 파일 삭제를 커널 잠금 해제 전에 수행, 삭제 오류는 해제 뒤 전파 — 지휘자 직접 적용(직접 수정).
- 지휘자 확인: `pnpm build` 0, `pnpm typecheck` 0, `git diff --check` 0(로그 `.brain-automation/build-conductor-r3fix.log`·`typecheck-conductor-r3fix.log`). 마지막 실질 수정의 독립 확인은 round 4(`ctx_9ef024b0010b`).

### 2026-11-08 — Review pass (round 4, 잠금 수정 독립 확인)
- 리뷰: Sol `ctx_9ef024b0010b`, 원문 `.brain-automation/review/r4-lock.md`. R3-1·R3-2 resolved, 새 발견 없음.
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 수렴: round 1(22)→2(7)→3(2)→4(0). 남은 구현 수정 없음. 다음은 Verification(시험·측정) 단계.

### 2026-11-08 — Review pass (round 5, case shard 확장 뒤 전체 4렌즈)
- 리뷰: Sol 4렌즈(blind-hunter `ctx_51d6c1fce865`, edge-case-hunter `ctx_d3e17e95705b`, verification-gap `ctx_c058094c27d6`, intent-alignment `ctx_9677097e756c`), diff `.brain-automation/review/diff-r5.patch`(161,133B), 원문 `.brain-automation/review/r5-*.md`.
- verdicts: 15 findings — high 0, medium 10, low 4, false 1, maybe-false 0
- 묶음: G-A 선택 이름·0-match(ECH5-1·BH5-1·BH5-2·IA5-1), G-J 시험 공백(VG5-1·BH5-10).
- findings:
  - `[medium]` `[patch]` VG5-1 실패·skip이 섞인 shard의 파일 집계를 실제 runner로 검증하지 않음 — 사전 검증 gap. 조치(F8): pass+fail 혼합 shard 통합 시험(아래 G-A 정책상 allowlist 파일은 skip 불가).
  - `[medium]` `[patch]` ECH5-1 중첩 describe에서 JSON `fullName`(공백 결합)과 `-t` 대상 `fullTestName`(` > ` 결합)이 달라 선택 case가 필터 제외되고 skip으로 성공 처리됨(G-A). 조치(F6): 수집 시 `ancestorTitles`+`title`로 filter 이름을 따로 보존해 패턴에 사용.
  - `[medium]` `[patch]` ECH5-2 기본 수집(`-t` 불일치)이 suite를 skip해 `afterAll`이 안 돌고 `environment.ts`가 import 때 만든 임시 폴더가 누적. 조치(F6): 수집 자식에 run dir 하위 전용 TMPDIR, 종료 뒤 삭제.
  - `[medium]` `[patch]` BH5-1 = ECH5-1(G-A).
  - `[medium]` `[patch]` BH5-2 선택 case의 skipped를 기존 조건부 skip으로 입증 못 해 0-match도 성공(G-A). 조치(F6): allowlist 파일은 조건부 skip/todo/only가 없어야 한다는 정적 조건을 수집 시 소스 검사로 강제하고, 선택 case가 skipped면 실패로 판정.
  - `[medium]` `[patch]` BH5-3 shard 하나가 JSON을 못 남기면 파일의 확인된 pass/fail까지 사라짐. 조치(F7): 확인된 집계 유지 + expected/completed/missing 기록, 파일은 실패 유지.
  - `[low]` `[patch]` BH5-4 shard 파일 요약의 start/wallMs가 첫 완료 job·job wall 합. 조치(F7): start=min, end=max, wallMs=end−start, `jobWallSumMs` 별도.
  - `[low]` `[patch]` BH5-5 실패 shard 파일 요약의 대표 로그·signal·cleanup이 첫 완료 job 값. 조치(F7): 실패 job을 대표로, job ID·로그 목록 연결.
  - `[low]` `[patch]` BH5-6 `--file-timeout`이 2,147,483,647 초과를 허용해 즉시 timeout. 조치(F6): 상한 검증(직접 수정).
  - `[medium]` `[patch]` BH5-7 빈 manifest를 exit 0 성공 처리. 조치(F6): 일반 실행에서 선택 0파일이면 오류.
  - `[medium]` `[patch]` BH5-8 report에 config·allowlist(경로·해시)·선택 파일·수집 case·예정 job 목록이 없어 측정 정책 동일성 감사 불가. 조치(F7): 실행 전 report/장부에 기록.
  - `[low]` `[patch]` BH5-9 장부 자식 항목에 job ID·선택 case 없음. 조치(F7): spawn 전 장부에 기록.
  - `[medium]` `[patch]` BH5-10 실패·timeout shard 뒤 후속 shard·집계·자원을 검증하는 통합 시험 없음(G-J). 조치(F8).
  - `[medium]` `[patch]` IA5-1 = BH5-2(G-A).
  - `[false]` `[reject]` IA5-표면 차이(실제 Python 회귀·성능 결과 부재) — 코드 결함 아님, Verification 단계 증거.
- 계: patch 14행(F6: G-A·ECH5-2·BH5-6·BH5-7, F7: BH5-3·4·5·8·9, F8: VG5-1·BH5-10·중첩 fixture), reject 1행, defer 0. medium 2개 이상 patch → 후속 독립 확인 필요.

### 2026-11-08 — Review pass (round 6, F6~F8 해결 확인)
- 리뷰: Sol resolution `ctx_bcdeead3f8c8`, diff `.brain-automation/review/diff-r6.patch`(179,747B), 원문 `.brain-automation/review/r6-resolution.md`. round 5 patch 14행: resolved 12, partially 2(BH5-8·BH5-10), unresolved 0.
- verdicts: 3 findings — high 0, medium 0, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` BH5-8 잔여 — 수집(소스 검사·수집 자식·파싱) 실패 시 report/장부에 정책 정보가 없음. 조치(F9): 수집 전 config·allowlist 해시·선택 파일을 먼저 기록하고 수집 상태·성공 case를 갱신.
  - `[low]` `[patch]` BH5-10 잔여 — timeout 시험이 timeout 뒤 같은 slot의 후속 shard 실행·generation 증가를 단언하지 않음. 조치(F9): `--slots 1`에서 timeout case를 먼저 배정하고 후속 shard·sentinel 실행과 generation 증가를 단언.
  - `[low]` `[patch]` R6-1 금지 수식어 텍스트 검사가 주석·문자열·무관 속성도 차단해 정상 allowlist 파일로 실행 전체가 실패할 수 있음. 조치(F9): 검출 시 실행 실패 대신 그 파일을 shard하지 않고 파일 job으로 배정(정책은 소스에서 결정적이라 N과 무관), report에 사유 기록. 선택 case skipped=실패 판정은 유지.

### 2026-11-08 — Review pass (round 7, 마지막 실질 수정 F9 확인)
- 리뷰: Sol resolution `ctx_ea918460b64d`, diff `.brain-automation/review/diff-r7.patch`(184,158B), 원문 `.brain-automation/review/r7-resolution.md`. round 6 세 행 모두 resolved, 새 발견 없음.
- verdicts: 0 findings — 수렴. 구현 수정 종료, Verification 단계로 이동.

## Design Notes

- 파일마다 별도 Vitest 자식을 쓰는 이유: 파일 경계에서 자식 종료·자원 0을 직접 확인하고 timeout 파일만 죽이며 다른 slot에 영향이 없게 하기 위함이다. 파일당 시작 비용(수 초)은 wall에 포함해 측정한다.
- Python 손자 프로세스는 CLI가 env를 선별 전달해 token 추적이 불가능하므로 PPID 트리 1초 표본 누적 + process group으로 추적한다. 표본 사이 짧은 수명 자손은 놓칠 수 있다는 한계를 report와 계획에 기록하고, 종료 후 누적 집합 중 생존이 있으면 quarantine한다.
- (2026-11-08 변경) 긴 파일 하나(garmin-report 349초, 동결 묶음의 66%)가 파일 단위 병렬의 하한이 되어 E19-5 비율 ≤0.5가 구조적으로 불가했다. 중앙 조건부 승인으로 독립성이 입증된 파일만 case shard한다(Execution 11). shard 정책·목록은 측정 전에 동결하고 N과 무관하게 같다.
- hook lane은 coordinator 안에서 slot과 동시에 도는 별도 lane이며 1 slot 분모에도 동일하게 포함된다. 잠금은 hook 파일 자체가 잡으므로 기본 suite·직접 실행도 같은 경계를 쓴다.

## Verification

시험 실행은 모든 구현·리뷰 수정 뒤에만. 개발 중: `pnpm build`(require_escalated) -- 성공; `pnpm typecheck` -- 성공; `git diff --check` -- 출력 없음.

**Commands (개발 종료 뒤, 순서대로):**
1. `pnpm build` → `pnpm typecheck` → `pnpm exec vitest list --config apps/cli/python-test/vitest.config.ts --filesOnly --json` -- 16파일, baseline manifest와 일치.
2. 파일별 시간 기록이 없으므로 선정 진단 `node tooling/test-db/dist/python-slots.js --slots 1 --report <verify>/select-1slot.json` 1회 -- 실패 시 보존, 고친 뒤 누락/실패 파일만 `--files`로 관련 재검증. 유효 시간 내림차순 상위 CLI 6파일(동률 경로순)+hook을 동결해 계획에 기록.
3. `pnpm exec vitest run --project test-db` 중 `python-slots`·`slots-*` 시험 -- 실패/timeout/부분시작/SIGTERM/SIGKILL 복구·sentinel 통과.
4. 중앙에 예상 시간·준비 영수증·표본 계획을 보내 측정 창 승인 후, 성능 잠금 아래 1/2/3/4 slot 순차 각 warm-up 1+3 (`--files <동결 묶음> --metrics --report`) -- 비율 표·선택 구성; 기본 `--slots`를 선택값으로 확정.
5. 독립 URL을 준 `pnpm exec vitest run`과 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts` 병행 1회 -- 두 결과·cluster 분리·lane 기록.
6. `pnpm test` → `pnpm test:python` 순차 각 1회 -- 통과·시간·자원 0. 실패 수정 뒤 `pnpm test:changed -- cb5214293d3169977a6e006940b41da52a305dc8`와 관련 시험.

## Auto Run Result

- 상태(2026-11-09): **built**(사용자 인수 done 아님). 구현·리뷰 수렴(round 1~7, case shard 확장 뒤 round 5~7, F10/F10b 독립 확인), 통합 독립 영향 확인 r1~r4.
- E19-5 성능 gate(v4, source `8f553a31da3bc19defbddea575c896a15d26572a`, 동결 v4): 16호출 전부 exit 0·같은 21 job/54 case·자원 0. 중앙값 1/2/3/4 slot = 650.1/347.1/256.0/209.1초, 비율 1/0.5339085/0.3937997/0.3216633 → 충족, **선택 4 slot**, 기본 `--slots` 4. 최초 호출(1 slot warmup1)이 정책·환경 기준을 생성했고 나머지 15호출이 그 기준과 일치. 원시 `.brain-automation/verify/measure-v4/gate-result-v4.md`·`audit-v4.json`. 이전 source 표본(65792e8 W1~W9, fb0cd31 measure-v2, 87f7b3e v3 0.3103660)은 각 source 이력.
- 변경 요약: Python 통합 시험 slot coordinator(`tooling/test-db/src/python-slots.ts`: slot cluster·lease·장부·dead run 복구·hook lane lockf 잠금·hook Compose 회수·case shard·metrics 소멸 판정), `tooling/test-db/src/slots/*`, Python 전용 global setup(`apps/cli/python-test/global-setup.ts`), extHome slot lease 소비, hook 자원 확인(`tooling/bootstrap/test/hook-resources.ts`), `test:python`/`test:changed` 연결·rules, 시험(test-db project 13파일 82시험, 합성 fixture).
- 검증: build/typecheck/diff-check 0; test-db project 82/82; 기본/Python Vitest 병행 1회(Python exit 0, 기본 exit 1 — 환경 암호 4건·기존 Drive 10건); hook lane 표적 관측(직렬화 동적 근거); 최초 필수 전체 `pnpm test`(87f7b3e) exit 1·`pnpm test:python` exit 0; 교정 뒤 Drive 45/45, `pnpm test:changed -- 87f7b3e…` exit 0(기본 86, Python 76).
- 미해결·위험(차단 아님): W9(65792e8) 4 slot 실패 원인 미확정(19.12 분리 이력), hook lane 해제 시각 미기록·1초 표본 한계, 4 slot이 호스트 CPU를 가장 많이 씀(Node 자손 합 ~640~670%), 결합 source(8f553a3)에서 전체 `pnpm test` 재실행은 하지 않음(AGENTS 규칙상 교정 뒤는 관련 시험·test:changed).
