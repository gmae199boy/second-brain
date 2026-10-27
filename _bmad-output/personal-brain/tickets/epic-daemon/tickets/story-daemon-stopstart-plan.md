---
title: '운영: daemon stop·start와 갱신 뒤 재시작'
type: 'feature'
ticket: '6'
created: '2026-10-27'
status: done
baseline_revision: e9f369b44b2bd2dca5d8900b4a2bb7b46d3b698f
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      데몬 재시작이 실패한 뒤 같은 ref의 SessionStart는 설치기를 부르지 않아 재시도하지 않는다.
    evidence: |-
      tooling/bootstrap/src/bootstrap.ts:389-390의 fast path는 installed.commit이 plugin ref와 같으면 설치기 전에 0으로 끝난다. 재시작 실패에도 설치는 계약대로 새 commit으로 installed.json을 쓰므로, 다음 재시도는 `brain setup run`이나 새 plugin ref의 bootstrap 때만 일어난다. 이 plan의 Never가 tooling/bootstrap 제품 코드 변경을 막으므로 자동 회복은 후속 작업이다(README와 deferred-work.md에 기록).
    location: >-
      tooling/bootstrap/src/bootstrap.ts:389
    severity: medium
  - summary: >-
      plist 재적재가 bootout에서 실패한 뒤 다시 설치하면 디스크 변경 표식이 사라져 기존 실행 인자를 재적재하지 못할 수 있다.
    evidence: |-
      registerDaemon은 실행 중 Label을 확인하기 전에 새 plist를 저장하고, 다음 호출은 같은 파일이면 plist_changed를 false로 돌려준다. 첫 bootout이 실패하면 다음 설치의 restartDaemon은 SIGTERM 경로를 택해 launchd에 남은 옛 인자를 유지한다. 검토 기준 revision의 registerDaemon과 restartDaemon에도 같은 쓰기·분기 순서가 있어 이번 변경 전부터 있던 문제다. 로드된 plist와 디스크의 차이를 보존하는 후속 설계가 필요하며, 기존 deferred-work 항목은 변경하지 않았다.
    location: >-
      apps/cli/src/daemon/launchd.ts:139; apps/cli/src/daemon/control.ts:87
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 9.2가 데몬 Label을 등록하고 9.3이 생존을 판단하지만, 사람이 데몬을 잠시 멈추거나 다시 올릴 명령이 없고, 플러그인 bootstrap이 앱을 새 commit으로 갱신해도 이미 떠 있는 데몬은 옛 빌드 코드로 계속 돈다(E9-6의 stop·start·재시작 부분).

**Approach:** launchd 제어 함수 셋(`stopDaemon`·`startDaemon`·`restartDaemon`)을 `apps/cli/src/daemon/control.ts`에 두고, `brain daemon stop`·`brain daemon start` 명령과 공용 설치 흐름(`runInstall` — 플러그인 bootstrap이 부르는 `dist/install.js`와 `setup run`이 지나는 곳)의 갱신 재시작 단계가 이 함수를 부른다. 데몬은 자기 빌드 commit을 pid 잠금에 적고 `daemon status`가 그것을 보여, 다시 뜬 데몬이 새 빌드임을 밖에서 확인한다.

## Boundaries & Constraints

**Always:**
- **adapter 확장.** `Launchctl`(`daemon/launchd.ts`)에 `kill(label, signal)` = `kill <SIGNAL> gui/<uid>/<label>`, 실패는 기존처럼 `{ ok: false, message }`. 메모리 가짜(`daemon-launchd.test.ts`)와 `test/fixtures/fake-launchctl.sh`에 같은 동작: 가짜 `kill`은 `loaded/<label>` 표식이 있으면 0, 없으면 stderr 한 줄과 3. 모든 launchctl 호출은 이 adapter를 지나고 시험은 실제 launchctl·실제 `~/Library/LaunchAgents`에 닿지 않는다(9.2 Implementation Notes의 사고를 되풀이하지 않는다).
- **`stopDaemon({ home, env, launchctl, platform, clock, isAlive?, bootAt?, waitMs? })`.** 순서가 계약이다 (2026-10-27 사용자 결정으로 고침): (1) darwin이고 uid가 있으며 `isLoaded`이면 `bootout`(Label을 내려 KeepAlive가 다시 띄우지 못하게 하고, launchd가 데몬에 SIGTERM을 보낸다 — macOS 표준 방식. plist는 남겨 다음 로그인에 다시 뜸 — 임시 정지); bootout 실패면 실패. (2) **stop은 어떤 pid에도 직접 신호를 보내지 않는다.** 모든 신호는 launchctl을 거친다. 잠금 파일의 pid는 생존 판단과 보고에만 쓴다(재부팅 없이 재사용된 pid에 신호가 가는 일을 막는다). launchd 밖에서 손으로 띄운 데몬(Label 없음, 살아 있는 잠금 주인)은 건드리지 않고 아래 (3)대로 살아 있다고 보고한다. (3) 잠금 주인이 사라지거나 죽을 때까지 200ms 간격으로 최대 `DAEMON_STOP_WAIT_MS = 20_000` 기다린다. 결과 `{ unloaded: boolean, alive: boolean, owner_pid: number | null }` — `owner_pid`는 기다림이 끝난 때 살아 있는 잠금 주인(없으면 null). 처음 주인이 사라졌어도 **다른 pid가 잠금을 잡고 살아 있으면 멈춘 것이 아니다**: `alive: true`, 그 pid를 `owner_pid`로, 실패(`DAEMON_CONTROL_FAILED`). 살아 있는 주인이 남으면(손으로 띄운 데몬 포함) 실패이고, hint가 그 pid와 "launchd 밖에서 띄운 데몬은 그 터미널에서 멈추세요"를 말한다. SIGKILL은 쓰지 않는다.
- **drain 시점** (2026-10-27 사용자 결정): `daemon stop`은 drain하지 않는다(명령 끝 기회적 drain도 이 명령에서는 돌지 않는다). 밀린 일은 데몬이 다시 뜰 때 첫 drain이 처리하고(9.1의 루프는 뜨자마자 drain부터 한다), 데몬이 멈춰 있는 동안에는 다른 명령 끝의 기회적 drain(9.3)과 SessionStart drain이 받친다.
- **`startDaemon({ env, launchctl, platform })`.** darwin 아님/uid 없음 → `unsupported`(호출 없음). plist(`daemonPlistPath(env)`)가 없으면 실패 `DAEMON_NOT_INSTALLED`. `isLoaded`면 `already-loaded`(bootstrap 없음). 아니면 `bootstrap(plist)` 성공 → `started`. plist를 새로 쓰지 않는다(재적재만; 쓰기는 설치기의 몫). 데몬이 실제로 떴는지 기다리지 않는다.
- **`restartDaemon({ env, home, launchctl, platform, plistChanged, expectCommit, clock, waitMs? })`.** 올라 있는 Label을 새 빌드로 다시 띄운다. `plistChanged`가 거짓이면 `launchctl kill SIGTERM gui/<uid>/<Label>` 한 번 — 데몬이 정상 종료하고 `KeepAlive`가 같은 shim으로 다시 띄우며, shim이 가리키는 `dist/`가 이미 새 빌드다. 참이면 `bootout` 뒤 `bootstrap`(새 plist를 읽게); bootout 직후 bootstrap이 실패하면 1초 간격으로 두 번 더 시도. **성공의 뜻** (2026-10-27 사용자 결정): 요청이 받아들여진 것이 아니라, 요청 뒤 200ms 간격으로 최대 `DAEMON_RESTART_WAIT_MS = 15_000` 안에 9.3의 생존 판단으로 살아 있는 잠금 주인이 있고 그 잠금의 `commit`이 `expectCommit`과 같은 것을 **관찰**했을 때다. 기다림이 끝나면 실패와 그 문장(마지막으로 본 pid·commit). 결과 `{ ok: true, method: 'signal' | 'reload', pid, commit } | { ok: false, message }`.
- **명령 두 개.** `apps/cli/src/commands/daemon-stop.ts`·`daemon-start.ts`, `commands/index.ts`에서 `daemonStatusCommand` 뒤에 stop, start 순. `ns: 'daemon'`, 같은 `nsDescription`, 한국어 `usedFor`·`output`·`examples`, `risk: 'write'`, `hook: false`, `dryRun: false`, `standalone: true`, 엔벨로프는 보통대로(snake_case 데이터). launchctl은 `systemLaunchctl({ env: context.env, uid: process.getuid?.() })`, 플랫폼은 `process.platform`, home은 `configHome(context.env)`. 텍스트는 한국어 한 줄. stop 데이터 = 위 결과; start 데이터 `{ status: 'started' | 'already-loaded' | 'unsupported', plist_path: string | null }`.
- **새 오류 코드 둘**(core `codes.ts`, 뜻·hint 한국어, README `### 오류 코드` 표에 행): `DAEMON_NOT_INSTALLED`(exit 2, retryable false, 데몬 plist가 없어 다시 올릴 Label이 없습니다, hint `` `brain setup run`으로 데몬을 등록하세요 ``), `DAEMON_CONTROL_FAILED`(exit 1, retryable true, launchctl 호출이 실패했거나 데몬이 기다리는 동안 멈추지 않았습니다, hint `` `brain daemon status`로 상태를 확인하고 같은 명령을 다시 실행하세요 ``). launchctl 실패와 stop 시간 초과는 `DAEMON_CONTROL_FAILED`.
- **갱신 뒤 재시작**(`install/flow.ts` `runInstall`). `deps.installed.read(home)`와 `deps.installed.build()`를 데몬 등록 **앞**에서 읽고(완료 기록 쓰기는 같은 값을 쓴다), 재시작이 필요하다 = 등록 결과가 `loaded`이고, 빌드 commit이 있으며(`build?.commit`이 null이면 비교할 수 없어 재시작하지 않음), **지금 살아 있는 데몬의 잠금 `commit`이 그 빌드 commit과 다르다**(잠금 없음·주인 죽음이면 KeepAlive가 새 빌드로 띄우므로 재시작하지 않음, 옛 잠금의 `commit: null`은 다름으로 본다) (2026-10-27 사용자 결정: 이전 기록과의 비교가 아니라 돌고 있는 데몬과의 비교라서, 재시작에 실패하고 완료 기록이 새 버전으로 넘어가도 다음 설치·bootstrap 때 다시 시도된다). 그러면 `deps.daemon.restart(plist_changed, build.commit, env)`를 한 번 부른다; `registered`(방금 새 빌드로 올림)·`unsupported`·`failed`이거나 위 조건이 아니면 부르지 않는다. 자리는 등록 바로 뒤·`installed.write` 앞(spine AD-27의 upgrade 순서: Label 일치 → 데몬 재시작 → 완료 기록). 실패는 새 경고 `DAEMON_NOT_RESTARTED`(core `WARNING_CODES`·뜻: 데몬을 새 빌드로 다시 띄우지 못해 옛 빌드가 계속 돌 수 있습니다, README `### 경고 코드` 행)를 넣고 설치는 계속해 exit 0과 `installed.json`. `InstallReport.daemon`에 `restarted: boolean`. 진행 줄 한국어(다시 띄움·실패와 그 문장). `InstallDeps.daemon`에 `restart(plistChanged, expectCommit, env)`, `install.ts` `systemInstallDeps`가 `restartDaemon`에 잇는다. `setup-run.ts` `output` 문장에 반영. epic-operations의 `setup upgrade`가 같은 `restartDaemon`을 부르도록 export한다.
- **데몬의 빌드 commit.** `runDaemon`이 `readBuildIdentity()`의 commit(없으면 null)을 `acquireDaemonLock`에 넘기고 잠금 JSON에 `commit` 필드로 적는다(take·reclaim 둘 다). `readDaemonLock`은 `commit: string | null`(필드가 없거나 40자 hex가 아니면 null — 이전 잠금 파일도 읽힌다). `DaemonLiveness`가 두 경우 모두 `commit`을 실어(잠금 없으면 null) `daemon status` 데이터에 `commit` 키, 텍스트에 짧은 commit. 잠금의 나머지 동작(원자적 생성·회수 규칙)은 그대로.
- **검증 범위** (2026-10-27 사용자 결정): bootstrap 갱신 시험은 지금처럼 재시작 요청(가짜 launchctl 호출)과 새 빌드 기동을 나눠 확인하면 충분하다. 옛 데몬이 내려가고 새 데몬이 뜨는 실제 전환은 9.8이 이 Mac의 launchd에서 확인한다. 리뷰가 찾은 두 시험 빈틈은 채운다: 실패한 `launchctl kill` 결과가 `restartDaemon`을 지나 그 진단 문장으로 전달되는 시험, bootstrap이 한 번 실패한 뒤 재시도에서 성공하면 성공으로 끝나는(앞선 실패가 남지 않는) 시험.
- **README**(한국어, 절대 홈 경로 금지): `## 데몬`에 `brain daemon stop`(Label을 내리면 launchd가 SIGTERM을 보냄 — 직접 pid에 신호하지 않음, 다음 로그인이나 `brain daemon start`·`brain setup run`까지 멈춤, stop 자체는 drain하지 않고 데몬이 다시 뜰 때 처리, 그동안 다른 명령의 기회적 drain이 받침, 손으로 띄운 데몬은 그 터미널에서 멈춤, doctor `daemon`이 `warn`)·`brain daemon start`·갱신 뒤 재시작(돌고 있는 데몬의 빌드가 설치된 빌드와 다르면 `launchctl kill`로 SIGTERM, 15초 안에 새 빌드 데몬이 뜬 것을 확인, 실패면 `DAEMON_NOT_RESTARTED`이고 다음 설치·세션 시작 때 다시 시도)·`daemon status`의 `commit`. 9.2가 쓴 "멈추려면 `launchctl bootout …`" 문단을 `brain daemon stop`으로 바꾼다. 코드 표 세 행.

**Never:**
- `setup upgrade`·`setup uninstall` 명령(epic-operations·9.10), 실제 Mac 실증(9.8), 로그 회전(9.9), 소켓·handshake·`VERSION_MISMATCH` 경로, 데몬 스스로의 자동 업데이트.
- `tooling/bootstrap`의 제품 코드 변경(bootstrap은 `dist/install.js`만 부르고 그 안에서 재시작이 일어난다; `bin/second-brain.js`·`plugin/bootstrap.mjs` 재빌드 없음), `plugin/app-ref`·plugin `version` 변경.
- 같은 빌드로 다시 설치할 때(`setup run` 반복) 데몬을 재시작하기 — 9.2의 "두 번 돌려도 bootstrap 한 번·추가 호출 없음" 계약을 지킨다. 첫 설치에서 재시작을 부르기.
- `launchctl disable`(로그인을 넘어 남는 정지), SIGKILL, pid로 직접 신호 보내기(`process.kill` 등 — 모든 신호는 launchctl을 거친다), stop에서 drain하기, 생존 판단을 두 벌 두기, Core(`packages/core`)에 launchd·프로세스 코드(코드 표 항목만 예외), 기존 설치 단계의 순서·문장·exit 바꾸기(재시작 줄을 더하는 것 말고).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| stop, launchd 데몬 | Label 올라 있음, 살아 있는 잠금 주인 | `bootout` 한 번(launchd가 SIGTERM), 직접 신호 없음, 주인이 사라지면 `{ unloaded: true, alive: false, owner_pid: null }`, exit 0, drain 없음 | — |
| stop, 손으로 띄운 데몬 | Label 없음, 살아 있는 주인 | 호출은 `print`뿐, 신호 없음, 기다림 뒤 `{ unloaded: false, alive: true, owner_pid }` | `DAEMON_CONTROL_FAILED`, hint가 그 pid와 그 터미널에서 멈추라는 말 |
| stop 중 다른 주인 | bootout 뒤 처음 주인은 사라졌고 다른 pid가 잠금을 잡고 살아 있음 | `alive: true`, `owner_pid`는 새 pid | `DAEMON_CONTROL_FAILED` |
| stop, 아무것도 없음 | Label 없음, 잠금 없음 | 호출은 `print`뿐, `owner_pid: null`, exit 0 | — |
| stop, bootout 실패 | launchctl이 0 아닌 exit | 그 밖의 호출 없음 | `DAEMON_CONTROL_FAILED`, exit 1 |
| stop, 안 멈춤 | bootout 뒤에도 잠금 주인이 살아 있음 | 20초 뒤 `alive: true` | `DAEMON_CONTROL_FAILED` |
| stop, 죽은 잠금 | 잠금 pid 사망·이전 부팅 | 신호 없음, `alive: false` | — |
| start | plist 있음, Label 없음 | `bootstrap gui/<uid> <plist>` 한 번, `started` | 실패면 `DAEMON_CONTROL_FAILED` |
| start 반복 | 이미 올라 있음 | bootstrap 없음, `already-loaded` | — |
| start, 설치 안 됨 | plist 없음 | 호출 없음 | `DAEMON_NOT_INSTALLED`, exit 2 |
| start/stop, macOS 아님 | `platform: linux` | start `unsupported`; stop은 신호만 | — |
| 갱신 설치 | 빌드 B, Label 올라 있음, 살아 있는 데몬의 잠금 commit A, plist 같음 | `kill SIGTERM gui/<uid>/<Label>` 한 번, 15초 안에 commit B 주인 관찰, `restarted: true` | 관찰 못 하면 `DAEMON_NOT_RESTARTED`, exit 0, 기록 씀 |
| 재시작 실패 뒤 다시 설치 | 기록은 B, 살아 있는 데몬은 여전히 A | 다시 재시작 요청 | 같음 |
| 갱신 + plist 바뀜 | 위 + `plist_changed` | `bootout` 뒤 `bootstrap`, `restarted: true` | 같음 |
| 같은 빌드 재설치 | 살아 있는 데몬의 잠금 commit = 빌드 | 재시작 없음, `restarted: false` | — |
| 첫 설치 | 이전 기록 없음 | 등록만(9.2), 재시작 없음 | — |
| 갱신, Label 안 올라 있음 | `registered` | 등록이 새 빌드로 올렸으므로 재시작 없음 | — |
| 옛 잠금 파일 | `commit` 필드 없음 | 읽힘, `commit: null`, 갱신 설치에서 한 번 재시작 | — |

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
- [x] `apps/cli/src/daemon/control.ts` -- `stopDaemon`·`startDaemon`·`restartDaemon`, `DAEMON_STOP_WAIT_MS` -- 한 곳의 launchd 제어 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `packages/core/src/codes.ts` -- `DAEMON_NOT_INSTALLED`·`DAEMON_CONTROL_FAILED`·`DAEMON_NOT_RESTARTED` -- 실패의 어휘
- [x] `apps/cli/src/commands/daemon-stop.ts`, `daemon-start.ts`, `commands/index.ts` -- 명령과 등록 -- 사용자 표면 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `apps/cli/src/install/flow.ts`, `apps/cli/src/install.ts`, `commands/setup-run.ts` -- 갱신 판정·재시작 단계·보고·진행 줄 -- bootstrap 갱신과 `setup upgrade`가 함께 쓸 단계 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `README.md` -- 위 절과 코드 표 -- 문서 대조 시험과 사용자 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `apps/cli/test/daemon-control.test.ts` (새 파일) -- 행렬의 stop·start·restart 행을 메모리 가짜 `Launchctl`·주입 `isAlive`·`bootAt`·짧은 `waitMs`로; 호출 순서(bootout이 신호보다 먼저), 잠금 주인이 아닌 pid에 신호 없음 -- 규칙의 증거 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `apps/cli/test/daemon-stop-start.test.ts` (새 파일) -- 빌드된 `dist/bin.js`로: 설치된 임시 home에서 `brain daemon run`을 subprocess로 띄우고 `loaded/<Label>` 표식을 둔 뒤 `daemon stop --json` → exit 0, 가짜 호출에 `bootout gui/<uid>/<Label>`, 데몬 프로세스가 끝나고 pid 파일이 사라지며, `daemon status --json` `alive: false`, `doctor run --json`의 `daemon` `warn`·exit 0, 임시 transcript 폴더의 transcript가 다음 `failures list`의 기회적 drain으로 들어온다; 이어서 `daemon start --json` → `started`, 호출에 `bootstrap gui/<uid> <plist>` 한 번, 다시 `daemon start` → `already-loaded`·bootstrap 추가 없음; plist 없는 home의 `daemon start` → `DAEMON_NOT_INSTALLED` exit 2; 살아 있는 데몬의 `daemon status --json` `commit`이 `dist/build.json`의 commit과 같다 -- 사용자 표면 증거 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `apps/cli/test/install-flow.test.ts`, `daemon-launchd.test.ts`, `daemon-liveness.test.ts`, `daemon-lock.test.ts`와 기대값이 바뀌는 다른 시험 -- 재시작 조건 행(갱신+loaded → 한 번, 같은 빌드·첫 설치·registered → 없음, 실패 → 경고·exit 0·기록), 새 필드 반영 -- 흐름 규칙 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)
- [x] `tooling/bootstrap/test/hook.test.ts` -- 갱신 시험: `work`에 빈 commit 하나를 더해 `bare`에 push하고 `plugin/app-ref`를 그것으로 바꾼 뒤 SessionStart → exit 0, `installed().commit`이 새 commit, 가짜 호출 기록에 `kill SIGTERM gui/<uid>/<Label>`이 정확히 한 줄(첫 설치의 `bootstrap` 말고 bootstrap 추가 없음); 그다음 launchd를 흉내 내어 plist의 `ProgramArguments`를 같은 env로 띄우고 `daemon status --json`이 `alive: true`가 될 때까지 기다려 `commit`이 `installed().commit`과 같음을 보고 SIGTERM으로 끝낸다 -- bootstrap 갱신의 사용자 표면 증거 (2026-10-27 결정에 맞춰 다시 — Plan Change Log와 고친 Always·행렬 참고)

**Acceptance Criteria:**
- Given 설치된 임시 home에서 떠 있는 데몬과 올라 있는 Label(가짜 launchctl), when `brain daemon stop`을 돌리면, then 데몬이 끝나고 `daemon status`가 살아 있지 않다고 하며 doctor `daemon`이 `warn`(exit 0)이고, 그다음 일반 명령의 기회적 drain이 밀린 transcript를 수집한다.
- Given 그 뒤, when `brain daemon start`를 두 번 돌리면, then 가짜 기록에 그 plist의 `bootstrap`이 한 번만 있다.
- Given 플러그인 SessionStart로 설치된 home과 더 새 commit을 가리키는 plugin `app-ref`, when SessionStart를 다시 돌리면, then 재시작 호출이 한 번 기록되고, plist가 띄우는 데몬의 `daemon status` `commit`이 새 `installed.json`의 `commit`과 같다.
- Given 이 변경 전의 설치·CLI·bootstrap 시험, when 가용 프로젝트 전체를 돌리면, then 새 필드·코드·명령 말고는 그대로 통과하고, 시험 전후 실제 `~/Library/LaunchAgents`에 이 Label의 plist가 없다.

## Implementation Notes

- 2026-10-27 재개: 아래 첫 구현은 고치기 전 계약(stop의 직접 SIGTERM, 신호 수락만으로 재시작 성공, 이전 기록 기준 갱신 판정)을 따른다. 다시 연 작업(`[ ]`)은 고친 Always·행렬·Plan Change Log에 맞춘다.

- `daemon/control.ts`에 stop/start/restart를 모았다. 명령은 제어 실패를 `DaemonControlError`의 코드와 exit로 엔벨로프에 싣는다. stop은 잠금 주인의 공용 생존 규칙을 쓰고 bootout 뒤에만 SIGTERM을 보낸다.
- 갱신 판단의 이전 기록·빌드 읽기는 등록 앞으로 옮겼고, 등록 뒤 재시작을 끝낸 다음 같은 값으로 완료 기록을 쓴다. 같은 빌드·첫 설치·방금 등록한 Label은 재시작하지 않는다.
- daemon 잠금의 commit은 새로 잡기와 회수 뒤 잡기 양쪽에 기록한다. 옛 잠금·잘못된 commit은 null이며 status의 생존 결과와 무관하게 전달한다.
- bootstrap 제품 코드·생성된 런처·plugin app-ref/version은 변경하지 않았다. 새 bootstrap 시험만 임시 저장소에 빈 commit을 만들고 임시 플러그인의 ref를 바꾼다.
- Implementation session's own self-check (not this workflow's review), moved here by the orchestrator:
  - medium / defer — `launchd.ts`의 기존 `isLoaded`는 모든 print 실패를 false로 바꾼다. stop은 계획대로 이 공용 boolean 계약을 사용하므로 probe 오류 때 Label이 남은 채 SIGTERM을 보낼 수 있다. 등록·해제도 쓰던 adapter의 기존 구분 한계이며 별도 후속 작업으로 기록했다.
  - medium / patch — `daemon-launchd.test.ts`의 메모리 kill 가짜가 loaded 상태를 보지 않아 미등록 Label에도 성공했다. shell 가짜와 같이 loaded가 거짓이면 실패하도록 직접 수정했다.

- 2026-10-27 재개 구현(codex 보고, 오케스트레이터가 옮김): 고친 계약대로 stop은 pid에 직접 신호하지 않고 기다림 끝의 살아 있는 잠금 주인을 보고한다. restart는 9.3 생존 판단으로 최대 15초 동안 기대 commit의 주인을 관찰한다. 설치는 돌고 있는 데몬의 commit과 비교하므로 다음 설치기 실행에서 다시 시도된다. adapter·잠금 commit·status·코드 표·명령 등록·start·setup 출력은 이미 고친 plan에 맞아 그대로 두었다.
- 구현 세션의 자체 점검(이 워크플로의 리뷰 아님): `[medium]` `[defer]` 같은 ref의 SessionStart는 설치기를 건너뛰어 재시작 실패 뒤 재시도하지 않는다. bootstrap 제품 코드 변경이 금지라 README에 한계를 적고 deferred-work.md에 남겼다.

- 2026-10-27 후속 thorough 검토: 제품 코드는 유지하고 시험 세 파일에서 네 검증 범위를 보강했다. 구현 세션 `01a17c06-d491-7022-a77c-580a26ff7d1f`가 패치를 작성했고, 명령 시험의 standalone 타입 오류도 같은 세션에서 고쳤다. 원장과 설정 파일은 이 실행에서 편집하지 않았다.

## Plan Change Log

- 2026-10-27 (escalation 해소, 사람 결정): (1) stop은 drain하지 않고 데몬이 뜰 때 처리. (2) 재시작 성공은 15초 안에 새 빌드 commit의 살아 있는 주인을 관찰한 것, 재시작 조건은 돌고 있는 데몬의 commit과 설치 빌드 비교라 실패 뒤 다음 설치에서 다시 시도. (3) 모든 신호는 launchctl을 거치고 pid로 직접 신호하지 않음(macOS 표준). (4) 다른 pid가 잠금을 잡고 살아 있으면 stop은 `alive: true`로 실패. (5) 실제 옛→새 전환은 9.8, 이 스토리는 나눠 확인 + 리뷰의 시험 빈틈 둘.

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `reject` (quick) `stopDaemon` treats a failed `launchctl print` probe as an absent Label, skips `bootout`, signals the owner, and can report success while `KeepAlive` restarts it — real: `systemLaunchctl.isLoaded` (`apps/cli/src/daemon/launchd.ts:67`) maps every non-zero `print` to false and `control.ts:38` follows it. But on macOS the GUI-domain `print` answers 0 or 113 in practice; the remaining failures are a missing `/bin/launchctl` or a 10-second stall, unlikely in everyday use. The fix needs a tri-state probe in the shared adapter (new branch and public surface, against 9.2's `0이 아니면 거짓` contract), more than a direct correction. Same root cause as 9.2's rejected low rows; kept as a residual risk below.

### 2026-10-27 — Thorough follow-up review pass
- verdicts: 21 findings — high 2, medium 11, low 6, false 1, maybe-false 1
- findings:
  - `[medium]` `[intent_gap]` blind 1: failed restarts lose retry eligibility — flow.ts:614–637 writes the new commit even on restart failure, and the same-build condition then skips restart. The intent contract explicitly requires both warning-only completion and no same-build restart. A recovery policy requires a contract decision.
  - `[low]` `[reject]` blind 2: a different home controls the same user Label — control.ts:38 uses the fixed user-wide Label regardless of home. registerDaemon already uses that singleton Label and rewrites its plist. Multiple installations under one user are not distinguished by this adapter; this unusual setup would require a new ownership surface, beyond a direct correction.
  - `[high]` `[intent_gap]` blind 3: a reused PID can receive SIGTERM — control.ts:44–48 uses ownerIsAlive, which checks boot time and PID existence only (lock.ts:100). A same-boot stale lock whose PID is reused passes both checks. Stop introduces destructive signalling using this existing rule. Process identity requirements and compatibility with old locks are not specified; the contract mandates this shared rule.
  - `[low]` `[reject]` blind 4: failed print bypasses bootout — carried: same location and claim as the existing quick-review row; systemLaunchctl.isLoaded maps print failures to false. Preserve its low/reject verdict and original rationale; no patch or new deferral.
  - `[medium]` `[intent_gap]` blind 5: replacement owner reported stopped — control.ts:58 returns alive:false on a different current PID, without testing the replacement. An independently started daemon can acquire the lock after the original releases it. The contract promises to wait for the addressed owner, but does not define concurrent replacement reporting; deciding whole-home stop semantics changes that contract.
  - `[low]` `[reject]` blind 6: unreadable lock reported absent — readDaemonLock intentionally returns undefined for unreadable/malformed files; control.ts then avoids signalling. Atomic link publication prevents partial normal writes. Reproducing this needs external corruption or permission changes; control-specific read states would add branches and public behavior for an uncommon case.
  - `[medium]` `[intent_gap]` blind 7: signal delivery reported as completed restart — control.ts:87–88 returns success immediately on accepted SIGTERM; flow.ts logs that the new build is running. run.ts explicitly allows an in-flight handler to outlive its drain budget. The contract explicitly chooses signal-only restart and does not settle whether replacement observation is required by the ticket outcome.
  - `[maybe-false]` `[defer]` blind 8: two-second reload retry window may be insufficient — control.ts:92–97 retries twice at one-second intervals exactly as contracted. Whether successful bootout leaves a normal GUI job unavailable longer than that is not established by repository code. Real launchd removal timing under an in-flight drain would settle the claim; if true, severity medium. Lower routes are moot on this intent-gap HALT; no deferred entry or ledger mutation made.
  - `[low]` `[reject]` blind 9: concurrent starts can yield one failure — control.ts:76–78 has a check/bootstrap race. Sequential idempotence is covered; two concurrent starts can leave one successful daemon and one explicit retriable control failure. Rechecking job identity adds branches for an uncommon, tolerable control race.
  - `[medium]` `[intent_gap]` blind 10: bootstrap test does not replace a resident process — hook.test.ts:237 onward records fake kill, then manually launches the new plist arguments; no old daemon exists before update. This proves request wiring and new-build launchability separately. The contract explicitly prescribes that split test while the ticket can be read as requiring the replacement transition itself.
  - `[low]` `[reject]` edge 1: transient print failure leaves KeepAlive active — carried: identical claim and location to the existing quick-review row; keep low/reject and its recorded rationale. Do not patch or defer again.
  - `[high]` `[intent_gap]` edge 2: stale lock PID reused in the same boot — Same verified root cause as blind 3: ownerIsAlive has no process-start identity check before the new SIGTERM consumer. Requires the same process-identity and old-lock policy decision.
  - `[medium]` `[intent_gap]` edge 3: replacement owner yields alive:false — Same verified root cause as blind 5: control.ts:58 treats any changed PID as successful stop. Concurrent replacement semantics are not settled by the contract.
  - `[medium]` `[intent_gap]` edge 4: failed restart followed by same-build retry skips recovery — Same verified root cause as blind 1: installed completion advances even on restart failure and removes the commit-change trigger. Recovery policy conflicts with the contract prohibition on same-build restart.
  - `[medium]` `[patch]` verification 1: failed SIGTERM helper result lacks coverage — Pre-verified gap: daemon-control.test.ts covers successful signal only; install-flow.test.ts replaces the restart dependency for failure. A test must pass a failed kill result through restartDaemon and assert its diagnostic. No new product behavior needed; lower routes are moot on intent-gap HALT, so no patch applied.
  - `[medium]` `[patch]` verification 2: transient bootstrap recovery lacks coverage — Pre-verified gap: helper tests cover immediate success and persistent failure, not failure followed by success. A focused retry-success test would detect retaining an earlier failure. Lower routes are moot on intent-gap HALT, so no patch applied.
  - `[medium]` `[intent_gap]` intent alignment 1: drain timing has two defensible readings — daemon-stop.ts is standalone, and dispatch.ts:546 returns before ordinary drain. daemon-stop-start.test.ts adds the transcript after stop and invokes failures list. The ticket says drain at command end while the contract explicitly chooses the next ordinary command. Which surface must drain requires a decision.
  - `[medium]` `[intent_gap]` intent alignment 2: bootstrap replacement shown in separate pieces — Same verified root cause as blind 10: hook.test.ts manually starts the new daemon after checking fake kill; there is no resident-to-replacement lifecycle proof. Decide required fake lifecycle evidence versus real launchd evidence assigned to 9.8.
  - `[medium]` `[intent_gap]` intent alignment 3: restart success and subsequent recovery are narrowed — Two verified outcomes, already recorded separately as blind 7 and blind 1: accepted signal is reported as restart, and warning-only completion removes retry eligibility. Both policies are explicit in the contract and need an intent decision rather than an automatic rewrite.
  - `[low]` `[reject]` intent alignment 4: KeepAlive-first behavior depends on print — carried: same existing quick-review claim, low/reject, preserved without re-verification or renewed deferral.
  - `[false]` `[reject]` intent alignment 5: macOS-only surface assertions — The intent is explicitly a launchd GUI-domain service on Mac; injected darwin unit tests cover control logic and macOS-only integration assertions exercise its supported platform. Skipping real macOS service behavior on other operating systems is not an uncovered supported consumer.

- Grouping: process identity (blind 3, edge 2); restart recovery (blind 1, edge 4, intent 3); restart outcome (blind 7, intent 3); replacement-owner reporting (blind 5, edge 3); lifecycle evidence (blind 10, intent 2); drain timing (intent 1). Intent gaps take precedence over pending patches and deferral.
- Saved reviewed baseline diff: `_bmad-output/personal-brain/tickets/epic-daemon/tickets/story-daemon-stopstart-plan.patch`. No source/test edits were made in this follow-up, so there are no new code changes to revert. Previously committed implementation is preserved; resetting it would discard prior orchestrator-owned work.

### 2026-10-27 — Review pass (재개 구현)
- verdicts: 3 findings — high 0, medium 2, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `apps/cli/src/install/flow.ts:616–618` 재시작 조건이 `daemonLiveness().alive`라서 주인은 살아 있지만 heartbeat가 없거나 오래된 옛 빌드 데몬을 재시작하지 않는다 — 확인: `liveness.ts:33–36`은 살아 있는 주인에도 `no-heartbeat`·`stale-heartbeat`·`future-heartbeat`로 `alive: false`를 돌려주고, Always는 「잠금 없음·주인 죽음」만 제외한다. 고침: `reason`이 `no-lock`·`pid-dead`가 아니면 주인이 살아 있다고 보고 재시작하도록 바꾸고, `install-flow.test.ts` 표에 heartbeat 세 상태(재시작 한 번)와 잠금 없음(재시작 없음) 행을 더했다. 이어서 그 시험의 `reason` 타입 오류(typecheck)도 고쳤다.
  - `[low]` `[reject]` `apps/cli/src/commands/daemon-stop.ts:19` stop 실패 때 `DaemonControlError.data`(`owner_pid` 등)가 JSON 응답에서 빠진다 — 확인: 사실이나, 오류 엔벨로프는 설계상 `data`가 없고(`packages/core/src/envelope.ts:112`) 계약은 「엔벨로프는 보통대로」다. pid는 message와 hint에 실린다. 실을 길을 만들려면 core 엔벨로프에 새 표면이 필요해 직접 고침이 아니고, 일상 사용에서 문제될 일이 드물다.
  - `[medium]` `[defer]` `apps/cli/src/install/flow.ts:623–634` 재시작 실패 뒤 같은 ref의 SessionStart가 재시도하지 않는다 — 확인: 실패에도 설치는 계약대로 새 commit으로 `installed.json`을 쓰고 `tooling/bootstrap/src/bootstrap.ts:389–390`의 fast path가 같은 ref면 설치기 전에 끝난다. 원인은 이번 변경 전부터 있던 bootstrap fast path이고 plan의 Never가 bootstrap 제품 코드 변경을 막는다. 설치기가 다시 돌면(`brain setup run`, 새 ref) 돌고 있는 데몬 비교로 재시도된다. README에 한계를 적었고 frontmatter `deferred`와 `deferred-work.md`에 남겼다. 앞선 triage의 blind 1·edge 4(완료 기록이 갱신 판정을 지움)는 코드가 돌고 있는 데몬 비교로 바뀌어 같은 주장이 아니므로 carried로 보지 않았다.

### 2026-10-27 — 후속 thorough 검토 판정

- 판정 수: 18건 — high 0, medium 8, low 3, false 7, maybe-false 0. edge-case-hunter는 추가 발견 없이 `[]`를 반환했다.
- 발견 사항(각 검토 세션의 반환 순서):
  - `[false]` `[reject]` 의도 1: stop 끝 drain이 티켓 원문과 다르다 — 원문만의 직접 해석과 차이는 있으나, Plan Change Log의 2026-10-27 사람 결정이 stop에서 drain하지 않고 다음 일반 명령과 재기동이 처리하도록 명시했다. 이미 해소된 의도를 다시 여는 근거가 아니다.
  - `[false]` `[reject]` 의도 2: bootstrap 시험이 실제 자동 교체를 이어 검증하지 않는다 — 같은 사람 결정이 요청·새 빌드 기동의 분리 검증을 승인하고 실제 launchd 전환을 9.8에 배정했다. 현재 시험은 그 표면을 확인하므로 이번 티켓의 미충족 조건이 아니다.
  - `[medium]` `[patch]` 의도 3: bootstrap의 exit 0은 재시작 관찰 성공을 뜻하지 않는다 — 사실이며 가짜 kill이 옛 잠금을 유지해 관찰 시간 초과가 예상되는데도 경고 전달을 단언하지 않는다. blind 7과 같은 시험 빈틈으로 묶어 실제 bootstrap 로그의 재시작 실패 경고를 단언한다.
  - `[false]` `[reject]` 의도 4: 모든 갱신이 재시작 호출 한 번을 뜻하지 않는다 — 사람 결정은 이전 완료 기록이 아니라 살아 있는 잠금 주인의 commit과 설치 빌드를 비교하도록 정했다. 잠금 없음·주인 죽음·방금 등록한 Label은 재시작 제외라는 계약과 일치한다.
  - `[false]` `[reject]` 의도 5: start 뒤 실제 생존은 통합 시험의 대상이 아니다 — 원문은 Label 재적재이고 계약도 bootstrap 성공까지만 기다리도록 명시한다. stop·status·doctor·멱등 start를 검증하므로 지적된 미충족 동작은 없다.
  - `[false]` `[reject]` 의도 6: setup upgrade·uninstall 연결은 후속 소비자로 남는다 — 티켓 자체가 epic-operations와 9.10의 책임을 명시한다. 이번 변경에 그 명령을 추가하지 않은 것은 누락이 아니다.
  - `[medium]` `[patch]` 검증 1: stop 실패의 맞춤 hint가 명령 결과로 전달되는지 검증하지 않는다 — 검증 렌즈의 사전 확인을 채택한다. helper의 PID 단언과 일반 dispatch의 기본 hint 시험만으로 daemonStopCommand catch의 hint 누락 회귀를 잡을 수 없다. blind 8과 묶어 실제 DaemonControlError의 hint·PID·안내·code·exit 보존을 플랫폼 공통 명령 시험으로 보강한다.
  - `[medium]` `[patch]` 검증 2: 첫 관찰 뒤 교체되는 잠금 주인을 시험하지 않는다 — 검증 렌즈의 사전 확인을 채택한다. 기존 교체 시험은 bootout 안에서 PID를 바꿔 첫 읽기부터 새 주인이라 루프 밖으로 읽기를 옮기는 회귀도 통과한다. blind 5와 묶어 관찰 사이의 교체 후 새 owner_pid로 실패함을 보강한다.
  - `[medium]` `[defer]` blind 1: plist 재적재 실패 후 다음 설치에서 plist_changed가 사라진다 — registerDaemon이 파일을 먼저 쓰고 bootout 실패 뒤 다음 등록은 false를 반환하므로 다음 재시작은 기존 launchd 인자로 SIGTERM 경로를 탄다. 검토 기준 revision에도 같은 순서와 분기가 있어 이번 변경 전 문제다. 계획 frontmatter에 새 항목만 덧붙였으며 기존 deferred 목록과 원장은 보존했다.
  - `[low]` `[reject]` blind 2: 시스템 시각 보정이 재시작 대기 시간을 바꾼다 — Date.now 기반 경과 계산이라 사실이다. 기존 stop도 같은 방식이고 일상적인 짧은 대기 중 시각 점프는 드물다. 단조 시계와 시험 주입 경로를 더하는 것은 직접 교정 이상의 복잡성을 늘리므로 기각한다.
  - `[low]` `[reject]` blind 3: 시간 초과 진단에 heartbeat 실패 이유가 없다 — pid·commit을 출력하는 현재 진단은 계약을 충족하며 `daemon status`가 이유를 제공한다. 문구 확장을 위한 상태별 분기는 요구된 복구를 바꾸지 않는 드문 진단 개선이어서 기각한다.
  - `[false]` `[reject]` blind 4: InstallDeps 밖 생존 조회가 가짜 의존성만으로 시험을 통제하지 못하게 한다 — 실제 파일 조회는 사실이지만 runInstall의 home은 호출자가 고르고 관련 시험은 임시 home과 모듈 spy를 사용한다. 다른 home의 잠금을 읽는 경로가 없고 실행 환경 때문에 잘못 재시작하는 재현 가능한 호출도 제시되지 않아 주장된 시험 오염은 성립하지 않는다.
  - `[medium]` `[patch]` blind 5: 교체 주인 시험의 첫 읽기 전에 교체가 끝난다 — 검증 2와 같은 원인이며 첫 관찰 이후 잠금 교체를 시험하도록 보강한다.
  - `[medium]` `[patch]` blind 6: restartDaemon 관찰 성공 시험이 모두 생존 조회를 모킹한다 — 실제 home 전달·잠금 commit 파싱·heartbeat를 잇는 성공 경로는 mock 시험에서 빠져 있다. 실제 임시 잠금과 heartbeat, 살아 있는 시험 프로세스 PID를 사용하는 재시작 관찰 시험을 보강한다.
  - `[medium]` `[patch]` blind 7: split bootstrap 갱신은 관찰 시간 초과인데 경고를 확인하지 않는다 — 옛 commit 잠금이 hook 종료까지 남아 제품 코드의 timeout이 예상된다. 의도 3과 같은 빈틈으로 묶어 실제 로그의 실패 진단과 사용자 경고를 단언한다.
  - `[medium]` `[patch]` blind 8: 수동 데몬 stop 실패의 플랫폼 공통 CLI 안내 검증이 없다 — helper는 linux·darwin을 확인하지만 명령 catch의 전달은 검사하지 않는다. 검증 1과 묶어 플랫폼 공통 command 시험으로 전달 회귀를 잡는다. JSON 직렬화는 기존 dispatch 시험이 맡으므로 20초짜리 중복 subprocess 시험은 추가하지 않는다.
  - `[false]` `[reject]` blind 9: 다시 뜬 데몬이 밀린 transcript를 처리하는 증거가 없다 — `apps/cli/test/daemon-run.test.ts`의 `collects hook-free writes within ten seconds and catches offline writes on restart`가 정지 뒤 transcript를 만들고 일반 명령 없이 재기동해 session 수가 2가 됨을 단언한다. 이미 실제 subprocess 경로로 검증된다.
  - `[low]` `[reject]` blind 10: 계획 행렬의 Linux 신호 문구·첫 설치 행이 최신 Always와 다르다 — 계획 일부의 오래된 문구라는 지적이며 수정 대상은 이 빌드의 계획이다. 워크플로의 계획 수정 제안 기각 규칙을 적용한다. 현재 구현은 더 구체적인 사람 결정과 Always를 따른다.
- 공통 원인으로 묶은 패치: medium 4건(명령 hint 전달, 대기 중 주인 재조회, 실제 재시작 생존 조회, bootstrap 실패 경고). 새 deferred 1건, 기각 10건. 기존 deferred-work 항목의 상태·내용은 변경하거나 재판정하지 않았다.


## Design Notes

- **재시작은 신호 + KeepAlive:** shim은 home 안의 같은 `app/` 클론을 가리키고 bootstrap은 그 클론을 제자리에서 갱신하므로 plist는 그대로다. 그래서 `kill SIGTERM`이면 데몬이 진행 중 drain을 정상으로 끝내고(9.1의 SIGTERM 경로), launchd가 같은 인자로 새 `dist/`를 띄운다. `bootout`→`bootstrap`은 비동기 해제와 겹쳐 실패하기 쉬우므로 plist가 바뀐 드문 경우에만 쓰고 재시도한다. 실제 launchd에서의 재기동 확인은 9.8.
- **재시작을 설치기에 두는 이유:** bootstrap 파일은 `node:` 내장만 쓸 수 있어 adapter를 가져올 수 없고, `setup upgrade`가 "같은 단계"를 불러야 한다. bootstrap 갱신은 언제나 `dist/install.js`를 지나므로 `runInstall` 안의 단계 하나가 두 길을 모두 덮는다. 갱신 판정을 이전 기록의 commit으로 하는 것은 bootstrap이 설치기를 부르는 조건(`installed.commit !== ref`)과 같은 사실을 보기 위해서다.
- **stop의 순서:** 신호를 먼저 보내면 KeepAlive가 곧 다시 띄운다. 그래서 Label을 먼저 내리고, 그때 launchd가 보내는 SIGTERM이 유일한 신호다(2026-10-27 결정: pid로 직접 신호하지 않음 — 재사용된 pid 위험을 없애는 macOS 표준 방식). launchd 밖에서 띄운 데몬은 멈추지 않고 살아 있다고 보고한다.

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

### 재개 구현 검증 (2026-10-27, 오케스트레이터가 직접 실행)

- `pnpm build`·`pnpm typecheck`: 통과(리뷰 패치 뒤 typecheck가 시험 파일 타입 오류 1건으로 실패 → 구현 세션이 고침 → 통과).
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio`: 리뷰 패치 뒤 96 파일 / 2777 시험 통과. 패치 전 첫 전체 실행에서 `daemon-run.test.ts`의 「collects hook-free writes…」가 `database is locked`로 한 번 실패했으나, 이 변경이 건드리지 않은 시험의 읽기 경합이며 단독 3회·core+cli 2회·전체 재실행에서 모두 통과했다.
- `git diff --check`: 통과. Docker가 없어(`docker info` exit 1) `postgres` 프로젝트는 돌리지 않았다.
- 시험 전후 `~/Library/LaunchAgents`에 이 Label의 plist 없음, `launchctl print` exit 113.
- 행렬 감사: 모든 행에 통과한 시험이 있다. 「첫 설치」 행(이전 기록 없음)은 실제로 Label이 안 올라 있어 `registered`가 되므로 `registered` 행과 「살아 있는 주인 없음」 행으로 덮인다. Always의 재시작 조건은 이전 기록을 보지 않으므로, 기록이 없는데 옛 빌드 데몬이 올라 돌고 있으면 재시작한다(사용자 결정 2와 같은 뜻).

## Auto Run Result

- 결과: 후속 thorough 검토와 시험 보강을 마쳤다. 티켓 상태는 `built`를 유지하며 `done` 판정은 오케스트레이터가 수행한다. `tickets.py mark`는 실행하지 않았다.
- 제품 동작 변경 없이 네 검증 범위를 보강했다: stop 대기 중 주인 교체, 실제 잠금·heartbeat를 이용한 새 commit 관찰, stop 실패의 맞춤 안내 전달, bootstrap 재시작 실패 경고 전달.
- 변경 파일:
  - `apps/cli/test/daemon-control.test.ts`: 첫 관찰 뒤 PID 교체와 실제 생존 조회의 이전→기대 commit 전환을 확인한다.
  - `apps/cli/test/daemon-stop-command.test.ts`: 플랫폼 공통으로 실제 DaemonControlError의 hint·PID·터미널 안내·code·exit가 명령 반환에 보존되는지 확인한다.
  - `tooling/bootstrap/test/hook.test.ts`: 가짜 kill의 관찰 시간 초과와 사용자 경고가 실제 bootstrap 로그에 남는지 확인한다.
  - 이 계획: 검토 선택과 렌즈 기록, 18건의 개별 판정, 새 deferred 한 항목과 검증 결과를 기록했다.
- 검토: medium 패치 4개 원인군(발견 사항 7건), 기존 문제의 새 deferred 1건, 기각 10건이다. 각 기각 근거는 위 개별 판정에 기록했다. 원장에 있던 기존 항목은 수정·재개·재작성하지 않았다. 새 deferred는 이 계획에만 덧붙였다.
- 후속 리뷰 권고: `false`. 이번 실행은 이미 `built`인 계획의 후속 검토이며 패치 원인군은 high 0, medium 4, low 0이므로 후속 검토의 high 기준에 해당하지 않는다.
- 검증:
  - 패치 전 `pnpm build`·`pnpm typecheck` 통과, 가용 8개 프로젝트 96개 파일·2,777개 시험 통과.
  - 구현 세션의 변경 파일 시험 26개 통과. 새 명령 시험의 타입 오류 1건을 같은 세션에서 고친 뒤 해당 시험과 `pnpm typecheck` 통과.
  - 패치 후 `pnpm build` 통과, 최종 `pnpm typecheck` 통과.
  - 최종 `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio`: 97개 파일·2,780개 시험 통과.
  - `git diff --check` 통과. 실제 daemon plist 없음, `launchctl print`는 exit 113으로 서비스 없음. Docker가 없어 `postgres` 프로젝트는 실행하지 않았다.
- 남은 범위: 실제 launchd의 옛→새 프로세스 전환은 기존 사람 결정대로 9.8이 맡는다. 같은 ref SessionStart의 설치기 생략은 기존 deferred대로 유지했다. plist 재적재 실패 뒤 변경 표식 소실은 이번 검토에서 확인한 기존 문제로 새 deferred에 기록했다.
- 시작 전부터 있던 원장·설정 변경은 내용을 보존하여 검토 결과와 함께 로컬 커밋에 기록한다. 원장 항목의 상태와 해소 여부는 오케스트레이터 소유로 유지한다. 원격 push는 하지 않는다.
