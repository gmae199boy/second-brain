---
title: '프로젝트·워크트리 정체성: remote 정규화, 첫 메시지 cwd, 불변 꼬리표'
type: 'feature'
ticket: '8'
created: '2026-10-18'
status: 'built'
baseline_revision: '64e72ce36537bb0c26a4065b62b75c4b52eb8b93'
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

**Problem:** 세션 행은 늘 `project_id`·`worktree_id`가 null로 만들어진다(`ingest.ts`의 "story 2.8's" 자리). git remote 정규화 함수도, git을 묻는 Runtime 포트도, `projects`·`worktrees` 행을 만드는 코드도 없다.

**Approach:** Core에 정규화 함수와 `RepositoryInspector` 포트를 둔다. `sessions.ingest`는 세션 행이 아직 없을 때만 첫 메시지의 `cwd`로 포트를 한 번 부른다. 그 결과(정체성·워크트리 경로·제안 id)를 `ensureSession`에 넘기면, Store가 같은 쓰기 트랜잭션 안에서 프로젝트·워크트리를 찾거나 만들고 세션에 붙인다. CLI Runtime은 `git`을 `execFile`로 불러 포트를 구현한다.

## Boundaries & Constraints

**Always:**
- **정규화**(`normalizeRemoteIdentity(url): string | null`, Core 순수 함수):
  - 결과는 `host/path`다. host는 소문자로 바꾸고, scheme·사용자·비밀번호·포트를 없앤다. path는 대소문자를 그대로 두고, 끝의 `/`와 `.git` 하나를 없앤다. 빈 path 조각도 없앤다.
  - 받는 모양: `https://`·`http://`·`ssh://`·`git://`·`git+ssh://`·`ssh+git://` URL과 scp 모양 `[user@]host:path`. 그래서 `git@GitHub.com:o/r.git`, `ssh://git@github.com:22/o/r`, `https://tok:x@github.com/o/r.git/`은 모두 `github.com/o/r`가 된다.
  - path 조각은 하나 이상이다. 하위 그룹(`host/g/sub/r`)은 그대로 둔다.
  - host가 없거나, path가 비었거나, `file://`·로컬 경로처럼 host 없는 remote이면 null이다.
- **정체성:** 정규화한 remote가 있으면 그것을 쓴다. 없을 때만 git 공통 디렉터리의 절대 경로를 그대로 쓴다. 절대 경로는 `/`로 시작하므로 `host/…`와 겹치지 않는다. remote는 `origin`을 먼저 고르고, 없으면 `git remote` 출력의 첫 이름을 고른다. 고른 remote를 정규화할 수 없으면 remote가 없는 것으로 본다.
- **워크트리:** (프로젝트, `git rev-parse --show-toplevel`의 절대 경로)다. cwd가 하위 폴더여도 워크트리는 최상위다. 같은 레포의 두 워크트리는 공통 디렉터리가 같으므로, remote가 없어도 한 프로젝트가 된다.
- **포트** `RepositoryInspector.inspect(cwd): Promise<Checkout | null>`은 던지지 않는다. `Checkout`은 `{remoteUrl: string | null, commonDir, worktreePath}`이고, 레포가 아니거나 알 수 없으면 null이다.
- **CLI 구현**(`apps/cli/src/runtime/git.ts`): `git -C <cwd> rev-parse --path-format=absolute --show-toplevel --git-common-dir`, `git -C <cwd> remote`, `git -C <cwd> remote get-url <name>`을 `execFile`로 부른다(셸 없음).
  - 호출마다 timeout은 2초다. env에 `GIT_TERMINAL_PROMPT=0`·`GIT_OPTIONAL_LOCKS=0`을 더한다.
  - cwd가 없음, 레포 밖, bare, git 없음, timeout, 비정상 출력은 모두 null이다.
- **use case:** 꼬리표는 `findSession`이 null이고 메시지가 있어서 세션을 만들 수도 있을 때만 계산한다. 근거는 `parsed.messages[0].cwd`다(커서가 없으니 처음부터 읽은 결과의 첫 메시지). cwd가 null이면 inspect를 부르지 않고 꼬리표가 없다. 프로세스 cwd는 쓰지 않는다. 세션이 이미 있으면 inspect를 부르지 않는다(hook 지연).
- **`EnsureSessionInput`:** `projectId`·`worktreeId`를 `checkout: EnsureCheckoutInput | null`로 바꾼다. `EnsureCheckoutInput`은 `{projectId, remoteIdentity, worktreeId, worktreePath}`이고, 두 id는 호출자가 만든 제안 id다(AD-8). `workspaceId`는 null로 남는다.
- **Store:**
  - 한 `withWrite` 안에서 세션 키가 이미 있으면 아무것도 만들지 않고 그 행을 돌려준다.
  - 없으면 `projects`를 `remote_identity`로, `worktrees`를 `(project_id, path)`로 찾거나 만든다. 이미 있으면 있는 id를 쓴다.
  - 그다음 세션을 넣는다. 돌려주는 `Session.projectId`·`worktreeId`는 실제로 붙은 id다.
  - 프로젝트·워크트리 행은 지우거나 바꾸지 않는다(`removed_at`은 drain 몫).
  - 메모리 가짜도 같게 한다.
- 새로 쓰는 사람이 읽는 문장은 한국어다(출력 언어 규칙).
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): git 조회가 어떤 이유로든 실패하면(git 없음, timeout, cwd 사라짐, 권한) 꼬리표 없이 수집한다. 수집은 막지 않는다. 다른 안: 수집 실패로 돌려 다음 hook이 다시 하게 함. 이 안은 git이 계속 없으면 세션이 영원히 안 들어간다. "빠짐없이"가 꼬리표보다 앞선다고 봤다. 새 경고 코드도 만들지 않는다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): remote가 여럿이면 `origin`, 없으면 `git remote` 출력의 첫 이름을 쓴다. 다른 안: 모든 remote를 보고 하나라도 기존 프로젝트와 맞으면 그것을 씀.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): remote가 없을 때의 정체성은 공통 디렉터리의 절대 경로 그대로다. 접두사나 기계 이름은 붙이지 않는다. AD-12 문구를 그대로 따른 것이다. 다른 안: `local:<machine>:<path>`.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): host 이름은 소문자로 바꾸지만 owner/repo의 대소문자는 그대로 둔다. AD-12는 host 소문자만 말한다. 다른 안: path도 소문자로 바꿈. 이 안은 대소문자를 구분하는 호스트에서 다른 레포가 합쳐진다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 이 스토리 전에 꼬리표 없이 만들어진 세션은 다시 수집해도 그대로 둔다(불변 규칙). 실제 수집은 2.14에서 켜지므로 그런 행은 개발용 임시 home에만 있다.

**Never:**
- 꼬리표 갱신 경로, 워크스페이스(`workspace_id`는 null, `sessions assign-workspace` 없음), 스키마·마이그레이션 변경, `removed_at` 채우기(drain), spool(2.10), 마스킹(2.9), 플러그인 hook(2.14).
- `git fetch`처럼 네트워크를 쓰거나 파일을 쓰는 git 명령, 셸을 거치는 실행, 프로세스 cwd를 근거로 쓰기.
- 실제 `~/.claude`·`~/.second_brain` 변경. 시험은 임시 home과 임시 git 레포로만 한다.
- Postgres store(SessionStore 미구현) 변경.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 두 워크트리 | 같은 레포의 main 폴더와 `git worktree add`한 폴더에서 연 두 세션 | `projects` 1행, `worktrees` 2행, 두 세션이 같은 `project_id`와 다른 `worktree_id`를 가짐 | — |
| ssh·https | 같은 레포를 가리키는 `git@host:o/r.git` remote의 clone과 `https://host/o/r` remote의 clone | 같은 `remote_identity`(`host/o/r`) 한 행 | — |
| remote 없음 | `git init`만 한 레포 | 정체성은 공통 디렉터리 절대 경로. 그 레포의 워크트리 둘은 한 프로젝트 | — |
| 하위 폴더 | cwd가 레포 안의 `sub/dir` | 워크트리 경로는 최상위 | — |
| 레포 밖 | cwd가 레포 아닌 임시 폴더, 또는 없는 경로(`/demo/repo`) | 세션은 수집되고 `project_id`·`worktree_id`가 null | inspect가 null |
| cwd 없음 | 첫 메시지에 `cwd`가 없음 | 꼬리표 없음, inspect 안 부름 | — |
| 다시 수집 | 꼬리표가 붙은 세션의 transcript를 다시 넣음. 그 사이 remote를 바꾸고 워크트리 폴더를 지움 | inspect 안 부름. 세션 꼬리표·`projects`·`worktrees` 행 그대로 | — |
| 겹친 첫 수집 | 같은 세션의 첫 ingest 두 개 | 세션 1행, 프로젝트·워크트리 중복 없음 | — |
| 비밀 든 remote | `https://user:token@host/o/r.git` | `host/o/r`. DB 어디에도 `token` 없음 | — |
| 정규화 불가 | `file:///srv/r.git`, `/srv/r.git`, `host:`, 빈 문자열 | null → 공통 디렉터리로 대신함 | — |

</intent-contract>

## Code Map

- `packages/core/src/domain/project.ts`, `worktree.ts` -- 타입만 있다. 정규화 함수는 새 `domain/project-identity.ts`에 두고 `domain/index.ts`와 `core/src/index.ts`에서 export한다.
- `packages/core/src/ports/repository.ts`(신규) -- `RepositoryInspector`·`Checkout`. `ports/index.ts`에서 export한다. 모양은 `ports/transcript.ts`(값을 돌려주고 던지지 않음)를 따른다.
- `packages/core/src/ports/store.ts` -- `EnsureSessionInput`(77행~)의 `projectId`·`worktreeId`를 `checkout`으로 바꾸고 `EnsureCheckoutInput`을 export한다. `SessionStore` 주석에 find-or-create 규칙을 적는다.
- `packages/core/src/sessions/ingest.ts` -- `IngestSessionDependencies`에 `repositories: RepositoryInspector`를 더한다. ensure 호출부(190행 부근의 null 셋)에 꼬리표 계산을 넣는다. `stored === null`일 때만 한다. 순서 주석(`token → parser → findSession → read → parse → owner → ensure → ingest`)에 inspect를 더한다.
- `packages/core/src/brain.ts` -- `BrainDependencies`에 `repositories`를 더하고 ingest에 넘긴다.
- `packages/core/src/testing/fakes/` -- `memoryRepositories(map: Record<cwd, Checkout>)`(신규, 호출 횟수를 셀 수 있게), `fakes/store.ts`의 `ensureSession`(100행~)에 project·worktree 맵을 더한다. `fakes/parser.ts`의 `memoryParser`가 메시지에 `cwd`를 내는지 확인하고, 안 내면 내게 한다. `testing/index.ts`에서 export한다.
- `packages/core/src/testing/fixtures.ts` -- `sampleEnsureSessionInput`(54행~)의 `projectId`/`worktreeId: null`을 `checkout: null`로 바꾸고 `sampleCheckoutInput`을 더한다.
- `packages/core/src/testing/contracts/session-store.ts` -- 기존 "keeps the tags" 사례(116행~)는 두 번째 ensure에 `checkout`을 준다. 새 사례:
  - checkout이 있으면 프로젝트·워크트리가 생기고 세션에 붙는다.
  - 같은 정체성의 다른 세션은 같은 프로젝트를 쓴다. 다른 경로면 새 워크트리, 같은 경로면 같은 워크트리다. 제안 id는 무시된다.
  - 이미 있는 세션에 checkout을 주면 아무 행도 생기지 않는다.
  - `checkout: null`이면 null 꼬리표다.
  - 프로젝트 행 수를 볼 읽기가 계약에 없으면, 같은 `projectId`가 붙었는지로만 단정한다(포트에 읽기를 더하지 않는다).
- `packages/core/test/{contracts,sessions-ingest,doctor}.test.ts` -- 새 의존성 반영. 음성 사례: 정체성마다 새 프로젝트를 만드는 store, 두 번째 ensure에서 꼬리표를 바꾸는 store. use case 행은 다음을 본다. 첫 수집만 inspect, 첫 메시지 cwd 사용, cwd null, inspect null, 세션이 있으면 안 부름.
- `packages/core/test/project-identity.test.ts`(신규) -- 정규화 표 사례.
- `packages/sqlite/src/sessions.ts` -- `ensureSession`(87~130행)을 바꾼다. 같은 `withWrite` 안에서 `readSessionRow` → 있으면 반환. 없으면 projects·worktrees를 `insert … on conflict do nothing` 후 select로 id를 읽고, sessions에 insert한다.
  - 기존 "id가 다른 세션 것" 오류 처리는 유지한다.
  - `packages/sqlite/test/session-store.test.ts`가 계약을 돌린다. FK가 켜져 있으므로, 없는 project id를 넣는 기존 사례가 깨지지 않는지 본다.
- `apps/cli/src/runtime/git.ts`(신규), `apps/cli/src/dispatch.ts`(466행 부근 `transcripts:` 옆) -- Runtime 구현과 배선이다. `runtime/transcript.ts`의 `describe`·주석 문체를 따른다.
- `apps/cli/test/runtime.test.ts` -- 임시 git 레포로 `gitRepositoryInspector`를 시험한다. 다룰 것: 하위 폴더, worktree add, remote 없음, `origin` 우선, 레포 밖, 없는 경로. git 사용자 설정이 필요하면 `-c user.name=… -c user.email=…`을 쓴다. 전역 설정은 건드리지 않는다.
- `apps/cli/test/sessions-ingest.test.ts` -- CLI 수준 verify다. 헬퍼 `homeFor`·`migratedDatabase`·`FIXTURE`(cwd는 `/demo/repo`, 없는 경로)를 재사용한다. transcript의 `"cwd": "/demo/repo"`를 임시 레포 경로로 바꾸고, hook payload의 `session_id`를 세션마다 다르게 준다.
- 읽기만: `packages/sqlite/migrations/0001_initial.sql` 48~62행(projects·worktrees, `unique(project_id, path)`), 0003의 sessions 재생성(FK).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/project-identity.ts`, `packages/core/test/project-identity.test.ts` -- 정규화 함수와 매트릭스의 정규화 행. 결과에 사용자·비밀번호가 남지 않음도 단정한다.
- [x] `packages/core/src/ports/{repository,store,index}.ts`, `src/index.ts` -- 포트와 입력 타입.
- [x] `packages/core/src/sessions/ingest.ts`, `src/brain.ts` -- 첫 수집에서만 inspect하고 checkout을 만든다.
- [x] `packages/core/src/testing/{fakes/*,fixtures,contracts/session-store,index}.ts` -- 가짜와 계약.
- [x] `packages/core/test/{contracts,sessions-ingest,doctor}.test.ts` -- 음성 사례와 use case 행.
- [x] `packages/sqlite/src/sessions.ts`, `packages/sqlite/test/session-store.test.ts` -- 한 트랜잭션의 find-or-create.
- [x] `apps/cli/src/runtime/git.ts`, `apps/cli/src/dispatch.ts`, `apps/cli/test/runtime.test.ts` -- Runtime git 조회와 배선.
- [x] `apps/cli/test/sessions-ingest.test.ts` -- 실제 임시 git 레포로 CLI 수준 verify:
  - 두 워크트리 → 프로젝트 1·워크트리 2
  - ssh·https clone 두 개 → 프로젝트 1
  - 레포 밖 → null
  - 다시 수집 → 그대로. remote를 바꾸고 워크트리 폴더를 지운 뒤 다시 넣어도 세션 꼬리표와 워크트리 행이 남음

**Acceptance Criteria:**
- Given 마이그레이션한 SQLite와 메모리 가짜, when session-store 계약을 돌리면, then 새 사례를 포함한 모든 사례가 둘 다에서 통과한다.
- Given 임시 home과 임시 git 레포들, when `brain sessions ingest claude-code --json`에 cwd만 다른 transcript로 hook payload를 넣으면, then 매트릭스의 두 워크트리·ssh·https·레포 밖·다시 수집 행이 `sqlite3`로 본 `projects`·`worktrees`·`sessions`에서 그대로 보인다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

- `normalizeRemoteIdentity`는 `domain/project-identity.ts`에 있다. 스킴 목록은 허용 목록이라서 `file://`는 호스트가 있어 보여도 null이다. scp 모양은 첫 `:`로 자르고, 콜론이 없는 문자열은 로컬 경로로 보고 null이다. IPv6 리터럴은 대괄호를 그대로 둔다. 마지막 조각이 `.git`뿐이면 그 앞 조각이 레포 이름이다.
- 포트는 `ports/repository.ts`의 `RepositoryInspector.inspect(cwd)`다. `domain/index.ts`·`ports/index.ts`가 export하고, `core/src/index.ts`의 `export *`로 함께 나간다.
- use case는 `stored === null && messages.length > 0`일 때만 `inspect`를 부른다. 근거는 `messages[0].cwd`이고, 프로젝트·워크트리 제안 id는 세션 id보다 먼저 발급된다(순서에 의존하는 시험은 없다).
- `EnsureSessionInput.projectId`·`worktreeId`는 `checkout: EnsureCheckoutInput | null`로 바뀌었다. `workspaceId`는 null로 남는다.
- SQLite `ensureSession`은 한 `withWrite` 안에서 `readSessionRow` → (있으면 반환) → `ensureCheckout`(projects·worktrees를 `insert … on conflict do nothing` 후 select) → sessions insert 순이다. `returning`이 아니라 select로 id를 읽는 것은, 충돌로 건너뛴 경우가 바로 "이미 있는 id를 써야 하는" 경우이기 때문이다. 제안 id가 다른 행의 것이면 `DB_UNAVAILABLE`과 그 이유를 돌려준다.
- CLI 구현은 `apps/cli/src/runtime/git.ts`다. `execFile`, 셸 없음, 호출마다 2초, `GIT_TERMINAL_PROMPT=0`·`GIT_OPTIONAL_LOCKS=0`. 실패·bare·없는 경로·비정상 출력은 모두 null이다. 새 경고 코드는 없다.
- 시험: `packages/core/test/project-identity.test.ts`(정규화 38건), session-store 계약 4건 추가(메모리·SQLite 양쪽), `contracts.test.ts` 음성 가짜 2개, `sessions-ingest.test.ts` use case 7건, `apps/cli/test/runtime.test.ts` 실제 임시 레포 9건, `apps/cli/test/sessions-ingest.test.ts` CLI 수준 4건.
- Postgres 통합 시험 16건은 `BRAIN_TEST_DATABASE_URL`이 없어 실패하며, 이 스토리 전후가 같다(기준선에서 확인). `packages/postgres`는 건드리지 않았다.
- (메인 세션, 검증 단계) 매트릭스 "겹친 첫 수집" 행을 꼬리표가 있는 상태로 덮는 시험이 없어서 `apps/cli/test/sessions-ingest.test.ts`에 실제 레포 cwd로 두 프로세스가 동시에 첫 수집하는 시험을 더했다(세션 1·프로젝트 1·워크트리 1). 4번 반복해 통과.

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass
- verdicts: 5 findings — high 0, medium 1, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` `ensureSession`의 실패 경로가 값을 돌려줘 `withWrite`가 커밋하므로, 먼저 넣은 projects·worktrees 행이 가리키는 세션 없이 남음 — 제안 id가 이미 다른 행의 것일 때만 생긴다(UUIDv7이라 일상에서는 드묾). 그러나 포트 규칙과 주석이 거짓이 되므로 고침: 내부 sentinel을 throw해 롤백하고 바깥에서 같은 `DB_UNAVAILABLE` 값으로 바꿈(세션 id 충돌 경로도 함께). sqlite 시험 추가.
  - `[medium]` `[patch]` git 조회가 `GIT_DIR`·`GIT_WORK_TREE` 같은 `GIT_*` 환경 변수를 물려받아 `-C <cwd>`가 무시되고 다른 레포로 영구 꼬리표가 붙을 수 있음. 상대 cwd는 프로세스 cwd 기준으로 풀림 — 확인함(git은 GIT_DIR을 따름). 고침: `GIT_` 접두 키를 모두 빼고, 절대 경로가 아니면 null. runtime 시험 2건 추가.
  - `[low]` `[patch]` "origin 우선" 시험이 `upstream`을 써서 알파벳순으로 이미 origin이 첫째라 규칙을 검증하지 못하고 주석도 틀림 — 고침: `alt`로 바꾸고 주석 정정.
  - `[low]` `[patch]` 매트릭스 "remote 없음"의 "워크트리 둘은 한 프로젝트"를 단정하는 시험이 없음 — 고침: core use case 사례 추가(`remoteUrl: null`, 같은 `commonDir` → 프로젝트 1·워크트리 2).
  - `[low]` `[patch]` `git.ts` 머리 주석이 코드가 넘기지 않는 `--no-optional-locks`를 말함 — 고침: `GIT_OPTIONAL_LOCKS=0`으로 정정.

## Design Notes

Store의 한 트랜잭션(의사 코드):
```
withWrite:
  row = readSessionRow(key); if row → return {created:false, row}
  if checkout:
    insert into projects(id, remote_identity) values(p, ident) on conflict do nothing
    pid = select id from projects where remote_identity = ident
    insert into worktrees(id, project_id, path) values(w, pid, path) on conflict do nothing
    wid = select id from worktrees where project_id = pid and path = path
  insert into sessions(..., project_id=pid, worktree_id=wid) on conflict do nothing returning id
```
세션 확인을 먼저 하는 것은, 이미 있는 세션에 붙지 않을 프로젝트 행이 생기지 않게 하려는 것이다. 겹친 첫 수집은 SQLite 쓰기 잠금 하나로 줄 선다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 통합은 `BRAIN_TEST_DATABASE_URL` 필요; 2.7 Implementation Notes 참고)

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에 `setup run --yes`를 한다. 그다음 임시 레포 경로로 cwd를 바꾼 fixture를 `sessions ingest claude-code --json`으로 넣는다. 끝으로 `sqlite3 <home>/brain.db "select * from projects; select * from worktrees; select harness_session_id, project_id, worktree_id from sessions"`로 확인한다.

## Auto Run Result

**요약:** 세션을 만드는 첫 수집이 첫 메시지의 transcript `cwd`로 git을 한 번 묻고, 그 결과로 프로젝트·워크트리 꼬리표를 붙인다. 프로젝트 정체성은 Core의 `normalizeRemoteIdentity`가 정한다(`host/path`, host만 소문자, scheme·사용자·비밀번호·포트·`.git` 제거, ssh와 https 같음). remote가 없을 때만 git 공통 디렉터리의 절대 경로를 쓴다. 워크트리는 (프로젝트, git 최상위 경로)다. Store는 한 쓰기 트랜잭션 안에서 프로젝트·워크트리를 찾거나 만들고 세션에 붙인다. 이미 있는 세션은 다시 묻지 않으므로 꼬리표가 바뀌지 않는다. 레포 밖, cwd 없음, git 실패이면 꼬리표 없이 수집한다. 스키마 변경은 없다.

**바뀐 파일:**
- `packages/core/src/domain/project-identity.ts`(신규) — remote 정규화 함수
- `packages/core/src/ports/repository.ts`(신규), `ports/{store,index}.ts`, `domain/index.ts` — `RepositoryInspector`·`Checkout`. `EnsureSessionInput.checkout`이 `projectId`·`worktreeId`를 대신한다.
- `packages/core/src/sessions/ingest.ts`, `brain.ts` — 첫 수집에서만 inspect하고 checkout을 만든다.
- `packages/core/src/testing/{fakes/repository,fakes/store,fixtures,contracts/session-store,index}.ts` — 가짜와 계약 4사례
- `packages/core/test/{project-identity,contracts,sessions-ingest,doctor}.test.ts` — 정규화 표, 음성 사례, use case 사례
- `packages/sqlite/src/sessions.ts`, `test/session-store.test.ts` — 한 트랜잭션의 find-or-create. 실패하면 롤백한다.
- `apps/cli/src/runtime/git.ts`(신규), `src/dispatch.ts` — `execFile` git 조회(2초, `GIT_*` 환경 변수 제거, 절대 경로만)와 배선
- `apps/cli/test/{runtime,sessions-ingest}.test.ts` — 실제 임시 git 레포로 하는 시험. 다루는 것: 두 워크트리, ssh·https, 레포 밖, 겹친 첫 수집, remote를 바꾸고 폴더를 지운 뒤 다시 수집

**리뷰:** quick 1회, 5건이다. 패치 5건(medium 1, low 4), 보류 0, 거부 0. 후속 리뷰 권고는 false다. high를 고친 것이 없고 medium 패치도 1건뿐이다.

**검증:** `pnpm test`(build → typecheck → vitest)를 돌렸고, `BRAIN_TEST_DATABASE_URL`을 설정해 Postgres 통합도 포함했다. 43파일 1380건이 통과했다(패치 뒤 다시 돌림). 매트릭스 10행은 모두 실행된 시험이 덮는다. "겹친 첫 수집"은 메인 세션이 CLI 시험을 더했고 4번 반복해 통과했다. 구현 서브에이전트는 임시 `SECOND_BRAIN_HOME`과 임시 레포 4개로 수동 확인을 했다. 결과: 프로젝트 1·워크트리 3, 레포 밖 세션은 null, 다시 수집해도 그대로, DB에 토큰 문자열 없음. 실제 `~/.claude`·`~/.second_brain`·git 전역 설정은 건드리지 않았다. diff에서 개인 식별자(사용자 이름·이메일·`/Users/` 경로)도 찾지 못했다.

**에이전트가 대신 내린 결정** (모두 intent-contract의 Decision에 기록):
1. git 조회가 어떤 이유로든 실패하면 수집을 막지 않고 꼬리표 없이 수집한다. 새 경고 코드는 없다. 다른 안: 수집 실패로 돌려 다음 hook이 다시 하게 함.
2. remote가 여럿이면 `origin`, 없으면 `git remote` 출력의 첫 이름을 쓴다. 다른 안: 모든 remote를 기존 프로젝트와 맞춰 봄.
3. remote가 없을 때의 정체성은 공통 디렉터리의 절대 경로 그대로다. 접두사와 기계 이름은 붙이지 않는다. 다른 안: `local:<machine>:<path>`.
4. host만 소문자로 바꾸고 owner/repo의 대소문자는 그대로 둔다. 다른 안: path도 소문자로 바꿈.
5. 이 스토리 전에 꼬리표 없이 만들어진 세션은 그대로 둔다. 실제 수집은 2.14에서 켜진다.
6. (구현 중) `file://` 같은 허용 목록 밖의 scheme과 콜론 없는 로컬 경로 remote는 정규화하지 않고 공통 디렉터리로 대신한다. 허용 목록은 https·http·ssh·git·git+ssh·ssh+git이다.
7. (리뷰 반영) git을 부를 때 `GIT_`로 시작하는 환경 변수를 모두 빼고, 절대 경로가 아닌 cwd는 레포 밖으로 본다.

**사람 확인 필요:**
- 위 결정 1~4가 맞는지 볼 것. 특히 1은, git이 없거나 느린 기계에서 세션이 영원히 꼬리표 없이 남는다는 뜻이다.
- 실제 Claude Code 세션 하나를 임시 home으로 수집해 볼 것(`tooling/dev/tracer-session.sh` 방식). 두 가지를 눈으로 확인한다: 이 레포(`origin`이 있는 실제 clone)의 정체성 문자열이 기대대로인지, 워크트리 경로가 맞는지. 자동 시험은 임시 레포와 중립 remote(`demo.example`)로만 했다.
- hook 환경에서 git을 찾는지 볼 것. CLI 시험의 자식 PATH는 `dirname(node):/usr/bin:/bin`이다. git이 `/usr/local/bin` 같은 곳에만 있는 기계에서는 꼬리표가 null이 된다(결정 1대로 수집은 된다). 2.14의 플러그인 hook 실측 때 함께 확인할 것.

**남은 위험:** `--path-format=absolute`는 git 2.31 이상이 필요하다. 그보다 낮으면 꼬리표 없이 수집된다. 같은 레포를 서로 다른 remote 이름이나 다른 호스트 별칭(ssh config의 `Host` 별칭 등)으로 clone하면 다른 프로젝트가 된다. 별칭을 풀지 않기 때문이다.
