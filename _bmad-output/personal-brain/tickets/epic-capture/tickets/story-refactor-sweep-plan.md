---
title: 'Refactor sweep: hook 경로의 pg 떼기, 중복 헬퍼, 임시 home 테스트 헬퍼, F12 테스트 공백'
type: 'refactor'
ticket: '15'
created: '2026-10-22'
status: done
baseline_revision: 'd7fa3000ef9d172371af997bebad55caac97bdac'
route: 'full'
route_source: 'auto'
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

**Problem:** epic 2 동안 미룬 정리가 남아 있다(epic 1 회고 Action 9·F12). `second_brain`이 `@second-brain/postgres`를 루트에서 재export해서 hook 경로(`sessions ingest`)를 포함한 모든 CLI 호출이 쓰지도 않는 `pg`를 불러온다(단독 import 중앙값 10.7ms). 같은 오류 문자열 헬퍼가 여러 벌이고(`oneLine(error)` 5벌, `describe(error)` 3벌 등), doctor가 node 버전 파서를 따로 갖고, CLI 테스트마다 임시 home 만들기·지우기를 따로 쓴다. `brain --version`의 도달할 수 없는 분기, `setup run --connect` 매핑과 설치기 Ctrl-C(`Cancelled`) 분기에 테스트가 없다.

**Approach:** 동작은 바꾸지 않고 정리만 한다. Postgres 재export는 `second_brain/postgres` 하위 경로로 옮기고, 같은 동작의 헬퍼만 한 곳으로 모으고, CLI 테스트에 임시 home 헬퍼를 두고, 빈 테스트를 채운다. 범위 조사(2026-10-22, codex 워커 둘)에서 열려 있지만 동작을 바꾸는 항목은 범위 밖이다(Design Notes).

## Boundaries & Constraints

**Always:**
- 사용자에게 보이는 출력·종료 코드·DB 내용·hook 동작은 바이트 단위로 그대로다. 헬퍼를 합칠 때 빈 문자열, 여러 줄 메시지, Error가 아닌 값, nullish, 대체 문구(한국어)의 결과가 합치기 전과 같아야 한다.
- 패키지 의존 경계(`packages/second_brain/test/boundaries.test.ts`)를 지킨다: core는 런타임 의존 0, adapter는 core에만, CLI는 `second_brain`에만 기댄다. 공유 순수 함수는 core에, Node 파일 시스템을 쓰는 테스트 헬퍼는 core 밖에 둔다(`@second-brain/core/testing`은 Node API 금지).
- import 시 부작용 없음(AD-3)은 그대로다.

**Never:**
- `brain --version` 기능을 새로 만들지 않는다(무엇을 버전으로 낼지 정해지지 않은 새 표면). 지금 동작(USAGE, exit 2)을 테스트로 고정만 한다.
- 의도적으로 다른 변형은 합치지 않는다: `runtime/spool.ts`의 `describe`(Error 아닌 값은 통째 `String`), `claude-code/src/transcript-folder.ts`의 `describe`(trim 없음), `postgres/src/connect.ts`의 `describe`·`innerMessage`(AggregateError, 영어), 값 표시 헬퍼(`instant.ts`, `spool-record.ts:543`, `testing/assert.ts`), `dispatch.ts`의 스택을 남기는 crash 출력.
- bootstrap(`tooling/bootstrap/src/bootstrap.ts`)의 버전 파서 복사본은 그대로 둔다(의존성 없는 한 파일로 배포됨).
- 오류 코드 메타 추가(`TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`), 파서 버전 업 뒤 재스캔, 도구 대상 잘림 칸, 코디네이터 메시지 구분, WAL 정리, 대화형 redact 확인은 하지 않는다(동작 변경, deferred-work에 이미 있음).
- `@second-brain/postgres` 의존이나 lockfile은 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| hook 경로 | 새 빌드, `node apps/cli/dist/bin.js sessions ingest claude-code` | 그 프로세스가 `pg`를 불러오지 않는다 | — |
| 복제 대상 표면 | `import { postgresStore, runMigrations, SCHEMA_VERSION } from 'second_brain/postgres'` | 지금 루트에서 받던 것과 같은 값 | — |
| 오류 한 줄 | `new Error('a\nb')`, `new Error('')`, `'x'`, `undefined`, `{code:'E'}` 등 | 합친 함수가 옛 헬퍼 각각과 같은 문자열 | — |
| `--version` | `brain --version` | USAGE 오류, exit 2(지금과 같음), home에 아무것도 쓰지 않음 | — |
| `setup run --connect` | `--connect claude-code`, 반복·없음 | 설치기에 넘어가는 플래그가 지금 매핑과 같다 | — |
| 설치기 취소 | 프롬프트가 `Cancelled`를 던짐 | `SETUP_CANCELLED` 실패 결과; 다른 오류는 그대로 던짐 | — |

</intent-contract>

## Code Map

- `packages/second_brain/src/index.ts:3` -- `export * from '@second-brain/postgres'`; 새 `src/postgres.ts`로 옮기고 `package.json` `exports`에 `./postgres`(types·default). 루트·CLI 소비자 중 Postgres 이름을 쓰는 곳은 없다(조사로 확인). `pg`는 CJS라 `createRequire(import.meta.url).cache`나 자식 프로세스로 로드 여부를 볼 수 있다.
- `packages/second_brain/test/import-side-effects.test.ts` -- AD-3 테스트. 루트 import·CLI 진입이 `pg`를 싣지 않음을 더한다.
- 같은 동작 `oneLine(error: unknown)`(Error.message 또는 String → 첫 줄 trim → 한국어 대체): `apps/cli/src/config/codec.ts:744`, `apps/cli/src/dispatch.ts:1144`, `packages/core/src/doctor/doctor.ts:339`, `packages/core/src/queue/drain.ts:446`, `packages/core/src/domain/spool-record.ts:549`.
- 같은 동작 `describe(error)`(message → code → name, 비Error는 String, 한국어 대체): `packages/sqlite/src/connect.ts:200`, `apps/cli/src/install/store.ts:313`, `apps/cli/src/runtime/transcript.ts:48`.
- 같은 동작 첫 줄 trim `describe`: `apps/cli/src/install/installed.ts:358`, `apps/cli/src/doctor/checks.ts:627`. 문자열 `oneLine(text)`: `installed.ts:365`, `checks.ts:634`, `runtime/spool.ts:540`.
- 버전 파서: `apps/cli/src/runtime/node-floor.ts:40`(`parts`)와 `apps/cli/src/doctor/checks.ts:551,557`(`parseVersion`·`parts`) 중복.
- 임시 home: `apps/cli/test/{config,dispatch,doctor-checks,doctor-run,install-store,install,messages-redact,output-codecs,queue-drain,sessions-ingest,setup,shim,spool}.test.ts`가 각자 경로 배열 + `mkdtemp(join(tmpdir(), prefix))` + `afterEach` `rm -rf`. `apps/cli/test/environment.ts`(harness 설정 격리)는 다른 일이라 그대로.
- F12: `apps/cli/src/dispatch.ts:864`(`commander.version` 조건, `buildProgram` :880이 `.version()`을 부르지 않아 도달 불가), `apps/cli/src/commands/setup-run.ts:72,113-125`(`--connect` → 설치기 플래그), `apps/cli/src/install.ts:123-142`(`Cancelled` → `SETUP_CANCELLED`, `runInstallerWithFlags`로 프롬프트 주입 가능).
- 테스트 명령: `pnpm test`(build → typecheck → vitest, Postgres는 Docker). lint 스크립트는 없다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/second_brain/src/{index,postgres}.ts`, `packages/second_brain/package.json` -- Postgres 재export를 `./postgres` 하위 경로로 -- hook 경로가 `pg`를 싣지 않게(G2)
- [x] `packages/second_brain/test/import-side-effects.test.ts` -- 루트 `second_brain` import와 `bin.js --help` 자식 프로세스가 `pg`를 싣지 않음, `second_brain/postgres`가 `postgresStore`·`runMigrations`·`SCHEMA_VERSION`을 냄 -- 회귀 방지
- [x] `packages/core/src/error-text.ts`(새), `packages/core/src/index.ts`, 위 5+3개 소비자 -- `errorLine(error)`(옛 `oneLine(error)`)과 `describeError(error)`(옛 3벌 `describe`)를 core에서 내보내고 소비자는 그것을 쓴다; 새 이름이 다른 패키지 export와 겹치지 않게 -- G4
- [x] `apps/cli/src/error-text.ts`(새), `install/installed.ts`, `doctor/checks.ts`, `runtime/spool.ts` -- 첫 줄 trim `describe` 2벌과 문자열 `oneLine` 3벌을 CLI 한 곳으로 -- G4
- [x] `packages/core/test/error-text.test.ts`, `apps/cli/test/error-text.test.ts`(새) -- 매트릭스의 입력 표로 옛 동작과 같은 결과를 단정 -- 동작 보존 증거
- [x] `apps/cli/src/runtime/node-floor.ts`, `apps/cli/src/doctor/checks.ts` -- 버전 세 마디 파서를 node-floor에서 내보내고 doctor의 사본을 지운다 -- G4
- [x] `apps/cli/test/temp-home.ts`(새)와 위 CLI 테스트 파일들 -- 추적하는 임시 폴더 할당기와 정리 하나로 바꾼다; 설정 쓰기·마이그레이션·자식 env는 각 테스트에 남긴다; 모듈 전역 등록부는 두지 않는다 -- Action 9c
- [x] `apps/cli/src/dispatch.ts`, `apps/cli/test/dispatch.test.ts` -- 도달할 수 없는 `commander.version` 조건을 지우고 `--version`이 USAGE·exit 2·home 무변경임을 단정 -- F12
- [x] `apps/cli/test/setup-run.test.ts`(새, 필요하면 `setup-run.ts`의 매핑을 좁은 이름으로 export) -- `--connect` 하나·여럿·없음이 설치기 플래그로 가는 모양 -- F12
- [x] `apps/cli/test/install.test.ts` -- `runInstallerWithFlags`에 `Cancelled`를 던지는 프롬프트를 주입해 `SETUP_CANCELLED`, 다른 오류는 다시 던짐 -- F12
- [x] `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`(패키지 표 35행·AD-2) -- 복제 대상 Postgres는 `second_brain/postgres` 하위 경로로 쓴다는 한 문장 -- 문서 일치
- [x] `_bmad-output/personal-brain/deferred-work.md` -- 끝에 두 항목 append: `brain --version` 기능(버전의 의미 결정 필요), dispatch가 Core에 모듈 harness 등록부를 넘기는 것(2.2 리뷰 #6, 테스트용 등록부 주입 seam) -- 범위 밖 기록

**Acceptance Criteria:**
- Given 새 빌드, when `pnpm test`, then build·typecheck·vitest(Postgres 포함)와 `boundaries.test.ts`가 모두 통과한다.
- Given 새 빌드와 임시 home, when hook 경로 `sessions ingest claude-code`를 20번 잰다, then 프로세스가 `pg`를 싣지 않고 중앙값이 플랜에 baseline(같은 방법 97.8~107.2ms)과 함께 기록된다.
- Given 바뀐 헬퍼 소비자, when 기존 테스트 전체를 돌린다, then 기존 단정(오류 문구·doctor 줄·failures 메시지)을 고치지 않고 통과한다.
- Given 에픽 Done when 1~8, when 각 항목을 다시 돈다, then 모두 통과하고 항목별 증거(테스트 파일·실측)가 Implementation Notes에 남는다.

## Implementation Notes

Implemented the refactor sweep without changing dependencies, the lockfile, plugin refs, or committing. The plan was read in full before implementation; its `context: []` names no additional files.

Changes:
- Moved the Postgres re-export from the root bundle to `second_brain/postgres`, with declaration and runtime export paths. Added child-process tests proving root import, CLI help, and hook entry do not load `pg`; the Postgres subpath exports identical `postgresStore`, `runMigrations`, and `SCHEMA_VERSION` values, with a positive cache control proving that subpath does load `pg`.
- Added core `errorLine` and `describeError`, replaced the five error-first-line copies and three full-message description copies. SQLite keeps its internal `describe` export as an alias so all adapter consumers share the same function without changing their API.
- Added CLI `oneLine` and `describeErrorLine`, replaced two trimmed descriptions and three string-line helpers. The spool-specific non-Error behavior, transcript-folder and Postgres variants, value printers, and crash stack output remain as specified. New core and CLI tables cover empty and multiline messages, code/name fallback, nullish and non-Error inputs, whitespace, and Korean fallback text. No existing output assertions were changed.
- Exported the existing three-number parser as `versionParts` from node-floor, moved the normalization wrapper there, and removed doctor's duplicate parser. Bootstrap's standalone parser remains unchanged.
- Added `tempHomes()` with a closure-owned allocation registry and explicit cleanup, and migrated all 13 named CLI test files. Configuration, migration setup, and child environments remain in their owning tests; shim's extra fake-node and fake-nvm directories also use the allocator.
- Removed only the unreachable Commander version-success branch. Added a regression asserting `--version --json` yields USAGE / exit 2 and leaves a pre-existing home sentinel and directory listing unchanged.
- Exported the narrow `setupRunFlags` mapping seam and tested absent, single, multiple/repeated, and filtered connect values plus other flags. Injected prompts throwing `Cancelled` or a distinct Error into `runInstallerWithFlags`, asserting the complete cancellation failure and identity-preserving rethrow respectively.
- Updated the architecture package table and AD-2 to name the Postgres subpath. Appended the two required deferred items.

Verification:
- `pnpm test`: build and typecheck succeeded; Vitest stopped in Postgres global setup because Docker is unavailable. No Postgres tests were skipped or altered in source.
- `pnpm build && pnpm typecheck`: passed again after implementation cleanup.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code`: **70 files, 2,231 tests passed**, 61.24 s. The first sandboxed attempt could not open the existing AD-3 localhost listener; the same project selection was rerun outside the sandbox and passed in full.
- `pnpm exec vitest run --project second_brain test/boundaries.test.ts`: **8 tests passed**, 74 ms.
- `git diff --check`: passed. Checking added diff lines against `d7fa300` found zero absolute home paths. New files were also inspected for this policy.

Hook measurement:
- Fresh build; isolated `SECOND_BRAIN_HOME` and `CLAUDE_CONFIG_DIR`; `setup run --yes --json`; copied `two-turns.jsonl` into the temporary Claude projects/measure folder; fed a Stop payload to `sessions ingest claude-code`. The first ingest was checked directly in SQLite: **1 session / 4 messages**. Then measured 20 unchanged-transcript invocations with synchronous child processes and a monotonic timer.
- Median **103.47 ms**, range **97.40–108.06 ms**. Plan baseline at `d7fa300`: **107.2 ms and 97.8 ms** (same method). This result overlaps the baseline range and does not establish a wall-clock speedup; removing `pg` loading is independently proven by the module-cache probe and regression tests.
- A separate instrumented invocation on the installed home confirmed **pgLoaded=false** without adding instrumentation to timed invocations. Raw timings and reproduction script are `/tmp/brain-2-15/measurement.json` and `/tmp/brain-2-15/measure.mjs`; all measurement homes were removed afterward.

Epic Done when evidence (all named test files passed in the selected project run):

| Item | Evidence / remaining ownership |
| --- | --- |
| 1: local transcript/session inventory | Coordinator-owned read-only machine inventory, as explicitly assigned in the plan; not performed by this worker. |
| 2: repeat/concurrent ingest | `apps/cli/test/sessions-ingest.test.ts`: adds nothing on second payload; two simultaneous processes insert each message once; same-session first ingests overlap. |
| 3: kill recovery, spool, first-session creation | `apps/cli/test/capture-scan.test.ts` kills a child and recovers through scan; `sessions-ingest.test.ts` covers lock-budget and schema-mismatch spool paths; `spool.test.ts` kills a claim owner and reclaims it; `packages/core/test/spool-replay.test.ts` and `brain-drain.test.ts` cover replay; ingest tests assert no session for a transcript without conversation. |
| 4: raw persistence / masked output / redact | `apps/cli/test/sessions-ingest.test.ts` raw secret bodies and targets; `output-codecs.test.ts` and `packages/core/test/output-codecs.test.ts` mask sinks; `apps/cli/test/messages-redact.test.ts` plus SQLite redact contracts cover persisted removal. |
| 5: project identity / recovery / deleted checkout | `apps/cli/test/sessions-ingest.test.ts` two worktrees, SSH/HTTPS identity, outside-repo and deferred tag recovery; `packages/core/test/project-identity.test.ts`, `checkout-estimate.test.ts`, and `session-identity-work.test.ts` cover case normalization and sibling evidence. |
| 6: plugin/bootstrap/doctor | `tooling/bootstrap/test/plugin.test.ts`, `hook.test.ts`, and `bootstrap.test.ts` cover hook wiring, concurrent locks, fast-forward/build and older-ref behavior; `apps/cli/test/setup.test.ts` plugin connection cleanup; `doctor-checks.test.ts`, `doctor-run.test.ts`, and `capture-scan.test.ts` cover plugin/build relation, capture status, spool and last-hook evidence. |
| 7: compact / claim / retry / failures | `apps/cli/test/sessions-ingest.test.ts` whole-session cursor reset retains prior conversation; `packages/sqlite/test/work-store.test.ts` two-process claims; `packages/core/test/queue-drain.test.ts` retry policies, exhaustion and permanent failure; `packages/core/test/failures.test.ts` retry as new work and claim ownership contracts. |
| 8: schema/meta/confirmation/writable/language | `apps/cli/test/guide.test.ts`, `command-meta.test.ts`, `messages-redact.test.ts`, `doctor-run.test.ts`, and `output-language.test.ts` cover these cases; existing assertions passed unchanged. |

Remaining validation / risk:
- Coordinator must rerun the full suite with Docker/Postgres and perform Done when 1 against the actual machine inventory. Those two checks cannot be claimed complete from this worker's run.
- The root bundle intentionally no longer exports Postgres names; explicit consumers must use `second_brain/postgres`, as required by the plan. No root or CLI consumer of those names was found.
- Timing noise is comparable to the observed change, so the report makes no performance-speedup claim beyond proving `pg` is absent from the local hook process.


## Plan Change Log

## Review Triage Log

### 2026-10-22 — Review pass
- verdicts: 2 findings — high 0, medium 0, low 0, false 2, maybe-false 0
- findings:
  - `[false]` `[reject]` 플랜 Implementation Notes에 Postgres를 포함한 `pnpm test` 통과가 없다(워커 샌드박스에 Docker가 없어 6개 프로젝트만 돌림) — 코디네이터가 Docker가 있는 메인 세션에서 `pnpm test`를 돌렸고 build·typecheck·vitest 74파일 2,322건(Postgres·boundaries 포함)이 통과했다(리뷰 전과 패치 뒤 두 번). 고치는 일이 이 플랜을 고치는 것뿐이라 기각.
  - `[false]` `[reject]` Done when 1(이 기계의 transcript와 Brain 세션 대조)의 결과가 없다 — 코디네이터가 읽기 전용으로 대조했다: 메인 transcript 284개 중 Brain에 없던 것은 4개였고, 둘은 대화 줄이 없는 파일(세션을 만들지 않는 것이 규칙), 하나는 아직 첫 턴이 끝나지 않은 이 세션, 하나는 10:42에 생긴 SDK 세션으로 그 뒤 drain이 한 번도 돌지 않았다. 설치된 brain의 `queue drain`을 한 번 돌리자 그 세션이 수집됐고, 남은 차이는 대화 없는 2개뿐이다. 고치는 일이 이 플랜을 고치는 것뿐이라 기각.
- 코디네이터 diff 읽기(렌즈 밖, 같은 패스): 새 import가 파일 맨 위(`node:` import 앞)에 붙어 저장소 순서(node → 패키지 → 상대 경로)를 어겼고, `second_brain`을 두 문장으로 import한 파일(`runtime/transcript.ts`, `install/store.ts`, `config/codec.ts`, `dispatch.ts`)과 `import { readFile, }`의 남은 쉼표(테스트 두 파일)가 있었다. 동작과 무관한 low지만 고치는 일이 줄 이동·삭제뿐이라 patch했다. 구현 워커는 dispatch가 끝나 다시 일을 받을 수 없어서(Orca: 끝난 dispatch의 우편함은 읽히지 않음) 코디네이터가 직접 고쳤고, `pnpm test`를 다시 돌려 통과했다.

## Design Notes

**범위를 고른 근거(2026-10-22 조사).** sweep 후보: G2, G4(오류 헬퍼·버전 파서), Action 9c, F12 셋, hook 지연 측정. 이미 해결: BUSY_TIMEOUT 단정(`dispatch.test.ts:1455-1471`), 설정 부분 읽기·모르는 키(2.4), node 하한(2.5), 동시성 테스트 SyntaxError(지금은 exit 단정이 먼저). 동작 변경이라 뺀 것: Never 목록.

**`--version`.** 기능을 더하는 대신 죽은 조건만 지운다. 무엇을 낼지(앱 `0.0.0`, 빌드 commit, 릴리스)는 정해지지 않았고 이 스토리는 정리만 한다.

**하위 경로.** `second_brain/postgres`는 같은 패키지의 다른 입구라 AD-2의 "쓰는 표면은 `second_brain` 하나"를 지킨다. 동적 import는 동기 named export를 깨므로 쓰지 않는다.

**hook 지연 재는 법(baseline).** `SECOND_BRAIN_HOME`·`CLAUDE_CONFIG_DIR`를 임시 폴더로, `setup run --yes --json`, `packages/claude-code/test/fixtures/two-turns.jsonl`을 `<claude>/projects/measure/`에 복사, Stop payload(`session_id`, `transcript_path`, `hook_event_name: Stop`, `cwd`)를 stdin으로 `node apps/cli/dist/bin.js sessions ingest claude-code`를 첫 회(수집) 뒤 20회(증분 없음) 잰다. baseline `d7fa300`: 두 번 잰 중앙값 107.2ms, 97.8ms(첫 회 수집 1세션·4메시지 확인).

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 포함, Docker 필요)
- `pnpm exec vitest run --project second_brain test/boundaries.test.ts` -- expected: 통과
- `git diff --check`와 `git diff d7fa300 -- . | grep -E "^\+.*/Users/"` -- expected: 공백 오류 없음, 새 절대 홈 경로 없음

**Manual checks (if no CLI):**
- hook 지연: Design Notes의 방법으로 새 빌드를 20회 재고 중앙값을 baseline 옆에 적는다.
- Done when 1(코디네이터, 읽기만): 이 기계 `~/.claude/projects` 아래 메인 transcript의 세션 id가 모두 `~/.second_brain/brain.db`의 `sessions`에 있다.
- Done when 2~8: 각 항목을 덮는 테스트 파일·사례를 적고, 그 테스트가 위 `pnpm test`에서 통과했음을 확인한다.

## Auto Run Result

Status: built

**바뀐 것.**
- `second_brain` 루트가 `@second-brain/postgres`를 재export하지 않는다. 복제 대상 Postgres는 새 하위 경로 `second_brain/postgres`로 쓴다(AD-2 문장과 패키지 표 갱신). 그래서 hook 경로를 포함한 CLI 프로세스가 `pg`를 싣지 않는다.
- 같은 동작의 오류 문자열 헬퍼를 모았다: core `errorLine`(옛 `oneLine(error)` 5벌)과 `describeError`(옛 `describe` 3벌, sqlite는 `describe` 이름을 별칭으로 유지), CLI `apps/cli/src/error-text.ts`의 `describeErrorLine`(첫 줄 trim `describe` 2벌)과 `oneLine(text)`(3벌). 의도적으로 다른 변형(spool·transcript-folder·Postgres·값 표시·crash 출력)은 그대로다.
- doctor의 node 버전 파서 사본을 지우고 `runtime/node-floor.ts`의 `versionParts`·`parseVersion`을 쓴다(bootstrap 사본은 그대로).
- CLI 테스트 13개 파일이 `apps/cli/test/temp-home.ts`의 `tempHomes()`(파일마다 하나, 명시적 정리)로 임시 폴더를 만든다.
- F12: `dispatch.ts`의 도달할 수 없는 `commander.version` 조건을 지우고 `brain --version`이 USAGE·exit 2·home 무변경임을 테스트로 고정했다. `setup run --connect` 매핑(`setupRunFlags`로 export)과 설치기 `Cancelled` 분기 테스트를 더했다.
- deferred-work에 범위 밖 두 항목(`brain --version` 기능, dispatch의 harness 등록부 주입 seam)을 append했다.

**파일.**
- `packages/second_brain/src/{index,postgres}.ts`, `package.json`, `test/import-side-effects.test.ts` — 하위 경로, `pg` 미적재·같은 값 테스트
- `packages/core/src/error-text.ts`(새), `index.ts`, `doctor/doctor.ts`, `domain/spool-record.ts`, `queue/drain.ts`, `test/error-text.test.ts`(새) — core 헬퍼
- `packages/sqlite/src/connect.ts` — `describe`를 core 함수의 별칭으로
- `apps/cli/src/error-text.ts`(새), `config/codec.ts`, `dispatch.ts`, `doctor/checks.ts`, `install/{installed,store}.ts`, `runtime/{node-floor,spool,transcript}.ts`, `commands/setup-run.ts` — CLI 헬퍼, 버전 파서, 죽은 조건, 매핑 export
- `apps/cli/test/temp-home.ts`(새), `error-text.test.ts`·`setup-run.test.ts`(새), 13개 테스트 파일 — 임시 폴더 헬퍼와 F12 테스트
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `deferred-work.md`

**리뷰.** quick 렌즈 1회(codex, Orca run `run_ed2adfe48442`). 지적 2건: patch 0, defer 0, reject 2(둘 다 false — 리뷰 시점의 플랜에 Postgres 포함 전체 테스트와 Done when 1 결과가 없었다는 것, 코디네이터가 둘 다 돌려 통과). 코디네이터 diff 읽기로 import 위치·중복 import·남은 쉼표를 직접 고쳤다(low, 동작 무관).

**후속 리뷰 권고:** `false`. 렌즈 지적 중 patch한 항목이 없다(high 0, medium 0, low 0). 코디네이터가 고친 것은 import 줄 이동뿐이다.

**검증.**
- `pnpm test`(build·typecheck·vitest, Postgres·boundaries 포함): 74파일 2,322건 통과(메인 세션, 패치 전과 뒤 두 번). `git diff --check` 통과, 새 diff에 절대 홈 경로 없음.
- 매트릭스 6행 모두 실행된 테스트가 덮는다: `import-side-effects.test.ts`(root·help·hook이 `pg`를 싣지 않음, 하위 경로가 같은 값), `packages/core/test/error-text.test.ts`·`apps/cli/test/error-text.test.ts`, `dispatch.test.ts`(`--version`), `setup-run.test.ts`, `install.test.ts`(취소·다른 오류).
- hook 지연(Design Notes의 방법, 20회): 새 빌드 중앙값 93.1ms, 93.4ms(구현 워커 103.5ms) — baseline `d7fa300` 107.2ms, 97.8ms. 잡음 폭과 비슷해 속도 향상을 단정하지 않는다. `pg` 미적재는 테스트가 증명한다.
- 에픽 Done when 1~8: 1은 코디네이터 실측(위 Review Triage Log, 이 기계 메인 transcript 284개 중 대화가 있는 것은 모두 Brain에 있음; 그 과정에서 설치된 brain의 `queue drain`을 한 번 돌려 SDK 세션 하나를 수집함). 2~8은 Implementation Notes의 표에 적은 테스트 파일이 위 `pnpm test`에서 통과했다.

**남은 위험.**
- 루트 `second_brain`에서 Postgres 이름을 받던 외부 코드가 있다면 `second_brain/postgres`로 옮겨야 한다. 저장소 안에는 없다(epic 7이 쓸 때 하위 경로로).
- 이 기계에서 10:42에 생긴 SDK 세션은 hook이 아닌 다음 drain에서야 수집된다(설계대로: hook이 없는 세션은 폴더 스캔이 줍는다). 이번 sweep과 무관하다.
