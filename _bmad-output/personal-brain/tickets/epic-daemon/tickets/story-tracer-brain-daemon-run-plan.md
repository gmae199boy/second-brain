---
title: 'Tracer: brain daemon run이 떠서 밀린 일감을 처리한다'
type: 'feature'
ticket: '1'
created: '2026-10-27'
status: done
baseline_revision: '9f70be46cdcad8e524d378b74f67a6cf6d2a9dd0'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** Brain에는 상주 런타임이 없다. drain은 명령 끝의 기회적 drain, `brain queue drain`, SessionStart hook에서만 돌고, pid 잠금·heartbeat·데몬 로그·SIGTERM 정상 종료 코드가 하나도 없다(E9-1, E9-3의 반복 drain·spool 부분). 뒤 스토리(9.2 launchd, 9.3 생존 판단·status·doctor, 9.4 감시, 9.5 예약 틱, 9.9 로그 회전)가 붙을 자리가 없다.

**Approach:** 명령 등록부에 `brain daemon run`(stdout 엔벨로프 없음)을 더하고, 같은 빌드에서 dispatcher와 같은 Core 조립 함수로 `createBrain`을 만들어 상주하며 drain을 반복한다. `<home>/run/daemon.pid` 단일 인스턴스 잠금, `<home>/run/heartbeat` 30초 갱신, `<home>/log/daemon.log` 한 줄 쓰기, SIGTERM/SIGINT 정상 종료를 만든다. launchd는 이 스토리 밖(9.2).

## Boundaries & Constraints

**Always:**
- **명령.** `apps/cli/src/commands/daemon-run.ts`의 `daemonRunCommand`: `ns: 'daemon'`, `verb: 'run'`, 한국어 `nsDescription`·`usedFor`·`output`, `risk: 'write'`, `hook: false`, `dryRun: false`, `standalone: true`(설정·store는 데몬이 스스로 읽고 연다), 새 메타 필드 `envelope: false`. `commands/index.ts`의 `queueDrainCommand` 앞에 등록한다.
- **엔벨로프 없음.** `CommandSpecBase`에 `envelope?: false`를 더한다. dispatcher는 그런 명령에 stdout을 아무것도 쓰지 않고(`--json`이어도), 실패면 stderr에 지금 텍스트 모드와 같은 `CODE: message`와 hint 줄을 `encodeTextLine`으로 쓰고 코드 표의 exit을 돌려준다. 다른 명령의 출력은 바이트 단위로 그대로다.
- **Core 조립 자리.** `dispatch.ts` `execute`의 `dependencies` 객체 만들기를 새 `apps/cli/src/assembly.ts`의 함수 하나(예: `brainDependencies({ home, env, config, store, clock, idGen, workHandlers })` → `BrainDependencies`)로 옮기고 dispatcher와 데몬이 함께 쓴다. dispatcher 동작(설정 없음일 때의 `files` 루트, `checks`, `workHandlers` 등)은 바뀌지 않는다. 9.4·9.5가 이 함수와 데몬 루프를 확장한다.
- **경로.** `config/paths.ts`에 `DAEMON_PID_FILE = 'daemon.pid'`, `HEARTBEAT_FILE = 'heartbeat'`, `DAEMON_LOG_FILE = 'daemon.log'`와 `daemonPidPath(home)`·`heartbeatPath(home)`·`daemonLogPath(home)`(`RUN_FOLDER`·`LOG_FOLDER` 아래). 폴더는 처음 쓸 때 `mkdir -p`, mode 0700.
- **상수**(`apps/cli/src/daemon/`에 export, 문서 주석에 이유): `DAEMON_HEARTBEAT_MS = 30_000`, `DAEMON_DRAIN_BUDGET_MS = 10_000`(launchd 기본 ExitTimeOut 20초 안에 종료가 끝나게), `DAEMON_DRAIN_PAUSE_MS = 10_000`(drain이 `empty`·`unwritable`·오류·스키마 불일치로 끝난 뒤 쉬는 시간; `budget`으로 끝나면 쉬지 않고 바로 다음 drain).
- **잠금**(`apps/cli/src/daemon/lock.ts`). 내용은 JSON 한 줄 `{"pid":<n>,"boot_at":"<ISO>","started_at":"<ISO>"}`(`boot_at` = 지금 − `os.uptime()`). 원자적 생성: 완성된 임시 파일(`daemon.pid.<pid>.tmp`)을 `link`로 `daemon.pid`에 걸고(EEXIST면 이미 있음) 임시 파일을 지운다 — 읽는 쪽이 반쯤 쓴 파일을 보지 않게. 이미 있으면 주인을 읽는다: 살아 있으면(`process.kill(pid, 0)`, EPERM은 생존) 나이와 상관없이 거절하고 주인 pid를 돌려준다. 죽었으면 회수한다. 죽음 = 신호가 ESRCH, 또는 기록된 `boot_at`이 지금의 부팅 시각보다 10분 넘게 이르다(재부팅 뒤 같은 pid를 다른 프로세스가 쓰는 경우), 또는 내용을 읽을 수 없다. 회수는 `rename(daemon.pid → daemon.pid.stale-<pid>)` 뒤 옮긴 파일을 다시 읽어 같은 죽은 주인일 때만 지우고 한 번 다시 건다; 다른 주인(경쟁자가 방금 만든 잠금)이면 `link`로 되돌리고 거절한다. `release()`는 파일의 pid가 자기일 때만 지운다. 판단 함수 `isAlive`·부팅 시각은 테스트에서 바꿀 수 있는 인자다. 9.3이 쓸 `readDaemonLock(home)`(주인 pid·시각 또는 없음)을 export한다.
- **heartbeat**(`daemon/heartbeat.ts`). 잠금을 잡은 바로 뒤 한 번, 그 뒤 `DAEMON_HEARTBEAT_MS`마다 `<home>/run/heartbeat`에 지금 ISO 시각 한 줄을 쓴다(mtime이 기록이다). 쓰기 실패는 로그 한 줄이고 데몬을 멈추지 않는다. drain 진행과 독립된 타이머다.
- **로그**(`daemon/log.ts`). `daemonLog(home, clock)` → `{ write(line) }`: `<ISO 시각> <한국어 문장>` 한 줄을 `appendFile`로 덧붙이고, 문장은 `encodeTextLine`으로 가린다(오류 메시지에 비밀이 섞일 수 있다). 9.9가 이 함수에 회전을 붙인다. 쓰기 실패는 삼킨다(로그 때문에 데몬이 죽지 않는다). 기록하는 것: 시작(pid), 정상 종료, 잠금 거절(주인 pid), 일이 있었던 drain 한 번의 건수(청구·완료·실패·spool·새 일감·되넣음이 하나라도 0이 아닐 때만), 상태가 바뀔 때만 한 번씩: 스키마 불일치·DB에 못 씀·drain 예외(같은 문제가 10초마다 반복 기록되지 않게).
- **루프**(`daemon/run.ts`의 `runDaemon(options)`; 신호는 받지 않고 `AbortSignal`을 받는다). 순서: 설정 읽기(`readConfig(configHome(env))`; 실패면 그 코드 `CONFIG_MISSING`/`CONFIG_INVALID`로 exit 2, 잠금·pid 없음) → 잠금(거절이면 새 오류 코드 `DAEMON_RUNNING`, exit 1, 메시지에 주인 pid) → heartbeat 시작 → 반복: 회차마다 `sqliteStore({ path, busyTimeoutMs: BUSY_TIMEOUT_MS.command })`를 열고 `checkSchema(store, SQLITE_SCHEMA_VERSION)`가 맞을 때만 조립 함수로 `createBrain` → `brain.queue.drain({ budgetMs: DAEMON_DRAIN_BUDGET_MS })` → 닫는다. 예외는 잡아 로그하고 계속한다. DB에 못 쓴 transcript 수집은 drain의 기존 spool 경로(같은 `fileSpool(spoolPath(home))`)로 남는다 — 새 spool 종류는 없다. 쉬는 동안 abort가 오면 바로 깨어난다.
- **종료.** `daemon-run.ts`가 `SIGTERM`·`SIGINT`를 AbortController에 잇는다. abort 뒤 새 drain을 시작하지 않고, 진행 중인 drain은 끝까지 기다린다(drain은 처리 중 일감을 끊지 않고 예산만큼만 새로 청구한다; 그사이 강제 종료되면 청구는 10분 lease 만료로 다른 drain에 넘어간다). 그 뒤 heartbeat 타이머를 멈추고, 잠금을 놓고(pid 파일 삭제), 종료 줄을 로그하고 exit 0. heartbeat 파일은 남긴다(9.3이 마지막 heartbeat를 보인다). 신호 처리기는 run이 끝나면 떼어 낸다.
- **오류 코드 `DAEMON_RUNNING`**(`packages/core/src/codes.ts` `CODES`, `VERSION_MISMATCH` 옆): exit 1, `retryable: false`, 한국어 meaning(이 설정 폴더의 데몬이 이미 떠 있다)과 hint(이미 떠 있는 데몬이 일을 맡고 있으니 다시 띄우지 말 것; 멈추려면 그 pid에 SIGTERM). Core 코드 표 테스트가 있으면 함께, README `### 오류 코드` 표에 한 줄.
- **README.** `## 밀린 일 처리` 뒤에 `## 데몬` 절: `brain daemon run`이 하는 일, 엔벨로프가 없다는 것, pid·heartbeat·로그 위치, 한 번에 하나(살아 있는 주인은 빼앗지 않고 죽은 주인만 회수), SIGTERM 정상 종료, 상수(30초·10초), launchd 등록은 아직 없음. 한국어(출력 언어 시험).
- 시험은 임시 home·임시 `CLAUDE_CONFIG_DIR`만 쓴다(`withoutHarnessFolders`/`environment()` 관례). 절대 홈 경로를 쓰지 않는다.

**Never:**
- launchd·plist·`launchctl`(9.2), 생존 판단 함수·기회적 drain 생략·`daemon status`·doctor 점검(9.3), 파일 감시와 기동 scan의 별도 단계(9.4), 예약 틱·마이그레이션(9.5), `daemon stop/start`·재시작 단계(9.6), 로그 회전(9.9), `setup uninstall`(9.10), 소켓·MCP·자동 업데이트(V1 뒤).
- 설치 잠금의 30분 회수 규칙을 데몬 잠금에 가져오기(살아 있는 데몬을 빼앗아 둘이 뜬다). 데몬이 `brain` CLI를 자식 프로세스로 부르기. Core(`packages/core`)에 프로세스·신호·타이머 코드를 넣기(FR-23; 데몬은 Runtime). 새 spool 종류. 스키마가 다른 DB에 쓰기(AD-20). 다른 명령의 출력·종료 코드·기회적 drain 동작 변경.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 기동 | 설치된 home, transcript 하나 | stdout 비어 있음, `run/daemon.pid`(자기 pid), `run/heartbeat`, `log/daemon.log` 시작 줄; 곧 그 세션이 `sessions`에 들어감 | — |
| 두 번째 | 첫 데몬이 살아 있음 | 두 번째는 exit 1, stderr `DAEMON_RUNNING: …<주인 pid>…`, stdout 비어 있음, pid 파일 그대로 | — |
| 죽은 pid | 끝난 프로세스의 pid가 든 잠금 | 회수하고 뜸; pid 파일이 새 pid | — |
| 이전 부팅 | 살아 있는 pid지만 `boot_at`이 10분 넘게 이전 | 회수하고 뜸 | — |
| 깨진 잠금 | 읽을 수 없는 내용 | 회수하고 뜸 | — |
| 경쟁 회수 | 회수 중 rename한 파일의 주인이 다름 | 되돌리고 거절 | — |
| SIGTERM | 떠 있는 데몬 | exit 0, pid 파일 없음, heartbeat 남음, 로그 종료 줄 | 진행 중 drain은 끝내고 종료 |
| 설정 없음 | 설치 안 된 home | exit 2 `CONFIG_MISSING`(stderr), pid 파일 없음 | — |
| 스키마 불일치 | `schema_version` 다름 | 계속 떠 있고 쓰지 않음, 로그 한 번 | 다음 회차에 다시 확인 |
| drain 예외·DB 없음 | 핸들러 throw, DB 파일 없음 | 로그 한 번, 쉬고 다시 | 데몬은 죽지 않음 |
| heartbeat 주기 | 짧은 주기를 준 `runDaemon` | 주기마다 mtime이 앞으로 감 | 쓰기 실패는 로그 |

</intent-contract>

## Code Map

- `apps/cli/src/dispatch.ts` -- `execute`(496–662): `dependencies` 조립(569–594)을 `assembly.ts`로 옮기는 자리; `dispatch`(396–477)의 출력 분기에 `envelope: false` 처리; `CommandSpecBase`(258)에 필드. `drainOpportunistically`(729)는 회차마다 store를 열고 `checkSchema` 뒤 `createBrain`하는 모범 — 데몬 회차가 같은 모양. 기회적 drain 동작은 그대로.
- `apps/cli/src/commands/index.ts` -- 등록부. `queue-drain.ts` -- 명령 spec 모양·한국어 건수 문장 관례.
- `apps/cli/src/config/paths.ts` -- `configHome`, `RUN_FOLDER`·`LOG_FOLDER`, `spoolPath`; 새 경로 함수 자리.
- `apps/cli/src/config/codec.ts` -- `readConfig(home)` → `{ ok, config: { storePath, filesPath }, warnings }`.
- `apps/cli/src/runtime/spool.ts:519` -- `systemIsAlive`(EPERM은 생존); 같은 규칙을 잠금이 쓴다(export해 재사용하거나 같은 규칙으로).
- `packages/core/src/brain.ts:224,431` -- `createBrain`, drain 한 번 = spool 되넣기→scan→identity→이름→재추출→대기열, 한 deadline. `domain/work-item.ts:135` `DRAIN_BUDGET_MS`(바꾸지 않음), 10분 lease.
- `packages/core/src/codes.ts` -- `CODES`(오류 코드 표, `VERSION_MISMATCH` 근처), `WARNING_CODES`는 건드리지 않음.
- `apps/cli/test/queue-drain.test.ts`, `capture-scan.test.ts` -- 빌드된 `dist/bin.js`를 spawn하는 통합 시험 틀, `installed()`(dist/install.js `--yes`), `transcript()` 픽스처 복사, `rows()`/`rowCounts()`; `test/temp-home.ts`, `test/environment.ts`.
- `apps/cli/test/output-codecs.test.ts:72` -- stdout/stderr 싱크 표. 새 파일이 stdout/stderr에 직접 쓰면 행을 더해야 하므로, 데몬 모듈은 stderr에 직접 쓰지 말고 실패는 dispatcher가 쓴다.
- `apps/cli/test/command-meta.test.ts`, `output-language.test.ts`, `guide.test.ts`, `readme-codes.test.ts` -- 새 명령·코드가 자동으로 걸리는 시험.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/assembly.ts`, `apps/cli/src/dispatch.ts` -- 의존성 조립 함수 추출, `envelope?: false` 필드와 출력 분기 -- 데몬과 dispatcher가 같은 조립을 쓰고 데몬은 엔벨로프를 내지 않게
- [x] `apps/cli/src/config/paths.ts` -- pid·heartbeat·로그 경로 -- 9.3·9.9·9.10이 같은 이름을 읽게
- [x] `apps/cli/src/daemon/lock.ts`, `heartbeat.ts`, `log.ts`, `run.ts` -- 잠금·heartbeat·로그·루프와 상수 -- 런타임 본체
- [x] `apps/cli/src/commands/daemon-run.ts`, `commands/index.ts` -- 명령 spec, 신호 → AbortController, `runDaemon` 결과를 `CommandOutcome`으로 -- 진입점
- [x] `packages/core/src/codes.ts`(+ 코드 표 시험이 있으면 그것) -- `DAEMON_RUNNING` -- 잠금 거절의 코드
- [x] `README.md` -- `## 데몬` 절, 오류 코드 행 -- 문서 대조 시험과 사용자
- [x] `apps/cli/test/daemon-lock.test.ts` -- 잠금 행렬: 새로 잡기, 살아 있는 주인 거절(오래된 `started_at`이어도), 죽은 pid·이전 부팅·깨진 내용 회수, 경쟁 회수 되돌림, 남의 잠금을 지우지 않는 `release`, `readDaemonLock` -- 잠금 규칙의 단위 증거
- [x] `apps/cli/test/daemon-run.test.ts` -- (a) `runDaemon`을 짧은 주기·임시 home으로 돌려 heartbeat mtime이 주기마다 앞으로 가는지, abort 뒤 pid 삭제·heartbeat 남음, 상수 30초 단언; (b) 빌드된 `dist/bin.js`로 기동·처리·두 번째 거절·죽은 pid 회수·SIGTERM·설정 없음을 행렬대로 -- 사용자 표면 증거
- [x] `apps/cli/test/dispatch.test.ts` -- `envelope: false`인 가짜 명령이 성공·실패에서 stdout을 비우고 실패를 stderr·exit으로 내는지 -- 새 dispatcher 분기

**Acceptance Criteria:**
- Given 설치된 임시 home과 transcript 하나가 든 임시 harness 폴더, when `brain daemon run`을 띄우면, then stdout은 비어 있고 pid 파일에 그 자식 pid가, heartbeat 파일과 로그 시작 줄이 생기며, 그 세션이 `sessions`에 들어간다.
- Given 떠 있는 데몬, when 두 번째 `brain daemon run`(`--json` 포함)을 띄우면, then 그것은 stdout 없이 exit 1과 stderr `DAEMON_RUNNING`으로 끝나고 첫 데몬의 pid 파일은 그대로다.
- Given 끝난 프로세스의 pid가 남은 pid 파일, when `brain daemon run`을 띄우면, then 뜨고 pid 파일이 새 pid로 바뀐다.
- Given 떠 있는 데몬, when SIGTERM을 보내면, then exit 0으로 끝나고 pid 파일이 없으며 로그에 종료 줄이 있다.
- Given 짧은 heartbeat 주기로 돈 `runDaemon`, when 주기 두세 번이 지나면, then heartbeat mtime이 매번 앞으로 가고, 실제 상수는 30초다.
- Given 이 변경 전의 모든 명령, when `pnpm test`를 돌리면, then 기존 시험이 그대로 통과한다(다른 명령 출력 불변).

## Implementation Notes

- `systemIsAlive`를 `runtime/spool.ts`에서 export해 `daemon/lock.ts`가 쓴다(Code Map의 두 선택지 중 재사용). 생존 판단이 두 벌이면 하나가 EPERM을 죽음으로 보고 살아 있는 데몬의 잠금을 빼앗는다.
- 잠금 판단 순서: "살아 있는 주인"만 거절로 바로 돌아가고 나머지(읽을 수 없음·이전 부팅·ESRCH)는 모두 회수로 떨어진다. 부팅 여유는 `BOOT_SLACK_MS = 600_000`으로 export했다(시험이 경계 양쪽을 짚는다).
- 상수 셋은 `daemon/run.ts`에 둔다(태스크의 "루프와 상수"). `heartbeat.ts`는 주기를 인자로 받으므로 상수에 의존하지 않고, 시험은 40ms로 돌린다.
- 로그 문장에서 pid는 마침표 뒤가 아니라 같은 절 안에 둔다(`데몬을 시작했습니다 — pid 123`). 출력 언어 검사는 절 단위로 한글을 보므로 `pid 123.`은 한글이 없는 절이 된다.
- drain 예산을 다 쓴 회차(`budget`)만 쉬지 않고, `empty`·`unwritable`·스키마 불일치·예외는 모두 `DAEMON_DRAIN_PAUSE_MS` 쉰다. 상태가 바뀔 때만 한 줄 쓰는 열쇠는 코드(`SCHEMA_MISMATCH`·`DB_UNAVAILABLE`·`DRAIN_THREW`)이고 문장이 아니다 — 예외 문장은 매번 줄 번호가 달라서 열쇠가 되지 못한다.
- 회차의 store는 `brain.close()` 대신 직접 닫는다(`drainOpportunistically`와 같은 모양). `createBrain`의 `close`는 그 store를 닫는 것이라 두 번 닫게 된다.
- `apps/cli/test/daemon-run.test.ts`의 `environment()`는 `withoutHarnessFolders`를 먼저 적용하고 그 뒤에 그 시험이 만든 `CLAUDE_CONFIG_DIR`을 덮어쓴다(`capture-scan.test.ts` 관례). 순서를 뒤집으면 격리가 시험 폴더를 지워 버린다.
- (리뷰 뒤 패치, codex 구현 세션) 회수 임시 이름에 자기 pid를 더했고(`daemon.pid.stale-<주인>-<자기 pid>`), 회차마다 `readConfig`를 다시 읽어 그 회차의 `storePath`를 쓰며 실패는 그 코드로 한 번만 기록한다. heartbeat는 진행 중 쓰기가 있으면 새 쓰기를 건너뛰고 `stop()`이 그 쓰기를 기다리며 `runDaemon`이 잠금을 놓기 전에 기다린다. 건수 줄과 `worked()`에 `spoolFailed`·`retried`·`released`·`lost`·`rereadMissing`·`reextractUnreachable`을 더했다. 예산 주석·README는 "보통의 종료"가 20초 안이고 그 뒤까지 처리 중인 일감은 죽을 수 있으며 청구는 10분 lease 만료로 돌아간다고 고쳤다. 시험: 실행 중 스키마 복구 뒤 수집, 실행 중 설정 고장 한 번 기록, 처리 중 핸들러가 끝날 때까지 abort가 잠금을 쥐고 기다림, 로그의 비밀 가림, 프로세스 시험의 `session_ingest` 완료 행.

## Plan Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 23 findings — high 0, medium 2, low 20, false 1, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) 회수의 rename이 경쟁자가 방금 만든 살아 있는 잠금을 잠깐 치워, 셋째 경쟁자가 그 틈에 잡으면 되돌리기가 EEXIST로 무시되어 데몬 둘 — 맞다. 다만 죽은 잠금 위에서 셋 이상이 같은 밀리초에 떠야 하고(launchd는 하나만 띄운다), 막으려면 회수 전체를 따로 직렬화하는 잠금이 든다. drain은 동시 실행을 전제한다(AD-7).
  - `[low]` `[patch]` (blind) 같은 죽은 pid를 회수하는 경쟁자들이 같은 `.stale-<pid>` 이름을 써서 서로의 파일을 옮기고 지울 수 있다 — 임시 이름에 자기 pid를 더했다(`daemon.pid.stale-<주인>-<자기 pid>`).
  - `[low]` `[reject]` (blind) 부팅 시각이 벽시계 − uptime이라 시계를 10분 넘게 앞으로 돌리면 살아 있는 주인이 이전 부팅처럼 보여 빼앗긴다 — 맞다. 계획 Design Notes가 받아들인 절충이고(수동 시계 변경은 드묾, 잘못 빼앗아도 drain은 동시 실행 안전), 고치려면 `kern.bootsessionuuid` 같은 부팅 id를 읽는 새 어댑터가 든다. 남은 위험에 적었다.
  - `[low]` `[patch]` (blind) 설정을 기동 때 한 번만 읽어 `setup run`이 `store.path`를 바꾼 뒤에도 옛 DB에 쓴다 — 회차마다 `readConfig`를 다시 읽고, 실패는 그 코드로 한 번만 기록하고 쉰다. 시험 추가.
  - `[low]` `[patch]` (blind) 10초 예산이 20초 안 종료를 보장한다고 README·주석이 말하지만 처리 중 핸들러는 무기한 기다린다 — 문구만 고쳤다: 보통의 종료가 그 안이고, 넘어가면 launchd가 죽일 수 있으며 청구는 10분 lease로 돌아간다(의도의 "lease 만료로 넘기고"와 같음).
  - `[low]` `[patch]` (blind) heartbeat `stop()`이 진행 중 쓰기를 기다리지 않아 잠금을 놓은 뒤 heartbeat가 쓰일 수 있다 — `stop()`이 진행 중 쓰기를 기다리고 `runDaemon`이 잠금 해제 전에 기다린다.
  - `[low]` `[reject]` (blind) 느린 파일 시스템에서 heartbeat 쓰기가 겹쳐 쌓인다 — 30초 간격에 ms 단위 쓰기라 일상에서 만나지 않는다. 위 패치가 진행 중이면 새 쓰기를 건너뛰게 해 덤으로 막는다.
  - `[low]` `[patch]` (blind) 건수 줄이 `spoolFailed`·`rereadMissing`·`reextractUnreachable` 등을 빠뜨려 spool 줄을 `failed/`로 옮기기만 한 회차는 로그가 없다 — `worked()`와 건수 문장에 여섯 칸을 더했다.
  - `[low]` `[reject]` (blind) 모든 예외가 `DRAIN_THREW` 한 열쇠라 다른 예외로 바뀌어도 성공 회차 없이는 기록되지 않는다 — 맞지만 드물고, 열쇠를 나누려면 오류 지문 규칙을 새로 정해야 한다(문장은 매번 달라 열쇠가 못 된다).
  - `[low]` `[reject]` (blind) run 폴더에 못 쓰는 등 잠금 I/O 실패가 `CODE: message` 대신 crash 줄(가린 스택)로 나간다 — exit 1이고 가린 채 나가며, 맞는 코드가 없어 고치려면 새 오류 코드가 든다. 홈 폴더가 쓰기 불가인 기계는 일상이 아니다.
  - `[low]` `[reject]` (edge) 회수 중 다른 starter가 빈 경로를 잡아 데몬 둘 — blind 첫 항목과 같은 이유.
  - `[low]` `[patch]` (edge) 종료 때 진행 중 heartbeat 쓰기가 잠금 해제 뒤 쓰인다 — blind heartbeat 항목과 같은 패치.
  - `[low]` `[reject]` (edge) SIGTERM 뒤 끝나지 않는 핸들러를 무기한 기다린다 — launchd는 ExitTimeOut 뒤 SIGKILL하고 그 청구는 lease 만료로 넘어간다(의도 그대로). 처리 중 일감을 끊지 않는 것은 drain의 규칙이고, 강제 종료 분기는 새 동작이다. 문구는 blind 예산 항목 패치로 고쳤다.
  - `[low]` `[patch]` (verification-gap) 실행 중 DB가 복구된 뒤 같은 데몬이 다시 수집하는지 시험이 없다 — 스키마 불일치로 시작해 불일치 줄을 본 뒤 버전을 되돌리고 같은 데몬이 세션을 수집하는 `runDaemon` 시험을 더했다.
  - `[medium]` `[patch]` (verification-gap) 처리 중인 drain이 끝날 때까지 종료가 기다리는지 시험이 없다 — 시험 전용 종류의 막힌 핸들러로 abort 뒤에도 잠금이 남고 `runDaemon`이 끝나지 않음을, 풀어 준 뒤 일감 완료·`{ ok: true }`·pid 삭제를 확인하는 시험을 더했다.
  - `[low]` `[patch]` (verification-gap) 데몬 로그의 비밀 가림을 확인하는 시험이 없다 — 예외 시험의 메시지에 심은 비밀을 넣고 `daemon.log`에 원문이 없고 가림 표식이 있음을 확인한다.
  - `[low]` `[patch]` (intent-alignment) "미리 넣어 둔 일감"이 `sessions` 행으로만 관찰된다 — 프로세스 시험에 `session_ingest` 일감의 `completed_at` 확인을 더했다.
  - `[low]` `[patch]` (intent-alignment) 쉬던 데몬이 뒤 회차에 새 일을 처리하는 것을 관찰하지 않는다 — verification-gap 복구 시험이 불일치 회차들 뒤의 성공 회차 수집을 확인한다(같은 패치).
  - `[low]` `[reject]` (intent-alignment) heartbeat 30초 주기를 프로세스 수준에서 재지 않는다 — 실제 상수 단언과 주입 주기의 mtime 진행 시험으로 덮는다. 30초 주기를 두 번 재는 프로세스 시험은 시험 하나에 1분이 넘는다.
  - `[false]` `[reject]` (intent-alignment) 읽을 수 없는 잠금과 이전 부팅 잠금을 살아 있는 pid여도 회수해 "죽은 pid만"을 넘는다 — 이전 부팅에 기록된 pid의 그 프로세스는 정의상 죽었고(같은 번호를 다른 프로세스가 쓸 뿐), 읽을 수 없는 잠금은 지킬 주인이 없다. 의도의 규칙을 지킨다(Design Notes).
  - `[low]` `[reject]` (intent-alignment) 동시 기동·여러 회수자를 실제로 겨루는 시험이 없다 — 회수 창은 `isAlive` 틈에 경쟁자를 끼워 결정적으로 시험하고, 실제 동시 실행 시험은 비결정적이다.
  - `[medium]` `[patch]` (intent-alignment) SIGTERM 때 처리 중 핸들러를 다루는지 관찰하지 않는다 — verification-gap 종료 항목과 같은 패치.
  - `[low]` `[reject]` (intent-alignment) DB에 못 쓴 transcript가 spool에 남는지 데몬 수준에서 관찰하지 않는다 — 데몬은 dispatcher와 같은 조립 함수로 같은 `fileSpool(spoolPath(home))`를 넘기고, 잠긴 DB에서 수집이 spool로 가는 길은 기존 Core·CLI 시험(`capture-scan`의 lock-holder 사례 등)이 덮는다. 데몬에서 재현하려면 10초 넘게 잠금을 쥐는 느린 시험이 든다.

### 2026-10-27 — Follow-up thorough review pass
- verdicts: 25 findings — high 0, medium 6, low 16, false 3, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) Three-starter reclamation can displace a living lock — carried: the same rename/restore claim remains described by the first prior row; preserve its low/reject verdict and existing rationale.
  - `[low]` `[reject]` (blind) Wall-clock jump can misidentify boot identity — carried: unchanged wall-clock-minus-uptime calculation; preserve the prior low/reject verdict and recorded residual risk.
  - `[medium]` `[patch]` (blind) Abort during configuration read still starts another drain — run.ts checks only before awaiting readConfig; fixed: abort is rechecked after readConfig and checkSchema, before drain execution; deterministic regressions cover both awaited boundaries.
  - `[low]` `[reject]` (blind) Lock filesystem errors escape as a crash — carried: unchanged acquire call and existing low/reject verdict; expected failure still exits with masked crash diagnostics.
  - `[low]` `[reject]` (blind) DRAIN_THREW hides a changed exception category — carried: same suppression key and claim as the prior low/reject row; retain its decision.
  - `[low]` `[reject]` (blind) Configuration warnings are not logged — readConfig success warnings cover unknown keys; ordinary setup/commands already expose them. A typo warning seen only through this resident process is uncommon; transition tracking adds state and branches for negligible additional harm.
  - `[low]` `[patch]` (blind) README promises an incorrect ten-second latency maximum — README and run.ts equate the pause with worst-case latency despite awaited handlers; fixed: README and the constant comment now say idle polling pause and acknowledge longer active work.
  - `[low]` `[patch]` (blind) Budget/empty/unwritable scheduling lacks regression coverage — existing tests assert constants and ingestion but do not distinguish the continuation timing; fixed: controlled budget/empty/unwritable tests observe the pause and release it to prove continuation.
  - `[medium]` `[patch]` (blind) Heartbeat is not observed during blocked drain work — the handler test checks only lock/shutdown state; fixed: the blocked-handler test observes three mtime advances while work remains unfinished; shared fix with verification-gap finding.
  - `[medium]` `[patch]` (blind) In-process test failure can leak the daemon timer — start() returns only a stop handle and afterEach removes folders without aborting in-process instances; fixed: startDaemon registers abort-and-await cleanup before callers can fail, and afterEach awaits it before removing homes.
  - `[low]` `[reject]` (edge) Third starter wins while a live lock is displaced — carried: identical location/claim to the prior recovery-race row; preserve low/reject.
  - `[medium]` `[patch]` (edge) SIGTERM during config read permits new drain — same demonstrated await boundary as blind abort finding; fixed by the shared abort rechecks and deterministic regressions.
  - `[low]` `[patch]` (edge) Startup readiness can read a nonexistent daemon log — startHeartbeat completes before the first log append; callback reads without an existence guard and waitFor propagates ENOENT; fixed: callback checks log existence before reading and retries until present.
  - `[low]` `[patch]` (edge) Reclamation readiness can read a missing pid path — rename deliberately creates a gap; callback reads directly and waitFor propagates ENOENT; fixed: callback uses readDaemonLock and retries during the absent-path window.
  - `[low]` `[reject]` (edge claim) Single-instance guarantee fails during concurrent recovery — carried: same race and existing low/reject decision; no new repair or deferral.
  - `[medium]` `[patch]` (verification-gap) Heartbeat independence from blocked drain is unverified — pre-verified: empty-database mtime checks and blocked-handler shutdown assertions cannot detect between-round heartbeat scheduling; fixed: blocked handler test now verifies three heartbeat mtime advances without handler completion.
  - `[low]` `[patch]` (verification-gap) Switching the valid configured database is unverified — pre-verified: invalid-config and schema-repair tests do not demonstrate moving writes to another configured database; fixed: two migrated databases, a valid config switch, and a later transcript prove only the new database receives subsequent work.
  - `[low]` `[reject]` (intent) Real 30-second process cadence is not timed — carried: prior row accepts the production constant assertion and short-interval mtime evidence; retain low/reject.
  - `[false]` `[reject]` (intent) Previously queued work and repeated drain use mixed test surfaces — the process test observes an actual completed session_ingest row; in-process tests also prove preinserted custom work and repeated recovery. This is descriptive evidence separation, not a missing required behavior.
  - `[medium]` `[patch]` (intent) Active work plus real SIGTERM is not jointly exercised — carried: prior medium/patch row already addressed the same observation through AbortController handler-wait coverage plus real-signal process coverage; do not patch again.
  - `[low]` `[reject]` (intent) External termination and lease recovery are not retested by daemon tests — the daemon delegates claim lifecycle to unchanged Core drain and awaits active work; new external-kill integration machinery would duplicate inherited lease recovery and is disproportionate for this tracer.
  - `[low]` `[reject]` (intent) No daemon-specific transcript-to-spool observation — carried: same assembly/existing spool coverage argument and prior low/reject verdict; no new deferral.
  - `[false]` `[reject]` (intent) Reclaiming unreadable or previous-boot locks exceeds live-pid wording — carried: prior false/reject row distinguishes original owner identity from reused numeric pid; preserve that interpretation and verdict.
  - `[low]` `[reject]` (intent) Strict concurrent recovery invariant is not established — carried: same rename restoration race and prior low/reject verdict; preserve existing decision.
  - `[false]` `[reject]` (intent) BMAD custom files are a separate change surface — both customization files existed untracked before this invocation and were supplied by the user; they are not daemon implementation changes. Preserve them without editing or claiming authorship.

## Design Notes

- standalone인 이유: 데이터베이스 명령의 dispatcher 경로는 store 하나를 열어 명령 끝에 닫고 쓰기 가드를 한 번만 본다. 상주 프로세스는 회차마다 store를 열고 스키마를 다시 봐야 하므로(DB 복구·마이그레이션 뒤에도 맞게), 설정 읽기와 조립을 데몬이 직접 하고 조립 함수만 dispatcher와 공유한다.
- 부팅 시각 검사: launchd가 로그인 때 띄우므로 재부팅 뒤 남은 pid 파일의 pid를 다른 프로세스가 쓰면 데몬이 영영 뜨지 않는다. 이전 부팅에서 쓴 pid는 정의상 죽은 것이라 "죽은 pid만 회수"를 지킨다. 10분 여유는 시계 보정으로 살아 있는 데몬을 빼앗지 않기 위한 것이고, 잘못 빼앗아도 drain은 동시 실행을 전제한다(AD-7).

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project cli` -- expected: 새 시험 포함 전부 통과
- `pnpm vitest run --project core` -- expected: 코드 표 시험 포함 통과
- `pnpm test` -- expected: 전체 통과(SQLite·bootstrap 포함; Docker가 필요한 프로젝트가 없으면 그 사실을 기록)

**결과(2026-10-27):**
- `pnpm build && pnpm typecheck` -- 오류 없음.
- `pnpm vitest run --project cli` -- 28 파일 882 통과(새 `daemon-lock` 18건, `daemon-run` 16건 포함).
- `pnpm vitest run --project core` -- 29 파일 1063 통과.
- `pnpm test`는 `postgres` 프로젝트가 Docker를 요구해서 global setup에서 멈춘다(이 기계에 Docker가 떠 있지 않음). 그래서 `postgres`를 뺀 모든 프로젝트를 한 번에 돌렸다: `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- 88 파일 2629 통과. 이 스토리는 Postgres를 건드리지 않는다.

## Auto Run Result

Status: built. Follow-up thorough review completed; ticket and plan status remain owned by the orchestrator. No tickets.py mark command was run.

**Implemented behavior.** The existing daemon tracer remains intact: shared Core assembly, stdout-free daemon command, repeated drain, pid ownership, heartbeat, masked logs, and graceful shutdown. This pass prevents a fresh drain after an abort received during configuration/schema reads, corrects the idle-polling latency description, and strengthens scheduling, heartbeat, configuration-switch, cleanup, and readiness evidence.

**Files changed since the baseline.**
- `apps/cli/src/assembly.ts` — shared dependency assembly for dispatcher and daemon.
- `apps/cli/src/dispatch.ts` — shared assembly and commands without stdout envelopes.
- `apps/cli/src/commands/daemon-run.ts` — daemon command and signal wiring.
- `apps/cli/src/commands/index.ts` — command registration.
- `apps/cli/src/config/paths.ts` — daemon pid, heartbeat, and log paths.
- `apps/cli/src/daemon/lock.ts` — ownership and stale-lock recovery.
- `apps/cli/src/daemon/heartbeat.ts` — independent heartbeat with awaited shutdown.
- `apps/cli/src/daemon/log.ts` — masked daemon log appends.
- `apps/cli/src/daemon/run.ts` — resident drain loop and abort guards at awaited startup boundaries.
- `apps/cli/src/runtime/spool.ts` — shared process-aliveness helper export.
- `packages/core/src/codes.ts` — DAEMON_RUNNING code.
- `packages/core/test/codes.test.ts` — error-code contract coverage.
- `apps/cli/test/daemon-lock.test.ts` — ownership and reclamation matrix.
- `apps/cli/test/daemon-run.test.ts` — process/runtime coverage plus six new regressions, independent heartbeat during blocked work, and reliable test cleanup/readiness.
- `apps/cli/test/dispatch.test.ts` — envelope-free command behavior.
- `README.md` — daemon usage, paths, ownership, shutdown, and corrected polling description.
- This plan — appended follow-up triage and result; existing triage decisions and deferred list preserved.
- `_bmad/custom/bmad-build-auto-codex.sh` — user-supplied Codex session adapter, recorded without content changes.
- `_bmad/custom/bmad-build-auto.toml` — user-supplied project workflow override, recorded without content changes.

**Review.** Four Codex CLI reviewers ran: blind-hunter, edge-case-hunter, verification-gap, intent-alignment. This pass records 25 finding rows: high 0, medium 6, low 16, false 3. Eight new patch groups were applied (medium 3: abort boundary, heartbeat evidence, test cleanup; low 5: latency wording, scheduling evidence, two readiness polls, database-switch evidence), spanning ten new finding rows. One additional medium/patch row was carried from the existing review without another patch. Fourteen rows were rejected, each with its specific refutation or prior decision in the triage log: existing reclamation race, wall-clock identity risk, lock-I/O crash output, exception suppression, unknown-key warning omission, production-cadence evidence split, queued-work evidence split, inherited lease recovery, inherited spool evidence, original-owner versus numeric-pid interpretation, and unrelated user-supplied workflow tooling. No new deferrals; no existing deferred-work ledger entries were edited, reopened, or rewritten.

**Follow-up review recommendation:** false. This is a follow-up pass with zero high patch groups; the existing workflow criterion does not recommend another pass for medium/low patch volume. Implementation session: `01a17b2c-55f0-7803-83e7-556e5412e732`.

**Verification after patches.**
- `pnpm build && pnpm typecheck` — passed.
- Targeted daemon-run tests in the implementation session — 26 passed; targeted CLI build and type-check passed.
- `pnpm test` — blocked during Postgres global setup because Docker is unavailable; no Postgres implementation changed.
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` — all available projects passed: 88 files, 2,639 tests. This includes both CLI and Core verification required by the plan.
- `git diff --check` — passed.

**Residual risks.** Prior review decisions remain unchanged: concurrent stale-lock reclamation can transiently displace a living lock; large wall-clock jumps can defeat estimated boot identity; a never-ending active handler requires external termination and inherited lease expiry; lock filesystem failures retain masked crash diagnostics. Real 30-second process cadence, external-kill lease recovery, and daemon-specific spool failure are covered through composition and existing narrower evidence rather than new long-running process scenarios. Postgres verification remains unavailable without Docker.
