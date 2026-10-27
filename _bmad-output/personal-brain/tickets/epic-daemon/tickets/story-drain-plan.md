---
title: '생존 판단과 폴백: 데몬이 살아 있으면 명령은 drain을 건너뛴다'
type: 'feature'
ticket: '3'
created: '2026-10-27'
status: done
baseline_revision: '168ba8eba0c510f48782d118357f236d381912eb'
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

**Problem:** 9.1의 데몬이 떠서 drain을 반복해도, 사람이 부른 명령은 끝마다 2초짜리 기회적 drain을 또 돈다. 데몬이 살아 있는지 판단하는 코드가 없어서 명령은 건너뛸 근거가 없고, doctor와 사람도 데몬이 살았는지 죽었는지 볼 길이 없다(E9-2, E9-6의 status·doctor 부분).

**Approach:** heartbeat mtime(90초 = 간격의 3배)과 pid 잠금 주인의 생존으로 "데몬이 살아 있다"를 판단하는 함수 하나를 만들고, 기회적 drain 생략·doctor `daemon` 점검·새 `brain daemon status`가 모두 그 함수만 쓴다. 죽었거나 멈췄으면 지금 그대로 기회적 drain과 SessionStart의 `queue drain`이 받친다.

## Boundaries & Constraints

**Always:**
- **판단 함수**(`apps/cli/src/daemon/liveness.ts`). `DAEMON_ALIVE_MS = 3 * DAEMON_HEARTBEAT_MS`(= 90_000)를 export하고 이유를 문서 주석에. `daemonLiveness({ home, clock, isAlive?, bootAt? })` → `Promise<DaemonLiveness>`: `{ alive: true, pid, heartbeatAt }` 또는 `{ alive: false, reason, pid: number | null, heartbeatAt: Date | null }`, `reason`은 `'no-lock' | 'pid-dead' | 'no-heartbeat' | 'future-heartbeat' | 'stale-heartbeat'`. 살아 있음 = `readDaemonLock(home)`의 주인이 있고 그 주인이 살아 있으며(아래 공유 규칙), heartbeat 파일이 있고 `age = clock.now() − floor(mtimeMs)`가 `0 ≤ age ≤ DAEMON_ALIVE_MS`. 판단 순서는 잠금 → heartbeat이고, 죽음이어도 읽은 pid·heartbeat 시각은 채운다(status가 보인다). 절대 throw하지 않는다: 파일을 읽을 수 없으면 없음과 같이 죽음.
- **주인 생존 규칙 하나.** `lock.ts`의 `acquireDaemonLock` 안 생존 조건(이전 부팅 `BOOT_SLACK_MS` 검사 + `isAlive`, 기본 `systemIsAlive`)을 export된 함수 하나(예: `ownerIsAlive(owner, { isAlive, bootAt })`)로 꺼내 잠금과 판단 함수가 함께 쓴다. 잠금 동작은 바이트 단위로 그대로.
- **상수 자리와 순환 금지.** `liveness.ts`는 `run.ts`를 import하지 않는다(`run.ts → assembly.ts → doctor/checks.ts → liveness.ts` 순환). `DAEMON_HEARTBEAT_MS`를 `liveness.ts`(또는 import 없는 leaf 모듈)로 옮기고 `run.ts`가 다시 export해 기존 import·시험이 그대로 돈다.
- **기회적 drain 생략**(`apps/cli/src/dispatch.ts` `execute`). `shouldDrain(...) && config.ok`일 때만 `daemonLiveness({ home, clock })`를 보고, `alive`면 `drainOpportunistically`를 부르지 않는다. 판단은 실패하지 않으므로 의심스러우면 지금처럼 drain한다. 결과·엔벨로프·종료 코드·stderr는 바뀌지 않는다. `shouldDrain`이 false인 명령(hook, `queue drain`, 실패한 결과)은 판단도 하지 않는다.
- **`brain daemon status`**(`apps/cli/src/commands/daemon-status.ts`, `commands/index.ts`의 `daemonRunCommand` 바로 뒤). `ns: 'daemon'`, `verb: 'status'`, `daemonRunCommand`와 같은 `nsDescription`, 한국어 `usedFor`·`output`, `risk: 'read'`, `hook: false`, `dryRun: false`, `standalone: true`(설정·DB 없이 `configHome(env)`의 파일만 본다), 엔벨로프는 보통대로. 데이터 `{ alive: boolean, pid: number | null, heartbeat_at: string | null, reason: string | null }`(시각은 `isoWithOffset`, 살아 있으면 `reason: null`). 살든 죽든 `ok: true`·exit 0. 텍스트는 한국어 한 줄(생존 여부·pid·마지막 heartbeat 또는 죽은 까닭).
- **doctor `daemon` 점검**(`apps/cli/src/doctor/checks.ts` `runtimeChecks` 목록 맨 끝, `spool` 뒤). 같은 판단 함수. 살아 있으면 `ok`, detail에 pid와 마지막 heartbeat(`isoWithOffset`). 죽었거나 멈췄으면 코드 없는 `warn`, detail에 한국어 까닭과(있으면) 마지막 heartbeat. `fail`·`skip`은 없다. `RuntimeChecksOptions`에 `clock?`(기본 `systemClock`)과 필요하면 판단 함수 seam. 설치기의 마지막 doctor(`install/store.ts doctorAt`)도 같은 목록이라 함께 나온다.
- **README.** `## 밀린 일 처리`의 기회적 drain 문단(데몬이 살아 있으면 건너뜀, 판단 규칙 한 줄), `## 데몬`(생존 판단: 90초·pid·미래 시각, `brain daemon status`와 출력), `## 실패 보기와 다시 하기` 끝 문장(데몬이 살아 있으면 데몬이 처리), `## 설치 상태 확인` 점검 표에 `daemon` 행, 요약 예시가 맞지 않게 되면 고친다. 한국어.
- 시험은 임시 home·임시 `CLAUDE_CONFIG_DIR`만 쓰고(`withoutHarnessFolders`/`environment()` 관례, 9.1 Implementation Notes의 순서 주의), 절대 홈 경로를 쓰지 않는다. 살아 있는 pid가 필요하면 시험 프로세스 자신의 pid와 지금 부팅 시각(`now − os.uptime()`)으로 잠금 JSON 한 줄을 쓴다.

**Never:**
- `queue drain` 명령과 SessionStart 런처(`plugin/bin/session-start.sh`)의 drain 변경 — 데몬이 살아 있어도 그대로 돈다. hook 명령 동작 변경.
- 데몬 루프·잠금·heartbeat 쓰기 동작 변경(위 공유 규칙 추출과 상수 이동 말고), `daemon stop/start`·재시작(9.6), 로그 회전(9.9), `setup uninstall`(9.10), 감시(9.4), 예약(9.5), 소켓·`DAEMON_UNAVAILABLE`(V1 뒤).
- 새 오류·경고 코드, 생존 판단을 두 벌로 두기(설정 `[daemon] enabled` 같은 다른 기준 포함), Core(`packages/core`)에 파일·프로세스 코드 넣기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 살아 있음 | 살아 있는 pid 잠금, heartbeat 89초 전 | `alive: true`; 명령 뒤 drain 안 돎; doctor `daemon: ok`; status `alive: true`, pid, heartbeat_at | — |
| 경계 | heartbeat 정확히 90초 전 | 살아 있음 | — |
| 멈춤 | 살아 있는 pid, heartbeat 91초 전 | `stale-heartbeat`; drain 돎; doctor `warn`, exit 0 | — |
| heartbeat 없음 | 잠금 있음, heartbeat 파일 없음 | `no-heartbeat`; drain 돎; `warn` | — |
| 미래 시각 | heartbeat mtime이 지금보다 뒤 | `future-heartbeat`; drain 돎; `warn` | — |
| 잠금 없음 | 정상 종료 뒤(heartbeat만 남음) | `no-lock`, heartbeatAt 채움; drain 돎; `warn` | — |
| pid 사망 | 잠금의 pid가 죽음 또는 이전 부팅 | `pid-dead`, pid 채움; drain 돎; `warn` | — |
| 읽을 수 없음 | 깨진 잠금, run 폴더 권한 없음 | 죽음으로 판단 | throw하지 않음 |
| 설정 없음 | 설치 안 된 home에서 `daemon status` | exit 0, `alive: false`, `no-lock` | — |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/lock.ts` -- `acquireDaemonLock`(109)의 생존 조건(122–129)을 꺼낼 자리; `readDaemonLock`(147) → `DaemonLockOwner { pid, bootAt, startedAt }`; `BOOT_SLACK_MS`. 기본 `bootAt`은 `clock.now() − uptime()*1000`.
- `apps/cli/src/daemon/run.ts:45` -- `DAEMON_HEARTBEAT_MS`(옮기고 다시 export). 이 파일은 `assembly.ts`·`dispatch.ts`를 import하므로 판단 함수가 기대면 순환.
- `apps/cli/src/daemon/heartbeat.ts` -- heartbeat는 `<home>/run/heartbeat`, 기록은 mtime(읽기만, 바꾸지 않음). `config/paths.ts` `heartbeatPath`·`daemonPidPath`.
- `apps/cli/src/runtime/spool.ts:519` -- `systemIsAlive`(EPERM은 생존).
- `apps/cli/src/dispatch.ts` -- `execute`(503~)의 기회적 drain 호출(647–657), `shouldDrain`(682), `drainOpportunistically`(730, 바꾸지 않음). `home`·`clock`은 `execute` 안에 이미 있다.
- `apps/cli/src/commands/daemon-run.ts`, `commands/index.ts` -- standalone 명령 spec 모양과 등록 순서. `commands/failures-list.ts` -- `isoWithOffset`·snake_case 데이터 관례.
- `apps/cli/src/doctor/checks.ts:118` -- `runtimeChecks` 목록; `lastHookCheck`(614)가 파일 mtime을 `isoWithOffset`로 보이는 모범. `assembly.ts:94`와 `install/store.ts:306`이 이 목록을 부른다.
- 점검 id 목록을 단언하는 시험: `apps/cli/test/doctor-run.test.ts:64,69`, `doctor-checks.test.ts:93`, `install-store.test.ts:40,376`. 요약 건수를 보는 설치·doctor 시험도 `daemon` 한 줄만큼 바뀐다.
- 시험 틀: `apps/cli/test/daemon-run.test.ts`·`queue-drain.test.ts`·`capture-scan.test.ts`(빌드된 `dist/bin.js` spawn, `installed()`, `transcript()` 픽스처, `rows()`); `command-meta.test.ts`·`output-language.test.ts`·`guide.test.ts`·`readme-codes.test.ts`가 새 명령을 자동으로 건다.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/daemon/lock.ts` -- 주인 생존 규칙을 export된 함수로 꺼내 `acquireDaemonLock`이 쓴다 -- 잠금과 판단이 같은 "살아 있는 주인"을 쓰게
- [x] `apps/cli/src/daemon/liveness.ts`, `apps/cli/src/daemon/run.ts` -- 판단 함수·`DAEMON_ALIVE_MS`·옮긴 `DAEMON_HEARTBEAT_MS`(run.ts가 다시 export) -- 셋이 쓸 하나뿐인 판단
- [x] `apps/cli/src/dispatch.ts` -- 기회적 drain 앞에 판단, 살아 있으면 생략 -- E9-2 폴백
- [x] `apps/cli/src/commands/daemon-status.ts`, `apps/cli/src/commands/index.ts` -- 새 명령과 등록 -- E9-6 status
- [x] `apps/cli/src/doctor/checks.ts` -- `daemon` 점검과 `clock` 옵션 -- E9-6 doctor
- [x] `README.md` -- 위 절들 -- 문서 대조 시험과 사용자
- [x] `apps/cli/test/daemon-liveness.test.ts` -- 행렬의 판단 단위 시험(주입 clock·`isAlive`·`bootAt`, `utimes`로 mtime): 89·90·91초, 없음, 미래, 잠금 없음, pid 사망, 이전 부팅, 깨진 잠금, throw하지 않음; 잠금 시험(`daemon-lock.test.ts`)이 그대로 통과 -- 판단 규칙의 증거
- [x] `apps/cli/test/daemon-status.test.ts`(새 파일) -- 빌드된 `dist/bin.js`로: (a) 설치된 home·임시 harness 폴더의 transcript 하나, 살아 있는 잠금 + heartbeat 89초 전 → `brain failures list` 뒤 `sessions` 0행, `doctor run --json`의 `daemon` `ok`·exit 0, `daemon status --json` `alive: true`·pid·heartbeat_at; (b) 91초 전과 heartbeat 없음 → 같은 명령 뒤 그 세션이 들어오고, `daemon` `warn`·exit 0, status `alive: false`와 까닭; (c) 설정 없는 home의 `daemon status` exit 0 -- 사용자 표면 증거
- [x] `apps/cli/test/doctor-run.test.ts`, `doctor-checks.test.ts`, `install-store.test.ts`와 건수가 바뀌는 다른 시험 -- 점검 목록·요약에 `daemon` 반영, `daemon` 점검 ok/warn detail 단위 시험 -- 기존 시험이 새 점검과 맞게

**Acceptance Criteria:**
- Given 데몬 파일이 하나도 없는 설치된 home, when `pnpm test`의 기존 epic 1·2·10 시험을 돌리면, then 바뀐 점검 목록·건수 말고는 그대로 통과하고 기회적 drain은 지금처럼 돈다.
- Given 같은 heartbeat·잠금 상태, when 기회적 drain 생략·doctor `daemon`·`daemon status --json`을 보면, then 셋이 늘 같은 생존 판단을 낸다(89초·91초·없음 상태마다).
- Given `brain guide schema --json`, when 명령 목록을 보면, then `daemon status`가 `risk: read`로 있다.

## Implementation Notes

- Shared `ownerIsAlive` preserves the existing lock acquisition rule. `liveness.ts` owns heartbeat constants and does not import `run.ts`; all three surfaces use `daemonLiveness`. Assembly passes its clock to doctor checks.
- Added isolated temporary-home unit and CLI coverage for every matrix state, including unreadable paths, previous boot, exact 90-second boundary, fallback drain, and explicit drain while alive. The alive CLI fixture refreshes its 89-second-old mtime during subprocesses to avoid crossing the cutoff during slow probes.

## Plan Change Log

## Review Triage Log

- **medium → patch:** `apps/cli/test/daemon-status.test.ts` held a fixed 89-second heartbeat across several subprocesses. Doctor probes can use the remaining one-second margin and make a correct liveness result fail the test. Keep the fixture age stable during each subprocess and clean up its refresh timer.
  (위 줄은 codex 구현 세션이 구현 중 스스로 돌린 점검의 메모다. 워크플로 리뷰가 아니므로 판정 건수에 넣지 않는다.)

### 2026-10-27 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` (quick) `liveness.ts`가 `stat()`이 되기만 하면 heartbeat로 받아, mode 000 파일이나 `run/heartbeat` 자리의 디렉터리도 mtime이 90초 안이면 살아 있다고 본다 — 기록은 mtime이고(9.1) mode 000이어도 mtime은 읽히므로 계획의 "읽을 수 없음"에 들지 않는다. 그런 경로에는 데몬의 `writeFile`이 실패해 mtime이 더 가지 않으므로 늦어도 90초 뒤 `stale-heartbeat`로 떨어지고 폴백 drain이 돈다. 누가 손으로 그 자리를 망가뜨려야 생기는 일이고, 고치려면 파일 종류 가드 분기를 더해야 한다.

### 2026-10-27 — Follow-up review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: none. Fresh read-only quick reviewer inspected the baseline diff and surrounding code; no patches or deferrals.

## Design Notes

- pid까지 보는 까닭: 정상 종료한 데몬은 pid 파일을 지우고 heartbeat는 남긴다(9.1). heartbeat만 보면 방금 끝난 데몬을 90초 동안 살아 있다고 보고 그동안 아무도 drain하지 않는다. 반대로 잠금만 보면 핸들러 안에서 멈춘 데몬을 살아 있다고 본다 — heartbeat는 drain과 독립된 타이머라 프로세스가 사라진 것과 바쁜 것은 가려도, 이 두 조건을 함께 봐야 "일을 맡을 데몬이 있다"가 된다.
- 경계는 `age ≤ 90_000`이 살아 있음("90초 안"). mtime은 `floor(mtimeMs)`로 ms에 맞춘다 — 방금 쓴 파일의 소수 ms가 `Date.now()`보다 커서 미래로 읽히지 않게.
- 새로 설치한 직후의 doctor(설치기 마지막 단계)는 launchd 등록 전이라 `daemon: warn`이다. `warn`은 설치를 실패시키지 않고(`fail`만), 사실 그대로다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project cli` -- expected: 새 시험 포함 전부 통과
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- expected: 전부 통과(`postgres`는 Docker가 없으면 global setup에서 멈추므로 뺀다; 이 스토리는 Postgres를 건드리지 않는다)
- `git diff --check` -- expected: 출력 없음

**Completed verification (2026-10-27):** `pnpm build` and `pnpm typecheck` passed. The CLI-only run passed 931 tests in 31 files. After the review fix, the exact combined eight-project command above passed 2,676 tests in 91 files. `guide schema --json` includes `daemon status` with `risk: read`. `git diff --check` passed. Quick review found one timing-sensitive test fixture; it was corrected and the full checks rerun. Nothing deferred; Postgres excluded as planned.

**오케스트레이터 재검증(2026-10-27, 커밋 `d82a181` 위):** `pnpm build && pnpm typecheck` 통과. 위 여덟 프로젝트 명령 91 파일 2,676건 통과. `pnpm vitest run --project cli daemon-liveness daemon-status` 2 파일 15건 통과(새 시험이 실제로 돈다). `git diff --check 168ba8e` 출력 없음.

## Auto Run Result

Status: built (hand-back). This follow-up leaves the orchestrator-owned plan status unchanged and does not run `tickets.py mark`. No human decision is required. Existing deferred-work ledger entries were untouched.

**Implemented behavior:** One shared pid/heartbeat liveness judgment controls opportunistic drain, doctor, and `daemon status`; alive means a live lock owner and a heartbeat aged 0–90 seconds. A missing, future, or stale heartbeat or dead owner enables fallback drain. SessionStart and explicit queue drain retain their behavior.

**Files in the reviewed change:**
- `apps/cli/src/daemon/liveness.ts`, `lock.ts`, `run.ts` — shared liveness, owner checks, and heartbeat constants.
- `apps/cli/src/dispatch.ts` — skip opportunistic drain while the daemon is alive.
- `apps/cli/src/commands/daemon-status.ts`, `commands/index.ts` — standalone status command and registration.
- `apps/cli/src/doctor/checks.ts`, `assembly.ts` — daemon diagnostic and injected clock.
- `apps/cli/test/daemon-liveness.test.ts`, `daemon-status.test.ts` — boundary and CLI fallback coverage.
- `apps/cli/test/doctor-checks.test.ts`, `doctor-run.test.ts`, `install-store.test.ts`, `setup.test.ts` — diagnostic expectations.
- `README.md` — daemon status and fallback documentation.
- This plan — follow-up review and result; no source/test edits in this pass. The pre-existing removal of the prior result was preserved and replaced with this run's result.

**Review:** Fresh quick reviewer reported no findings. Patches 0 (high 0, medium 0, low 0), deferred 0, rejected 0 in this pass. Earlier triage decisions remain recorded above. Follow-up review recommended: false.

**Verification:** At revision `330b9b330843f3be41335932110f2bb84919aed4`, `pnpm build`, `pnpm typecheck`, and `pnpm vitest run --project cli daemon-liveness daemon-status` passed (2 files, 15 tests). Earlier eight-project verification remains recorded above; no source/test changes required another broad run. Final `git diff --check` passed after recording this result.

**Residual limits:** Postgres integration was not rerun (unaffected; requires Docker). The previously rejected manually damaged heartbeat-path edge case remains recorded above. The orchestrator performs final verification and owns ticket completion.
