---
title: '파일 감시: Stop hook 없이 저장된 transcript가 10초 안에 수집된다'
type: 'feature'
ticket: '4'
created: '2026-10-27'
status: done
baseline_revision: '7bb83db3e5ebb5e109154888b5ad3f6cf4d1a688'
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
---

<intent-contract>

## Intent

**Problem:** 데몬(9.1)은 회차마다 drain(spool 되넣기→scan→대기열)을 돌지만, 할 일이 없으면 10초 쉬므로 Stop hook 없이 저장된 transcript는 쉬는 시간과 drain 시간만큼 늦게 들어오고, 감시가 없어 변경을 알아차리지 못한다(E9-3의 감시·scan 연결 부분).

**Approach:** 데몬 안에서 등록된 하네스의 transcript 폴더(Claude Code는 connector가 찾는 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects`)를 `fs.watch`로 감시하고, 변경을 2초 묶음으로 모아 묶음마다 쉬고 있던 루프를 한 번 깨운다. 깨어난 회차는 기존 drain(그 안의 scan)을 그대로 돌 뿐 감시 이벤트로 직접 수집하지 않는다. 기동 직후 첫 회차가 scan을 돌아 꺼져 있던 동안의 변경을 메우고, 감시가 안 되면 로그하고 10초 주기 회차가 받친다.

## Boundaries & Constraints

**Always:**
- **감시 대상 경로는 connector와 같은 출처.** `packages/claude-code/src/transcript-folder.ts`에서 `projects` 경로 계산을 `claudeCodeProjectsFolder(options: ClaudeCodeTranscriptFolderOptions): string`으로 export하고(`claudeCodeTranscriptFolder`도 그것을 쓴다; 패키지 `index.ts`에서 export), `apps/cli/src/harnesses.ts`의 `Harness`에 `watchFolder(env): string`을 더해 같은 `claudeConfigDir(env)`로 부른다. `watchFolders(env, registry = harnesses): readonly string[]` 함수를 export한다. Core 포트(`TranscriptFolder`)는 바꾸지 않는다.
- **감시 모듈** `apps/cli/src/daemon/watch.ts`: `DAEMON_WATCH_BATCH_MS = 2_000`(문서 주석에 이유: 한 턴의 연속 쓰기를 한 scan으로 묶고 10초 안에 들어오게). `startTranscriptWatch({ folders, batchMs, log, onBatch, watch? })` → `{ close(): void; retry(): Promise<void> }` 모양(이름은 자유). 폴더마다 `fs.watch(folder, { recursive: true })`; `watch` 인자는 시험이 실패를 꾸미는 자리(기본 `node:fs`의 `watch`).
- **묶음 규칙.** 첫 이벤트가 2초 창을 열고, 창 안의 이벤트는 그 창에 합쳐진다(이벤트마다 창을 늘리지 않는다 — 계속 쓰이는 세션이 scan을 영영 미루지 않게). 창이 닫히면 `onBatch()` 한 번. 이벤트의 파일 이름이 있고 `.jsonl`로 끝나지 않으면 무시한다(이름이 `null`이면 센다).
- **루프 연결**(`daemon/run.ts`). 감시는 잠금·heartbeat 뒤, 첫 회차 앞에서 시작한다. `pause`는 abort뿐 아니라 묶음 깨움에도 바로 끝난다. 회차가 도는 중에 닫힌 묶음은 잊지 않고 표시해 두었다가 그 회차가 끝나면 쉬지 않고 바로 다음 회차를 돈다. 여러 묶음이 한 회차 동안 쌓여도 다음 회차는 하나다. 묶음이 없으면 지금처럼 `DAEMON_DRAIN_PAUSE_MS`(10초) 뒤 회차 — 이것이 주기 scan이다. `RunDaemonOptions`에 `watchBatchMs?`(기본 상수)와 `watch?`(시험 자리)를 더한다. 감시 대상은 `watchFolders(env)`.
- **실패와 회복.** 폴더가 없거나 `fs.watch`가 던지거나 감시자가 `error`를 내면: 그 감시자를 닫고, 로그 한 줄(상태가 바뀔 때만, 한국어, 폴더 경로 포함), 데몬은 계속(주기 회차가 받친다). 감시가 없는 폴더는 매 회차 끝에 다시 걸어 보고, 걸리면 로그 한 줄(감시 시작). 처음 걸린 때도 로그 한 줄. 같은 실패가 회차마다 반복 기록되지 않는다.
- **종료.** abort 뒤 `finally`에서 heartbeat 정지보다 먼저 감시자를 모두 닫고 열린 창 타이머를 지운다. 종료 뒤 타이머·감시자가 남지 않는다(프로세스가 바로 끝난다).
- **로그 문장**은 9.1 관례(절마다 한글, `encodeTextLine` 가림은 `daemonLog`가 한다). 데몬 모듈은 stdout/stderr에 직접 쓰지 않는다(`output-codecs.test.ts` 싱크 표).
- `DAEMON_DRAIN_PAUSE_MS`의 주석("9.4가 줄인다")을 이 스토리의 실제 동작(감시 깨움 + 10초 주기 받침)으로 고친다.
- **README** `## 데몬` 절에 파일 감시 문단: 감시 폴더, 2초 묶음, 묶음마다 회차 한 번(감시 이벤트로 직접 수집하지 않음), 기동 회차가 꺼져 있던 동안을 메움, 감시 실패·폴더 없음은 로그와 10초 주기로 받침, `[files] path`는 감시하지 않음. 로그 기록 목록에 감시 시작·실패를 더한다. 한국어.
- 시험은 임시 home·임시 `CLAUDE_CONFIG_DIR`만 쓴다(`environment()` 관례). 절대 홈 경로를 쓰지 않는다.

**Never:**
- `[files] path` 감시, 감시 이벤트로 세션을 직접 수집하거나 새 일감 종류·새 spool 종류를 만들기, scan 경로(`packages/core/src/capture/scan.ts`·`brain.ts` drain) 변경, Core에 파일 감시·타이머 코드 넣기(FR-23), `DAEMON_DRAIN_PAUSE_MS`·`DAEMON_DRAIN_BUDGET_MS` 값 변경, 예약 틱(9.5)·stop/start(9.6)·로그 회전(9.9), 새 의존성(chokidar 등) 추가 — Node 24의 `fs.watch` recursive로 충분하다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 새 transcript | 데몬 떠 있음, 쉬는 중, hook 없이 `projects/<p>/<id>.jsonl` 씀 | 약 2초 뒤 회차 하나, 세션이 DB에 | — |
| 연달은 쓰기 | 1초 안에 같은 파일을 5번 고침 | 그 묶음에 회차 하나(쉬는 시간이 길어도) | — |
| 회차 중 묶음 | drain이 도는 중 묶음이 닫힘 | 그 회차 뒤 쉬지 않고 바로 회차 하나 | — |
| 무관한 파일 | `.jsonl`이 아닌 이름의 변경 | 깨우지 않음 | — |
| 꺼져 있던 동안 | 데몬 종료 뒤 transcript 씀, 다시 기동 | 첫 회차에 수집 | — |
| 폴더 없음 | `projects/` 없음 | 로그 한 줄, 데몬 계속, 주기 회차 | 회차마다 다시 걸고, 생기면 감시 시작 로그 |
| 감시 오류 | 감시자가 `error`를 냄 / `watch`가 던짐 | 로그 한 줄, 감시자 닫음, 주기 회차로 계속 | 같은 실패는 다시 기록하지 않음 |
| 종료 | 감시 중 SIGTERM/abort | 감시자·창 타이머 닫히고 9.1과 같이 exit 0 | — |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/run.ts` -- `runDaemon`: 잠금→heartbeat→루프(`readConfig`→`drainOnce`→`pause`)→`finally`(heartbeat→잠금→종료 줄). 감시 시작은 heartbeat 뒤·루프 앞, 닫기는 `finally` 맨 앞. `pause(ms, signal)`(파일 끝)를 깨움도 받게 바꾼다. 상태가 바뀔 때만 로그하는 `said` 관례를 감시 상태에도 따른다(감시 상태는 drain 문제와 별도 상태로 — 한 쪽이 다른 쪽의 기록을 지우지 않게). `drainOnce`·`counts`·`worked`는 바꾸지 않는다.
- `apps/cli/src/daemon/log.ts` -- `daemonLog(home, clock).write(line)`; 감시 모듈은 이것만 받는다.
- `apps/cli/src/harnesses.ts` -- `Harness`, `harnesses`, `transcriptFolders(env)`, `claudeConfigDir(env)`(빈 값은 unset). `watchFolder`·`watchFolders`를 여기 더한다.
- `packages/claude-code/src/transcript-folder.ts:59` -- `claudeCodeTranscriptFolder`: `configDir ?? join(homedir(), '.claude')` 뒤 `projects`. 이 계산을 `claudeCodeProjectsFolder`로 뽑는다. scan은 `projects/<폴더>/*.jsonl` 한 단계만 본다. `packages/claude-code/src/index.ts` -- export 목록. `packages/second_brain/src/index.ts`가 `export * from '@second-brain/claude-code'`라 `apps/cli`는 `second_brain`에서 그대로 가져온다(second_brain 수정 불필요).
- `packages/core/src/brain.ts:431` -- drain = spool 되넣기→scan→identity→이름→재추출→대기열. 읽기만; 바꾸지 않는다.
- `apps/cli/test/daemon-run.test.ts` -- `environment(home, configDir)`(113), `startDaemon(options)`(128; abort·대기 정리 등록), 프로세스 시험 틀 `installed()`(560)·`transcript(configDir, sessionId)`(569), `createStore` 주입으로 회차 수 세기 가능(회차마다 store 하나를 연다).
- `apps/cli/test/output-codecs.test.ts:72` -- stdout/stderr 싱크 표(새 모듈은 행이 필요 없게 직접 쓰지 않는다). `output-language.test.ts` -- 로그 문장 언어 검사 관례.
- `README.md:532` -- `## 데몬` 절.

## Tasks & Acceptance

**Execution:**
- [x] `packages/claude-code/src/transcript-folder.ts`, `packages/claude-code/src/index.ts` -- `claudeCodeProjectsFolder` 추출·export -- 감시와 scan이 같은 폴더를 보게
- [x] `apps/cli/src/harnesses.ts` -- `Harness.watchFolder`, `watchFolders(env)` -- 데몬이 감시 대상을 하네스 등록부에서 얻게
- [x] `apps/cli/src/daemon/watch.ts` -- 감시자·2초 고정 창·`.jsonl` 걸러내기·실패/회복 상태와 로그·닫기, 상수 -- 감시 본체
- [x] `apps/cli/src/daemon/run.ts` -- 감시 시작·닫기, 깨울 수 있는 `pause`, 회차 중 묶음 표시, 회차 끝 재시도, 옵션 두 개, 상수 주석 정정 -- 루프 연결
- [x] `README.md` -- `## 데몬`에 파일 감시 문단과 로그 목록 -- 사용자 문서
- [x] `apps/cli/test/daemon-watch.test.ts` -- 감시 모듈 단위: 고정 창(창 안 여러 이벤트 → `onBatch` 한 번, 창 뒤 이벤트 → 새 창), `.jsonl` 아닌 이름 무시·`null` 이름 셈, 폴더 없음·`watch` 던짐·`error` 이벤트의 로그 한 번과 재시도 회복 로그, `close` 뒤 `onBatch` 없음 -- 행렬의 감시 행
- [x] `apps/cli/test/daemon-run.test.ts` -- in-process(`drainPauseMs`를 60초처럼 길게, `watchBatchMs` 짧게 또는 기본): 쉬는 중 쓴 transcript가 5초 안에 수집됨; 1초 안 5번 쓰기에 회차(=store 열기) 정확히 하나 더; 회차 중 닫힌 묶음이 바로 다음 회차를 부름; 폴더 없음으로 시작해 로그 한 줄 뒤 폴더를 만들면 감시 시작 로그와 수집; abort 뒤 감시자 닫힘. 프로세스(`dist/bin.js`): 빈 폴더로 데몬을 띄운 뒤 hook 없이 transcript를 쓰면 10초 안에 `sessions`에 들어옴; SIGTERM 뒤 쓴 transcript가 다시 띄운 데몬에서 수집됨 -- 사용자 표면 증거
- [x] `packages/claude-code/test/transcript-folder.test.ts` -- `claudeCodeProjectsFolder`가 `configDir`·기본값에서 `claudeCodeTranscriptFolder`가 읽는 폴더와 같음 -- 경로 출처 하나

**Acceptance Criteria:**
- Given 설치된 임시 home과 빈 임시 transcript 폴더로 뜬 `brain daemon run`, when hook 없이 transcript 파일을 쓰면, then 10초 안에 그 세션이 `sessions`에 들어온다.
- Given 쉬는 시간을 길게 준 `runDaemon`, when 같은 transcript를 2초 창 안에서 여러 번 고치면, then 그 묶음에 회차(scan)는 한 번이고 세션은 쉬는 시간이 끝나기 전에 들어온다.
- Given 데몬이 꺼진 동안 쓴 transcript, when 데몬을 다시 띄우면, then 첫 회차가 그것을 수집한다.
- Given 감시할 폴더가 없거나 감시가 실패한 데몬, when 회차가 여러 번 돌면, then 로그에 실패가 한 번만 남고 데몬은 주기 회차로 계속 수집하며, 폴더가 생기면 감시가 다시 걸린다.
- Given 이 변경 전의 시험, when 전체 시험을 돌리면, then 그대로 통과한다.

## Implementation Notes

## Plan Change Log

## Review Triage Log

- `false` — Quick review suggested a deleted/recreated projects root would leave recursive watching attached to the old directory. A Node 24.16.0 reproduction removed the watched root, recreated it, and wrote `new.jsonl`; the original recursive watcher delivered the new file event without an error or close. The reviewer withdrew the unsupported inode-behavior assumption; no substantiated findings or deferrals remain.

- 위 행은 구현 세션(codex)이 스스로 돌린 자체 점검 기록이다. 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-27 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (quick 리뷰어가 수용 기준 미충족·규칙 위반·버그를 찾지 못함)

### 2026-10-27 — Follow-up review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: Quick reviewer inspected the diff against the acceptance criteria and repository rules; no unmet criteria, violations, or bugs found.

## Design Notes

- 고정 창인 이유: Claude Code는 한 턴 동안 transcript에 줄을 계속 덧붙인다. 이벤트마다 창을 늘리는 디바운스는 긴 턴 내내 scan을 미뤄 10초를 넘긴다. 첫 이벤트에서 2초 창을 열고 닫으면 최악의 지연은 2초 + 회차 하나다.
- 감시는 깨움일 뿐이다: scan은 크기 비교라 이벤트를 놓쳐도 다음 회차가 잡는다. 그래서 감시 실패는 데몬 실패가 아니고, 주기 회차(10초)가 받침이다. 기동 scan은 따로 만들지 않는다 — 첫 회차의 drain이 scan을 포함한다(Code Map `brain.ts`).
- 경로를 Core 포트가 아니라 claude-code 패키지 함수와 Runtime의 하네스 등록부에 두는 이유: 감시는 Runtime의 일이고(AD-1, FR-23), `TranscriptFolder`에 경로를 더하면 Core 시험의 가짜들이 모두 바뀐다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project cli --project claude-code` -- expected: 새 시험 포함 전부 통과
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- expected: 전부 통과(`postgres`는 Docker가 없으면 global setup에서 멈추므로 제외하고 그 사실을 기록)
- `git diff --check` -- expected: 출력 없음

**Implementation verification (2026-10-27):**
- `pnpm build && pnpm typecheck`: passed.
- `pnpm vitest run --project cli --project claude-code`: 37 files, 1102 tests passed.
- Focused watcher, daemon, and shared-root tests: 3 files, 45 tests passed.
- Full requested non-Postgres suite: 92 files, 2685 tests passed. Postgres was excluded as specified; Docker-backed Postgres setup was not attempted.
- `git diff --check`: passed.
- An initial CLI run exposed the log-language check's required `오류: <system original>` format; corrected the watcher failure line and verified the full suite after that correction.


## Auto Run Result

Status: built. Follow-up review completed; the orchestrator owns ticket completion. No ticket marking command was run. Existing deferred-work ledger entries were not changed.

**Implemented change.** The daemon watches registered transcript roots, batches changes in fixed two-second windows, and wakes the existing scan/drain loop. Startup scans recover changes made while stopped. Watch failures log once per state change and fall back to periodic scans, with retries and shutdown cleanup.

**Files changed in the implementation:**
- `packages/claude-code/src/transcript-folder.ts` — shared projects-root calculation for scans and watching.
- `packages/claude-code/src/index.ts` — exports the shared root helper.
- `apps/cli/src/harnesses.ts` — registered harness watch roots.
- `apps/cli/src/daemon/watch.ts` — batching, filtering, retry, logging, and cleanup.
- `apps/cli/src/daemon/run.ts` — watcher lifecycle and scan-loop wakeups.
- `README.md` — watcher behavior and fallback documentation.
- `apps/cli/test/daemon-watch.test.ts` — watcher behavior and failure/recovery coverage.
- `apps/cli/test/daemon-run.test.ts` — daemon integration, timing, and restart coverage.
- `packages/claude-code/test/transcript-folder.test.ts` — shared-root coverage.

**This follow-up pass.** Documentation only. Quick review: zero findings; patches applied: zero (high 0, medium 0, low 0); deferred: zero; rejected findings: zero. Follow-up review recommended: false.

**Verification performed in this pass:**
- `pnpm build` — passed.
- `pnpm typecheck` — passed.
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` — 92 files, 2,685 tests passed. Docker-backed Postgres tests were excluded as specified in the plan.
- `git diff --check` — passed.

**Residual risks.** A long-running drain can delay the next scan beyond ten seconds. Actual installed launchd behavior remains the separate ticket 9.8 verification responsibility.
