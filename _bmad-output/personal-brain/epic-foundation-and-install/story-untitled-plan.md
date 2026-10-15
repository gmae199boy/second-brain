---
title: '설치 진입점: 내려받기와 빌드'
type: 'feature'
ticket: '5'
created: '2026-10-13'
status: done
baseline_revision: 'd824e47c267dc99e9fe8eeb6c6dab86ed843055d'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 빈 Mac에서 Brain을 설치할 진입점이 없다. `npx github:gmae199boy/second-brain`을 쳐도 실행할 것이 없고, 저장소를 받아 빌드해 설치기에 넘기는 경로가 없다.

**Approach:** 의존성 없는 빌드된 단일 진입 파일(커밋됨)을 루트 `package.json`의 `bin`으로 노출한다. 그 파일이 환경(node≥24, git)을 확인하고, 저장소를 `<home>/app`에 clone(있으면 fast-forward 갱신)하고, pnpm이 없거나 12 미만이면 최신 설치를 묻고, `pnpm install`·`pnpm build` 후 빌드된 설치기 진입 파일을 같은 터미널에서 실행한다. 설치기 본문(의존성·DB·설정)은 story 6이 채우고, 이번에는 시작 화면만 낸다.

## Boundaries & Constraints

**Always:**
- 루트 `package.json`에 `dependencies`·`prepare`(및 npm이 git 의존에서 빌드를 일으키는 lifecycle script) 없음. 기존 경계 테스트(c)가 계속 통과.
- 진입 파일은 Node 내장 모듈만 쓴다(`node:child_process`, `node:readline/promises`, `node:fs`, …). TS 원본에서 tsc로 만든 단일 JS 파일이고 저장소에 커밋된다. 원본과 커밋본이 어긋나면 테스트가 실패한다.
- `<home>`은 `SECOND_BRAIN_HOME`이 있으면 그 값, 없으면 `~/.second_brain`(story 4의 `configHome`과 같은 규칙). 저장소 URL은 기본 `https://github.com/gmae199boy/second-brain.git`, `SECOND_BRAIN_REPO`로 바꿀 수 있다(테스트·포크용).
- 외부 명령은 `spawn`의 인자 배열로만 실행(셸 문자열 금지). 단계마다 무엇을 하는지 한 줄 출력.
- 묻는 것은 TTY일 때만. TTY가 아니면 "아니오"로 보고 직접 할 명령을 안내하고 종료.
- 공개 저장소 위생: 회사 이름·실제 대화 없음.
- Decision(2026-10-13, 사용자): pnpm 정확한 버전 고정을 푼다. 루트 `packageManager` 필드를 지우고 `engines.pnpm: ">=12"`만 둔다(고정이 남으면 최신 pnpm도 12.10.1로 전환하려다 ENOEXEC). lockfile은 다시 만든다. architecture Stack 표의 pnpm 행과 epic 1 Notes의 pnpm 결정도 "12 이상, 설치 시 최신"으로 고친다.
- Decision(2026-10-13, 사용자): pnpm이 없거나 major가 12 미만이면 동의를 묻고 `npm install -g pnpm@latest`로 설치·갱신한다.
- Decision(2026-10-13, 사용자): 수락은 로컬 `git+file://` 대리 실측까지. push와 실제 `npx github:` 실행은 이 story에서 하지 않는다.
- Decision(2026-10-13, 사용자): 플랜 크기(약 3,000 토큰)는 단일 목표이므로 분할하지 않는다.

**Never:**
- 설치기 본문: 의존성(Docker) 설치, DB, config·.env 기록, 마이그레이션, shim, connector(story 6·7). `brain setup run` 명령 등록(story 7).
- 이미 있는 `<home>/app`의 로컬 변경을 지우거나 reset·force하는 것.
- npm 발행, corepack에 기대는 것.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 설치 | `<home>/app` 없음, pnpm ≥ 12 있음 | clone → install → build → 설치기 시작 화면, exit 0 | — |
| 재실행 | `<home>/app`이 같은 origin의 깨끗한 clone | `git pull --ff-only` 후 install·build·설치기 | — |
| 앱 폴더 오염 | 로컬 변경 있음, 또는 ff 불가 | 아무것도 바꾸지 않고 이유와 직접 할 명령을 보이고 exit 1 | — |
| 다른 것이 있음 | `<home>/app`이 git 저장소가 아니거나 origin이 다름 | 건드리지 않고 exit 1 | — |
| pnpm 없음·낮은 버전 | `pnpm` 없음 또는 major < 12 | 최신 설치를 묻는다. 동의 → `npm install -g pnpm@latest` 후 계속, 거절·비TTY → 명령 안내, exit 1 | 설치 실패 시 exit 1 |
| pnpm 12 이상 | `pnpm --version` ≥ 12 | 묻지 않고 그대로 쓴다 | — |
| 필수 도구 없음 | node<24 또는 git 없음 | 무엇이 없는지와 설치 방법 한 줄, exit 1 | clone 전에 멈춤 |
| 단계 실패 | clone·install·build가 0 아닌 코드 | 실패한 단계 이름과 코드, exit 1 | 자식 출력은 그대로 터미널에 |
| 설치기 종료 코드 | 설치기가 n으로 끝남 | 진입 파일도 n으로 끝남 | — |

</frozen-after-approval>

## Code Map

- `package.json`(루트) -- `bin`(이름 `second-brain`)과 `files`(진입 파일만)를 더하고, `packageManager`를 지우고 `engines.pnpm: ">=12"`를 더한다. `scripts`에 lifecycle 이름(`prepare`·`prepack`·`install`·`postinstall`)을 두지 않는다.
- `pnpm-lock.yaml` -- `packageManagerDependencies`(pnpm@12.10.1 exe들)가 들어 있다. 필드를 지운 뒤 `pnpm install`로 다시 만든다.
- `README.md` -- "pinned to 12.10.1 through packageManager" 문단을 고친다.
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` Stack 표 pnpm 행, `epic-foundation-and-install.md` Notes의 pnpm Decision -- "12 이상, 설치 시 최신"으로.
- `packages/second_brain/test/` -- 경계 테스트(c) "루트 `dependencies`·`prepare` 없음"이 있다. 그대로 둔다.
- `apps/cli/src/config/paths.ts` -- `HOME_ENV`·`DEFAULT_HOME_FOLDER` 규칙. 진입 파일은 의존 없이 같은 규칙을 다시 쓴다(import 불가). 상수 값이 같은지 테스트로 묶는다.
- `apps/cli/src/dispatch.ts` -- 모든 명령이 config를 읽고 DB에 연결한다. 그래서 설치기는 디스패처를 거치지 않는 별도 진입 파일(`apps/cli/src/install.ts` → `dist/install.js`)로 둔다.
- `vitest.config.ts` -- `test/`가 있는 패키지를 자동으로 project로 잡는다. 새 패키지에 `test/`만 두면 된다.
- `tooling/test-db/` -- 패키지 형태(private, ESM, typescript 7.0.2 devDep, `tsc -p`)의 본보기.
- 환경: Node 24.16.0, npm 11.13.0, git 2.54, 전역 pnpm 10.34.4(nvm 아래), npm 최신 pnpm 12.11.2. 구현 중 이 Mac의 전역 pnpm을 올리는 것은 사용자 승인됨(질문 답).
- npm의 git 의존 동작(검증 대상): `prepare`가 없으면 clone한 저장소를 빌드 없이 pack(`files` 적용)해 bin만 연결한다. 실측은 push 없이 `npx --yes git+file://<임시 bare repo>`로 한다.

## Tasks & Acceptance

**Execution:**
- [x] `tooling/bootstrap/` -- 새 workspace 패키지. `src/bootstrap.ts`(단일 파일, import는 `node:`만), `tsconfig.json`(outDir `bin`, `types:["node"]`), `package.json`(build = tsc → `bin/second-brain.js`, 실행 권한·shebang). `bin/second-brain.js`는 `.gitignore`의 `dist/`에 걸리지 않으므로 커밋된다 -- 의존 없는 진입 파일
- [x] `tooling/bootstrap/src/bootstrap.ts` -- `main(argv, env, deps)`: 환경 확인 → 앱 폴더 clone/갱신 → pnpm 확인(major ≥ 12)·최신 설치 질문 → `pnpm install --frozen-lockfile` → `pnpm build` → `node <app>/apps/cli/dist/install.js` 실행, 종료 코드 전달. `deps`(run·ask·isTTY·log)를 주입받아 테스트 가능하게 -- I/O 표 전부
- [x] `apps/cli/src/install.ts` -- 설치기 진입 파일. 시작 화면(이름·버전·`<home>`)과 "다음 단계는 준비 중" 한 줄, exit 0. config·DB를 읽지 않는다 -- 넘겨받을 자리
- [x] `package.json`(루트), `pnpm-lock.yaml` -- `bin`·`files`·`engines.pnpm` 추가, `packageManager` 삭제, lockfile 재생성 -- npx 진입과 고정 해제
- [x] architecture Stack 표, epic 1 Notes -- pnpm 고정 결정을 사용자 결정대로 고친다 -- 문서와 코드 일치
- [x] `tooling/bootstrap/test/bootstrap.test.ts` -- 주입한 가짜 `run`/`ask`로 I/O 표의 각 행(명령 순서, 묻는 조건, exit 코드, 오염 시 무변경). 커밋된 `bin/second-brain.js`가 원본 빌드 결과와 같은지, `node:` 외 import가 없는지, 루트 `package.json`에 lifecycle script가 없는지 -- 회귀 고정
- [x] `tooling/bootstrap/test/npx.test.ts` -- 작업 트리를 임시 bare repo에 커밋하고, 임시 `SECOND_BRAIN_HOME`·`SECOND_BRAIN_REPO=file://…`로 `npx --yes git+file://…`를 실행해 `<home>/app/apps/cli/dist/bin.js`가 생기고 설치기 시작 화면이 출력되는지 확인(느린 통합 테스트, 타임아웃 넉넉히) -- unknown 실측
- [x] `README.md` -- 설치 한 줄(`npx github:gmae199boy/second-brain`)과 `SECOND_BRAIN_HOME`·`SECOND_BRAIN_REPO`, pnpm 문단 수정 -- 사용 안내

**Acceptance Criteria:**
- Given 임시 `SECOND_BRAIN_HOME`과 로컬 bare repo, when `npx --yes git+file://<repo>`, then npm이 의존성 설치 없이 진입 파일을 실행하고 `<home>/app`이 빌드되어 설치기 시작 화면이 뜬다.
- Given 같은 상태에서 다시 실행, when 진입 파일이 돈다, then clone 대신 갱신하고 결과가 같다.
- Given `pnpm test`, then 기존 테스트와 새 테스트가 모두 통과한다.

## Implementation Notes

- unknown 해소(실측, `tooling/bootstrap/test/npx.test.ts`): `prepare`가 없으면 npm은 git 저장소를 clone해 `files`만 pack하고 bin을 연결한다. 의존성 설치도 빌드도 없다. pack 내용은 `package.json`·`README.md`·`tooling/bootstrap/bin/second-brain.js` 세 개뿐(`npm pack --dry-run`으로 확인). 루트 `package.json`의 bin이 객체 하나뿐이면 패키지 이름(`second-brain-workspace`)과 bin 이름(`second-brain`)이 달라도 npx가 그 하나를 실행한다.
- 루트 `package.json`에 `version: "0.0.0"`을 더했다. 없으면 `npm pack`이 `Invalid package, must have name and version`으로 거절한다(npx의 git 경로는 version 없이도 돌았지만, 같은 manifest를 두 도구가 다르게 받아들이는 상태로 둘 이유가 없다).
- tsc는 `outDir`를 파일 이름까지 정하지 못하므로 build는 `tsc` 뒤에 `mv bin/bootstrap.js bin/second-brain.js && chmod +x`를 붙였다. 이 패키지만 `declaration`·`sourceMap`을 끈다 — 커밋되는 산출물이 한 파일이어야 하기 때문.
- 진입 파일과 설치기 모두 "node가 이 파일을 직접 실행했는가"를 `realpathSync`로 양쪽 비교해 판단한다. Mac의 `/tmp`는 symlink이고 npm은 bin을 `node_modules/.bin`에 링크하므로, 경로 문자열 비교로는 어긋난다.
- 테스트의 임시 bare repo는 `git clone --bare`가 아니라 `git init --bare` + `git push`로 만든다. 로컬 bare clone은 object 파일을 hardlink하는데, 이 머신에서 그 결과가 `bad tree object`로 읽히지 않는 저장소가 나왔다.
- `pnpm --version`은 clone 뒤에, 그 clone을 cwd로 실행한다. 그래야 clone 안에 남은 `packageManager` 고정도 같이 걸린다.
- 전역 pnpm을 10.34.4 → 12.11.2로 올렸다(사용자 승인). lockfile은 지우고 다시 만들었고, 빠진 것은 `packageManagerDependencies`와 `@pnpm/exe.*`·`pnpm@12.10.1` 항목뿐 — 다른 의존성 버전은 그대로다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-13, lens: quick) — high 0 / medium 3 / low 8 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `prepareApp`의 `rev-parse --is-inside-work-tree`가 조상 저장소에 답해, 비어 있는 `<home>/app`이 같은 origin의 clone 안에 있으면 조상을 pull한다 | medium | patch | 리뷰어 재현(조상 HEAD가 ff됨). `git -C`는 위로 올라간다. `--show-toplevel`을 `<app>` realpath와 비교 |
| 2 | 상대 경로 `SECOND_BRAIN_HOME`이면 설치기 경로가 `cwd: app` 기준으로 두 번 붙는다 | medium | patch | 재현: `h3/app/h3/app/apps/cli/dist/install.js` 없음, exit 1. `app`을 절대 경로로 |
| 3 | `npm install -g pnpm@latest` 뒤 PATH의 pnpm을 다시 확인하지 않아 옛 pnpm이 앞에 있으면 원인 없이 `pnpm install failed`만 보인다 | medium | patch | 코드 확인: 설치 성공 후 바로 install. 버전 재확인 한 번 |
| 4 | 캡처하는 git 탐침이 stderr를 버려 실패 이유가 안 보인다 | low | patch | `stdio: ['ignore','pipe','ignore']`. stderr를 inherit로 |
| 5 | `tsc && mv` 사이 중단 시 clone에 `bin/bootstrap.js`가 남아 다음 실행이 "local changes"로 멈춘다 | low | patch | `.gitignore`가 `bin/`을 안 덮음. 한 줄 ignore |
| 6 | `sameRepo` 주석이 모든 철자를 같게 본다고 하나 `git@` 형식은 다루지 않는다 | low | patch(주석만) | 코드 확인. 거절은 안전한 쪽(clone은 늘 https로 만든다)이라 동작은 두고 주석만 좁힌다 |
| 7 | npx 테스트 두 번째가 첫 번째 실행에 기댄다 | low | 거절 | 개발자가 `-t`로 단독 실행할 때만 만남. 고치려면 테스트 구조 변경 |
| 8 | "node: 외 import 없음" 정규식이 side-effect·여러 줄·동적 import를 못 잡는다 | low | 거절 | 현재 두 파일 모두 깨끗함. 일상에서 만나기 어렵고 수정은 파서 수준 |
| 9 | `install.ts`가 `apps/cli`의 version을 `second-brain` 이름으로 보인다, 단위 테스트 없음 | low | 거절 | 둘 다 0.0.0이라 차이 없음. 어느 버전을 보일지는 story 6·7 설계 몫 |
| 10 | `tickets.toml` story 5 설명에 `pnpm@12.10.1`이 남았다 | low | defer | 빌드는 티켓 파일에 쓰지 않는다(규칙). deferred-work에 기록 |
| 11 | 플랜 파일 이름이 `story-untitled-plan.md` | low | 거절 | 이름은 `tickets.py find`가 정한 경로이고, 고치려면 이 빌드의 플랜을 옮겨야 한다 |

경로 요약: intent_gap 0, bad_plan 0, patch 6(1~6), defer 1(10), 거절 4(7·8·9·11).

패치 6건 적용 후 재검증(2026-10-13): compose PG로 `pnpm test` 14개 파일·292개 통과(bootstrap 47개, npx 실측 포함).

## Design Notes

- 설치기를 디스패처 밖 진입 파일로 둔 이유: 설치 시점엔 config가 없어 디스패처가 `CONFIG_MISSING`으로 끝난다. story 7이 `brain setup run`을 같은 함수에 연결한다.
- `files`로 pack 범위를 진입 파일 하나로 줄인다. npx 캐시에 workspace 전체가 들어가지 않게 한다. 실제 코드는 진입 파일이 clone한 `<home>/app`에서만 빌드된다.
- 갱신은 `git pull --ff-only`만. 사람이 앱 폴더를 고쳤다면 Brain이 판단하지 않는다.

## Verification

**Commands:**
- `pnpm test` (최신 pnpm, compose PG + `BRAIN_TEST_DATABASE_URL`) -- expected: 전 프로젝트 통과
- `node tooling/bootstrap/bin/second-brain.js` with `SECOND_BRAIN_HOME=$(mktemp -d)`·`SECOND_BRAIN_REPO=file://<bare>` -- expected: clone·build·설치기 시작 화면, exit 0
- `git status --short` -- expected: `tooling/bootstrap/bin/second-brain.js`만 새로 추적, `dist/`·`node_modules/` 없음
