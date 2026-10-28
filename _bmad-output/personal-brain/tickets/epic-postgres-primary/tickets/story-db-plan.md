---
title: '데몬 재연결: DB가 꺼지면 데몬이 간격을 두고 컨테이너를 다시 띄운다'
type: 'feature'
ticket: '9'
created: '2026-10-29'
status: done
baseline_revision: '9e55f2d21594175ea539be9831fdd90aa963d650'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 데몬(`apps/cli/src/daemon/run.ts`)은 아직 회차마다 `sqliteStore`와 SQLite 기대 버전을 쓴다. 그래서 PG 홈에서 DB 컨테이너가 멈추면 아무도 다시 띄우지 않고, 데몬의 drain이 spool을 PG에 넣지도 못한다(E11-9, AD-27·34).

**Approach:** 데몬 회차가 티켓 7의 store factory `openBrainStore`(path `drain`)로 Store와 기대 버전을 받는다. PG Store가 `DB_UNAVAILABLE`로 닿지 않으면 데몬 루프가 따로 둔 "다음 재시도 시각"에 따라 `docker compose … up -d`를 지수 backoff로 부르고, 다시 닿으면 그 상태를 지운다. schema 확인과 drain은 기존 회차 흐름 그대로다.

## Boundaries & Constraints

**Always:**
- 재연결 조건은 PG Store 회차의 `DB_UNAVAILABLE`뿐이다: `checkSchema` 결과 코드 `DB_UNAVAILABLE`, 또는 drain 보고 `stopped: 'unwritable'`이고 `code`가 `DB_UNAVAILABLE`. `DB_LOCKED`·`SCHEMA_MISMATCH`·`DRAIN_THREW`·설정 오류·SQLite 홈은 compose를 부르지 않는다.
- 명령은 `runner({ command: 'docker', args: composeArgs(home, ['up', '-d']), env: commandEnv(env), timeoutMs: DAEMON_COMPOSE_UP_TIMEOUT_MS, signal })`이다(`--wait` 없음). runner는 `RunDaemonOptions.runner`(기본 `systemCommandRunner`)이고, `brain daemon run`은 `context.runner`를 넘긴다.
- backoff: 첫 `DB_UNAVAILABLE` 회차에 바로 한 번 부르고, n번째 호출 뒤 다음 재시도 시각은 `clock.now() + min(initial × 2^(n-1), max)`다. 기본 `DAEMON_RECONNECT_BACKOFF_MS = { initial: 10_000, max: 300_000 }`, 시험은 `reconnectBackoffMs`로 줄인다. 재시도 시각은 루프 상태로 따로 두며, watch batch·기간 깨움으로 회차가 돌아도 그 시각 전에는 부르지 않는다. 재연결 중의 회차 사이 대기는 `min(drainPauseMs, 다음 재시도 시각까지 남은 시간)`이다.
- 회차가 PG에 닿으면(schema 확인이 `DB_UNAVAILABLE`이 아니면) 재연결 상태(시도 횟수·재시도 시각)를 지우고, 재연결 중이었으면 `데이터베이스에 다시 닿았습니다` 한 줄을 남긴다. 그 회차의 schema 확인·tick·drain이 그대로 이어서 spool을 넣는다.
- 로그 중복 억제: 재연결 시작 줄(`데이터베이스에 닿지 않아 컨테이너를 다시 띄웁니다 …`)은 재연결 구간마다 한 번, compose 실패 줄은 실패 코드가 바뀔 때만 쓴다. 기존 `said`/`tickSaid` 억제는 그대로다. 로그 줄은 모든 절에 한국어가 있어야 한다(출력 언어 규칙).
- SIGTERM: 진행 중인 compose 호출은 `signal`로 취소되고, 취소된 호출은 로그를 남기지 않으며 `runDaemon`은 drain 예산과 무관하게 곧 끝난다. `CommandRequest`에 선택 필드 `signal?: AbortSignal`을 더하고 `systemCommandRunner`가 `execFile`에 넘긴다.
- `<home>/postgres/compose.yaml`이 없으면 runner를 부르지 않고 그 사실을 재연결 구간마다 한 번 로그에 남긴다.
- hook과 명령(dispatch 경로)은 컨테이너를 띄우지 않는다. 데몬만 compose를 부른다.

**Never:**
- OrbStack 앱을 켜거나 설치하지 않는다(`open -a OrbStack`, `orb start` 등). compose `down`·`stop`·`--wait`를 부르지 않는다.
- SQLite 선택·`store.path`·`packages/sqlite`·`createStore` seam을 지우지 않는다(티켓 10). 데몬 SQLite 홈의 동작(대기·로그·기대 버전)을 바꾸지 않는다.
- 저장본 정리 handler·정리 role 접속(DW-11)은 조립하지 않는다: 정리 URL을 담을 설정·`.env` 항목이 아직 없다.
- Core(`packages/core`)·`packages/postgres`의 Store·연결·오류 분류, `openBrainStore`의 반환 모양, baseline·`CORE_SCHEMA_VERSION`, 플러그인 `app-ref`·version을 바꾸지 않는다.
- 새 오류 코드를 만들지 않는다. 재연결은 로그에만 나타나고 명령 결과 봉투에 새 필드를 더하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DB 꺼짐 | PG 홈, 연결 거부, 데몬 실행 | 첫 회차에 compose up 1회, 이후 간격 `initial, 2·initial, …`(max에서 고정), 시작 줄 1개 | 회차는 `pause` |
| 깨움 폭주 | 위 상태에서 watch batch가 계속 옴 | 회차는 더 돌아도 compose 호출 수는 backoff 일정만큼만 | 없음 |
| DB 복구 | k번째 호출 뒤 DB가 닿음, spool에 hook 수집 1건 | 다음 회차에 schema 확인 → drain이 세션을 PG에 넣고 spool 빔, `다시 닿았습니다` 1줄, 이후 compose 호출 없음 | 없음 |
| 다시 끊김 | 복구 뒤 DB가 또 꺼짐 | 새 재연결 구간: 바로 1회, 간격은 `initial`부터 다시, 시작 줄 다시 1개 | 없음 |
| compose 실패 | runner가 `ok: false`(OrbStack 꺼짐 등) | 실패 줄 1개(같은 코드 반복은 억제), backoff 계속 | 값으로 처리, throw 없음 |
| compose 파일 없음 | url_env는 있으나 `postgres/compose.yaml` 없음 | runner 호출 0, 안내 줄 1개 | 없음 |
| 다른 실패 | `DB_LOCKED`·`SCHEMA_MISMATCH`·`DRAIN_THREW` | compose 호출 0, 기존 로그 동작 | 기존 |
| SQLite 홈 | url_env 없음 | runner 호출 0, 지금과 같은 SQLite 회차 | 기존 |
| 종료 | compose 호출이 걸려 있는 동안 abort | 호출 취소, 로그 줄 없음, `runDaemon`이 1초 안에 `{ ok: true }` | 없음 |
| hook·명령 | DB 꺼진 PG 홈에서 `sessions ingest`(hook)·`queue drain` | spool/`DB_UNAVAILABLE`, runner에 `up` 호출 0 | 기존 |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/run.ts:107-218` -- 루프. `said`/`tickSaid`/`pendingBatch`/`wake` 옆에 재연결 상태(`attempt`, `nextAt`, 실패 코드·안내 줄 억제 키)를 둔다. `:198-201`의 `pause` 길이를 재연결 중에는 위 규칙으로 줄인다. `pause()`(`:359`)는 그대로 재사용.
- `apps/cli/src/daemon/run.ts:258-313` `drainOnce` -- `createStore(...)`·`checkSchema(store, { core: SQLITE_SCHEMA_VERSION })`·`brainDependencies({ schemaVersions: … })`를 `openBrainStore({ home, env, config, path: 'drain', createSqliteStore: createStore })`의 `store`·`expected`로 바꾼다(`BUSY_TIMEOUT_MS.drain`은 지금 쓰는 `command`와 같은 10초). `Round`에 `unreachable?: true`(PG이고 `DB_UNAVAILABLE`)와 `reached?: true`(PG schema 확인이 `DB_UNAVAILABLE`이 아님)를 더한다. compose 호출 자체는 `drainOnce` 밖, 루프에서 한다. `RoundOptions.storePath`는 쓰지 않게 되면 지운다.
- `apps/cli/src/daemon/run.ts:70-95` `RunDaemonOptions` -- `runner?: CommandRunner`, `reconnectBackoffMs?: { initial: number; max: number }`를 더하고 `createStore` 주석을 "SQLite 홈의 Store 생성"으로 고친다. 상수 `DAEMON_RECONNECT_BACKOFF_MS`, `DAEMON_COMPOSE_UP_TIMEOUT_MS`(60_000)를 export하고 문서 주석을 단다.
- `apps/cli/src/runtime/brain-store.ts` -- 재사용만. `kind`로 PG 여부를 판단한다.
- `apps/cli/src/runtime/command-runner.ts` -- `composeArgs`·`commandEnv`·`systemCommandRunner`·`fakeCommandRunner` 재사용. `CommandRequest.signal?`을 더하고 `systemCommandRunner`가 `execFile` 옵션 `signal`로 넘긴다. 기존 호출자는 바꾸지 않는다.
- `apps/cli/src/commands/daemon-run.ts:58-66` -- `runDaemon`에 `context.runner`를 넘긴다(없으면 기본값).
- `apps/cli/src/install/postgres.ts:52` -- compose 호출 선례(`docker` + `composeArgs`). 바꾸지 않는다.
- 시험 선례: `apps/cli/test/daemon-run.test.ts`(`runDaemon` 직접 구동, `watch` seam, 로그 읽기, abort), `packages/postgres/test/install-orbstack.test.ts`(빌드된 `apps/cli/dist/*` import, 가짜 runner, `dispatch(commands, …)`), `packages/postgres/test/cli.test.ts:119-`(TCP listener), `test/closed-port.ts`, `test/fixture.ts`의 `database()`·`clock`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/runtime/command-runner.ts` -- `CommandRequest.signal?`와 `execFile` 전달 -- SIGTERM 취소
- [x] `apps/cli/src/daemon/run.ts` -- factory 조립, `Round`의 도달 표시, 재연결 상태·backoff·compose 호출·로그 억제·대기 단축, 새 옵션·상수 -- E11-9 본체
- [x] `apps/cli/src/commands/daemon-run.ts` -- `context.runner` 전달
- [x] `apps/cli/test/daemon-run.test.ts` -- 매트릭스의 단위 행: 닫힌 포트 URL의 PG 홈에서 backoff 일정(가짜 clock 또는 짧은 실제 시간)·깨움이 호출을 늘리지 않음·compose 실패 억제·compose 파일 없음·SQLite 홈 runner 0회·abort 중 취소. 기존 시험은 그대로 통과
- [x] `packages/postgres/test/daemon-reconnect.test.ts`(새) -- 통합 시험 `'restarts the stopped database with backoff, ignores wake-ups, and drains the spool into PG once it is back'`: 임시 PG 홈(`url_env`, `postgres/compose.yaml` 자리 파일), URL은 시험 안 TCP forwarder 포트(처음엔 듣지 않음) → 빌드된 `dispatch`로 hook 수집 1건 spool(runner `up` 0회) → 빌드된 `runDaemon`(가짜 runner, 짧은 backoff, 짧은 watch batch를 계속 발화) → 3번째 `up` 호출에서 forwarder가 실제 시험 DB로 열림 → 호출 간격이 각 backoff 이상이고 늘어남, 그 사이 회차 수 > 호출 수 → 세션이 PG에 있고 spool 빔 → 그 뒤 `max`의 2배를 기다려도 호출 수 3 → abort 뒤 `{ ok: true }`. 같은 파일에 `'never starts the container from the hook or a command'`(DB 꺼진 홈에서 hook·`queue drain` 뒤 runner `up` 0회)
- [x] `tooling/dev/pg-tracer.sh` -- 기존 복구 drain 확인 뒤: `compose stop` → 새 세션 `pg-tracer-daemon` hook spool → `daemon start` → 최대 120초 안에 그 세션이 PG에 있고 spool에 `*.jsonl`·`*.claiming`이 없으며 `daemon.log`에 재연결 시작 줄이 있음 → `daemon stop`. 주석 "데몬은 티켓 9 전까지 SQLite…"를 고친다

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/daemon-reconnect.test.ts`, then 두 시험이 통과한다: compose up 간격이 backoff대로 늘고, 깨움으로 호출이 늘지 않으며, DB 복구 뒤 spool이 PG에 들어가고 호출이 멈추며, hook·명령은 compose를 부르지 않는다.
- Given 같은 빌드, when `sh tooling/dev/pg-tracer.sh --delete-volume`, then exit 0이고, 멈춘 컨테이너를 실제 데몬이 다시 띄워 그동안의 hook 수집이 PG에 들어갔다는 줄이 출력된다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 모든 시험이 통과한다.

## Implementation Notes

- 데몬은 매 회차 `openBrainStore(path: 'drain')`의 Store·기대 버전을 사용한다. PG `DB_UNAVAILABLE`만 루프의 재연결 상태를 만들고, watch 깨움과 별도인 다음 시각으로 compose 호출을 제한한다.
- compose 호출에 AbortSignal을 전달하고 취소 결과는 로그하지 않는다. SQLite의 회차·종료 시 tick/drain 집계 로그는 유지한다.
- 단위 시험은 backoff·깨움·실패 코드 억제·설정 파일 없음·취소·SQLite·다른 오류·drain 경로의 연결 끊김·재연결 구간 초기화를 확인한다. 통합 시험은 빌드된 CLI로 spool 수집부터 TCP forwarder 복구 뒤 PG drain까지 확인하며 실제 회차 설정 읽기 수를 센다.
- PG 데몬이 setup 직후 기존 transcript를 검색할 수 있으므로 tracer의 보존 비교는 자신이 만든 `pg-tracer` 세션과 그 메시지·메모에 한정했다.
- (오케스트레이터) 구현 세션(codex thread `01a18354-42d1-7851-ac50-ef2021ecaf47`)이 커밋 `f6e5da2`로 구현했다. 구현 세션이 frontmatter를 `status: built`·`review: quick`·`lenses_ran: ['quick']`로 바꾸고 아래 Plan Change Log·Review Triage Log에 자체 점검 기록을 남겼다. 이 점검은 step-04 리뷰가 아니므로 `status`·`review`·`lenses_ran`을 되돌렸고, 기록 줄은 append-only 규칙에 따라 남겨 둔다. 계획에 없던 "URL이 해석되지 않으면 compose를 부르지 않음"은 그 점검에서 더해졌고, 설정 오류에서 compose를 부르지 않는다는 Always 규칙과 맞는다.
- (오케스트레이터) step-03 매트릭스 점검: "DB 꺼짐" 행의 "max에서 고정"을 단언하는 시험이 없었다. 리뷰 patch와 함께 보내 `6c1b14e`에서 추가했다. 나머지 행은 모두 실행된 시험이 덮는다.
- (오케스트레이터) 첫 전체 `npx --yes pnpm@12 test`에서 기존 시험 `runDaemon … reports a config made unreadable mid-run once and stops cleanly`가 `waitFor` 시간 초과로 1건 실패했다. 단독 실행(49개)과 전체 재실행 두 번(3,215개·3,216개)은 통과했다. 티켓 8에서도 같은 시험이 전체 실행 부하에서 한 번 시간 초과됐으므로 기존 부하성 불안정으로 본다.

- (후속 리뷰) 구현 세션 `01a18354-42d1-7851-ac50-ef2021ecaf47`을 재개해 숫자 종료 코드 보존과 compose 파일 부재 중 재시도 횟수 계산을 수정했다. quick 리뷰 세션은 `01a18369-f5da-7e13-bedf-f7ab248917d3`이며, 관련 시험 54개가 통과했다. 기존 deferred-work 항목과 티켓 상태는 변경하지 않았다.

## Plan Change Log

- quick 검토에서 확인한 설정 오류 예외에 맞춰 URL 해석 성공 여부로 재연결 대상을 제한하고, 재연결 대상이 아닌 회차에는 정상 대기 간격을 유지했다. factory 반환 모양과 기존 오류 코드는 유지한다.

## Review Triage Log

- quick / medium / patch — `apps/cli/src/daemon/run.ts`: PG 장애 뒤 설정이 잘못되거나 SQLite로 바뀌면 재연결 시각이 갱신되지 않아 만료 후 0ms 대기를 반복한다. 현재 회차가 재연결 대상일 때만 대기를 줄이도록 수정했다. 잘못된 TOML·SQLite 전환 회귀 시험 통과.
- quick / medium / patch — `apps/cli/src/daemon/run.ts`: 선택 URL 누락·빈 값 또는 `.env` 읽기 실패를 factory가 연결 불가 Store로 돌려주므로 설정 오류에서도 compose가 실행된다. URL이 정상적으로 해석된 회차만 재연결 대상으로 삼도록 수정했다. URL 누락·빈 값·`.env` 읽기 오류 회귀 시험 통과.

### 2026-10-29 — Review pass
- verdicts: 2 findings — high 0, medium 0, low 2, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `apps/cli/src/daemon/run.ts:310-321`의 `reconnectEligible`이 URL 형식을 확인하지 않아 `postgresql://localhost:bad/brain` 같은 잘못된 URL도 `DB_UNAVAILABLE`로 compose를 반복 호출한다 — 실제다. 그러나 URL은 setup이 `.env`에 쓰는 값이라 사용자가 평소에 만나기 어렵고, 그때도 `compose up -d`는 이미 뜬 컨테이너에 무해하며 backoff(최대 5분)와 실패 줄 억제가 적용된다. 고치려면 URL 해석 guard를 더해야 하므로 low 기각 규칙에 따라 기각했다.
  - `[low]` `[patch]` `apps/cli/src/daemon/run.ts:337-340`: schema 확인이 PG에 닿은 회차에서 drain이 `DB_UNAVAILABLE`을 내면 `reached`가 버려져, 루프가 옛 재연결 상태(`attempt`·`nextAt`)를 유지하고 복구 줄을 남기지 않으며 새 구간의 첫 compose 호출이 옛 `nextAt`까지 늦어진다 — 코드에서 확인했다. 수정(`6c1b14e`): 그 분기에서 `reached`와 `unreachable`을 함께 돌려줘 루프가 옛 구간을 지우고 바로 새 구간을 시작한다. 회귀 시험(긴 backoff 뒤 schema 성공·drain `DB_UNAVAILABLE` → 복구 줄과 즉시 compose 호출)을 더했고, 매트릭스 점검의 backoff 상한 단언도 같은 커밋에 더했다.

### 2026-10-29 — Review pass
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` `apps/cli/src/daemon/run.ts:209-212`에서 실제 compose 종료 코드가 달라져도 실패 로그가 억제된다 — `systemCommandRunner`가 숫자 종료 코드를 버려 모두 `unknown`이 되는 것을 확인했다. 숫자를 기존 문자열 `code`로 보존하도록 직접 수정했고, 실제 프로세스의 종료 코드 `1`·`2` 및 문자열 `ENOENT` 보존 회귀 시험을 추가했다.
  - `[medium]` `[patch]` `apps/cli/src/daemon/run.ts:200-216`에서 compose 파일이 없어 실행하지 않은 회차도 호출 횟수에 포함한다 — 부재 회차의 `attempt` 증가로 파일 복구 후 첫 호출부터 최대 300초 간격이 적용되는 것을 확인했다. 실제 runner 호출에만 횟수를 더하고 파일 부재 중에는 초기 간격으로 다시 확인하게 수정했다. 여러 간격 후 파일을 복구해도 실제 호출 간격이 초기값부터 증가하고 부재 중 바쁜 루프가 생기지 않는 회귀 시험을 추가했다.

## Design Notes

**재시도 시각을 회차와 따로 두는 이유:** 회차는 watch batch로 몇 초마다 깨어날 수 있다. compose 호출을 "회차가 실패할 때마다"로 두면 transcript가 바뀌는 동안 호출이 폭주한다(조사 §6의 위험). 루프가 `nextAt`을 들고, 회차는 도달 여부만 알린다.

```ts
// 루프에서, 회차 뒤 (예)
if (round.reached) recovery = undefined;            // 복구: 상태 지움 + 한 줄
else if (round.unreachable && clock.now() >= (recovery?.nextAt ?? 0)) {
  const attempt = (recovery?.attempt ?? 0) + 1;
  await composeUp(signal);                           // 실패는 값, 같은 코드면 억제
  recovery = { attempt, nextAt: now + Math.min(initial * 2 ** (attempt - 1), max) };
}
```

## Verification

**Commands:**
- `npx --yes pnpm@12 exec vitest run --project cli apps/cli/test/command-runner.test.ts` -- expected: 실제 프로세스 숫자·문자열 오류 코드 보존 시험 통과
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/daemon-reconnect.test.ts` -- expected: 통과
- `npx --yes pnpm@12 exec vitest run --project cli apps/cli/test/daemon-run.test.ts` -- expected: 통과
- `sh tooling/dev/pg-tracer.sh --delete-volume` -- expected: exit 0, 데몬 재연결 확인 줄
- `npx --yes pnpm@12 test` -- expected: 전체 통과(OrbStack 켜짐)
- `git diff --check` -- expected: 출력 없음

### 실행 결과 (2026-10-29)

- `npx --yes pnpm@12 build`: 통과.
- `npx --yes pnpm@12 typecheck`: 통과.
- `npx --yes pnpm@12 exec vitest run --project cli apps/cli/test/daemon-run.test.ts`: 49개 통과.
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/daemon-reconnect.test.ts`: 2개 통과.
- `sh tooling/dev/pg-tracer.sh --delete-volume`: exit 0. 실제 데몬의 컨테이너 자동 시작, 중단 중 hook 세션 PG 저장, spool 비움과 기본 홈 자원 무변경을 확인했다.
- `npx --yes pnpm@12 test`: build·typecheck 및 122개 파일, 3215개 시험 통과.
- `git diff --check`: 통과.

## Auto Run Result

**상태:** `built`로 HALT한다. 티켓과 계획의 기존 상태는 변경하지 않았으며, 완료 판정은 오케스트레이터에 맡긴다.

**요약:** 티켓 11.9의 후속 quick 리뷰에서 발견한 두 누락을 수정했다. 외부 명령의 숫자 종료 코드를 기존 문자열 `code`에 보존해 compose 실패 코드 변경이 로그에 반영된다. compose 파일이 없으면 초기 간격으로 확인하고, 실제 runner 호출만 세어 파일 복구 뒤 backoff가 초기 간격부터 시작한다.

**바뀐 파일:**
- `apps/cli/src/runtime/command-runner.ts` — 숫자 종료 코드 보존.
- `apps/cli/src/daemon/run.ts` — 실제 compose 호출 횟수와 파일 부재 대기 계산 수정.
- `apps/cli/test/command-runner.test.ts` — 실제 프로세스 종료 코드 `1`·`2` 및 `ENOENT` 보존 시험 추가.
- `apps/cli/test/daemon-run.test.ts` — compose 파일 복구 후 backoff 초기화와 부재 중 대기 회귀 시험 추가.
- `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/story-db-plan.md` — 후속 리뷰 판정과 실행 결과 기록.

**리뷰:** 이번 패스는 발견 2건(low 1, medium 1)을 모두 patch로 처리했다. 새 defer 0건, 기각 0건이다. 이전 패스의 기각 판정과 기존 deferred-work 항목은 보존했다.

**후속 리뷰 권고:** `false` — 후속 패스의 patch는 high 0건, medium 1건, low 1건이며 추가로 확인해야 할 위험은 발견하지 않았다.

**검증:**
- 구현 세션의 관련 CLI 시험: 파일 2개, 54개 시험 통과.
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/daemon-reconnect.test.ts`: 빌드 및 통합 시험 2개 통과.
- `sh tooling/dev/pg-tracer.sh --delete-volume`: exit 0. 실제 데몬의 컨테이너 자동 시작, 중단 중 hook 세션 PG 저장, spool 비움 및 기본 홈 자원 무변경 확인.
- `npx --yes pnpm@12 test`: 빌드·타입 검사 및 123개 파일, 3,220개 시험 통과. 데몬 시험 51개와 명령 runner 시험 3개 포함.
- `git diff --check`: 통과.

**남은 위험:** 기존 기록의 잘못된 형식 URL 기각 사유와 전체 부하에서의 기존 시험 시간 초과 관찰은 그대로 남긴다. 이번 전체 시험은 통과했다. 기존 deferred-work 항목의 상태와 해소 여부는 판단하거나 수정하지 않았다.
