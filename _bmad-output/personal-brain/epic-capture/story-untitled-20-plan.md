---
title: '정체성 보강: 대소문자 비교 키와 비어 있는 꼬리표 다시 채우기'
type: 'feature'
ticket: '20'
created: '2026-10-21'
status: done
baseline_revision: '24d1291886607db49e392142ee3f643347db16a2'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 프로젝트 비교 키는 SQLite 식(`PROJECT_IDENTITY_KEY_SQL`)에만 있고 Core 함수·호스트 상수·포트 입력이 없어 가짜 store는 대소문자만 다른 GitHub remote를 두 프로젝트로 만든다. 그리고 `RepositoryInspector.inspect`가 "레포 아님"과 "git이 답을 못 함"을 같은 `null`로 돌려줘, git이 잠깐 없거나 느렸던 세션은 영원히 꼬리표가 없다(2.8 Decision 1, change D7·D8, AD-12).

**Approach:** Core에 호스트 상수와 비교 키 함수를 두고 그 값을 `EnsureCheckoutInput.identityKey`로 넘겨 두 Store가 그것으로 찾거나 만들게 한다. inspect 결과를 checkout·레포 아님·모름 셋으로 나누고, 모름이면 세션을 만드는 같은 트랜잭션에서 `session_identity` 일감을 연다. Core 소유 handler가 그 일감에서 transcript를 토큰으로 다시 읽어 첫 cwd로 다시 묻고, 성공하면 새 Store 동사가 비어 있던 꼬리표를 한 번 채운다.

## Boundaries & Constraints

**Always:**
- **비교 키(Core, `domain/project-identity.ts`).** `CASE_INSENSITIVE_HOSTS = ['github.com', 'bitbucket.org']`, `projectIdentityKey(identity)`: 정체성을 ASCII만 소문자로 접은 값이 `<목록의 host>/`로 시작하면 그 접은 값, 아니면 정체성 그대로(다른 호스트, `/`로 시작하는 공통 디렉터리). ASCII만 접는 것은 0005와 `project-keys.ts`의 SQLite `lower()`와 같은 값을 내기 위해서다. `PROJECT_IDENTITY_KEY_SQL`은 이 상수로 만든다(0005 파일은 그대로). Core 함수와 SQL 식이 표본 표에서 같은 값임을 SQLite 테스트가 단정한다.
- **포트 입력.** `EnsureCheckoutInput.identityKey: string`(호출자가 `projectIdentityKey(remoteIdentity)`로 채움). SQLite `ensureCheckout`은 SQL로 계산하지 않고 이 값을 bind해 `identity_key`로 찾거나 만든다. 가짜 store도 `identityKey`로 키잉한다. 표시용 `remote_identity`는 그 키를 처음 만든 호출의 값이다. 포트 주석의 "story 20에서 맞춘다" 문단을 지금 사실로 고친다.
- **inspect 결과 셋.** `RepositoryInspector.inspect(cwd): Promise<InspectResult>`, `InspectResult = {kind: 'checkout', checkout} | {kind: 'not_repository'} | {kind: 'unknown', reason: 'git_missing' | 'timeout' | 'permission' | 'unexpected', message}`. 던지지 않는다. CLI 구현(`runtime/git.ts`)의 판정:
  - 절대 경로가 아님, cwd가 없음(ENOENT·ENOTDIR), 디렉터리가 아님 → `not_repository`. cwd 권한 거부(EACCES·EPERM) → `unknown/permission`.
  - git을 실행할 수 없음(spawn ENOENT) → `git_missing`. 시간 초과(2초, killed) → `timeout`.
  - 0이 아닌 종료: stderr에 `not a git repository` 또는 `must be run in a work tree`(bare) → `not_repository`. `dubious ownership`·`Permission denied` → `permission`. 그 밖 → `unexpected`. stderr를 읽으므로 git 호출 env에 `LC_ALL=C`(와 `LANGUAGE` 제거)를 더한다.
  - rev-parse 성공인데 두 줄이 안 됨 → `unexpected`. 뒤의 `git remote`·`remote get-url`이 실패하면 같은 분류로 `unknown`이다(공통 디렉터리로 대신하지 않는다 — 그 답은 틀린 영구 정체성이다). remote가 없는 레포는 지금처럼 `remoteUrl: null`인 checkout.
  - 테스트용 seam `gitRepositoryInspector({command?, timeoutMs?})`(기본 `'git'`, 2000).
- **수집(ingest).** inspect는 지금처럼 `stored === null`이고 메시지가 있을 때만, cwd가 있는 첫 메시지의 cwd로 부른다. `checkout` → checkout 입력. `not_repository`·cwd 없음 → `checkout: null`, 일감 없음. `unknown` → `checkout: null`이고 `EnsureSessionInput.identityWork: AddWorkInput`(kind `session_identity`, target `session`/세션 토큰, `createdAt`·`nextAttemptAt` = 이 배치의 `ingestedAt`, 새 id). 그 밖의 호출은 `identityWork: null`. 새 경고 코드는 없다.
- **`ensureSession`(두 Store).** `identityWork`가 있고 **이 호출이 세션 행을 만들 때만** 같은 쓰기 트랜잭션에서 그 일감을 연다(`addWork`와 같은 find-or-create 규칙: 열린 키가 있으면 그대로). 세션이 이미 있으면 아무것도 만들지 않는다. 실패는 지금처럼 롤백된다.
- **새 Store 동사 `fillSessionTags({key, checkout: EnsureCheckoutInput})`(SessionStore).** 한 `withWrite`: 세션 없음 → `SESSION_NOT_FOUND`. `project_id`나 `worktree_id`가 있으면 → `{ok: true, filled: false, session}`이고 아무 행도 만들지 않는다. 둘 다 null이면 `ensureCheckout`과 같은 find-or-create로 프로젝트·워크트리를 정하고 `update sessions … where id = ? and project_id is null and worktree_id is null` → `{filled: true, session}`. 결과는 값(`DB_UNAVAILABLE`·`DB_LOCKED`). 계약 사례로 두 Store를 묶는다.
- **일감 종류 `session_identity`(Core 소유, `createBrain`의 `coreHandlers`).** handler 순서:
  1. 토큰 → `findSession`. 읽기 실패는 그 코드(drain이 돌려주기). 세션 없음 → `{ok: true}`(채울 것이 없음). 꼬리표가 이미 있음 → `{ok: true}`, 바꾸지 않음.
  2. 12의 토큰 경로로 transcript를 찾고(`transcriptFolders`, `locateTranscript` 재사용) 읽고 처음부터 parse한다(커서 null). `TRANSCRIPT_UNREADABLE`은 `retryable: false`, parser 없음은 `USAGE`(코드 그대로, `session_ingest`와 같다).
  3. cwd가 있는 첫 메시지가 없으면 `{ok: true}`(물을 근거가 없음).
  4. inspect: `checkout` → `fillSessionTags`(실패는 그 코드) → 성공. `not_repository` → 성공(일감을 닫음). `unknown` → `{ok: false, code: REPOSITORY_UNANSWERED, message: 한국어로 이유}`(Core 상수, 코드 표 밖, `retryable` 없음 → 모르는 오류의 지수 간격, 10번째에 `failures`).
  5. 성공한 모든 갈래에서 `resolveFailures({targetKind: 'session', targetId, stage: 'session_identity'})`(실패는 버림). 실패의 정보 칸 `harness`·`sessionId`는 `session_ingest`의 `about`과 같게 채운다.
  - 정책은 기본값(덮어쓰기 표에 넣지 않음).
- **다시 하기.** `failures retry`는 실패 행의 `stage`가 아는 일감 종류(`session_ingest`·`session_identity`)면 그 종류를, 아니면 지금처럼 대상 종류 표(`session` → `session_ingest`)를 쓴다. 중복 제거는 (종류, 대상)이다. 표 밖은 지금처럼 `skipped`.
- 사람이 읽는 새 문장은 한국어다(출력 언어 검사). 주석은 영어로 *왜*를. fixture·remote는 중립(`demo.example`, `github.com/brain-owner/…`). 테스트는 임시 home·임시 레포·빈/임시 `CLAUDE_CONFIG_DIR`만 쓴다.
- Decision(2026-10-21, 무인 실행에서 에이전트가 고름):
  1. 일감은 세션 행을 만드는 `ensureSession` 트랜잭션 안에서 연다. 다른 안: ensure 뒤 따로 `addWork`(그 쓰기가 잠금에 막히면 꼬리표가 영원히 빈다).
  2. 없어진 cwd는 `not_repository`다(2.8과 같음, 다시 물어도 같은 답). 권한 거부만 `unknown`.
  3. remote 조회가 실패하면 `unknown`이다. 2.8은 공통 디렉터리로 대신했으나 그것은 틀린 정체성을 영구히 붙인다.
  4. 세션이 없거나 cwd 근거가 없으면 일감을 성공으로 닫는다(실패 기록 없음).
  5. `failures retry`는 단계가 아는 종류면 그 종류로 다시 한다(대상 종류 표는 대비책).
  6. 비교 키는 ASCII만 접는다(SQLite `lower()`와 같은 값).

**Never:**
- 마이그레이션·스키마 변경, 0001~0006 파일 수정, 기존 꼬리표 바꾸기(null → 값만), 프로젝트·워크트리 행 지우기나 고치기.
- 수집 hook 켜기·`SECOND_BRAIN_CAPTURE` 스위치 제거(14), `messages redact`(13), Postgres(epic 7), 코드 표에 새 오류·경고 코드.
- 셸을 거치는 git, 네트워크 git 명령, 프로세스 cwd를 근거로 쓰기, 실제 `~/.claude`·`~/.second_brain`·git 전역 설정 읽기나 바꾸기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 접히는 호스트 | remote `https://github.com/Owner/Repo.git`인 세션 다음 `git@github.com:owner/repo.git`인 세션 | 프로젝트 1, `remote_identity`=`github.com/Owner/Repo`, `identity_key`=`github.com/owner/repo` | — |
| 안 접히는 호스트 | `demo.example/Owner/Repo`와 `demo.example/owner/repo` | 프로젝트 2 | — |
| 공통 디렉터리 | remote 없는 레포 | 키 = 경로 그대로 | — |
| git 없음 | PATH에 git 없이 hook 수집 | 세션 수집, 꼬리표 null, 열린 `session_identity` 일감 1 | — |
| 되돌린 뒤 drain | 위 + git 복구, 수집 스위치·`CLAUDE_CONFIG_DIR`, `queue drain` | 꼬리표 채워짐, 일감 완료, 미해결 실패 0 | — |
| 레포 밖 | cwd가 레포 아닌 폴더·없는 경로 | 꼬리표 null, 일감 없음 | — |
| 꼬리표 있음 | 꼬리표 있는 세션에 `session_identity` 일감 | 꼬리표·`projects`·`worktrees` 그대로, 일감 완료 | — |
| 계속 모름 | handler의 inspect가 매번 `unknown` | 1~9번 다시 시도, 10번째 `failures`(stage `session_identity`) 한 행; `failures retry`가 `session_identity` 일감을 다시 넣음 | — |
| 일감 중 레포 아님 | 일감 처리 때 cwd가 레포가 아님 | 성공으로 닫힘, 꼬리표 null | — |
| transcript 없음 | 토큰으로 파일을 못 찾음 | 첫 시도에서 `failures`(`TRANSCRIPT_UNREADABLE`) | — |
| 겹친 생성 | 같은 세션 첫 수집 둘, 둘 다 `unknown` | 세션 1, 열린 일감 1 | — |
| 분류 | git 실행 불가 / 느린 git / 비정상 출력 / bare / 권한 없는 폴더 | `git_missing` / `timeout` / `unexpected` / `not_repository` / `permission` | — |

</intent-contract>

## Code Map

- `packages/core/src/domain/project-identity.ts` -- `CASE_INSENSITIVE_HOSTS`, `projectIdentityKey` 추가(같은 파일, `domain/index.ts`가 이미 export하는지 확인). 테스트 `packages/core/test/project-identity.test.ts`.
- `packages/core/src/ports/repository.ts` -- `InspectResult`·`InspectUnknownReason` 타입, `inspect` 반환형과 주석. `ports/index.ts` export.
- `packages/core/src/ports/store.ts` -- `EnsureCheckoutInput.identityKey`(89행~), `EnsureSessionInput.identityWork: AddWorkInput | null`(101행~), `SessionStore.fillSessionTags`와 입력·결과 타입, 199~228행 주석 고침. `AddWorkInput`은 335행에 있다.
- `packages/core/src/sessions/ingest.ts` -- `checkoutFor`(592행)가 inspect 결과를 셋으로 다루고 `{checkout, unknown}`을 돌려준다. ensure 호출(413행)에 `identityWork`. `locateTranscript`(501행)·`firstCwd`(624행)와 checkout 입력 만들기를 새 handler가 쓰게 export하거나 작은 모듈로 뺀다(복붙 금지). 머리 주석의 순서·Decision 2026-10-18 문단을 새 규칙으로.
- 새 `packages/core/src/capture/session-identity-work.ts` -- `SESSION_IDENTITY_KIND = 'session_identity'`, `REPOSITORY_UNANSWERED`, handler 팩토리(deps: `findSession`·`fillSessionTags`·`resolveFailures`, parsers, transcripts, transcriptFolders, repositories, clock, idGen). 본보기 `capture/session-ingest-work.ts`(PERMANENT_CODES, `about`).
- `packages/core/src/capture/session-ingest-work.ts` -- `FAILURE_RETRY_KINDS` 주석·모양(단계 표 + 대상 종류 표, Always "다시 하기"). `packages/core/src/failures/retry.ts` -- 종류 고르기와 (종류, 대상) 중복 제거.
- `packages/core/src/brain.ts` -- `coreHandlers`(199행)에 `session_identity`. `packages/core/src/index.ts` export.
- `packages/core/src/testing/fakes/repository.ts` -- 맵 값이 `InspectResult`도 받게(기존 `Checkout` 값은 `checkout`으로 감싸기, 없는 cwd는 `not_repository`), 호출 수 유지. 답을 바꿀 수 있게(첫 수집은 `unknown`, 다음은 checkout) 하는 방법 하나.
- `packages/core/src/testing/fakes/store.ts` -- `ensureSession`(223행) `identityKey` 키잉과 `identityWork`(같은 단계에서 `addWork` 규칙), `fillSessionTags`.
- `packages/core/src/testing/fixtures.ts` -- `sampleCheckoutInput`에 `identityKey`, `sampleEnsureSessionInput`에 `identityWork: null`.
- `packages/core/src/testing/contracts/session-store.ts` -- 새 사례: 키가 같은 다른 `remoteIdentity` 두 세션 → 같은 프로젝트(표시는 첫 값은 SQLite 테스트에서 select로); `identityWork`는 만들 때만 열림(이미 있는 세션이면 안 열림, `listOpenWorkTargets`로 확인); `fillSessionTags` 빈 세션 채움·이미 있으면 그대로이고 행 안 만듦·없는 세션 `SESSION_NOT_FOUND`. Store 타입이 `WorkStore`를 못 보면 계약 subject 타입을 넓힌다. `packages/core/test/contracts.test.ts`에 음성 가짜 둘(꼬리표 있는 세션을 덮어쓰는 fill, 이미 있는 세션에도 일감을 여는 ensure).
- `packages/core/test/{sessions-ingest,capture-scan,brain-drain,failures,doctor}.test.ts` -- 새 inspect 모양 반영. ingest 사례(셋 갈래와 일감), 새 `packages/core/test/session-identity-work.test.ts`(매트릭스 Core 행: 꼬리표 있음, 일감 중 레포 아님, 계속 모름 10번, transcript 없음, cwd 없음, 세션 없음, retry가 `session_identity`를 넣음).
- `packages/sqlite/src/project-keys.ts` -- `PROJECT_IDENTITY_KEY_SQL`을 Core 상수로 만든다(주석 고침). `packages/sqlite/src/sessions.ts` -- `ensureCheckout`(495행) bind `checkout.identityKey`, `ensureSession`(132행) `identityWork`(work 행 insert는 `work.ts`의 것과 같은 SQL 규칙; 공유 helper를 쓰고 `withWrite` 안에서는 `held`만), `fillSessionTags`. 테스트 `packages/sqlite/test/session-store.test.ts`(계약 실행, `remote_identity` 첫 값, Core 함수 = SQL 식 표본 표).
- `apps/cli/src/runtime/git.ts` -- 분류와 seam. `apps/cli/test/runtime.test.ts` 224행 describe의 null 단정을 새 결과로, 분류 사례(없는 명령, `sleep`하는 가짜 git 스크립트 + 작은 timeout, 쓰레기를 찍는 가짜 git, bare, `chmod 000` 폴더 — root가 아니면).
- `apps/cli/test/sessions-ingest.test.ts` 1746행 describe(`git` helper, `repositoryIn`) -- CLI verify: 접히는/안 접히는 호스트(`sqlite3`로 projects), git 없음(PATH를 node만 링크한 임시 bin 폴더로 — node 옆에 git이 있을 수 있으므로 `dirname(node)`를 쓰지 않는다) → 일감 열림 → git 복구 + `SECOND_BRAIN_CAPTURE=1` + transcript를 둔 임시 `CLAUDE_CONFIG_DIR/projects/<폴더>/<id>.jsonl`로 `queue drain` → 꼬리표 채워짐, 레포 밖 → 일감 없음, 꼬리표 있는 세션에 일감을 직접 넣고 drain → 그대로. `environment.ts`의 격리 규칙을 지킨다.
- `README.md` -- `## 밀린 일 처리`(361~368행 "일감 종류는 하나"), 실패 다시 하기(431~433행), 프로젝트 꼬리표 설명 절의 git 실패 문단. `_bmad-output/personal-brain/deferred-work.md` 143행 항목 닫기. architecture는 AD-12·Table Contract가 이미 이 규칙을 적었으니 AD-21 일감 종류 목록 등 어긋난 곳만.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/project-identity.ts`, `ports/{repository,store,index}.ts`, `testing/fixtures.ts` -- 키 함수·상수, 포트 모양 -- 규칙을 Core 한 곳에.
- [x] `packages/core/src/testing/{fakes/repository,fakes/store,contracts/session-store}.ts`, `packages/core/test/contracts.test.ts` -- 가짜·계약·음성 가짜.
- [x] `packages/core/src/sessions/ingest.ts`, `capture/{session-identity-work,session-ingest-work}.ts`, `failures/retry.ts`, `brain.ts`, `index.ts` -- 세 갈래, 일감, handler, 다시 하기.
- [x] `packages/core/test/*` -- 매트릭스 Core 행과 기존 사례의 새 모양.
- [x] `packages/sqlite/src/{project-keys,sessions}.ts`, `packages/sqlite/test/session-store.test.ts` -- bind 키, 일감, `fillSessionTags`, 식 대조.
- [x] `apps/cli/src/runtime/git.ts`, `apps/cli/test/runtime.test.ts` -- 분류.
- [x] `apps/cli/test/sessions-ingest.test.ts` -- CLI verify 행.
- [x] `README.md`, `deferred-work.md`, architecture(필요한 곳만) -- 문서.

**Acceptance Criteria:**
- Given 임시 home과 remote가 `github.com/Owner/Repo`·`github.com/owner/repo`인 두 임시 레포, when 각 레포 cwd의 transcript를 `brain sessions ingest claude-code --json`으로 넣으면, then `sqlite3`로 본 `projects`가 1행이고 두 세션의 `project_id`가 같다. `demo.example`의 같은 쌍은 2행이다.
- Given git을 찾을 수 없는 PATH로 수집한 세션, when git이 있는 PATH와 수집 스위치·임시 `CLAUDE_CONFIG_DIR`로 `brain queue drain --json`을 부르면, then 그 세션의 `project_id`·`worktree_id`가 채워지고 `session_identity` 일감은 완료이며 `brain failures list --json`이 비었다.
- Given 레포 밖 cwd의 세션, when 수집하면, then `work_items`에 그 세션의 일감이 없다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다(출력 언어 검사·README 코드 대조 포함).

## Implementation Notes

- `context: []`이므로 별도 지정 컨텍스트는 없다. 코디네이터 지시에 따라 계획의 intent-contract는 그대로 보존했고 커밋하지 않았다.
- bmad-build 초기화의 `uv`가 macOS 시스템 설정 패닉으로 실패했다. 코디네이터가 BMad 스킬·renderer 없이 이 계획을 직접 구현하도록 명시적으로 지시했다.
- 최초 수집과 정체성 handler는 `checkoutFor`·`firstCwd`·`locateTranscript`를 공유한다. 두 SQLite 쓰기는 열린 트랜잭션 핸들만 받는 `ensureWork`를 공유하므로 중첩 쓰기 잠금을 만들지 않는다.
- Store 포트 확장에 따라 진단용 `failedConfigStore`와 dispatch 테스트의 Store mock에도 같은 실패 값을 돌려주는 `fillSessionTags`를 추가했다.
- CLI 수용 테스트는 기존 테스트의 `node:sqlite` 직접 조회 방식을 따른다. 실제 임시 SQLite 파일의 프로젝트 수·비교 키·세션 연결·열린 일감·완료 시각을 확인한다.
- CLI의 자식 프로세스와 git fixture는 임시 HOME을 사용하며, git 없는 PATH는 node만 심볼릭 링크한 별도 폴더다. 복구 drain은 임시 `CLAUDE_CONFIG_DIR/projects/`와 수집 스위치로 실행한다.
- 검증: Core·SQLite·CLI 51개 파일의 1,807개 테스트 통과. 전체 `pnpm test`도 build·typecheck·65개 파일의 2,170개 테스트까지 통과했다. Docker 소켓과 Orca 런타임 접근은 샌드박스 밖에서 실행했다.
- 마지막 보완으로 동일 대상의 수집·정체성 실패를 종류별로 다시 넣는 사례, 알 수 없는 단계 이름의 객체 기본 속성 충돌 방지, 레포 밖 CLI 수집의 일감 부재 확인을 추가했다.
- 최종 검증(2026-10-21): `pnpm test` 종료 코드 0 — build·typecheck·65개 파일의 2,173개 테스트 모두 통과(51.12초). `git diff --check` 통과, 마이그레이션 변경 없음, 새로 추가한 코드에 절대 홈 경로 없음. 구현상 미완료 항목은 없다. 트랜스크립트가 이미 삭제되었으면 꼬리표를 복구할 수 없고 첫 시도에서 실패로 남기는 것은 계획대로다.

## Plan Change Log

## Review Triage Log

### 2026-10-21 — Review pass
- 리뷰어: quick 렌즈, Orca orchestration의 codex 워커(사용자 지시), run `run_e76ce0793cd2`.
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` 수집 스위치(`SECOND_BRAIN_CAPTURE`)가 꺼져 transcript 폴더가 없으면 `session_identity` 일감이 첫 시도에서 `TRANSCRIPT_UNREADABLE`(영구)로 닫히므로, 그 사이 기회적 drain이 돌면 git이 돌아와도 `failures retry` 전까지 꼬리표가 빈다 — 재현됨(`capture/session-identity-work.ts`, 폴더 없음 → `locateTranscript` 실패). 하지만 그 상태는 실제 수집이 꺼진 지금의 개발 home에서만 생긴다: 2.14가 수집 hook을 켜며 스위치를 없애므로 그 뒤로는 폴더가 늘 있고, 그 전에는 실제 세션이 수집되지 않는다. 실패는 `failures retry`로 되살아난다. 고치려면 "폴더 없음"을 따로 가려 돌려주는 갈래가 더해진다(`session_ingest`도 같은 동작).

## Design Notes

일감을 세션 생성 트랜잭션에 묶는 이유: 따로 `addWork`하면 그 쓰기만 잠금에 막힌 경우 세션은 꼬리표 없이 남고 그것을 다시 볼 일감이 없다. 생성 트랜잭션 안이면 "꼬리표 없는 세션"과 "그것을 채울 일감"이 함께 생기거나 함께 안 생긴다. 이미 있는 세션은 그 세션을 만든 쪽이 정했으므로 열지 않는다(겹친 첫 수집도 일감 하나).

```ts
// ingest, the one moment a row can be created
const asked = stored === null ? await inspectFirstCwd(repositories, messages) : none;
store.ensureSession({ ..., checkout: asked.checkout,
  identityWork: asked.unknown ? identityWork(key, idGen, ingestedAt) : null });
```

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과
- `git grep -nE "/Users/" -- packages apps` -- expected: 새로 넣은 절대 홈 경로 없음

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에서 git 없는 PATH로 수집 → `sqlite3 <home>/brain.db "select kind, target_id, completed_at from work_items"` → git 있는 PATH로 `SECOND_BRAIN_CAPTURE=1 CLAUDE_CONFIG_DIR=<tmp> node apps/cli/dist/bin.js queue drain` → `select project_id, worktree_id from sessions`가 채워짐.

## Auto Run Result

Status: built

**바뀐 것.**
- 비교 키: Core `CASE_INSENSITIVE_HOSTS`(`github.com`·`bitbucket.org`)와 `projectIdentityKey`(ASCII만 접음)를 두고, `EnsureCheckoutInput.identityKey`로 넘겨 SQLite·가짜 store가 그 키로 프로젝트를 찾거나 만든다. 표시용 `remote_identity`는 처음 본 값. `PROJECT_IDENTITY_KEY_SQL`은 Core 상수로 만들고 Core 함수와의 일치를 SQLite 테스트가 본다.
- inspect 결과 셋: `checkout`·`not_repository`·`unknown(git_missing|timeout|permission|unexpected)`. CLI git 조회는 `LC_ALL=C`로 stderr를 읽어 가르고, remote 조회 실패는 공통 디렉터리로 대신하지 않고 `unknown`이다.
- 첫 수집에서 `unknown`이면 꼬리표 없이 수집하고, 세션을 만드는 같은 트랜잭션에서 `session_identity` 일감을 연다(겹친 생성도 일감 하나).
- Core 소유 일감 `session_identity`: 토큰으로 transcript를 찾아 처음부터 읽고 첫 cwd로 다시 묻는다. 성공하면 새 Store 동사 `fillSessionTags`가 비어 있던 꼬리표만 한 번 채운다. 레포 아님·cwd 없음·세션 없음·이미 꼬리표 있음은 성공으로 닫고, 계속 모르면 지수 간격 10번 뒤 `failures`(`REPOSITORY_UNANSWERED`), transcript 없음은 첫 시도에서 영구 실패.
- `failures retry`는 아는 단계(`session_ingest`·`session_identity`)면 그 종류로, 아니면 대상 종류 표로 다시 넣고 (종류, 대상)마다 하나.

**파일.**
- `packages/core/src/domain/project-identity.ts` — 호스트 상수·비교 키 함수
- `packages/core/src/ports/{repository,store,index}.ts` — `InspectResult`, `identityKey`, `identityWork`, `fillSessionTags`
- `packages/core/src/sessions/ingest.ts` — 세 갈래와 일감, `checkoutFor`·`checkoutInput`·`firstCwd`·`locateTranscript` 공유
- `packages/core/src/capture/session-identity-work.ts`(새) — handler, `SESSION_IDENTITY_KIND`, `REPOSITORY_UNANSWERED`
- `packages/core/src/capture/session-ingest-work.ts`, `failures/retry.ts`, `brain.ts`, `index.ts`, `domain/index.ts` — 단계 표, 다시 하기, 배선, export
- `packages/core/src/testing/{fakes/repository,fakes/store,fixtures,contracts/session-store}.ts` — 가짜·계약 3사례
- `packages/sqlite/src/{sessions,work,project-keys}.ts` — bind 키, 생성 트랜잭션의 일감(`ensureWork` 공유), `fillSessionTags`, Core 상수로 만든 SQL 식
- `apps/cli/src/runtime/git.ts` — 분류와 테스트 seam(`command`, `timeoutMs`); `apps/cli/src/doctor/store.ts` — 스텁
- 테스트: `packages/core/test/{session-identity-work,project-identity,contracts,failures,capture-scan}.test.ts`, `packages/sqlite/test/session-store.test.ts`, `apps/cli/test/{runtime,sessions-ingest,dispatch}.test.ts`
- `README.md`, `deferred-work.md`(비교 키 항목 닫음), architecture AD-21 한 줄

**리뷰.** quick 렌즈 1회(codex, Orca). 지적 1건: patch 0, defer 0, reject 1(low — 수집 스위치가 꺼진 동안 `session_identity`가 첫 시도에 영구 실패; 2.14 전 개발 home에서만 생기고 `failures retry`로 되살아나며, 고치려면 갈래가 더해짐).

**후속 리뷰 권고:** `false`. 이번 패스에서 patch한 항목이 없다(high 0, medium 0, low 0).

**검증.** `pnpm test`(build·typecheck·vitest) 통과 — 65파일 2,173건, 실패 0(메인 세션에서 다시 돌림). I/O 매트릭스 12행 모두 실행·통과한 테스트가 덮는다: 접히는/안 접히는 호스트(CLI `compares clone identity paths` 세 행), 공통 디렉터리(`projectIdentityKey` 표), git 없음·되돌린 뒤 drain·겹친 생성(CLI `defers unknown identity without git…`, Core `two overlapping initial ingests`), 레포 밖(CLI 일감 0건 단정, Core no-work 사례), 꼬리표 있음(CLI·Core), 계속 모름·retry(Core 10번 사례), 일감 중 레포 아님·transcript 없음(Core), 분류(runtime `failure classification` 다섯 갈래와 bare). 새 diff에 절대 홈 경로 없음.

**에이전트가 대신 내린 결정**(intent-contract Decision 1~6): 생성 트랜잭션 안의 일감, 없어진 cwd는 레포 아님, remote 조회 실패는 `unknown`, 세션·cwd 근거 없음은 성공으로 닫음, retry는 단계 우선, ASCII만 접는 키. 구현 워커가 bmad-build 스킬을 부르려다 멈췄을 때 코디네이터가 "스킬 없이 플랜 직접 구현"으로 답했다.

**남은 위험.**
- 수집 스위치가 꺼진 동안의 `session_identity` 즉시 실패(위 reject). 2.14가 스위치를 없앨 때 사라진다.
- git stderr 문구(`not a git repository`, `must be run in a work tree`, `dubious ownership`, `Permission denied`)에 기대는 분류다. git이 문구를 바꾸면 `not_repository`가 `unexpected`로 떨어져 10번 재시도 뒤 실패로 남는다(꼬리표를 잘못 붙이지는 않음).
- 구현 워커가 `runtime/git.ts`·`ports/repository.ts`·`fakes/repository.ts`·`ports/store.ts`의 긴 "왜" 주석을 한 줄로 줄였다. 동작에는 영향이 없지만 저장소의 주석 문체보다 짧다.
- 사람 확인 필요: 위 Decision 1~6, 특히 3(remote 조회 실패를 `unknown`으로 바꿔 2.8의 공통 디렉터리 대신 규칙을 좁힘).
