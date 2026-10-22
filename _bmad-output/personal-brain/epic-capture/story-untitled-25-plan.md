---
title: '지워진 워크트리의 꼬리표 추정과 꼬리표 근거 칸'
type: 'feature'
ticket: '25'
created: '2026-10-21'
status: built
baseline_revision: 'a8fb5287cacd5620870b579d087d29404616c3b4'
route: 'full'
route_source: 'auto'
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

**Problem:** 꼬리표 근거 폴더(cwd가 있는 첫 메시지의 cwd)가 디스크에 없으면 `gitRepositoryInspector`가 `not_repository`로 답해 세션이 영원히 꼬리표 없이 남는다. 이 기계의 첫 수집에서 꼬리표 없는 세션 39개 중 33개가 이미 지운 워크트리의 세션이다. 그리고 꼬리표가 없으면 그 세션이 어느 폴더였는지 DB에 남는 것이 없어, Claude Code가 30일 뒤 transcript를 지우면 다시 판단할 근거도 사라진다(epic Decision 2026-10-21 두 건, AD-12). 또 첫 메시지가 나올 때 이미 하위 폴더로 들어가 있는 세션이 있어(이 기계 4개), 그 근거로는 워크트리째 지워진 경우 바로 위 폴더도 없어 추정할 수 없다.

**Approach:** 꼬리표 근거를 "세션을 시작한 폴더"(transcript에서 cwd가 있는 첫 줄의 cwd, 없으면 cwd가 있는 첫 메시지의 cwd)로 바꾸고(사용자 결정 2026-10-22, B), 그 폴더가 없을 때만 Core가 두 단계로 추정한다: (1) 처음 남아 있는 위 폴더가 저장소 안이면 그 저장소(`ancestor`), (2) 아니면 원래 폴더의 바로 위 폴더의 형제 checkout이 모두 같은 `identity_key`이면 그 프로젝트(`sibling`). 마이그레이션 0007이 `sessions.tag_source`·`sessions.first_cwd`를 더하고, 수집은 세션을 만들 때 둘을 쓰며, drain이 이미 꼬리표 없이 저장된 세션을 한 번 다시 판단한다. doctor는 꼬리표 없는 세션 수를 보인다.

## Boundaries & Constraints

**Always:**
- **포트(`packages/core/src/ports/repository.ts`).** `InspectResult`에 `{kind: 'missing'}`(경로나 그 앞 폴더가 없음: stat의 ENOENT·ENOTDIR)를 더한다. 새 메서드 `listFolders(path): Promise<FolderListing>`, `FolderListing = {kind: 'listed', folders: readonly string[]} | {kind: 'missing'} | {kind: 'unknown', reason, message}` — `path` 바로 아래 디렉터리의 절대 경로(심볼릭 링크는 따라가 디렉터리면 넣고, 가리키는 곳이 없으면 뺌), 경로순 정렬. 읽기 권한 거부는 `unknown/permission`. 두 메서드 모두 던지지 않는다. 폴더 이름이나 도구 이름(Orca, Paseo, `.claude/worktrees` 등)은 어떤 코드에도 넣지 않는다.
- **추정(Core, 새 `packages/core/src/sessions/checkout-estimate.ts` 또는 `checkoutFor` 확장, 수집과 handler가 함께 쓰는 한 함수).** 결과는 `{checkout: EnsureCheckoutInput | null, tagSource: TagSource | null, unknown: InspectUnknown | null}`, `TagSource = 'cwd' | 'ancestor' | 'sibling'`(domain 타입).
  1. cwd가 null → 셋 다 null. `inspect(cwd)`: `checkout` → `checkoutInput` 그대로, `cwd`. `not_repository` → 비움. `unknown` → 미룸. `missing` → 2로.
  2. 위로: 부모부터 `inspect`. `missing`이면 한 칸 더 위. 처음 `checkout`이면 그 저장소의 `checkoutInput`에서 `worktreePath`만 원래 cwd로 바꾼 값, `ancestor`. `unknown` → 미룸. `not_repository`면 3으로. 루트 위로는 없다(비움).
  3. 형제: 원래 cwd의 바로 위 폴더 하나에서만 `listFolders`. `missing` → 비움(1·2에서 이미 그 폴더가 없음을 봤으면 묻지 않아도 된다). `unknown` → 미룸. `listed`에서 원래 cwd를 빼고 각각 `inspect`: `checkout`은 `checkoutInput`의 `identityKey`로 모으고, `not_repository`·`missing`은 건너뛰며, 하나라도 `unknown`이면 미룸. checkout이 하나 이상이고 키가 모두 같으면 경로순 첫 형제의 입력에서 `worktreePath`를 원래 cwd로, `sibling`. 없거나 갈리면 비움. remote 없는 로컬 저장소 형제는 AD-12대로 공통 디렉터리가 정체성이므로 remote 형제와 다른 정체성이다.
  - 경로는 POSIX 절대 경로 문자열로 다룬다(Core는 `node:path`를 쓰지 않음; 끝 `/` 정리, 마지막 `/` 앞이 부모, `/`의 부모는 없음).
- **근거 폴더(사용자 결정 2026-10-22, B).** parser 결과에 `startCwd: string | null`을 더한다(`ports/parser.ts`, `startSource`와 같은 자리·같은 규칙: 커서와 상관없이 내용 전체에서 처음 것). Claude Code parser는 메시지가 아닌 줄(attachment·hook 줄 등)을 포함해, 서브에이전트 줄(`isSidechain: true`)을 뺀 줄 가운데 비어 있지 않은 문자열 `cwd`를 가진 첫 줄의 값을 준다. 메시지는 바뀌지 않으므로 parser 버전은 올리지 않는다. 세션의 근거 폴더는 `startCwd ?? firstCwd(messages)`이고, 직접 조회(`cwd`)와 추정 모두 이 폴더 하나에서 시작한다. `first_cwd` 칸에 이 값을 쓴다(칸을 더하지 않는다). handback 메시지에 cwd가 없다는 22의 문제는 cwd 있는 첫 줄을 쓰므로 그대로 풀린다.
- **수집(`sessions/ingest.ts`).** 세션을 만들 수 있는 호출(지금처럼 `stored === null`)에서 위 함수를 근거 폴더로 부르고, `EnsureSessionInput`에 `firstCwd`(근거 폴더, 없으면 null)와 `tagSource`(checkout이 있을 때만 값)를 더해 넘긴다. 미룸은 20처럼 `identityWork`를 연다. 이미 있는 세션은 바꾸지 않는다.
- **마이그레이션 `packages/sqlite/migrations/0007_session_tag_source.sql`, `SQLITE_SCHEMA_VERSION = 7`.** `alter table sessions add column tag_source text`와 `first_cwd text`(둘 다 nullable, 표 재생성 없음). 기존 행: `project_id is not null`이면 `tag_source = 'cwd'`, 나머지와 `first_cwd`는 null. 트리거로 강제: `tag_source`는 null 또는 셋 중 하나, `(tag_source is null) = (project_id is null)`, 값이 있는 `tag_source`·`first_cwd`는 바뀌지 않는다(null → 값만). 0001~0006 파일은 고치지 않는다. 머리 주석은 0005·0006의 문체(왜를 영어로).
- **Store(SQLite·가짜, 계약 사례로 묶음).** `ensureSession`은 만들 때 `first_cwd`·`tag_source`를 쓴다. `fillSessionTags` 입력에 `tagSource`·`firstCwd`를 더한다: `first_cwd`가 null이고 값이 오면 채우고, 꼬리표는 지금처럼 둘 다 null일 때만 `tag_source`와 함께 채운다(`checkout: null`이면 꼬리표는 그대로). `Session`에 `firstCwd`·`tagSource`. 새 읽기 둘(잠금 없음, AD-7): 다시 판단할 세션 목록(꼬리표 없음 ∧ `first_cwd is null` ∧ 그 토큰의 `session_identity` 일감이 열린 것도 닫힌 것도 없음), 꼬리표 없는 세션 수.
- **다시 판단(drain).** `drain`의 폴더 스캔 뒤·대기열 앞에서, 위 목록의 세션마다 `session_identity` 일감을 `addWork`한다(Core가 id·시각을 정함, 읽기가 비면 쓰기 없음). 그 일감이 닫히면 다시 열리지 않는다 — 이것이 "한 번"이다.
- **handler(`capture/session-identity-work.ts`).** transcript를 찾으면 거기서 근거 폴더(`startCwd ?? firstCwd(messages)`), 그것도 없으면 저장된 `session.firstCwd`, transcript를 못 찾으면 저장된 `session.firstCwd`. transcript를 읽었는데 근거가 하나도 없으면 20처럼 성공으로 닫고, transcript도 저장값도 없으면 20 그대로(`TRANSCRIPT_UNREADABLE`, 영구). 추정 함수로 판단하고 `fillSessionTags`에 `checkout`(없으면 null)·`tagSource`·`firstCwd`를 넘긴다(비움으로 끝나도 `first_cwd`는 채운다). 미룸은 20의 `REPOSITORY_UNANSWERED`. 이미 꼬리표가 있으면 지금처럼 그대로 성공.
- **doctor.** Core doctor에 `untagged` 점검: 늘 `ok`, detail `N건`(읽기 실패는 `failures` 점검과 같은 `fail` 모양). 진단용 가짜 store·dispatch mock에 새 읽기 스텁.
- 사람이 읽는 새 문장은 한국어(출력 언어 검사). fixture·remote는 중립(`github.com/brain-owner/…`, `demo.example`). 테스트는 임시 폴더·임시 레포·임시 home만 쓴다.
- 문서: spine AD-12(근거 폴더가 세션을 시작한 폴더라는 것, 근거 폴더가 없을 때의 추정과 `tag_source`·`first_cwd`)와 Table Contract(`sessions.tag_source`·`first_cwd`의 작성자 = 수집·`fillSessionTags`, 불변 규칙), AD-20 등의 스키마 버전 언급이 있으면 7로; README 프로젝트 꼬리표 절·doctor 항목.
- Decision(2026-10-21, 무인 실행에서 에이전트가 고름):
  1. 로컬 저장소 형제의 정체성은 AD-12의 공통 디렉터리다. 그래서 remote 형제와는 다르고, 같은 로컬 저장소의 워크트리 형제끼리는 같다. 다른 안: 로컬 형제를 늘 갈림으로 셈.
  2. "한 번"의 표식은 그 세션의 `session_identity` 일감이 있었는지와 `first_cwd`다. 새 칸은 더하지 않는다. 0007 뒤 비움으로 만든 세션은 `first_cwd`가 있어 다시 판단하지 않는다.
  3. 0007 전 세션인데 transcript도 `first_cwd`도 없으면 20처럼 `TRANSCRIPT_UNREADABLE` 실패로 남긴다.
  4. `ancestor`·`sibling`의 워크트리 행 경로는 원래 cwd다(티켓 본문). `cwd`는 지금처럼 저장소 꼭대기.
  5. 불변 규칙은 표 재생성 대신 트리거로 강제한다(sessions는 많은 표가 가리킨다).
  6. doctor `untagged`는 `warn`이 아니라 `ok`다(레포 밖 세션은 정상).
- Decision(2026-10-22, 사용자): B — 꼬리표 근거를 세션을 시작한 폴더로 하고 `first_cwd`에 저장한다. 다른 안이었던 A(규칙 그대로, 4개는 비움)와 C(바로 위가 없으면 더 위에서 형제 찾기)는 고르지 않았다. 새 칸은 더하지 않는다.

**Never:**
- 기존 꼬리표·`tag_source`·`first_cwd` 바꾸기(null → 값만), 프로젝트·워크트리 행 지우기나 고치기, 0001~0006 수정, Postgres(epic 7), 코드 표에 새 오류·경고 코드.
- 폴더 이름으로 프로젝트 만들기, 바로 위보다 더 위에서 형제 찾기, 도구별 폴더 규칙.
- 셸을 거치는 git, 네트워크 git 명령, 프로세스 cwd를 근거로 쓰기, 테스트에서 실제 `~/.claude`·`~/.second_brain`·git 전역 설정 읽기나 바꾸기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 형제 같음 | `<p>/repo/wt-gone` 없음, `<p>/repo/wt-a`·`wt-b`가 같은 remote의 워크트리 | 그 프로젝트, 워크트리 경로 `<p>/repo/wt-gone`, `tag_source=sibling` | — |
| 저장소 안 | `<repo>/a/gone` 없음, `<repo>` 살아 있음 | `<repo>`의 프로젝트, `ancestor` | — |
| 하위 폴더 메시지 | transcript의 첫 cwd 줄(attachment)은 `<p>/repo/wt-gone`, 첫 메시지 cwd는 `<p>/repo/wt-gone/sub`, 둘 다 없음, 살아 있는 형제 같은 remote | `sibling`, `first_cwd`=`<p>/repo/wt-gone`, 워크트리 경로 `<p>/repo/wt-gone` | — |
| 시작 폴더 읽기 | 서브에이전트 줄이 먼저 cwd를 갖고, 다음 줄이 세션 cwd / cwd 줄이 메시지뿐 / 커서 뒤만 읽음 | 서브에이전트 줄은 건너뜀 / 첫 메시지 cwd / 내용 전체의 처음 것 | — |
| 형제 갈림 | 부모 아래 다른 remote의 checkout 둘(`git worktree add ../x` 배치) | 꼬리표 null, `tag_source` null, `first_cwd` 있음 | — |
| 형제 없음 | 부모에 checkout 아닌 폴더만, 또는 빈 부모 | null | — |
| 로컬 형제 | remote 형제 하나 + remote 없는 레포 형제 하나 | null | — |
| 부모도 없음 | 원래 폴더의 바로 위까지 지워짐 | null | — |
| 형제 무응답 | 형제 하나의 inspect가 `unknown` | 꼬리표 null, `session_identity` 일감 열림, 처리 때도 무응답이면 `REPOSITORY_UNANSWERED`로 다시 시도 | — |
| 살아 있는 cwd | cwd가 checkout | 지금과 같은 꼬리표, `tag_source=cwd`, `first_cwd`=cwd | — |
| 꼬리표 있음 | 꼬리표 있는 세션 | 꼬리표·출처 그대로, 다시 판단 일감 없음 | — |
| 마이그레이션 | 버전 6 DB에 꼬리표 있는/없는 세션 | 버전 7, 있는 행 `tag_source=cwd`, 없는 행 null, 꼬리표·건수 그대로 | — |
| 다시 판단 | 0007 뒤 꼬리표 없고 `first_cwd` null인 세션, transcript 있음 | drain 한 번에 일감 하나 → 판단·`first_cwd` 채움; 두 번째 drain은 일감을 만들지 않음 | — |
| transcript 지움 | `first_cwd`가 있는 꼬리표 없는 세션에 일감, transcript 없음 | `first_cwd`로 판단 | — |
| 증거 없음 | transcript·`first_cwd` 둘 다 없음 | `TRANSCRIPT_UNREADABLE` 실패 | — |
| 불변 | `tag_source`나 `first_cwd`를 다른 값으로 update | 트리거가 거부 | — |
| doctor | 꼬리표 없는 세션 2개 | `untagged` ok, `2건` | — |

</intent-contract>

## Code Map

- `packages/core/src/ports/repository.ts` -- `InspectResult`의 `missing`, `FolderListing`, `listFolders`. `ports/index.ts`·`packages/core/src/index.ts` export.
- `packages/core/src/sessions/ingest.ts` -- `checkoutFor`(약 592행)·`checkoutInput`·`firstCwd`는 20이 수집과 handler에 공유했다; 추정은 여기서 같은 길로 공유한다(복붙 금지). ensure 호출(약 413행)에 `firstCwd`·`tagSource`. 머리 주석의 cwd 규칙 문단.
- `packages/core/src/capture/session-identity-work.ts` -- 73행 handler 전체; transcript 없을 때 `session.firstCwd`로.
- `packages/core/src/brain.ts` -- `drain`(약 330행): `scanTranscripts` 뒤 다시 판단 일감 넣기. `BrainDrainReport`의 모양은 바꾸지 않는다(넣은 일감은 대기열 숫자에 잡힌다).
- `packages/core/src/domain/session.ts` -- `Session.firstCwd`·`tagSource`, `TagSource`.
- `packages/core/src/ports/store.ts` -- `EnsureSessionInput`(약 101행), `FillSessionTagsInput`, 새 읽기 둘의 입력·결과 타입. 주석의 "꼬리표 근거" 문단.
- `packages/core/src/doctor/doctor.ts` -- `failures` 점검(약 235행)을 본보기로 `untagged`.
- `packages/core/src/testing/fakes/{repository,store}.ts`, `testing/fixtures.ts`, `testing/contracts/session-store.ts` -- 가짜 inspector에 `missing`·`listFolders` 답 정하기, 가짜 store의 새 칸·읽기, 계약 사례(만들 때 두 칸, `fillSessionTags`의 `first_cwd`만 채움, 다시 판단 목록 조건, 꼬리표 없는 수). `packages/core/test/contracts.test.ts` 음성 가짜 하나 이상.
- `packages/core/test/` -- 추정 함수 단위 테스트(매트릭스 Core 행), `session-identity-work.test.ts`·`sessions-ingest`·`brain-drain`·`doctor` 사례.
- `packages/sqlite/migrations/0007_session_tag_source.sql`(새), `packages/sqlite/src/migrate.ts`(버전 7), `packages/sqlite/src/sessions.ts`(`ensureSession` 약 132행, `fillSessionTags`, `findSession` 행 매핑, 새 읽기), 새 `packages/sqlite/test/schema-0007.test.ts`(`schema-0006.test.ts` 본보기: 기존 행 보존·`cwd` 채움·트리거 거부). 스키마 버전 6을 박은 테스트(설치 흐름 등)는 7로.
- `apps/cli/src/runtime/git.ts` -- stat ENOENT·ENOTDIR → `missing`, `listFolders`(`readdir` withFileTypes + 링크는 stat). `apps/cli/test/runtime.test.ts`.
- `apps/cli/src/doctor/store.ts` 등 Store를 흉내 내는 곳 -- 새 읽기 스텁.
- `apps/cli/test/sessions-ingest.test.ts`(20이 쓴 임시 레포 helper `git`·`repositoryIn` 근처) -- CLI verify: 임시 부모 아래 `git worktree add`로 형제 둘 + 지운 워크트리 cwd의 transcript 수집 → `sibling`; 저장소 안 지운 하위 폴더 → `ancestor`; 다른 저장소 형제 → 비움; drain 다시 판단(버전 7 DB에 `first_cwd` null로 둔 행 + transcript) → 채워지고 두 번째 drain은 일감 0. 조회는 기존 테스트처럼 `node:sqlite`.
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- AD-12, Table Contract `sessions`. `README.md` -- 프로젝트 꼬리표 절, doctor 항목, 스키마 버전 언급.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/{ports/repository,ports/store,domain/session}.ts`, `index.ts` -- 포트·타입 -- 규칙의 모양을 Core 한 곳에.
- [x] `packages/core/src/sessions/{ingest,checkout-estimate}.ts`, `capture/session-identity-work.ts`, `brain.ts`, `doctor/doctor.ts` -- 추정, 수집, handler, 다시 판단, doctor.
- [x] `packages/core/src/testing/*`, `packages/core/test/*` -- 가짜·계약·매트릭스 Core 행.
- [x] `packages/sqlite/migrations/0007_session_tag_source.sql`, `packages/sqlite/src/{migrate,sessions}.ts`, `packages/sqlite/test/*` -- 마이그레이션·Store·계약 실행.
- [x] `apps/cli/src/runtime/git.ts`, `apps/cli/src/doctor/*`, `apps/cli/test/*` -- inspector, 스텁, CLI verify.
- [x] architecture AD-12·Table Contract, `README.md` -- 문서.

**Acceptance Criteria:**
- Given 임시 home과 같은 부모 아래 살아 있는 워크트리 둘(같은 remote)과 지운 워크트리 cwd의 transcript, when `brain sessions ingest claude-code --json`, then 그 세션의 프로젝트가 살아 있는 워크트리 세션과 같고 `tag_source = 'sibling'`이다.
- Given 버전 6 DB, when 0007을 적용하면, then 세션·프로젝트·워크트리 건수와 꼬리표가 그대로이고 꼬리표 있는 행만 `tag_source = 'cwd'`이다.
- Given 꼬리표 없는 세션이 있는 home, when `brain doctor run --json`, then `untagged` 점검이 그 수를 보인다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다(출력 언어 검사·README 코드 대조 포함).

## Implementation Notes

- 2026-10-21: `context: []`를 확인하고 계획 전체를 읽은 뒤 같은 작업 트리에서 직접 구현했다. BMad 스킬·커밋 없이 진행했고 `<intent-contract>`는 수정하지 않았다.
- 공통 `checkoutFor`에 missing → 조상 → 바로 위 형제의 정체성 일치 추정을 넣었다. 수집·지연 handler가 이를 공유하며, 직접 꼬리표는 저장소 꼭대기, 추정 꼬리표는 원래 cwd를 워크트리 경로로 쓴다.
- RepositoryInspector에 missing과 폴더 목록을 더했다. 실제 어댑터는 디렉터리 링크를 따라가고 끊어진 링크·파일을 제외하며 경로순으로 반환한다. 가짜도 목록과 무응답을 지정할 수 있다.
- 스키마 0007·버전 7, SQLite·메모리 Store의 첫 cwd·출처 저장 및 null에서만 채우기, 재판단 대상·꼬리표 없는 수 읽기를 구현했다. 기존 꼬리표를 cwd로 채우고 새 칸의 불변·출처 유효성·project null 일치를 트리거로 강제한다. 0001~0006은 그대로다.
- drain은 폴더 스캔 뒤 기존 identity 일감 이력이 없는 과거 세션을 예산 안에서 다시 판단한다. handler는 원본이 없으면 저장된 첫 cwd를 사용하고, 비움으로 끝나도 근거를 저장한다. 닫힌 일감은 자동으로 다시 열지 않는다. doctor에 untagged 진단을 더하고 README·AD-12·Table Contract를 갱신했다.
- 검증: `pnpm test` 전체 통과(빌드·타입 검사, 71개 파일·2,282개 테스트). 새 검증은 추정 매트릭스, Store 계약과 음성 가짜, transcript 삭제·근거 없는 영구 실패·한 번 재판단, 0006 → 0007 보존·트리거, 실제 임시 git 워크트리의 sibling·ancestor·갈림, CLI drain·doctor, 링크 목록을 포함한다. 출력 언어·README 코드 대조도 전체 실행에 포함됐다.
- 최초 샌드박스 실행은 Docker·로컬 리스너 접근 제한으로 전체 검증을 진행하지 못했으나, 권한이 있는 실행에서 Postgres를 포함한 전체 테스트를 통과했다. `git diff --check`와 새 diff의 절대 홈 경로 검사도 통과했다.
- 남은 수동 검증: 계획의 실제 DB 사본 검증은 코디네이터 담당으로 남겼다. 실제 home·transcript·git 전역 설정은 읽거나 고치지 않았으며 구현에서 알려진 미완료 항목은 없다.
- 코디네이터(2026-10-21, diff 검토 뒤 수정): `session-identity-work.ts`가 transcript에 cwd 줄이 없을 때 20의 "근거 없음은 성공으로 닫음"을 깨고 `TRANSCRIPT_UNREADABLE`로 실패시키고, 저장된 `first_cwd`가 있어도 null로 덮었다. `firstCwd(parsed) ?? 저장값`으로 고치고 둘 다 없으면 성공으로 닫는다. 워커가 이 동작에 맞춰 바꾼 기존 테스트 기대값(`closes successful empty branch no_cwd`)을 원래대로 `{ok: true}`로 되돌렸다. README 설치 출력 예시의 `store.path` 하나가 `~/`로 바뀌어 같은 예시의 다른 경로(`/Users/me/…`)와 어긋나 되돌렸다. 다시 돌린 `pnpm test`: 71파일 2,282건 통과, `git diff --check` 통과.
- 코디네이터 실제 DB 사본 검증(2026-10-21): `~/.second_brain/brain.db`를 `.backup`으로 임시 home에 복사하고 새 빌드로 0006 → 0007을 적용한 뒤 실제 `~/.claude`(읽기만)로 `queue drain`을 여섯 번 돌렸다. 첫 drain이 다시 판단 일감 39개 + 스캔 3개를 처리했고, 이후 다섯 번은 일감 0(한 번만 다시 판단). 원래 꼬리표 없던 39개 결과: `sibling` 26, 빈 채 13(모두 `first_cwd` 있음), `ancestor` 0, 미해결 실패 0. 원래 꼬리표 있던 243개(사본 시점 이후 스캔분 포함)는 모두 `cwd`로 그대로. 빈 13개: 살아 있는 레포 밖 폴더 6(홈·`~/Github`·임시 폴더), 바로 위 폴더가 비어 있음 3(티켓 Decision의 "이 기계에서 3개"), 바로 위 폴더까지 지워짐 4. **기대값 30과 어긋난다.** 4개는 transcript의 첫 줄(attachment)들이 워크트리 꼭대기 cwd를 갖지만, parser가 남기는 cwd 있는 첫 메시지(AD-12·22의 근거)는 이미 그 워크트리 안의 하위 폴더(`<worktree>/_bmad-output` 등)에 있다. 규칙대로면 원래 폴더의 바로 위(지워진 워크트리)가 없으므로 비운다. 2.25를 정할 때의 대화는 "하위 폴더에서 연 세션이 워크트리째 지워진 경우는 33개 중 0개"를 전제로 30을 셌는데, 저장된 근거로 다시 세면 4개다.



- 워커(2026-10-22, 사용자 결정 B 반영): 계획 전체와 `context: []`를 확인하고 기존 구현에서 변경분만 더했다. `ParseResult.startCwd`와 Claude Code parser의 전체 내용 첫 cwd 조회를 추가했다. 메시지가 아닌 attachment·hook 줄도 읽고 `isSidechain: true`·빈 값은 제외하며, 커서와 무관하게 같은 값을 반환한다. 메시지·도구 메모의 규칙과 parser 버전 4는 그대로다.
- 수집과 identity handler는 `startCwd ?? firstCwd(messages)`를 공통 근거로 삼아 직접 조회·추정을 시작하고 `first_cwd`에 보존한다. handler의 저장된 근거 fallback과 근거 없는 읽기는 성공으로 닫는 기존 동작을 유지했다. 메모리 parser·parser 계약·직접 만드는 parser mock, README와 AD-12를 함께 갱신했다. 0007·추정 알고리즘·기존 꼬리표의 불변 규칙은 바꾸지 않았다.
- 회귀 검증: 서브에이전트·빈 cwd 제외, 메시지 앞의 시작 폴더, 메시지만 있는 경우·근거 없음, 커서로 꼬리만 읽어도 같은 시작 폴더, 수집·handler 양쪽의 시작 폴더 우선, 저장값 fallback, 실제 임시 git 워크트리에서 첫 메시지 cwd가 지워진 하위 폴더여도 시작 폴더로 `sibling`을 채우는 사례를 추가했다.
- 검증 결과: 샌드박스 실행은 Docker 접근 제한으로 테스트 시작 전 중단됐고 빌드·타입 검사는 통과했다. 권한이 있는 `pnpm test`는 71파일·2,287건을 통과했다. 그 실행 뒤 추가한 저장값 fallback 사례와 parser의 줄당 한 번 읽기까지 반영한 최종 빌드·타입 검사 및 Postgres 외 전체 재검증(`pnpm exec vitest run --project core --project claude-code --project sqlite --project cli --project second_brain --project bootstrap --project test-db`)도 68파일·2,205건 통과했다. 출력 언어·README 코드 대조가 포함됐고 `git diff --check`도 통과했다.
- 남은 범위: 실제 DB 사본의 30/33 재검증은 코디네이터 담당이다. 이번 실행은 실제 home·transcript·git 전역 설정을 읽거나 변경하지 않았고, BMad 스킬·커밋·`<intent-contract>` 수정 없이 마쳤다. 위 Auto Run Result의 과거 blocked 기록은 이번 변경 전 사본 검증에 관한 기록으로 남긴다.


## Plan Change Log

- 2026-10-22, 사용자 결정 B(실제 DB 사본 검증 26/33 뒤): 꼬리표 근거를 cwd가 있는 첫 메시지에서 "세션을 시작한 폴더"(cwd가 있는 첫 줄, 없으면 첫 메시지)로 바꿨다. parser 결과 `startCwd`, 수집·handler의 근거 폴더, `first_cwd`의 값, AD-12 문서, 매트릭스 두 행, Decision 하나를 고쳤다. 피하는 나쁜 상태: 첫 메시지 전에 하위 폴더로 들어간 세션이 워크트리째 지워지면 추정할 수 없음(이 기계 4개). KEEP: 지금 작업 트리의 구현(추정 함수, 0007과 트리거, 다시 판단, doctor, 코디네이터가 고친 handler의 "근거 없음은 성공")은 그대로 두고 이 차이만 더한다.

## Review Triage Log

### 2026-10-22 — Review pass
- 리뷰어: quick 렌즈, Orca orchestration의 codex 워커(사용자 지시), run `run_b702b8f509da`.
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` 겹친 drain 둘이 같은 후보를 읽은 뒤 한쪽이 일감을 닫고 나서 다른 쪽이 `addWork`하면, 닫힌 행은 열린 키 색인에 걸리지 않아 같은 세션의 `session_identity` 일감이 하나 더 생긴다(`packages/core/src/brain.ts` 다시 판단 루프, `packages/sqlite/src/work.ts` `ensureWork`) — 재현됨. 하지만 두 번째 판단은 같은 결과를 낸다(꼬리표·`first_cwd`는 null에서만 채움, 이미 꼬리표가 있으면 그대로 성공). transcript도 근거도 없는 경우 같은 실패 행의 `occurrences`가 1 오를 뿐이다. 후보는 0007 직후의 과거 세션뿐이고, 그 판단이 끝나면 후보에서 빠지므로 세션당 많아야 한 번 더다. 고치려면 `addWork`에 "이력이 없을 때만" 옵션이나 새 Store 동사가 필요하다(공개 표면 추가).

## Design Notes

추정을 Core에 두는 이유: "형제가 모두 같은 정체성"의 판단은 `identity_key`(Core 함수)로 해야 SQLite와 가짜가 같은 답을 내고, 가짜 inspector로 매트릭스를 Core 테스트에서 돌릴 수 있다. 어댑터는 사실(있음·없음·폴더 목록·git 답)만 준다.

```ts
// missing cwd only
up = parent(cwd); while (up) { r = inspect(up); if (r.kind !== 'missing') break; up = parent(up); }
if (r is checkout) return { ...checkoutInput(r.checkout), worktreePath: cwd, source: 'ancestor' };
listing = listFolders(parent(cwd));   // only the immediate parent
keys = siblings.filter(checkout).map(identityKey); all equal && ≥1 → 'sibling'
```

다시 판단을 마이그레이션 안에서 일감 행으로 넣지 않는 이유: 일감 id는 Core가 만드는 UUIDv7이고(AD-8), 0007 뒤에 만들어진 세션도 같은 조건으로 걸러지므로 drain 한 곳이 더 단순하다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과
- `git diff --check` 와 `git grep -nE "/Users/" -- packages apps` -- expected: 공백 오류 없음, 새로 넣은 절대 홈 경로 없음

**Manual checks (if no CLI):**
- 실제 DB 사본(코디네이터): `~/.second_brain`의 `brain.db`·`config.toml`을 임시 home으로 복사하고, 새 빌드로 0007을 적용한 뒤 실제 `~/.claude`(읽기만)로 `queue drain`을 충분히 돌린다. 원래 꼬리표 없던 39개 중 지운 워크트리 세션 33개에서 30개가 `ancestor`·`sibling`으로 채워지고(빈 3개는 바로 위 폴더가 비어 있음), 원래 꼬리표 있던 세션은 그대로이며, `first_cwd`가 꼬리표 없는 세션에도 남는다. 실제 home은 건드리지 않는다.

## Auto Run Result

Status: built

**바뀐 것.**
- 꼬리표 근거는 세션을 시작한 폴더다: parser 결과 `startCwd`(서브에이전트 줄을 뺀, cwd가 있는 첫 줄. 메시지 아닌 줄 포함, 커서와 무관), 없으면 cwd가 있는 첫 메시지(사용자 결정 B, 2026-10-22). parser 버전은 그대로.
- 근거 폴더가 없을 때만 추정: 처음 남은 위 폴더가 저장소 안이면 `ancestor`, 아니면 바로 위 폴더의 형제 checkout이 모두 같은 `identity_key`면 `sibling`(워크트리 경로는 원래 폴더). 바로 위가 없거나 비었거나 갈리면 비우고, 형제 하나라도 답이 없으면 20의 일감으로 미룬다. 도구·폴더 이름은 코드에 없다.
- 마이그레이션 0007(버전 7): `sessions.tag_source`·`first_cwd`, 기존 꼬리표 행은 `cwd`, 트리거가 값 집합·project와의 null 일치·null → 값만을 강제한다.
- drain이 0007 전의 꼬리표 없는 세션(`first_cwd` 없음, `session_identity` 이력 없음)을 한 번 다시 판단한다. handler는 transcript가 없으면 저장된 `first_cwd`로 판단하고, 비움으로 끝나도 근거를 저장한다.
- doctor `untagged`(늘 `ok`, `N건`).

**파일.**
- `packages/core/src/ports/{repository,parser,store}.ts`, `domain/session.ts` — `missing`·`listFolders`, `startCwd`, 새 입력·읽기, `TagSource`
- `packages/core/src/sessions/ingest.ts` — 근거 폴더와 추정(`checkoutFor`), `first_cwd`·`tag_source` 쓰기
- `packages/core/src/capture/session-identity-work.ts` — 저장된 근거로 판단, 근거 보존
- `packages/core/src/brain.ts`, `doctor/doctor.ts` — 한 번 다시 판단, `untagged`
- `packages/core/src/testing/*` — 가짜 inspector·parser·store, 계약 사례
- `packages/claude-code/src/parser.ts` — `readStartCwd`
- `packages/sqlite/migrations/0007_session_tag_source.sql`, `packages/sqlite/src/{migrate,sessions}.ts` — 스키마와 Store
- `apps/cli/src/runtime/git.ts`, `apps/cli/src/doctor/store.ts` — 없는 폴더·폴더 목록, 스텁
- 테스트: `packages/core/test/{checkout-estimate,session-identity-work,doctor,contracts,capture-scan}.test.ts`, `packages/claude-code/test/parser.test.ts`, `packages/sqlite/test/schema-0007.test.ts` 외 버전 7 반영, `apps/cli/test/{sessions-ingest,runtime,doctor-run,dispatch,setup,install-store}.test.ts`
- `README.md`, architecture AD-12·Table Contract

**리뷰.** quick 렌즈 1회(codex, Orca). 지적 1건: patch 0, defer 0, reject 1(low — 겹친 drain이 같은 세션을 한 번 더 판단할 수 있음; 결과가 같고 고치려면 Store 표면이 늘어남).

**후속 리뷰 권고:** `false`. 이번 패스에서 patch한 항목이 없다(high 0, medium 0, low 0).

**검증.**
- `pnpm test`(build·typecheck·vitest) 통과 — 71파일 2,288건(메인 세션에서 다시 돌림). `git diff --check` 통과, 새 diff에 절대 홈 경로 없음.
- 매트릭스 17행 모두 실행된 테스트가 덮는다(추정 Core 사례, 시작 폴더 parser 사례와 커서 사례, CLI 실제 임시 git 워크트리 sibling·ancestor·갈림·시작 폴더, 0007 보존·트리거, 다시 판단·transcript 지움·근거 없음, doctor).
- 실제 DB 사본(코디네이터, 2026-10-22): `brain.db`를 임시 home으로 `.backup`, 0006 → 0007, 실제 `~/.claude`(읽기만)로 drain 세 번. 원래 꼬리표 없던 39개 → `sibling` 30, 빈 채 9(레포 밖 폴더 6, 바로 위 폴더가 빈 3), 모두 `first_cwd` 있음. 기존 꼬리표 행은 모두 `cwd`로 그대로, 미해결 실패 0, 세 번째 drain 일감 0, doctor `untagged` `9건`. 사본은 지웠고 실제 home은 건드리지 않았다.
- 첫 시도(2026-10-21)는 같은 사본 검증에서 26/33이라 blocked로 멈췄고, 사용자가 B를 골라 다시 구현했다(Plan Change Log).

**에이전트가 대신 내린 결정**(intent-contract Decision 1~6): 로컬 형제는 공통 디렉터리 정체성, "한 번"의 표식은 일감 이력과 `first_cwd`, 0007 전 근거 없는 세션은 `TRANSCRIPT_UNREADABLE`, 추정 워크트리 경로는 원래 폴더, 트리거로 불변 강제, doctor `untagged`는 `ok`. 코디네이터가 handler의 "transcript에 cwd가 없으면 성공으로 닫음"(20 동작)을 되살리고 그에 맞춰 바뀌었던 테스트 기대값을 되돌렸다.

**남은 위험.**
- 겹친 drain의 한 번 더 판단(위 reject).
- 처음 남은 위 폴더가 저장소이면 그 저장소로 붙는다(예: 홈 폴더가 dotfiles 저장소인 기계). 규칙 그대로의 결과다.
- 형제가 많은 부모(임시 폴더 등)에서는 형제마다 git을 부르므로 수집이 느려질 수 있다. 실시간 수집은 폴더가 살아 있어 이 길을 타지 않는다.
- 에픽 파일 E2-6과 Decision(2026-10-15·20)의 "cwd가 있는 첫 메시지의 cwd가 유일한 근거" 문구는 B와 어긋난다. 빌드는 티켓 파일을 고치지 않으므로 사람이 맞춰야 한다.
