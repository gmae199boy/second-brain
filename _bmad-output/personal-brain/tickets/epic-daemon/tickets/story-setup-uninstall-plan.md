---
title: '최소 setup uninstall: 데몬 흔적만 지운다'
type: 'feature'
ticket: '10'
created: '2026-10-27'
status: done
baseline_revision: 'd6c34fddd3fbb05c84d2866c3f4089173d620976'
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

**Problem:** 9.2가 Label·plist를, 9.1·9.9가 pid·heartbeat·데몬 로그를 남기지만 지우는 명령이 없다(E9-6, Done when 4의 "`setup uninstall` 뒤 Label·pid·heartbeat·로그가 남지 않는다").

**Approach:** standalone 명령 `brain setup uninstall`을 더한다. 9.2의 `unregisterDaemon`으로 Label을 내리고 plist를 지운 뒤, 9.6의 `stopDaemon`으로 잠금 주인이 끝나기를 기다리고, 그다음 pid·heartbeat·`daemon.log`와 회전본 `.1`…`.5`를 지운다. 설정·DB를 열지 않는다.

## Boundaries & Constraints

**Always:**
- **순서.** (1) `unregisterDaemon`(올라 있으면 bootout, 그다음 plist 삭제) → (2) `stopDaemon`과 같은 기다림(이미 내렸으므로 bootout 없이 잠금 주인의 죽음만 기다림, 같은 생존 규칙·같은 `DAEMON_STOP_WAIT_MS`) → (3) 파일 삭제. 로그는 데몬이 종료 줄을 쓴 뒤에 지워야 남지 않으므로 기다림 뒤다.
- **지우는 것은 정확히 이것뿐:** `daemonPlistPath(env)`, `daemonPidPath(home)`, `heartbeatPath(home)`, `daemonLogPath(home)`, `daemonLogRotatedPath(home, 1…DAEMON_LOG_KEEP)`. 없는 파일은 조용히 넘긴다(`ENOENT`만). 폴더(`run/`, `log/`)와 그 안의 다른 파일(`bootstrap.log`, `plugin.json`, last-hook 기록, spool)은 남긴다.
- **멱등.** 두 번째 실행도 exit 0이고 상태는 같다. 지울 것이 없으면 bootout을 부르지 않는다(9.2 `unregisterDaemon`이 `isLoaded`로 거른다).
- **실패.** bootout 실패나 plist 삭제 실패 → `DAEMON_CONTROL_FAILED` exit 1, pid·heartbeat·로그는 지우지 않는다. 기다림이 끝나도 살아 있는 잠금 주인(launchd 밖에서 띄운 데몬) → `DAEMON_CONTROL_FAILED` exit 1, hint는 9.6과 같은 문장(그 터미널에서 멈추라), pid·heartbeat·로그는 남긴다(살아 있는 데몬의 잠금을 지우면 둘이 뜰 수 있다). 사람이 멈춘 뒤 다시 돌리면 나머지가 지워진다.
- **macOS 밖·uid 없음:** launchctl을 부르지 않고(`unregisterDaemon`이 이미 그렇다) 기다림과 파일 삭제는 한다.
- **명령 메타.** `ns: 'setup'`, `verb: 'uninstall'`, `nsDescription`은 `setup run`의 문장 그대로, `risk: 'destructive'`, `hook: false`, `dryRun: false`, `standalone: true`, 확인(`confirm`) 요구 없음. 실패는 `daemon stop` 명령처럼 `DaemonControlError`를 엔벨로프 실패로 옮긴다. 데이터는 `{ label, plist_path, unloaded, plist_removed, removed }` — `removed`는 실제로 지운 run/log 파일의 경로 배열(지운 순서). 텍스트는 한국어 한 줄(지운 것이 있으면 "데몬 흔적을 지웠습니다", 없으면 "지울 데몬 흔적이 없습니다").
- 시험은 실제 launchd·`~/Library/LaunchAgents`·실제 `~/.second_brain`에 닿지 않는다(`withoutHarnessFolders`, `SECOND_BRAIN_HOME`, 가짜 launchctl).

**Never:**
- DB 파일, `files/`(또는 `[files] path`), `config.toml`, `.env`, `installed.json`, shim, hook 설정, spool, mirror를 건드리지 않는다. 데이터 삭제 확인·전체 제거는 epic-operations(V1 뒤).
- pid로 직접 신호하지 않는다(9.6 결정: 모든 신호는 launchctl). 설치 잠금을 잡지 않는다.
- 9.2·9.6의 기존 함수 계약(`unregisterDaemon`, `stopDaemon`, `isLoaded`)과 기존 명령 출력을 바꾸지 않는다. 새 오류·경고 코드를 만들지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 설치 뒤, 데몬이 launchd로 떠 있음 | Label loaded, plist·pid·heartbeat·log·log.1 있음 | bootout 한 번, 데몬 SIGTERM 종료, plist·pid·heartbeat·log·log.1 없음, `unloaded: true`, `plist_removed: true` | 없음 |
| 두 번째 실행 | 위 결과 상태 | exit 0, `unloaded: false`, `plist_removed: false`, `removed: []`, launchctl `bootout` 추가 호출 없음 | 없음 |
| 등록 안 됨·흔적 없음 | 빈 home | exit 0, 모두 false·빈 배열 | 없음 |
| 죽은 pid 잠금만 남음 | Label 없음, 죽은 pid의 `daemon.pid`·heartbeat | 둘 다 지움, exit 0 | 없음 |
| bootout 실패 | 가짜 launchctl이 bootout 거절 | exit 1 `DAEMON_CONTROL_FAILED`, plist·pid·heartbeat·log 그대로 | 엔벨로프 실패 |
| launchd 밖 데몬이 살아 있음 | Label 없음, 살아 있는 잠금 주인 | 기다림 뒤 exit 1 `DAEMON_CONTROL_FAILED`+hint, plist는 지워짐, pid·heartbeat·log 그대로 | 엔벨로프 실패 |
| macOS 밖 | `platform !== 'darwin'` | launchctl 호출 없음, run/log 파일은 지움 | 없음 |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/launchd.ts` -- `unregisterDaemon`(9.2, `{ok, booted_out, plist_removed}` 또는 `{ok:false,message}`), `DAEMON_LABEL`, `daemonPlistPath`, `systemLaunchctl`. 바꾸지 않는다. 알려진 한계: `isLoaded`는 print 실패를 모두 false로 본다(9.6 deferred) — 손대지 않는다.
- `apps/cli/src/daemon/control.ts` -- `stopDaemon`(Label이 이미 내려가 있으면 bootout 없이 잠금 주인 죽음만 기다림, 살아 있으면 `DaemonControlError('DAEMON_CONTROL_FAILED', …, hint, data)`), `DaemonControlError`, `DAEMON_STOP_WAIT_MS`. 새 함수 `uninstallDaemon`을 여기에 더한다(시험 주입: `isAlive`·`bootAt`·`waitMs`는 `stopDaemon`과 같은 이름으로 넘김).
- `apps/cli/src/config/paths.ts:154–169` -- `daemonPidPath`, `heartbeatPath`, `daemonLogPath`, `daemonLogRotatedPath`, `configHome`.
- `apps/cli/src/daemon/log.ts:7` -- `DAEMON_LOG_KEEP`(5).
- `apps/cli/src/commands/daemon-stop.ts` -- 새 명령의 본(standalone, `configHome(context.env)`, `systemLaunchctl({env, uid: process.getuid?.()})`, `DaemonControlError` → `{ok:false, code, message, hint, exit}`).
- `apps/cli/src/commands/index.ts` -- 등록 목록. `setupRun` 바로 뒤에 `setupUninstallCommand`.
- `apps/cli/src/commands/setup-run.ts:50` -- `nsDescription` 문장.
- `apps/cli/test/fixtures/fake-launchctl.sh` -- `FAKE_LAUNCHCTL_DIR/loaded/<Label>` 표식, `calls` 기록, `FAKE_LAUNCHCTL_PID_FILE`이 있으면 bootout이 그 pid에 SIGTERM. bootout 실패를 흉내 낼 변수가 없으면 `FAKE_LAUNCHCTL_FAIL=bootout` 분기를 더한다(기존 분기 동작은 그대로).
- `apps/cli/test/daemon-stop-start.test.ts` -- 빌드된 `dist/install.js --yes`로 설치하고 `dist/bin.js daemon run`을 subprocess로 띄워 생존을 기다리는 관례, env 조립(`SECOND_BRAIN_LAUNCH_AGENTS`, `FAKE_LAUNCHCTL_DIR`, `FAKE_LAUNCHCTL_PID_FILE`). 새 사용자 표면 시험이 이것을 본뜬다.
- `apps/cli/test/daemon-control.test.ts` -- 메모리 가짜 `Launchctl`·주입 `isAlive`·`bootAt`·짧은 `waitMs` 관례.
- `apps/cli/test/command-meta.test.ts`, `guide.test.ts`, `output-language.test.ts`, `readme-codes.test.ts` -- 새 명령을 자동으로 건다(메타·한국어 출력·README 대조).
- `README.md` -- `## 데몬`(532–637, stop/start 단락 뒤가 자리), `## 다시 설정하기, 하네스 연결하기`(674). 명령 목록이 README에 대조되는지 `readme-codes`·`guide` 시험으로 확인.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/daemon/control.ts` -- `uninstallDaemon({home, env, clock, launchctl, platform, isAlive?, bootAt?, waitMs?})`와 `DaemonUninstallData` -- 순서·삭제 목록·실패 규칙을 한 곳에
- [x] `apps/cli/src/commands/setup-uninstall.ts`, `apps/cli/src/commands/index.ts` -- 명령과 등록 -- 사용자 표면
- [x] `apps/cli/test/fixtures/fake-launchctl.sh` -- 필요하면 `FAKE_LAUNCHCTL_FAIL=bootout` -- 실패 행의 사용자 표면 증거
- [x] `apps/cli/test/daemon-control.test.ts` -- 행렬의 모든 행을 메모리 가짜로: 호출 순서(bootout → 기다림 → 삭제), 지운 목록, 실패 때 남는 파일, 다른 파일(`bootstrap.log`·`plugin.json`·spool 파일) 보존 -- 규칙의 증거
- [x] `apps/cli/test/setup-uninstall.test.ts` (새 파일) -- 빌드된 `dist/bin.js`로: 설치된 임시 home, `daemon run` subprocess와 `loaded/<Label>` 표식, `log/daemon.log.1`도 만든 뒤 DB 파일 SHA-256과 `files/` 목록(없으면 만든 표본 파일 하나 포함)을 기록 → `setup uninstall --json` exit 0, 호출에 `bootout gui/<uid>/<Label>` 한 줄, 데몬 프로세스 종료, plist·pid·heartbeat·`daemon.log`·`daemon.log.1` 없음, DB 해시·`files/`·`installed.json`·shim 그대로 → 다시 실행 exit 0, `removed: []`, `bootout` 호출 수 그대로, 파일 상태 같음; bootout 실패 home에서 exit 1 `DAEMON_CONTROL_FAILED`와 plist 유지 -- 사용자 표면 증거
- [x] `README.md` -- `brain setup uninstall`이 지우는 것·남기는 것(hook·shim·`installed.json`·데이터), 다음 `setup run`이나 플러그인 갱신이 다시 등록한다는 점, launchd 밖 데몬이면 실패하고 남긴다는 점 -- 사용자 문서

**Acceptance Criteria:**
- Given 설치된 임시 home에서 launchd(가짜)로 떠 있는 데몬, when `brain setup uninstall --json`, then exit 0, 가짜 기록에 그 Label의 `bootout`이 있고 plist·`run/daemon.pid`·`run/heartbeat`·`log/daemon.log`(회전본 포함)가 없으며 DB 파일 바이트와 `files/` 내용은 그대로다.
- Given 그 직후, when 같은 명령을 다시 돌리면, then exit 0이고 파일 상태가 같으며 `bootout`이 더 기록되지 않는다.
- Given 이 변경 전의 CLI·설치·bootstrap 시험, when 가용 프로젝트 전체를 돌리면, then 새 명령이 더해진 것 말고는 그대로 통과하고, 시험 전후 실제 `~/Library/LaunchAgents`에 이 Label의 plist가 없다.

## Implementation Notes

- `stopDaemon`의 잠금 주인 대기를 내부 `waitForOwner`로 추출해 기존 반환값·오류·시간 제한을 유지했다. `uninstallDaemon`은 `unregisterDaemon` 후 같은 대기만 호출하므로 bootout을 중복 호출하지 않는다.
- pid·heartbeat·현재 로그·회전본 `.1`…`.5`를 정해진 순서로 unlink하며 실제 삭제 경로만 반환한다. ENOENT 외 삭제 실패는 기존 `DAEMON_CONTROL_FAILED`로 전달한다.
- 메모리 가짜 시험은 삭제 순서·실패 보존·수동 데몬·플랫폼/uid 미지원·다른 파일 보존을 확인하고, subprocess 시험은 임시 설치의 데몬 종료·DB/파일/shim/설치 기록 보존·멱등·실패 엔벨로프를 확인한다.

- 구현 세션의 자체 점검(이 워크플로의 리뷰 아님, 오케스트레이터가 Review Triage Log에서 옮김): 지적 사항 없음. 계획 행렬의 모든 행은 실행·통과한 단위 시험으로 확인했으며, 사용자 표면 시험에서 종료·보존·멱등·실패 엔벨로프를 확인했다.
- 구현 세션이 `f8df106`으로 직접 커밋했고 계획 frontmatter `status`를 `built`로 미리 바꿨다. 오케스트레이터가 리뷰 동안 `in-review`로 되돌렸다.

## Plan Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `apps/cli/src/daemon/control.ts:77–82` — `waitForOwner`가 주인 없음을 확인한 뒤 `daemon.pid`를 무조건 지우므로, 그 사이에 손으로 띄운 `brain daemon run`이 잠금을 잡으면 살아 있는 새 잠금이 지워질 수 있다 — 구간은 실재한다(`lock.ts`의 `releaseDaemonLock`처럼 주인을 다시 읽는 보호가 없다). 그러나 Label을 이미 내렸으므로 launchd는 다시 띄우지 않고, 사람이 `setup uninstall`과 같은 순간에 `daemon run`을 손으로 띄울 때만 생긴다. 고치려면 다시 읽기 가드를 더해야 하고 그래도 POSIX에 원자적 비교-삭제가 없어 구간이 좁아질 뿐 닫히지 않는다. 일상 사용에서 만나기 어렵고 고침이 가드 추가이므로 규칙대로 기각.

### 2026-10-27 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. Quick 렌즈가 인수 조건과 변경 코드의 주변 경로를 점검했고 추가 결함을 보고하지 않았다.

## Design Notes

- **plist를 먼저, run/log 파일을 나중에:** Label이 올라 있는 동안 pid를 지우면 KeepAlive가 다시 띄운 데몬과 겹치고, 로그를 먼저 지우면 데몬의 종료 줄이 새 `daemon.log`를 만든다. launchd 밖 데몬이 살아 있을 때 plist는 이미 지워졌지만 그것은 다시 돌리면 끝나는 부분 상태이고, 살아 있는 잠금을 지우는 것보다 안전하다.
- **확인 없음·`destructive`:** 지우는 것은 데몬의 기록뿐이고 사용자 데이터가 아니다(데이터 삭제 확인은 전체 제거의 몫). 그래도 되돌릴 수 없이 지우므로 `--help`에는 `destructive`로 보인다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 성공(가용 프로젝트)
- `ls ~/Library/LaunchAgents | grep second-brain` -- expected: 시험 전후 같음(이 Label의 plist가 시험 때문에 생기지 않음)

**Results (2026-10-27):**
- `pnpm build && pnpm typecheck && pnpm exec vitest run apps/cli/test/daemon-control.test.ts apps/cli/test/setup-uninstall.test.ts` — 성공, 2개 파일·34개 시험.
- `pnpm test` — build·typecheck 성공, 102개 파일·2,892개 시험 모두 통과.
- 명령 메타·guide·한국어 출력·README 대조 추가 확인 — 4개 파일·180개 시험 통과.
- 실제 `~/Library/LaunchAgents`의 second-brain 항목은 시험 전후 모두 없음. 모든 새 시험은 임시 home과 가짜 launchctl을 사용함.

## Auto Run Result

Status: built

**요약:** 기존 `built` 계획의 후속 리뷰를 수행했다. `brain setup uninstall`은 Label 해제와 plist 삭제 후 데몬 종료를 기다리고 pid·heartbeat·현재 로그·회전본만 지운다. DB·`files/`·설정·hook·shim·`installed.json`·spool은 보존하며 반복 실행할 수 있다. 이번 실행에서 소스·시험 코드는 바꾸지 않았다. 티켓 계획의 상태와 기존 deferred-work 항목을 유지했으며 `tickets.py mark`를 실행하지 않았다. 최종 완료 판정은 오케스트레이터가 수행한다.

**검토한 변경 파일:**
- `apps/cli/src/daemon/control.ts` — `uninstallDaemon`과 공용 종료 대기.
- `apps/cli/src/commands/setup-uninstall.ts` — standalone 제거 명령과 실패 엔벨로프.
- `apps/cli/src/commands/index.ts` — 명령 등록.
- `apps/cli/test/fixtures/fake-launchctl.sh` — bootout 실패 주입.
- `apps/cli/test/daemon-control.test.ts` — 삭제 순서·실패·보존·미지원 플랫폼 검증.
- `apps/cli/test/setup-uninstall.test.ts` — 사용자 명령으로 제거·멱등·데이터 보존 검증.
- `README.md` — 최소 제거 범위와 재등록 안내.
- 이 계획 파일 — 후속 리뷰와 검증 결과 기록.

**리뷰:** 이번 Quick 후속 리뷰에서 지적 0건, patch 0건, defer 0건, reject 0건. 이전 리뷰의 `low` 기각은 그대로 유지한다. 제거와 수동 데몬 기동이 겹치는 경쟁 구간은 일상 사용에서 만나기 어렵고, 추가 가드로도 원자적 비교·삭제를 보장하지 못한다는 기존 판단이다.

**후속 리뷰 권고:** `false`. 이번 실행에서 적용한 patch는 high 0건, medium 0건, low 0건이다.

**검증:** `pnpm test` exit 0. build·typecheck 성공, 102개 시험 파일·2,892개 시험 통과. 실제 `~/Library/LaunchAgents`의 second-brain 항목은 검증 중 및 완료 후 모두 0개다. 새 시험은 임시 home과 가짜 launchctl을 사용한다.

**남은 위험:** 기존 리뷰에서 기각한 수동 기동 경쟁 구간과 `isLoaded`가 print 실패를 미등록으로 보는 기존 한계는 유지된다. 기존 deferred-work 항목은 수정·재개·재작성하지 않았다. 실제 launchd 설치본의 실증은 9.8의 범위다.
