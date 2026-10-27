---
title: 'Refactor sweep: epic 9가 미룬 정리'
type: 'refactor'
ticket: '7'
created: '2026-10-27'
status: done
baseline_revision: '9c7ae4aca16b4fa56c293fd6ee207d0bf85e1bb9'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
closes_deferred: [DW-3]
---

<intent-contract>

## Intent

**Problem:** 9.1~9.6·9.9·9.10의 plan과 리뷰가 남긴 정리 가운데 기능 추가 없이 닫을 수 있는 것이 셋 있다. (1) DW-3: 시스템 launchctl adapter의 10초 시간 초과는 기본 SIGTERM만 보내므로 SIGTERM을 무시하는 실행 파일이면 설치·제어가 시간 초과를 넘겨 멈출 수 있고, 가짜의 `exec sleep 30`은 SIGTERM에 끝나 이를 보이지 못한다(9.2 deferred, maybe-false). (2) `apps/cli/test/environment.ts`가 모듈을 읽을 때마다 임시 폴더 셋을 만들고 지우지 않아 시험을 돌릴 때마다 `tmpdir()`에 쌓인다(9.2 후속 리뷰 low 기각). (3) `apps/cli/test/daemon-run.test.ts`의 `sessionCount`가 데몬이 쓰는 중인 DB를 busy timeout 없이 읽어 `database is locked`로 시험이 가끔 실패한다(9.6 재개 구현 검증 기록).

**Approach:** 세 가지를 제품 동작 변경 없이(1은 시간 초과 때 강제 종료만) 고친다. 범위 밖 항목은 새 스토리 후보로 Auto Run Result에 남긴다.

## Boundaries & Constraints

**Always:**
- 1: `systemLaunchctl`의 `run`이 시간 초과 때 자식을 `SIGKILL`로 끝내(`execFile`의 `killSignal`) 10초 남짓 안에 `{ ok: false, message }`를 돌려준다. 성공·실패 메시지 형식과 `Launchctl` 인터페이스는 그대로다.
- 1: 가짜 `fixtures/fake-launchctl.sh`의 `FAKE_LAUNCHCTL_HANG` 경로가 SIGTERM을 무시하는 프로세스가 되어(`trap '' TERM` 뒤 `exec sleep 30`), 기존 시험 `times out a stalled launchctl before its sleep ends`가 강제 종료를 증명한다.
- 2: `environment.ts`가 만든 세 임시 폴더는 그 폴더를 쓰는 시험 파일의 시험이 모두 끝난 뒤 지워진다(자식 프로세스 시험이 도중에 폴더를 잃지 않음). `EMPTY_CONFIG_DIR`·`withoutHarnessFolders`의 공개 모양은 그대로다.
- 3: 시험의 DB 읽기는 데몬의 쓰기와 겹쳐도 잠금 오류로 실패하지 않는다(busy timeout 또는 잠금일 때 "아직"으로 보고 다시 기다림). 단언의 뜻(세션 수)은 그대로다.
- 바꾼 시험은 고치기 전의 결함을 잡는다: 1은 `killSignal`을 빼면 실패하고, 2는 폴더가 남으면 드러난다.

**Never:**
- DW-4(재시작 실패 뒤 같은 ref 재시도), DW-5(plist 재적재 표식), `isLoaded`의 세 상태 probe, 예약 등록 입력 검증, DW-1·DW-2(다른 에픽)는 만들지 않는다 — 정책·계약 변경이라 새 스토리 후보다.
- `deferred-work.md`와 티켓 파일(`tickets.toml`, epic 파일)을 고치지 않는다. DW-3 닫기는 frontmatter `closes_deferred`로 오케스트레이터가 한다.
- `tooling/bootstrap` 제품 코드, 다른 패키지, 실제 `~/Library/LaunchAgents`·실제 launchctl을 건드리지 않는다.
- 기존 리뷰가 기각한 다른 항목을 다시 열지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SIGTERM 무시 launchctl | `FAKE_LAUNCHCTL_HANG=bootstrap`, 가짜가 TERM을 무시 | `bootstrap`이 15초 안에 `{ ok: false }`, 호출 기록 한 줄 | 값으로 돌려줌, 던지지 않음 |
| 정상 launchctl | 가짜가 바로 0·113·5로 끝남 | 지금과 같은 결과·메시지 | 없음 |
| 시험 파일 종료 | `environment.ts`를 읽은 시험 파일이 끝남 | 그 실행이 만든 `brain-no-harness-*`·`brain-launch-agents-*`·`brain-launchctl-*`가 남지 않음 | 지우기 실패는 시험을 실패시키지 않음(`force`) |
| 쓰는 중 DB 세기 | 데몬이 쓰기 트랜잭션 중 `sessionCount` | 잠금 오류 없이 수를 돌려주거나 다음 폴링에서 다시 셈 | 잠금 외 오류는 그대로 던짐 |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/launchd.ts:50-68` -- `systemLaunchctl`; `run`의 `execute(executable, args, { env, timeout: 10_000 })`에 `killSignal: 'SIGKILL'`을 더할 자리. 메시지 조립은 그대로 둔다.
- `apps/cli/test/fixtures/fake-launchctl.sh:5-7` -- `FAKE_LAUNCHCTL_HANG` 분기. `exec` 전에 TERM을 무시하게 한다(무시한 신호는 exec 뒤에도 이어짐).
- `apps/cli/test/daemon-launchd.test.ts:155-166` -- 시간 초과 시험. 이름·주석에 "SIGTERM을 무시해도"를 드러내고 그대로 15초 경계를 단언한다.
- `apps/cli/test/environment.ts:21-24` -- 모듈 수준 `mkdtempSync` 셋. 18개 시험 파일이 읽는다. vitest 시험 파일마다 모듈이 다시 평가되므로 같은 모듈에서 `afterAll`(vitest)로 지우는 방식이 자연스럽다. `apps/cli/test/temp-home.ts`가 같은 저장소의 정리 관례(`rm(path, { recursive: true, force: true })`).
- `apps/cli/test/daemon-run.test.ts:718-726` -- `sessionCount`. `DatabaseSync(path, { readOnly: true })`; node:sqlite의 `timeout` 옵션(busy timeout ms) 또는 잠금 오류를 0이 아닌 "다시"로 다루는 자리. `:894`, `:906`의 직접 읽기는 데몬이 멈춘 뒤라 그대로 둔다. `waitFor`(`:101`)는 25ms 폴링.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/daemon/launchd.ts` -- 시간 초과 때 `SIGKILL` -- DW-3.
- [x] `apps/cli/test/fixtures/fake-launchctl.sh` -- HANG 분기가 TERM을 무시 -- 기존 시간 초과 시험이 강제 종료를 증명하도록.
- [x] `apps/cli/test/daemon-launchd.test.ts` -- 시간 초과 시험 이름·설명을 SIGTERM 무시 경우로 -- 무엇을 증명하는지 드러냄.
- [x] `apps/cli/test/environment.ts` -- 시험 파일 끝에 세 임시 폴더 지우기 -- 9.2 후속 리뷰의 정리 누락.
- [x] `apps/cli/test/daemon-run.test.ts` -- `sessionCount`가 잠금과 겹쳐도 실패하지 않게 -- 9.6에서 본 `database is locked` 흔들림.

**Acceptance Criteria:**
- Given `killSignal`을 뺀 `launchd.ts`, when `pnpm vitest run --project cli daemon-launchd`를 돌리면, then 시간 초과 시험이 실패하고(약 30초 sleep을 기다림), 넣으면 통과한다.
- Given 비어 있는 새 `TMPDIR`, when `pnpm vitest run --project cli`를 끝까지 돌리면, then 그 `TMPDIR`에 `brain-no-harness-*`·`brain-launch-agents-*`·`brain-launchctl-*`가 남지 않는다.
- Given 정리 뒤 코드, when `pnpm test`(build·typecheck·vitest)를 돌리면, then 가용 프로젝트가 모두 통과한다(Docker가 없으면 `postgres`를 빼고 그 사실을 기록).

## Implementation Notes

- `systemLaunchctl`의 `execFile`에 `killSignal: 'SIGKILL'`을 지정하고, 가짜 HANG 경로는 `trap '' TERM`을 거쳐 `sleep`을 실행한다. 기존 메시지와 인터페이스는 유지했다.
- `environment.ts`에서 vitest `afterAll`로 세 폴더를 `rm(..., { recursive: true, force: true })`한다. 시험 파일의 모든 시험과 `afterEach` 뒤에 정리한다.
- `sessionCount`의 읽기 전용 연결에 `timeout: 5_000`을 지정했다. 세션 수 단언과 다른 DB 읽기는 유지했다.
- `pnpm build && pnpm typecheck` 및 `pnpm vitest run --project cli daemon-launchd daemon-run`: 통과(49개 시험).
- 음성 대조: `killSignal`만 임시 제거하면 SIGTERM 무시 시험이 20초에 timeout으로 실패(exit 1). 복원했다.
- 음성 대조: `afterAll` 정리만 임시 제거하고 새 `TMPDIR`에서 adapter 시험을 실행하면 대상 접두어 폴더 3개가 남는다. 정리를 복원했고 음성 대조의 임시 폴더도 제거했다.

## Plan Change Log

## Review Triage Log

- quick: 코드와 주변 호출 경로를 읽은 독립 검토에서 지적 사항 없음.
- 위 행은 구현 세션(codex)이 스스로 돌린 자체 점검 기록이다(계획의 상태·리뷰 칸과 Auto Run Result도 그 세션이 썼고, 상태·리뷰 칸은 오케스트레이터가 되돌렸다). 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-27 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (없음) Quick 렌즈(새 codex 읽기 전용 리뷰어)가 계획의 수용 기준·`AGENTS.md`·기준 리비전 이후 diff와 주변 코드를 대조해 미충족 수용 기준·규칙 위반·버그를 찾지 못했다.

### 2026-10-27 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 새 읽기 전용 codex 리뷰어가 계획·적용 지침·기준 리비전 이후 diff와 주변 코드를 대조했으며 지적 사항이 없었다. 리뷰 세션: `01a17c39-c4c8-72b0-b95f-e6be12cedd7d`.

## Design Notes

- 정리 목록을 정한 근거(2026-10-27 착수): 8개 plan의 `deferred`, Review Triage Log, Residual risks, Implementation Notes와 `deferred-work.md`의 epic 9 항목(DW-3·4·5)을 모았다. 9.6의 검증 빈틈 두 건(실패한 kill 결과, 일시적 bootstrap 실패 뒤 회복)은 이미 `daemon-control.test.ts`의 `passes failed kill diagnostics through without polling`·`recovers from a transient bootstrap failure…`로 덮여 뺐다. 계약이나 정책을 바꿔야 하는 항목은 "정리만" 범위를 넘으므로 새 스토리 후보로 남긴다.
- `SIGKILL`인 이유: launchctl 하위 명령은 상태를 남기지 않는 짧은 호출이라 시간 초과 뒤 정상 정리를 기다릴 까닭이 없고, adapter 계약은 "10초 안에 값으로 답한다"다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project cli daemon-launchd daemon-run` -- expected: 통과
- `TMPDIR=$(mktemp -d) pnpm vitest run --project cli` 뒤 그 폴더 `ls` -- expected: 세 접두어 폴더 없음
- `pnpm vitest run --project core --project sqlite --project claude-code --project second_brain --project cli --project bootstrap --project test-db --project modelstudio` -- expected: 전부 통과(`postgres`는 Docker가 없으면 빼고 기록)
- `git diff --check` -- expected: 출력 없음
- `ls ~/Library/LaunchAgents | grep second-brain` (시험 전후) -- expected: 같음

## Auto Run Result

Status: built

- 요약: 기존 구현의 후속 리뷰와 전체 검증을 마쳤다. launchctl 시간 초과의 `SIGKILL`, 시험 공용 임시 폴더 정리, 데몬 시험 DB 읽기의 busy timeout을 확인했다. 이번 실행에서 소스·시험 코드는 수정하지 않았다.
- 변경 파일: `apps/cli/src/daemon/launchd.ts` — 강제 종료 신호; `apps/cli/test/fixtures/fake-launchctl.sh` — SIGTERM 무시; `apps/cli/test/daemon-launchd.test.ts` — 강제 종료 검증; `apps/cli/test/environment.ts` — 세 임시 폴더 정리; `apps/cli/test/daemon-run.test.ts` — 읽기 잠금 대기. 이 계획에는 이번 리뷰·검증 결과를 기록했다.
- 리뷰: quick 후속 회차 지적 0건, patch 0건(high 0, medium 0, low 0), defer 0건, reject 0건. 다른 렌즈는 이번 quick 선택에 따라 생략했다. 후속 리뷰 권고는 `false`다.
- 검증: `657df0fda063199ba265d14994ab234f2b99cea0`의 소스에서 새 빈 `TMPDIR`로 `pnpm test`를 실행해 exit 0. 빌드·typecheck와 PostgreSQL을 포함한 102개 파일, 2,892개 시험이 모두 통과했다. 종료 뒤 `brain-no-harness-*`·`brain-launch-agents-*`·`brain-launchctl-*` 폴더는 0개였다. 실제 `~/Library/LaunchAgents`의 second-brain 항목은 실행 전후 모두 없었다. 로그: `/tmp/brain-9-7-test.log`, 확인 결과: `/tmp/brain-9-7-verification.json`. `git diff --check`도 통과했다.
- 남은 위험: `sessionCount`의 5초 busy timeout보다 오래 잠기면 오류가 날 수 있다. 실제 launchctl을 호출하는 설치본 실증은 이번 정리의 검증 범위에 포함하지 않았다.
- 반환: 사용자 지시에 따라 계획의 기존 `status: built`를 유지했고 `tickets.py mark`를 실행하지 않았다. 기존 deferred-work 원장 항목과 그 상태·해결 기록은 수정하지 않았다. 기존 `closes_deferred: [DW-3]`도 그대로이며 해당 항목 처리와 티켓 완료 판정은 오케스트레이터가 맡는다.
