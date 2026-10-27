---
title: '데몬 로그 회전: daemon.log가 1MB×5를 넘지 않는다'
type: 'feature'
ticket: '9'
created: '2026-10-27'
status: done
baseline_revision: 'bcb19af44ddf1330d947be3a1aeb4657bd54d23b'
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
---

<intent-contract>

## Intent

**Problem:** 9.1이 만든 `<home>/log/daemon.log`는 `appendFile`로 덧붙이기만 해서, launchd가 계속 띄우는 상주 데몬의 로그가 끝없이 커진다(E9-1 "1MB×5 회전").

**Approach:** `apps/cli/src/daemon/log.ts`의 `daemonLog` 한 함수에 크기 회전을 붙인다. 한 줄을 쓰기 전에 지금 크기와 그 줄의 바이트를 더해 1MiB를 넘으면 `daemon.log.4→.5`…`daemon.log→.1`로 밀고(가장 오래된 `.5`는 버림) 새 `daemon.log`에 그 줄을 쓴다. 한 프로세스 안의 쓰기는 한 줄씩 차례로 처리하고, 회전은 잠금을 쥔 데몬만 한다.

## Boundaries & Constraints

**Always:**
- **상수.** `daemon/log.ts`에 `DAEMON_LOG_MAX_BYTES = 1_048_576`(1MiB), `DAEMON_LOG_KEEP = 5`를 export한다. 시험은 `daemonLog`의 선택 인자(`{ maxBytes?, keep?, rotate? }`)로 작은 값을 준다.
- **회전 규칙.** 줄 = `<ISO 시각> <encodeTextLine(문장)>\n`(지금 형식 그대로). 쓰기 전 `daemon.log`의 크기(없으면 0)가 0보다 크고 `크기 + Buffer.byteLength(줄) > maxBytes`이면 회전한 뒤 쓴다. 그래서 `daemon.log`는 maxBytes를 넘지 않는다. 단, 한 줄이 maxBytes보다 길면 자르지 않고 빈 새 파일에 통째로 쓴다(줄을 자르거나 버리지 않는 것이 크기 한도보다 앞선다).
- **회전 순서.** `.keep`을 지우고(없으면 무시), `n = keep-1 … 1`에 대해 `.n → .n+1` rename(없으면 무시), 마지막에 `daemon.log → .1` rename. 각 단계의 ENOENT는 무시한다. 회전 중 다른 실패는 삼키고 그 줄은 지금 `daemon.log`에 덧붙인다(로그 때문에 데몬이 멈추지 않는다는 9.1 규칙). 새 `daemon.log`는 지금처럼 `appendFile`의 mode 0600, 폴더는 0700으로 만든다.
- **순서와 섞임.** 한 `DaemonLog` 안의 `write`는 promise 사슬로 하나씩 처리한다 — 동시에 부른 `write`(heartbeat·watch·회차 루프가 같은 로그를 쓴다)가 크기 확인과 회전 사이에 끼어들지 않고, 줄이 부른 순서대로 남는다. 한 줄은 `appendFile` 한 번으로 쓴다. 앞 쓰기가 실패해도 사슬이 끊기지 않는다(`write`는 여전히 던지지 않는다).
- **회전하는 프로세스는 하나.** `run.ts`는 잠금을 잡기 전(거절 줄)에는 회전하지 않는 로그(`rotate: false`)를 쓰고, 잠금을 잡은 뒤의 로그만 회전한다. 같은 home의 데몬은 pid 잠금으로 하나이므로 두 프로세스가 동시에 회전해 파일을 하나 더 밀어 버리는 일이 없다. 회전하지 않는 프로세스가 rename과 겹쳐 쓴 줄은 `.1`에 들어갈 뿐 사라지지 않는다.
- **경로.** `config/paths.ts`에 `daemonLogRotatedPath(home, n)`(`<home>/log/daemon.log.<n>`)을 더해 회전과 9.10(`setup uninstall`)이 같은 이름을 쓰게 한다.
- **README.** `## 데몬` 절의 `daemon.log` 항목에 회전(1MiB를 넘기 전에 `.1`…`.5`로 밀고 가장 오래된 것을 버림, 가장 새 줄은 `daemon.log`, 줄을 자르지 않음)을 한국어로 적는다.
- 기존 로그 문장·형식·가림은 바이트 단위로 그대로다. 기존 시험은 그대로 통과한다.

**Never:**
- 외부 로그 라이브러리, 압축, 시간 기준 회전, 설정 키(`[daemon]` 등) 추가.
- 회전할 때 파일을 복사하거나 내용을 잘라 내는 방식(copy-truncate) — 경계 줄을 잃을 수 있다.
- `setup uninstall`이 회전 파일을 지우는 일(9.10), doctor·status가 로그를 읽는 일, launchd plist에 `StandardOutPath` 추가.
- stdout/stderr에 직접 쓰기(`test/output-codecs.test.ts` 싱크 표를 늘리지 않는다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 한도 아래 | `daemon.log` 작음 | 덧붙이기만, 회전 파일 없음 | — |
| 경계 | 크기 + 줄 > maxBytes | 기존 내용은 `.1`로, 그 줄은 새 `daemon.log` 첫 줄; 두 파일 합치면 쓴 줄 전부가 순서대로 온전 | — |
| 오래 씀 | maxBytes의 10배 넘게 씀 | `daemon.log`와 `.1`…`.5`만 남고 `.6` 없음; 각 파일 ≤ maxBytes; 가장 새 줄은 `daemon.log` 끝; 남은 파일들의 줄은 모두 온전하고 끊김 없이 이어짐(가장 오래된 것만 버려짐) | — |
| 긴 줄 | 한 줄 > maxBytes | 회전 뒤 그 줄 하나가 통째로 `daemon.log`에 | 자르지 않음 |
| 동시 쓰기 | 한 `DaemonLog`에 `write` 여러 개를 기다리지 않고 부름 | 부른 순서대로, 줄 섞임·잘림 없이 남고, 회전 수 규칙 그대로 | — |
| 회전 실패 | `.1` rename이 실패(예: 이름 자리에 지울 수 없는 폴더) | `write`는 던지지 않고 줄은 `daemon.log`에 덧붙여짐 | 삼킴 |
| 거절 프로세스 | `rotate: false` 로그, 크기 > maxBytes | 회전하지 않고 덧붙이기만 | — |
| 파일 없음 | `log/` 폴더도 없음 | 폴더 0700·파일 0600으로 만들고 씀 | — |

</intent-contract>

## Code Map

- `apps/cli/src/daemon/log.ts` -- `daemonLog(home, clock)` → `{ write(line) }`, `appendFile` + `encodeTextLine` + 실패 삼킴. 9.1 주석이 "Story 9.9 adds rotation to this one function"이라고 자리를 정해 두었다. 여기만 고치고 시그니처는 선택 인자만 더한다.
- `apps/cli/src/config/paths.ts:91,164` -- `DAEMON_LOG_FILE`, `daemonLogPath(home)`; 회전 경로 함수를 그 옆에.
- `apps/cli/src/daemon/run.ts:109,127,140` -- `runDaemon`이 잠금 전에 `daemonLog`를 만들고 거절 줄(127)을 쓴 뒤, 같은 로그를 heartbeat(`startHeartbeat({ log })`)·watch·회차에 넘긴다. 거절 줄용 로그와 잠금 뒤 로그를 나눈다.
- `apps/cli/src/daemon/watch.ts:37` -- 자체 `logging = logging.then(...)` 사슬로 쓴다; 그대로 둔다(로그 쪽 사슬과 함께 써도 순서는 같다).
- `apps/cli/src/daemon/heartbeat.ts:72` -- 실패 줄을 쓴다; 바꾸지 않는다.
- `apps/cli/test/daemon-run.test.ts` -- 로그 내용을 읽는 기존 시험들(줄 형식·한 번만 기록). 깨지면 안 된다. `test/temp-home.ts`가 임시 home 틀.
- `apps/cli/test/output-language.test.ts`, `readme-codes.test.ts` -- README 한국어·코드 대조; 새 오류 코드는 없다.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/config/paths.ts` -- `daemonLogRotatedPath(home, n)` -- 회전과 9.10이 같은 이름을 쓰게
- [x] `apps/cli/src/daemon/log.ts` -- 상수 둘, 선택 인자 `{ maxBytes, keep, rotate }`, 쓰기 사슬, 쓰기 전 크기 확인과 회전, 주석 갱신 -- 회전 본체
- [x] `apps/cli/src/daemon/run.ts` -- 잠금 전 거절 줄은 `rotate: false` 로그로, 잠금 뒤에는 회전하는 로그로 -- 회전하는 프로세스를 하나로
- [x] `README.md` -- `## 데몬`의 `daemon.log` 항목에 회전 설명 -- 사용자 문서
- [x] `apps/cli/test/daemon-log.test.ts` -- I/O 행렬 전부를 작은 `maxBytes`(예: 200~500바이트)와 임시 home으로: 각 줄에 번호를 넣어 써서 남은 파일을 `.5`→`.1`→`daemon.log` 순으로 이어 읽으면 번호가 빠짐없이 증가하고 마지막 번호가 `daemon.log` 끝에 있음, 파일 수·크기 한도, 긴 줄, 동시 `write`, 회전 실패, `rotate: false`, 상수 값(1_048_576·5) 단언 -- 회전 규칙의 증거
- [x] `apps/cli/test/daemon-run.test.ts`(또는 같은 파일 안 한 시험) -- 기본 상수로 1MiB를 넘게 쓰는 실제 크기 시험 하나: `daemonLog(home, clock)`에 1MiB 넘게 써서 `daemon.log` ≤ 1MiB, `.1` 존재, 경계 줄 온전 -- 실제 상수 경로의 증거

**Acceptance Criteria:**
- Given 임시 home, when 기본 상수의 데몬 로그에 1MiB를 넘게 쓰면, then `daemon.log`는 1MiB 이하이고 `daemon.log.1`이 생기며, 회전 직전 마지막 줄은 `.1` 끝에, 회전 뒤 첫 줄은 `daemon.log` 첫 줄에 온전히 있다.
- Given 임시 home과 작은 한도의 로그, when 한도의 10배 넘게 번호 붙인 줄을 쓰면, then `daemon.log`와 `.1`…`.5`만 남고, 이어 읽은 번호가 빠짐없이 증가하며 가장 새 번호는 `daemon.log` 마지막 줄이다.
- Given 떠 있는 데몬이 있는 home, when 두 번째 `brain daemon run`이 거절되면, then 거절 줄은 회전 없이 `daemon.log`에 덧붙여진다.
- Given 이 변경 전의 모든 시험, when `pnpm test`를 돌리면, then 그대로 통과한다.

## Implementation Notes

- 종료 로그도 pid 잠금을 보유한 동안 회전하도록, 마지막 로그 기록 뒤 잠금을 해제한다.
- 기본 1MiB 경계 시험은 `apps/cli/test/daemon-log.test.ts`에 포함했다.
- (구현 세션의 자체 점검, step-04 리뷰 아님) `apps/cli/test/daemon-run.test.ts`의 거절 시험은 시작 줄만 기다려 watcher 초기 로그와 경쟁할 수 있었다. `runDaemon`은 watcher 로그를 기다린 후 첫 store를 열므로, 기존 `createStore` seam으로 그 시점을 기다리도록 수정했다.

## Plan Change Log

## Review Triage Log

### 2026-10-27 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (없음) Quick 렌즈(codex 읽기 전용 리뷰어)가 diff·계획·`AGENTS.md`를 대조해 미충족 수용 기준·규칙 위반·버그를 찾지 못했다.

### 2026-10-27 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (없음) 독립된 읽기 전용 Codex Quick 리뷰가 기준 리비전부터의 diff와 계획의 수용 기준 및 저장소 규칙을 대조했으며 지적 사항이 없었다.

## Design Notes

- 쓰기 전에 확인하는 이유: 쓴 뒤에 회전하면 `daemon.log`가 한도를 한 줄만큼 넘고, "daemon.log가 1MB를 넘지 않는다"는 제목이 틀어진다. 쓰기 전 확인이면 줄은 늘 한 파일 안에 통째로 들어가 경계에서 잘리지 않는다.
- rename 방식인 이유: rename은 원자적이라, 회전과 겹친 다른 프로세스의 `appendFile`은 옛 파일(이제 `.1`)이나 새 파일 어느 한쪽에 줄을 통째로 남긴다. copy-truncate는 복사와 자르기 사이의 줄을 잃는다.
- 크기 확인은 경로 `stat`이면 충분하다: 회전하는 쪽은 한 프로세스이고 그 안의 쓰기는 사슬로 차례이므로, 확인과 쓰기 사이에 크기를 바꾸는 것은 회전하지 않는 프로세스의 드문 거절 줄뿐이다(그때 한도를 그 한 줄만큼 넘을 수 있으나 줄은 잃지 않는다).

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run apps/cli/test/daemon-log.test.ts apps/cli/test/daemon-run.test.ts` -- expected: 통과
- `pnpm test` -- expected: build·typecheck·전체 시험 통과

**Results:**
- `pnpm build && pnpm exec vitest run apps/cli/test/daemon-log.test.ts apps/cli/test/daemon-run.test.ts`: 2 files, 46 tests passed after review fix.
- `pnpm test`: build, typecheck, 101 files / 2,875 tests passed after review fix (Postgres included).
- `git diff --check`: passed.
- Quick review: one test startup race fixed; no deferred findings or incomplete tasks.

## Auto Run Result

- 상태: 기존 `built`를 유지했다. 티켓 완료 판정은 오케스트레이터가 수행한다. `tickets.py mark`는 실행하지 않았다.
- 구현 요약: 기존 구현의 1MiB 경계 회전, 회전 파일 5개 보존, 줄 단위 직렬 쓰기, 잠금 보유 중 회전 및 거절 프로세스의 회전 없는 쓰기를 후속 리뷰했다. 이번 실행에서 소스와 시험은 수정하지 않았다.
- 구현 파일:
  - `apps/cli/src/daemon/log.ts`: 크기 회전과 쓰기 직렬화.
  - `apps/cli/src/config/paths.ts`: 회전 로그 경로 함수.
  - `apps/cli/src/daemon/run.ts`: pid 잠금에 따른 회전 권한과 종료 순서.
  - `README.md`: 로그 회전 사용 설명.
  - `apps/cli/test/daemon-log.test.ts`: 회전 경계·보존·실패·동시 쓰기 검증.
  - `apps/cli/test/daemon-run.test.ts`: 두 번째 데몬 거절 시 회전 없는 기록 검증.
- 이번 변경 파일: 이 계획 파일에 후속 리뷰와 실행 결과를 기록했다. 실행 시작 시 이미 삭제되어 있던 이전 실행 결과는 복원하지 않았다.
- 리뷰: Quick 렌즈 지적 0건. 적용 패치 0건(high 0, medium 0, low 0), 새 보류 0건, 거절 0건. 기존 deferred-work 원장은 수정하지 않았다.
- 후속 리뷰 권고: `false`. 이번 패스에 패치나 새 미검증 위험이 없다.
- 검증: `pnpm test` 통과. 빌드·타입 검사·101개 파일의 2,875개 시험이 Postgres 포함 통과했다. 이 실행은 `daemon-log.test.ts`와 `daemon-run.test.ts`도 포함한다.
- 차이 검사: `git diff --check` 통과.
- 남은 제약: 기존 설계대로 한도보다 긴 한 줄은 자르지 않으며, 회전하지 않는 거절 프로세스의 동시 쓰기는 크기 한도를 한 줄만큼 넘길 수 있다. 회전 파일 제거는 9.10의 범위다.
