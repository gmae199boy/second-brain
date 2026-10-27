---
title: '운영: daemon stop·start와 갱신 뒤 재시작'
type: 'feature'
ticket: '6'
created: '2026-10-27'
status: 'built'
baseline_revision: '14fb7bd77c582f1977836d4b2553327f66753885'
route: 'full'
route_source: 'pinned'
risk: 'high'
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

**Problem:** 9.2가 데몬 Label을 등록하고 9.3이 생존을 판단하지만, 사람이 데몬을 잠시 멈추거나 다시 올릴 명령이 없고, 플러그인 bootstrap이 앱을 새 commit으로 갱신해도 이미 떠 있는 데몬은 옛 빌드 코드로 계속 돈다(E9-6의 stop·start·재시작 부분).

**Approach:** launchd 제어 함수 셋(`stopDaemon`·`startDaemon`·`restartDaemon`)을 `apps/cli/src/daemon/control.ts`에 두고, `brain daemon stop`·`brain daemon start` 명령과 공용 설치 흐름(`runInstall` — 플러그인 bootstrap이 부르는 `dist/install.js`와 `setup run`이 지나는 곳)의 갱신 재시작 단계가 이 함수를 부른다. 데몬은 자기 빌드 commit을 pid 잠금에 적고 `daemon status`가 그것을 보여, 다시 뜬 데몬이 새 빌드임을 밖에서 확인한다.

## Boundaries & Constraints

**Always:**
- **adapter 확장.** `Launchctl`(`daemon/launchd.ts`)에 `kill(label, signal)` = `kill <SIGNAL> gui/<uid>/<label>`, 실패는 기존처럼 `{ ok: false, message }`. 메모리 가짜(`daemon-launchd.test.ts`)와 `test/fixtures/fake-launchctl.sh`에 같은 동작: 가짜 `kill`은 `loaded/<label>` 표식이 있으면 0, 없으면 stderr 한 줄과 3. 모든 launchctl 호출은 이 adapter를 지나고 시험은 실제 launchctl·실제 `~/Library/LaunchAgents`에 닿지 않는다(9.2 Implementation Notes의 사고를 되풀이하지 않는다).
- **`stopDaemon({ home, env, launchctl, platform, clock, isAlive?, bootAt?, waitMs? })`.** 순서가 계약이다: (1) darwin이고 uid가 있으며 `isLoaded`이면 먼저 `bootout`(KeepAlive가 다시 띄우지 못하게 Label부터 내림, plist는 남겨 다음 로그인에 다시 뜸 — 임시 정지); bootout 실패면 신호를 보내지 않고 실패. (2) 그다음 pid 잠금의 주인이 `ownerIsAlive`(9.3의 공용 규칙, 이전 부팅 검사 포함)로 살아 있으면 그 pid에 SIGTERM(ESRCH는 무시) — launchd 밖에서 손으로 띄운 데몬도 멈춘다. (3) 주인이 사라지거나 죽을 때까지 200ms 간격으로 최대 `DAEMON_STOP_WAIT_MS = 20_000`(drain 예산 10초 + launchd 기본 `ExitTimeOut` 20초 안) 기다린다. 결과 `{ unloaded: boolean, signalled_pid: number | null, alive: boolean }`; 기다림이 끝나도 살아 있으면 실패. SIGKILL은 쓰지 않는다.
- **`startDaemon({ env, launchctl, platform })`.** darwin 아님/uid 없음 → `unsupported`(호출 없음). plist(`daemonPlistPath(env)`)가 없으면 실패 `DAEMON_NOT_INSTALLED`. `isLoaded`면 `already-loaded`(bootstrap 없음). 아니면 `bootstrap(plist)` 성공 → `started`. plist를 새로 쓰지 않는다(재적재만; 쓰기는 설치기의 몫). 데몬이 실제로 떴는지 기다리지 않는다.
- **`restartDaemon({ env, launchctl, platform, plistChanged })`.** 올라 있는 Label을 새 빌드로 다시 띄운다. `plistChanged`가 거짓이면 `kill SIGTERM` 한 번 — 데몬이 정상 종료하고 `KeepAlive`가 같은 shim으로 다시 띄우며, shim이 가리키는 `dist/`가 이미 새 빌드다. 참이면 `bootout` 뒤 `bootstrap`(새 plist를 읽게); bootout 직후 bootstrap이 실패하면 1초 간격으로 두 번 더 시도. 결과 `{ ok: true, method: 'signal' | 'reload' } | { ok: false, message }`.
- **명령 두 개.** `apps/cli/src/commands/daemon-stop.ts`·`daemon-start.ts`, `commands/index.ts`에서 `daemonStatusCommand` 뒤에 stop, start 순. `ns: 'daemon'`, 같은 `nsDescription`, 한국어 `usedFor`·`output`·`examples`, `risk: 'write'`, `hook: false`, `dryRun: false`, `standalone: true`, 엔벨로프는 보통대로(snake_case 데이터). launchctl은 `systemLaunchctl({ env: context.env, uid: process.getuid?.() })`, 플랫폼은 `process.platform`, home은 `configHome(context.env)`. 텍스트는 한국어 한 줄. stop 데이터 = 위 결과; start 데이터 `{ status: 'started' | 'already-loaded' | 'unsupported', plist_path: string | null }`.
- **새 오류 코드 둘**(core `codes.ts`, 뜻·hint 한국어, README `### 오류 코드` 표에 행): `DAEMON_NOT_INSTALLED`(exit 2, retryable false, 데몬 plist가 없어 다시 올릴 Label이 없습니다, hint `` `brain setup run`으로 데몬을 등록하세요 ``), `DAEMON_CONTROL_FAILED`(exit 1, retryable true, launchctl 호출이 실패했거나 데몬이 기다리는 동안 멈추지 않았습니다, hint `` `brain daemon status`로 상태를 확인하고 같은 명령을 다시 실행하세요 ``). launchctl 실패와 stop 시간 초과는 `DAEMON_CONTROL_FAILED`.
- **갱신 뒤 재시작**(`install/flow.ts` `runInstall`). `deps.installed.read(home)`와 `deps.installed.build()`를 데몬 등록 **앞**에서 읽고(완료 기록 쓰기는 같은 값을 쓴다), 갱신 = 이전 기록이 있고 `previous.commit !== (build?.commit ?? null)`. 등록 결과가 `loaded`이고 갱신이면 `deps.daemon.restart(plist_changed, env)`를 한 번 부른다; `registered`(방금 새 빌드로 올림)·`unsupported`·`failed`이거나 갱신이 아니면 부르지 않는다. 자리는 등록 바로 뒤·`installed.write` 앞(spine AD-27의 upgrade 순서: Label 일치 → 데몬 재시작 → 완료 기록). 실패는 새 경고 `DAEMON_NOT_RESTARTED`(core `WARNING_CODES`·뜻: 데몬을 새 빌드로 다시 띄우지 못해 옛 빌드가 계속 돌 수 있습니다, README `### 경고 코드` 행)를 넣고 설치는 계속해 exit 0과 `installed.json`. `InstallReport.daemon`에 `restarted: boolean`. 진행 줄 한국어(다시 띄움·실패와 그 문장). `InstallDeps.daemon`에 `restart(plistChanged, env)`, `install.ts` `systemInstallDeps`가 `restartDaemon`에 잇는다. `setup-run.ts` `output` 문장에 반영. epic-operations의 `setup upgrade`가 같은 `restartDaemon`을 부르도록 export한다.
- **데몬의 빌드 commit.** `runDaemon`이 `readBuildIdentity()`의 commit(없으면 null)을 `acquireDaemonLock`에 넘기고 잠금 JSON에 `commit` 필드로 적는다(take·reclaim 둘 다). `readDaemonLock`은 `commit: string | null`(필드가 없거나 40자 hex가 아니면 null — 이전 잠금 파일도 읽힌다). `DaemonLiveness`가 두 경우 모두 `commit`을 실어(잠금 없으면 null) `daemon status` 데이터에 `commit` 키, 텍스트에 짧은 commit. 잠금의 나머지 동작(원자적 생성·회수 규칙)은 그대로.
- **README**(한국어, 절대 홈 경로 금지): `## 데몬`에 `brain daemon stop`(Label부터 내리고 SIGTERM, 다음 로그인이나 `brain daemon start`·`brain setup run`까지 멈춤, 그동안 명령의 기회적 drain이 받침, doctor `daemon`이 `warn`)·`brain daemon start`·갱신 뒤 재시작(이전 기록과 다른 빌드를 설치할 때 올라 있는 데몬에 SIGTERM, `DAEMON_NOT_RESTARTED`)·`daemon status`의 `commit`. 9.2가 쓴 "멈추려면 `launchctl bootout …`" 문단을 `brain daemon stop`으로 바꾼다. 코드 표 세 행.

**Never:**
- `setup upgrade`·`setup uninstall` 명령(epic-operations·9.10), 실제 Mac 실증(9.8), 로그 회전(9.9), 소켓·handshake·`VERSION_MISMATCH` 경로, 데몬 스스로의 자동 업데이트.
- `tooling/bootstrap`의 제품 코드 변경(bootstrap은 `dist/install.js`만 부르고 그 안에서 재시작이 일어난다; `bin/second-brain.js`·`plugin/bootstrap.mjs` 재빌드 없음), `plugin/app-ref`·plugin `version` 변경.
- 같은 빌드로 다시 설치할 때(`setup run` 반복) 데몬을 재시작하기 — 9.2의 "두 번 돌려도 bootstrap 한 번·추가 호출 없음" 계약을 지킨다. 첫 설치에서 재시작을 부르기.
- `launchctl disable`(로그인을 넘어 남는 정지), SIGKILL, 잠금 주인이 아닌 pid에 신호 보내기, 생존 판단을 두 벌 두기, Core(`packages/core`)에 launchd·프로세스 코드(코드 표 항목만 예외), 기존 설치 단계의 순서·문장·exit 바꾸기(재시작 줄을 더하는 것 말고).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| stop, launchd 데몬 | Label 올라 있음, 살아 있는 잠금 주인 | `bootout` 다음 SIGTERM, 주인이 사라지면 `{ unloaded: true, signalled_pid, alive: false }`, exit 0 | — |
| stop, 손으로 띄운 데몬 | Label 없음, 살아 있는 주인 | bootout 없이 SIGTERM, `unloaded: false` | — |
| stop, 아무것도 없음 | Label 없음, 잠금 없음 | 호출은 `print`뿐, `signalled_pid: null`, exit 0 | — |
| stop, bootout 실패 | launchctl이 0 아닌 exit | 신호 보내지 않음 | `DAEMON_CONTROL_FAILED`, exit 1 |
| stop, 안 멈춤 | SIGTERM을 무시하는 주인 | 20초 뒤 | `DAEMON_CONTROL_FAILED` |
| stop, 죽은 잠금 | 잠금 pid 사망·이전 부팅 | 신호 없음, `alive: false` | — |
| start | plist 있음, Label 없음 | `bootstrap gui/<uid> <plist>` 한 번, `started` | 실패면 `DAEMON_CONTROL_FAILED` |
| start 반복 | 이미 올라 있음 | bootstrap 없음, `already-loaded` | — |
| start, 설치 안 됨 | plist 없음 | 호출 없음 | `DAEMON_NOT_INSTALLED`, exit 2 |
| start/stop, macOS 아님 | `platform: linux` | start `unsupported`; stop은 신호만 | — |
| 갱신 설치 | 이전 기록 commit A, 빌드 B, Label 올라 있음, plist 같음 | `kill SIGTERM gui/<uid>/<Label>` 한 번, `restarted: true` | 실패면 `DAEMON_NOT_RESTARTED`, exit 0, 기록 씀 |
| 갱신 + plist 바뀜 | 위 + `plist_changed` | `bootout` 뒤 `bootstrap`, `restarted: true` | 같음 |
| 같은 빌드 재설치 | 이전 기록 commit = 빌드 | 재시작 없음, `restarted: false` | — |
| 첫 설치 | 이전 기록 없음 | 등록만(9.2), 재시작 없음 | — |
| 갱신, Label 안 올라 있음 | `registered` | 등록이 새 빌드로 올렸으므로 재시작 없음 | — |
| 옛 잠금 파일 | `commit` 필드 없음 | 읽힘, `commit: null` | — |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/launchd.ts` -- `Launchctl`·`systemLaunchctl`(9.2): `kill` 추가. `daemonPlistPath`, `DAEMON_LABEL`, `registerDaemon`(`plist_changed`)은 그대로 쓴다. `unregisterDaemon`은 손대지 않는다(9.10).
- `apps/cli/src/daemon/control.ts` (새 파일) -- stop·start·restart. `ownerIsAlive`·`readDaemonLock`(`lock.ts`), `systemIsAlive`(`runtime/spool.ts:519`, EPERM은 생존). 기본 `bootAt`은 `lock.ts`처럼 `clock.now() − uptime()*1000`.
- `apps/cli/src/daemon/lock.ts` -- `LockDocument`·`take`(≈200)·`reclaim`·`readOwner`(≈265)·`DaemonLockOwner`에 `commit`. 회수·생성 규칙은 그대로.
- `apps/cli/src/daemon/run.ts:118` -- `acquireDaemonLock` 호출에 commit. `install/installed.ts`의 `readBuildIdentity`(`dist/build.json`). 순환 주의: `liveness.ts`는 `run.ts`를 import하지 않는다(9.3).
- `apps/cli/src/daemon/liveness.ts`, `commands/daemon-status.ts` -- `commit` 실어 나르기. 9.3의 판단 규칙은 바꾸지 않는다.
- `apps/cli/src/commands/daemon-run.ts`·`daemon-status.ts` -- standalone 명령 모양, `StandaloneCommandContext`(`env`·`clock`). standalone 명령은 기회적 drain을 돌지 않는다(`dispatch.ts:546`); "stop 뒤 기회적 drain"은 다음 DB 명령의 것.
- `apps/cli/src/install/flow.ts` -- `InstallReport.daemon`(≈78), `InstallDeps.daemon`(276), 등록 단계(588–608), `build`·`previous` 읽기(613–614)를 등록 앞으로. `apps/cli/src/install.ts:194` -- `systemInstallDeps`의 `daemon`.
- `apps/cli/src/commands/setup-run.ts` -- `output` 문장.
- `packages/core/src/codes.ts` -- `WARNING_CODES`(`DAEMON_NOT_REGISTERED` 뒤)·뜻 표, `CODES`(`DAEMON_RUNNING` 근처). `packages/core/test/codes.test.ts`, `apps/cli/test/readme-codes.test.ts`, `output-language.test.ts`, `command-meta.test.ts`, `guide.test.ts`가 새 코드·명령을 자동으로 건다.
- `apps/cli/test/fixtures/fake-launchctl.sh` -- `kill` 분기. `apps/cli/test/environment.ts` -- `withoutHarnessFolders`가 모듈마다 가짜 폴더를 준다(`FAKE_LAUNCHCTL_DIR/loaded/<Label>` 표식이 "올라 있음"). 자기 폴더가 필요한 시험은 이 함수 뒤에 env를 덮는다.
- `apps/cli/test/daemon-status.test.ts`·`daemon-run.test.ts` -- 빌드된 `dist/bin.js` spawn, `installed()`·`transcript()` 픽스처, 살아 있는 잠금 JSON 쓰기, 데몬 subprocess 띄우기·SIGTERM 관례.
- `apps/cli/test/install-flow.test.ts` -- `harness(options)`의 가짜 `daemon`(호출 기록), 보고 기대값에 `restarted`.
- `tooling/bootstrap/test/hook.test.ts` -- 실제 clone·build로 SessionStart를 돌리는 시험. `beforeAll`의 `work`·`bare`·`plugin/app-ref`, `hook()`의 가짜 launchctl env(`root/launchctl`, `root/launch-agents`). 기존 두 시험 뒤에 갱신 시험을 더한다. 느리다(`SLOW`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/daemon/launchd.ts`, `apps/cli/test/fixtures/fake-launchctl.sh` -- `kill` -- 재시작 신호
- [x] `apps/cli/src/daemon/lock.ts`, `daemon/run.ts`, `daemon/liveness.ts`, `commands/daemon-status.ts` -- 잠금의 `commit`과 status 노출 -- 다시 뜬 데몬의 빌드를 밖에서 확인
- [x] `apps/cli/src/daemon/control.ts` -- `stopDaemon`·`startDaemon`·`restartDaemon`, `DAEMON_STOP_WAIT_MS` -- 한 곳의 launchd 제어
- [x] `packages/core/src/codes.ts` -- `DAEMON_NOT_INSTALLED`·`DAEMON_CONTROL_FAILED`·`DAEMON_NOT_RESTARTED` -- 실패의 어휘
- [x] `apps/cli/src/commands/daemon-stop.ts`, `daemon-start.ts`, `commands/index.ts` -- 명령과 등록 -- 사용자 표면
- [x] `apps/cli/src/install/flow.ts`, `apps/cli/src/install.ts`, `commands/setup-run.ts` -- 갱신 판정·재시작 단계·보고·진행 줄 -- bootstrap 갱신과 `setup upgrade`가 함께 쓸 단계
- [x] `README.md` -- 위 절과 코드 표 -- 문서 대조 시험과 사용자
- [x] `apps/cli/test/daemon-control.test.ts` (새 파일) -- 행렬의 stop·start·restart 행을 메모리 가짜 `Launchctl`·주입 `isAlive`·`bootAt`·짧은 `waitMs`로; 호출 순서(bootout이 신호보다 먼저), 잠금 주인이 아닌 pid에 신호 없음 -- 규칙의 증거
- [x] `apps/cli/test/daemon-stop-start.test.ts` (새 파일) -- 빌드된 `dist/bin.js`로: 설치된 임시 home에서 `brain daemon run`을 subprocess로 띄우고 `loaded/<Label>` 표식을 둔 뒤 `daemon stop --json` → exit 0, 가짜 호출에 `bootout gui/<uid>/<Label>`, 데몬 프로세스가 끝나고 pid 파일이 사라지며, `daemon status --json` `alive: false`, `doctor run --json`의 `daemon` `warn`·exit 0, 임시 transcript 폴더의 transcript가 다음 `failures list`의 기회적 drain으로 들어온다; 이어서 `daemon start --json` → `started`, 호출에 `bootstrap gui/<uid> <plist>` 한 번, 다시 `daemon start` → `already-loaded`·bootstrap 추가 없음; plist 없는 home의 `daemon start` → `DAEMON_NOT_INSTALLED` exit 2; 살아 있는 데몬의 `daemon status --json` `commit`이 `dist/build.json`의 commit과 같다 -- 사용자 표면 증거
- [x] `apps/cli/test/install-flow.test.ts`, `daemon-launchd.test.ts`, `daemon-liveness.test.ts`, `daemon-lock.test.ts`와 기대값이 바뀌는 다른 시험 -- 재시작 조건 행(갱신+loaded → 한 번, 같은 빌드·첫 설치·registered → 없음, 실패 → 경고·exit 0·기록), 새 필드 반영 -- 흐름 규칙
- [x] `tooling/bootstrap/test/hook.test.ts` -- 갱신 시험: `work`에 빈 commit 하나를 더해 `bare`에 push하고 `plugin/app-ref`를 그것으로 바꾼 뒤 SessionStart → exit 0, `installed().commit`이 새 commit, 가짜 호출 기록에 `kill SIGTERM gui/<uid>/<Label>`이 정확히 한 줄(첫 설치의 `bootstrap` 말고 bootstrap 추가 없음); 그다음 launchd를 흉내 내어 plist의 `ProgramArguments`를 같은 env로 띄우고 `daemon status --json`이 `alive: true`가 될 때까지 기다려 `commit`이 `installed().commit`과 같음을 보고 SIGTERM으로 끝낸다 -- bootstrap 갱신의 사용자 표면 증거

**Acceptance Criteria:**
- Given 설치된 임시 home에서 떠 있는 데몬과 올라 있는 Label(가짜 launchctl), when `brain daemon stop`을 돌리면, then 데몬이 끝나고 `daemon status`가 살아 있지 않다고 하며 doctor `daemon`이 `warn`(exit 0)이고, 그다음 일반 명령의 기회적 drain이 밀린 transcript를 수집한다.
- Given 그 뒤, when `brain daemon start`를 두 번 돌리면, then 가짜 기록에 그 plist의 `bootstrap`이 한 번만 있다.
- Given 플러그인 SessionStart로 설치된 home과 더 새 commit을 가리키는 plugin `app-ref`, when SessionStart를 다시 돌리면, then 재시작 호출이 한 번 기록되고, plist가 띄우는 데몬의 `daemon status` `commit`이 새 `installed.json`의 `commit`과 같다.
- Given 이 변경 전의 설치·CLI·bootstrap 시험, when 가용 프로젝트 전체를 돌리면, then 새 필드·코드·명령 말고는 그대로 통과하고, 시험 전후 실제 `~/Library/LaunchAgents`에 이 Label의 plist가 없다.

## Implementation Notes

- `daemon/control.ts`에 stop/start/restart를 모았다. 명령은 제어 실패를 `DaemonControlError`의 코드와 exit로 엔벨로프에 싣는다. stop은 잠금 주인의 공용 생존 규칙을 쓰고 bootout 뒤에만 SIGTERM을 보낸다.
- 갱신 판단의 이전 기록·빌드 읽기는 등록 앞으로 옮겼고, 등록 뒤 재시작을 끝낸 다음 같은 값으로 완료 기록을 쓴다. 같은 빌드·첫 설치·방금 등록한 Label은 재시작하지 않는다.
- daemon 잠금의 commit은 새로 잡기와 회수 뒤 잡기 양쪽에 기록한다. 옛 잠금·잘못된 commit은 null이며 status의 생존 결과와 무관하게 전달한다.
- bootstrap 제품 코드·생성된 런처·plugin app-ref/version은 변경하지 않았다. 새 bootstrap 시험만 임시 저장소에 빈 commit을 만들고 임시 플러그인의 ref를 바꾼다.
- Implementation session's own self-check (not this workflow's review), moved here by the orchestrator:
  - medium / defer — `launchd.ts`의 기존 `isLoaded`는 모든 print 실패를 false로 바꾼다. stop은 계획대로 이 공용 boolean 계약을 사용하므로 probe 오류 때 Label이 남은 채 SIGTERM을 보낼 수 있다. 등록·해제도 쓰던 adapter의 기존 구분 한계이며 별도 후속 작업으로 기록했다.
  - medium / patch — `daemon-launchd.test.ts`의 메모리 kill 가짜가 loaded 상태를 보지 않아 미등록 Label에도 성공했다. shell 가짜와 같이 loaded가 거짓이면 실패하도록 직접 수정했다.

## Plan Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `reject` (quick) `stopDaemon` treats a failed `launchctl print` probe as an absent Label, skips `bootout`, signals the owner, and can report success while `KeepAlive` restarts it — real: `systemLaunchctl.isLoaded` (`apps/cli/src/daemon/launchd.ts:67`) maps every non-zero `print` to false and `control.ts:38` follows it. But on macOS the GUI-domain `print` answers 0 or 113 in practice; the remaining failures are a missing `/bin/launchctl` or a 10-second stall, unlikely in everyday use. The fix needs a tri-state probe in the shared adapter (new branch and public surface, against 9.2's `0이 아니면 거짓` contract), more than a direct correction. Same root cause as 9.2's rejected low rows; kept as a residual risk below.

## Design Notes

- **재시작은 신호 + KeepAlive:** shim은 home 안의 같은 `app/` 클론을 가리키고 bootstrap은 그 클론을 제자리에서 갱신하므로 plist는 그대로다. 그래서 `kill SIGTERM`이면 데몬이 진행 중 drain을 정상으로 끝내고(9.1의 SIGTERM 경로), launchd가 같은 인자로 새 `dist/`를 띄운다. `bootout`→`bootstrap`은 비동기 해제와 겹쳐 실패하기 쉬우므로 plist가 바뀐 드문 경우에만 쓰고 재시도한다. 실제 launchd에서의 재기동 확인은 9.8.
- **재시작을 설치기에 두는 이유:** bootstrap 파일은 `node:` 내장만 쓸 수 있어 adapter를 가져올 수 없고, `setup upgrade`가 "같은 단계"를 불러야 한다. bootstrap 갱신은 언제나 `dist/install.js`를 지나므로 `runInstall` 안의 단계 하나가 두 길을 모두 덮는다. 갱신 판정을 이전 기록의 commit으로 하는 것은 bootstrap이 설치기를 부르는 조건(`installed.commit !== ref`)과 같은 사실을 보기 위해서다.
- **stop의 순서:** 신호를 먼저 보내면 KeepAlive가 곧 다시 띄운다. Label을 먼저 내리면 launchd도 SIGTERM을 보내므로 뒤따르는 우리 SIGTERM은 같은 주인에게 한 번 더일 뿐이고, launchd 밖의 데몬을 멈추는 길도 된다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project core --project cli` -- expected: 새 시험 포함 전부 통과
- `pnpm vitest run --project bootstrap` -- expected: 갱신 시험 포함 통과(느림)
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- expected: 전부 통과(`postgres`는 Docker가 없으면 기록하고 뺀다)
- `ls ~/Library/LaunchAgents | grep second-brain; launchctl print gui/$(id -u)/io.github.gmae199boy.second-brain.daemon` (시험 전후) -- expected: plist 없음, print 113

**실행 결과 (2026-10-27):**
- `pnpm build`와 `pnpm typecheck`: 통과(최종 재실행 포함).
- `pnpm vitest run --project core --project cli`: 초기 실행에서 새 코드 기대 목록·README 경고 순서 3건을 발견해 수정했다. 이후 아래 전체 실행과 별도 표/잠금/생존/설치 회귀 실행으로 통과 확인했다.
- `pnpm vitest run --project bootstrap`: 4 파일, 131 시험 통과. SessionStart 갱신 뒤 SIGTERM 호출 1회·bootstrap 추가 없음·plist 실행 데몬의 새 commit 일치를 검증했다.
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project test-db --project modelstudio`: 92 파일, 2622 시험 통과.
- 추가한 잠금/생존/adapter 시험과 설치/코드 표 회귀 실행: 6 파일, 287 시험 통과. 최종 control 행렬: 14 시험 통과.
- `git diff --check`: 통과. Docker가 없어 `postgres` 프로젝트는 실행하지 않았다(`docker info` exit 1).
- 시험 전후 실제 `~/Library/LaunchAgents`의 daemon plist는 없고, 최종 `launchctl print`는 exit 113이다. launchctl을 바꾸는 시험 호출은 모두 가짜 adapter/실행 파일과 임시 LaunchAgents 폴더를 사용했다.
- 남은 구현 항목 없음. 실제 launchd KeepAlive 재기동 실증은 계약대로 9.8 범위다.

- 리뷰 수정 뒤 최종 통합 검증: `pnpm build && pnpm typecheck` 통과; bootstrap 포함 가용 8개 프로젝트 96 파일 / 2765 시험 통과. 메모리 launchctl kill의 미등록 Label 실패 규칙을 수정하고 회귀 시험을 추가했다. 기존 print 오류 구분 한계 1건을 후속 작업으로 기록했다.

## Auto Run Result

Status: built. Ticket completion belongs to the orchestrator; no tickets.py mark was run. No operator actions are owed by this ticket (real-Mac launchd proof is ticket 9.8).

- Summary: `brain daemon stop` unloads the Label first and then sends SIGTERM to the lock owner, waiting up to 20 seconds; `brain daemon start` re-bootstraps the existing plist once; the shared installer restarts a loaded daemon once when the previous `installed.json` names a different build (SIGTERM via `launchctl kill`, or bootout+bootstrap when the plist changed), with `DAEMON_NOT_RESTARTED` as a warning on failure. The daemon writes its build commit into the pid lock and `daemon status` shows it, so a restarted daemon can be checked against `installed.json`.
- Files: `apps/cli/src/daemon/control.ts` (stop/start/restart); `daemon/launchd.ts` (`kill` in the adapter); `daemon/lock.ts`, `daemon/run.ts`, `daemon/liveness.ts`, `commands/daemon-status.ts` (build commit in the lock and status); `commands/daemon-stop.ts`, `commands/daemon-start.ts`, `commands/index.ts` (commands); `install/flow.ts`, `install.ts`, `commands/setup-run.ts` (restart step after registration, report `restarted`); `packages/core/src/codes.ts` and its test (`DAEMON_NOT_INSTALLED`, `DAEMON_CONTROL_FAILED`, `DAEMON_NOT_RESTARTED`); `README.md` (데몬 section, code tables); tests `daemon-control`, `daemon-stop-start` (new), `daemon-launchd`, `daemon-liveness`, `daemon-lock`, `install-flow`, fake launchctl `kill`, and `tooling/bootstrap/test/hook.test.ts` (plugin ref update → one restart call, plist-launched daemon reports the new commit). Bootstrap product code, `plugin/app-ref` and plugin version unchanged.
- Review: quick lens, 1 finding — 0 patched, 0 deferred, 1 rejected (low; reason in the triage log). The implementation session had also appended an entry to `_bmad-output/personal-brain/deferred-work.md` on its own; the orchestrator reverted that ledger edit, since the finding was triaged here and rejected.
- Follow-up review recommended: false (no patched entries).
- Verification: orchestrator ran `pnpm build` and `pnpm typecheck` (pass) and all available projects (core, sqlite, claude-code, second_brain, cli, bootstrap, test-db, modelstudio): 96 files, 2,764 of 2,765 passed. The one failure was `apps/cli/test/daemon-run.test.ts` reading the database read-only while the daemon wrote (`database is locked`); that file is not touched by this change, and three reruns of it gave 1 failure (a different case in the same file) then 34/34 twice — an intermittent pre-existing race in the test helper. The implementation session's own full run passed 2,765/2,765. Every I/O matrix row has a passing covering test (unit rows in `daemon-control.test.ts`, `daemon-lock.test.ts`, `install-flow.test.ts`; surface rows in `daemon-stop-start.test.ts` and the bootstrap hook update test). PostgreSQL omitted (Docker unavailable). Real `~/Library/LaunchAgents` daemon plist absent before and after; `launchctl print gui/<uid>/<Label>` returned 113.
- Residual risks: a failing `launchctl print` probe makes `daemon stop` skip `bootout` (rejected low above; shared with 9.2's `unregisterDaemon`). The `DAEMON_RUNNING` JSDoc in `packages/core/src/codes.ts` now sits above the new `DAEMON_NOT_INSTALLED` entry (cosmetic). `daemon-run.test.ts` has an intermittent read-while-writing lock failure. Restart via `launchctl kill SIGTERM` relies on `KeepAlive` and launchd throttling; real launchd behaviour is verified in 9.8.
