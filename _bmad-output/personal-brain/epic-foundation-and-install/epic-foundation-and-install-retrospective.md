---
epic: epic-foundation-and-install
date: 2026-10-15
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# 회고: epic 1 기반과 설치


## Epic summary

- 에픽: `epic-foundation-and-install`(epic 1 기반과 설치). `tickets.py status`: 13/13 done, `pending_tickets` 없음, `built`에 머문 티켓 없음(2026-10-15 사용자 요청으로 `mark done`, 커밋 `09c2a6f`).
- 기준: 에픽 파일의 Done when 1~6(declared). 사용자가 무게를 둔 곳: 설치기·설정 흐름, 미룬 작업의 양.
- 범위: 저장소 코드만(`_bmad`·`_bmad-output`·`.agents`·`.claude`·lockfile 제외) `06c7ac6..149974f` — 157개 파일, +21,766 / −21.

| 티켓 | 플랜 | 범위(baseline → 다음 baseline) | 커밋 | 비고 |
| --- | --- | --- | --- | --- |
| 1.1 | story-tracer-workspace-doctor-plan.md | 06c7ac6..1d0a80e | 3 | `1d0a80e`(BMad 갱신)이 범위에 섞임 |
| 1.2 | story-core-port-plan.md | 1d0a80e..780610f | 2 | |
| 1.3 | story-trigger-plan.md | 780610f..7e9b555 | 1 | |
| 1.4 | story-cli-plan.md | 7e9b555..d824e47 | 1 | |
| 1.5 | story-untitled-plan.md | d824e47..8a05aec | 1 | |
| 1.6 | story-db-plan.md | 8a05aec..2f6c25f | 1 | |
| 1.7 | story-shim-connector-plan.md | 2f6c25f..2afd31c | 4 | correct-course 문서 커밋 3개(`9a12d04`·`47760fb`·`2afd31c`)가 범위에 섞임 |
| 1.10 | story-sqlite-store-plan.md | 2afd31c..7eeadaf | 1 | |
| 1.11 | story-sqlite-trigger-plan.md | 7eeadaf..cc77697 | 1 | |
| 1.12 | story-untitled-12-plan.md | cc77697..a9a233a | 1 | |
| 1.13 | story-untitled-13-plan.md | a9a233a..276415a | 1 | −2,084(Postgres 연결 제거) |
| 1.8 | story-doctor-plan.md | 276415a..cc73211 | 1 | |
| 1.9 | story-refactor-sweep-plan.md | cc73211..149974f | 1 | 마지막 범위는 HEAD가 아니라 `149974f`에서 자름(뒤의 `09c2a6f`는 티켓 문서만) |

증거 목록:
- 있음: 에픽 파일, 이니셔티브·spec·architecture·PRD, `tickets.toml` 엔트리 13개(파일로 꺼낸 스토리 없음), 플랜 13개(Review Triage Log·Verification 모두 있음), 커밋, `deferred-work.md`.
- 없음: 이전 회고(이 에픽이 첫 에픽). 세션 로그는 이 회고에 넘겨받지 않아 과정 분석은 플랜의 Plan Change Log·Triage Log와 프로젝트 메모리로 좁힌다.

## Findings

분석 방법: 서브에이전트 4개(구조 집계, 스펙 대조·리뷰 집계, `bmad-review` 3렌즈 — 원문 `scratchpad/retro/epic1-review.md`, 동작 확인)를 돌렸다. Action item에 올린 항목은 회고 작성자가 원본 코드를 다시 열어 확인했다(✔). 처분은 **지금 고침 / 미룸(대상) / 그대로 받아들임**이다.

### 1. 설치기·설정 흐름 (사용자가 무게를 둔 곳)

리뷰 이력 117건 중 41건(35%)이 설치기 계열 스토리(1.5·1.6·1.7·1.13)에서 나왔다. 미룬 12건 중 7건도 여기서 나왔다. 반복된 주제는 재실행 시 설정 보존(8건), 오류 코드 오분류(8), 조용한 누락(6)이다. 스토리마다 리뷰를 했지만 같은 종류의 결함이 다음 스토리에서 다시 나왔다.

| # | 발견 | 출처 | 처분 |
| --- | --- | --- | --- |
| F1 | 설정 하나가 틀리면 `setup run`이 맞는 경로(`files.path`·`mirror.path`)까지 기본값으로 되돌리고, 그렇게 했다는 말도 없다. Done when 4의 "현재 값을 기본값으로"가 이 경우 깨진다 | 동작 확인 4번 재현. `deferred-work.md` story 13 항목 | 미룸 → epic 2 (사용자 결정 2026-10-15) |
| F2 | 모르는 키를 doctor는 경고하지만 `setup run`은 말없이 지운다(AD-18) | 동작 확인 3번 재현 | 미룸 → epic 2 (사용자 결정) |
| F3 ✔ | config를 store 준비보다 먼저 쓴다. 그래서 잘못된 `--store-path` 하나가 기록된 정상 경로를 덮고, 그 뒤로는 그냥 재실행해도 계속 실패한다 | `apps/cli/src/install/flow.ts:210` 쓰기가 `:213` 준비보다 앞섬. bmad-review가 재현 | 지금 고침 → epic 2 첫 설치기 스토리 |
| F4 ✔ | 기존 파일을 DB인지 확인하기 전에 0600으로 바꾼다. 경로를 잘못 치면 남의 파일 권한이 바뀐다 | `apps/cli/src/install/store.ts:43-47`(`open 'a'` + `chmod`). bmad-review가 재현 | F3과 같이 |
| F5 | `writeConfig`만 값을 돌려주지 않고 던진다. `.env`에 따옴표가 섞인 값이 있으면 `setup run --json`이 봉투 없이 exit 1로 끝난다 | `apps/cli/src/config/codec.ts:324-330`, `install.ts:84-92`. bmad-review가 재현 | F3과 같이 |
| F6 ✔ | `setup run`이 흐름의 로그 줄을 거꾸로 파싱해 오류 코드를 되찾는다. `--json` 메시지가 콜론으로 끝나고, 실패(exit 1)인데도 봉투가 `ok:true`다 | `apps/cli/src/commands/setup-run.ts:66-72,90-98`. 동작 확인 2번 | 지금 고침(설계) → epic 2: 흐름이 코드 있는 결과를 돌려주게 |
| F7 ✔ | 진입점은 node major만 본다(`MIN_NODE_MAJOR = 24`). doctor의 하한 `24.16.0`은 설치 마지막에야 걸린다. 그래서 24.0~24.15에서는 clone·빌드·DB까지 다 만든 뒤 exit 1로 끝나고 `brew install node` 안내도 나오지 않는다. 미룬 항목 5가 기록보다 나쁘다 | `tooling/bootstrap/src/bootstrap.ts:42` vs `apps/cli/src/doctor/checks.ts:15` | 지금 고침 → epic 2 또는 epic 5(upgrade 경로와 함께) |
| F8 ✔ | `setup connect`는 shim이 있는지만 본다. doctor의 `inspectShim`(실행 권한·서명·같은 home)은 쓰지 않는다 | `apps/cli/src/commands/setup-connect.ts:53-63` vs `doctor/checks.ts:127-168` | 지금 고침 → epic 2(첫 connector와 함께) |
| F9 ✔ | shim이 `${SECOND_BRAIN_HOME:-'<home>'}`라서 셸의 export가 이기면 hook이 다른 brain으로 간다. 그래도 doctor는 ok다 | `apps/cli/src/install/shim.ts:68` | 질문(아래 Open questions) |
| F10 | E1-5는 `[files] path`를 설치에서 정하는 값으로 적었는데 설치기는 묻지 않고 기본값만 쓴다. README는 "두 질문"이라고 적었다 | `install/flow.ts:206-208`(주석 "Nothing asks for the file store's root"), 에픽 E1-5 | 스펙 맞춤 제안(아래 Action items) |
| F12 | 테스트 공백: `brain --version`이 exit 2로 끝나고 `dispatch.ts:409`의 version 분기는 도달할 수 없다. `setup run`의 `--connect` 매핑(`setup-run.ts:106-108`)과 설치기 Ctrl-C(`Cancelled`) 분기(`install.ts:86-92`)는 테스트가 없다 | bmad-review adversarial #7, verification-gap | 미룸 → epic 2 refactor sweep(Action 9) |
| F11 | AD-19의 동의 단계가 없다. TTY에서는 묻는 것이 임베딩 질문뿐이고 `--yes`는 비TTY 가드만 푼다 | `install/flow.ts:19-22,182-185`. bmad-review | 질문 |

### 2. 미룬 작업의 양

- `deferred-work.md` 14건의 상태는 다음과 같다.
  - 대상이 정해진 것: epic 2 3건, epic 7 2건, epic 4 1건, epic 5 1건
  - **대상 없음 7건**
  - 이미 해결됐는데 목록에 남은 것 4건: node 하한(1.8), busy 예산 테스트·`setup upgrade` 문구(1.9), tickets.toml pnpm 문구(epic 1 마무리)
  - 아무 에픽도 맡지 않은 것 4건: Postgres `MIGRATION_FAILED` 구분, 다른 불변 테이블 trigger, `size_bytes` bigint, 0002 새 테이블 5개 trigger
- 이 파일은 빌드 규칙상 append-only라 해결 표시를 할 수 없다. 그래서 어떤 항목이 살아 있는지 읽는 사람이 매번 다시 확인해야 한다.
- 거절한 low 지적이 실제 결함으로 돌아온 사례가 1건 있다. 1.1 리뷰 #7("테스트가 타입 검사되지 않는다")을 거절했는데, 1.9가 숨은 TS 오류 2건을 찾았다(`story-tracer-workspace-doctor-plan.md` Triage #7, `story-refactor-sweep-plan.md` Intent).

### 3. 구조 집계 (aggregate views)

| # | 발견 | 출처 | 처분 |
| --- | --- | --- | --- |
| G1 | 계층은 지켜졌다. core 런타임 의존성 0, adapter는 core에만 의존, second_brain은 재export만 한다. 순환 없음 | `packages/core/package.json`, `packages/second_brain/src/index.ts:2-6`, `boundaries.test.ts` | 그대로 |
| G2 | `second_brain`이 아직 `@second-brain/postgres`를 재export한다. 그래서 모든 CLI 호출(hook 경로 포함)이 `pg`를 불러온다(측정 약 +8.7ms) | `packages/second_brain/src/index.ts:3`. bmad-review 측정 | 미룸 → epic 2(hook 지연 NFR-7과 함께 판단) |
| G3 | `install/docker.ts` 266줄은 import하는 곳이 없는 죽은 코드이고, 테스트도 1.13에서 지웠다 | grep 결과 importer 0 | 그대로(에픽 Notes 2026-10-14 결정, epic 7이 되살림) |
| G4 | 같은 문제를 여러 번 풀었다. `describe(error)` 4개, `oneLine(error)` 4개, 버전 파서 2개, migrate runner 2개(postgres·sqlite, 설계상 평행), 임시 home 테스트 셋업 11곳 | 구조 집계 Duplication map | 미룸 → epic 2 refactor sweep 후보 |
| G5 | 크기: `install/flow.ts` 545줄(플래그 파싱·질문·안내 문구·조립), `dispatch.ts` 503줄, `codec.ts` 420줄. god-class는 아니지만 `flow.ts`가 가장 많은 책임을 지고 있다 | 현재 줄 수, churn 1,477(4개 티켓) | 받아들임. F3·F5·F6을 고칠 때 결과 타입부터 정리 |
| G6 | 오류 처리 패턴이 셋으로 갈렸다. 값 반환이 기본이지만 `codec.ts`·`sqlite/migrate.ts`·`install.ts`(`Cancelled`)는 던진다. 설치기 경계는 exit 코드와 로그 줄로 말한다(F6의 뿌리). 진입점·CLI·connect의 exit 코드 의미도 서로 다르다 | 구조 집계 Pattern divergence, bmad-review adversarial #8 | F6과 같이 |

### 4. 스펙 대조

- 남은 옛 문서 줄은 모두 "복제 대상 / epic 7"로 다시 표시돼 있다. "원본은 Postgres"라는 문장은 남지 않았다(correct-course 성공 기준 충족).
- `tickets.toml` entry 3(Postgres 첫 마이그레이션)에는 1·6과 달리 Superseded 표시가 없다. → Action item
- Done when 5의 증거(`import-side-effects.test.ts`)는 아직 Postgres 모양이다. TCP 연결 없음만 보고 SQLite 파일을 여는지는 보지 않는다. → epic 2로 넘김(epic 1 closure 때 Carry로 기록함)
- `.env`는 쓰기만 하고 읽지 않는다(E1-4의 ".env" 코덱 문구). 받아들임: 키 저장 자리로 남긴다(1.13 결정).

## Behavior verification

빌드된 CLI를 임시 home에서 실제로 돌렸다(Node 24.16.0, SQLite 3.53.0). 결과:

- 새 설치는 exit 0이다. 권한은 `brain.db` 600, `files/` 700, `.env` 600, `bin/brain` 755이고 doctor 10항목이 모두 ok다.
- 재실행 3번 모두 `cmp`로 같다. `--store-path`·`--mirror-path`, 손으로 고친 timezone이 유지된다.
- doctor 실패 경우는 모두 기대대로다.
  - DB 파일을 지우면 `DB_UNAVAILABLE`이고 파일을 다시 만들지 않는다.
  - 0444면 `writable` fail이다.
  - shim을 지우면 `shim` fail, node가 없으면 `node-path` fail이다.
  - schema가 99면 "install a newer build", 1이면 `setup run`을 안내한다.
- `setup connect claude-code`는 USAGE로 "epic 2"를 안내한다.
- 기대와 다른 동작: F1·F2·F6(위). 그리고 SDK 밖 클라이언트에서 `messages` UPDATE를 하면 설계한 문구 대신 `no such function: brain_redact_allowed`로 거부된다. 쓰기는 막히니 받아들임.
- 진입점은 `--help`가 없어 어떤 인자든 clone부터 한다(받아들임, 기록만).
- 실제 `npx github:` 실행은 하지 않았다(Done when 1 대체 증거, 사용자 결정).

## Previous-retro follow-through

이전 회고 파일이 없다. 이 에픽이 이니셔티브의 첫 에픽이라 따라 확인할 항목이 없다.

## Action items

모두 제안이고 자동으로 적용하지 않았다. 담당은 다음과 같다.

| # | 할 일 | 종류 | 담당 |
| --- | --- | --- | --- |
| 1 | epic 2 인셉션에 설치기 안정화 스토리 하나를 넣는다. 범위: F1·F2(이미 Carry), F3(config를 store 준비 뒤에 쓰기), F4(DB 확인 뒤 chmod), F5(`writeConfig`도 값으로 실패), F6(흐름이 코드 있는 결과를 돌려주고 `setup run`은 로그를 파싱하지 않기, 실패 시 `ok:false`) | 고침 | 사용자 → `bmad-ticket` epic 2 인셉션 |
| 2 | 진입점 node 하한을 doctor의 `NODE_FLOOR`와 같은 minor까지 본다(F7). epic 2 설치기 스토리에 넣거나 epic 5 upgrade와 묶는다 | 고침 | 사용자, 인셉션 때 결정 |
| 3 | epic 2 첫 connector 스토리에서 `setup connect`가 doctor의 `inspectShim`을 쓰게 한다(F8) | 고침 | epic 2 인셉션 |
| 4 | `deferred-work.md`를 정리한다. 해결된 4건은 해결 표시나 별도 "resolved" 기록으로, 대상 없는 7건은 에픽을 정하거나 Dropped로. 빌드가 append-only로 쓰는 파일이니 사람이 직접(또는 `bmad-ticket`으로) 정리한다 | 과정 | 사용자 |
| 5 | 과정 교훈: 리뷰에서 같은 주제(설정 보존, 오류 코드, 조용한 누락)가 스토리를 넘어 반복됐다. 설치기처럼 여러 스토리가 이어 붙이는 흐름은 인셉션 때 "흐름 결과 타입·실패 계약"을 먼저 한 스토리로 정하고 나머지가 그 위에 얹게 한다 | 과정(스토리 나누기) | epic 2 인셉션 때 적용 |
| 6 | 과정 교훈: low 지적 거절 기준("일상에서 만나지 않고 수정이 trivial하지 않음")이 테스트 인프라 지적에는 맞지 않았다(타입 검사 누락 → 숨은 오류). 테스트·빌드 인프라 지적은 거절하지 말고 refactor sweep으로 미룬다 | 과정(리뷰 기준) | 사용자, `bmad-customize`로 build 리뷰 지침에 반영 여부 결정 |
| 7 | 스펙 맞춤: E1-5의 `[files] path`를 "기본값으로 정하고 기록한다(묻지 않음)"로 고치거나, 설치기가 묻게 한다(F10). README "두 질문" 문구도 맞춘다 | 스펙 맞춤 | 사용자 결정 |
| 8 | 스펙 맞춤: `tickets.toml` entry 3에도 1·6과 같은 Superseded 줄을 단다 | 스펙 맞춤 | `bmad-ticket` |
| 9 | 리팩터 후보(G2·G4): second_brain의 postgres 재export 지연 로딩 또는 분리, 오류 문자열 헬퍼 하나로, 테스트 임시 home 헬퍼 공유 | 미룸 | epic 2 refactor sweep |

## Acceptance verdict

**accepted-with-open-items** (기준: declared, 에픽 Done when 1~6)

- 미완 티켓 0개, 13/13 done.
- Done when 2·3·5·6은 증거로 충족된다(closure 검증, 동작 확인, 전체 테스트 666개 통과 — 1.9 Verification).
- Done when 1은 대체 증거다(git+file:// npx 테스트 + `setup run --yes`). 사용자가 2026-10-15에 받아들였다(에픽 Notes Decision).
- Done when 4는 정상 재실행에서는 충족되지만, 설정 값 하나가 틀린 경우에는 깨진다(F1). 사용자 결정으로 epic 2로 넘겼고 epic 2 Notes에 Carry로 기록돼 있다.
- 막는 지적은 없다. 남은 항목(F3~F8, deferred 정리)은 위 Action items로 추적한다.

## Open questions

1. F9: shim이 셸의 `SECOND_BRAIN_HOME`을 우선하는 것은 의도인가? 의도라면 doctor가 "덮어쓰기 중"을 경고해야 하고, 아니라면 shim이 home을 고정해야 한다.
2. F11: AD-19의 설치 동의 단계(TTY에서 무엇을 만들지 보여 주고 묻기)를 epic 2 설치기 스토리에 넣을지, AD-19를 지금 동작에 맞게 고칠지.
3. F10: 파일 저장소 위치를 설치에서 물을지(Drive 연동 전까지 의미가 작음), 기본값 고정으로 스펙을 고칠지.
