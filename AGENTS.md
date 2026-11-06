<!-- bmad:context -->
<!-- Verified 2026-10-18 against 24f0063. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## brain

Personal Brain (`second-brain`): a local-first memory of agent sessions whose source of truth is PostgreSQL in an OrbStack Docker container. TypeScript on Node, pnpm workspace. Planning lives in `_bmad-output/personal-brain/`, tickets in its `tickets.toml`.

## Policy

- Never write absolute home paths (`/Users/<name>/…`) in docs, plans, reviews, commit messages, or prompts handed to subagents — the OS user name is a real name and the remote is public. Write `~/…` for the home folder and `<repo>/…` or a repo-relative path inside the repo, including when pasting command output as evidence. `.githooks/` refuses such commits; fix the text, never bypass it with `--no-verify`.
- When you change `plugin/app-ref`, bump `version` in `plugin/.claude-plugin/plugin.json` in the same commit — the remote marketplace caches the plugin by version, so without it nobody gets the new ref, and the local marketplace hides the miss. Point `app-ref` at an earlier commit, never at the one that changes it (README "릴리스").

<!-- /bmad:context -->

## 시험 실행 범위

- **개발 중에는 시험을 실행하지 않는다 — 2026-11-06 사용자 지시.** 구현·리뷰 반영 수정을 반복하는 동안 `pnpm test:changed`·`pnpm test`·`pnpm test:python`·개별 vitest·eval을 돌리지 않는다. 시험이 오래 걸려 개발 반복을 막기 때문이다. 이 기간에는 `pnpm build`·`pnpm typecheck`·`git diff --check`로 컴파일만 확인한다. 수락조건을 덮는 시험 코드는 계속 작성한다.
- 개발이 끝난 뒤(마지막 구현·리뷰 수정이 들어간 뒤, 커밋·push 전) 전체 `pnpm test` → `pnpm test:python`을 순차로 한 번씩 돌린다. 이 마지막 전체 회귀를 생략하지 않는다. 여기서 난 실패를 고친 뒤의 재검증은 `pnpm test:changed`(기본 `origin/main` 대비, `pnpm test:changed -- <ref>`로 기준 변경)와 관련 시험으로 한다.
- 이 규칙은 티켓 명세·계획·Dispatch·Task 명세·스킬에 적힌 "반복 `test:changed`" 요구보다 우선한다. 지휘자는 구현자·수정 Task 명세에 "시험 실행 금지, 컴파일 확인만"을 적는다. 명세의 "시험 실행 유예 대상이 아니다"는 그 티켓이 21.8로 시험을 넘기지 않고 개발 뒤 스스로 전체 회귀를 돌린다는 뜻이며, 개발 중 반복 실행을 요구하지 않는다.
- `pnpm test`와 `pnpm test:python`은 둘 다 build하므로 동시에 돌리지 않는다. `test:changed`는 TS 의존 시험을 Vitest `--changed`로, Python 통합 시험을 `tooling/test-changed/rules.mjs`의 경로 규칙으로 고른다. Python·SQL·자식 프로세스로만 쓰이는 새 경로를 만들면 `rules.mjs`에 규칙을 더한다.

### Garmin 구현 시험 실행 유예 — 2026-11-05 최신 사용자 지시

- 대상은 구현 티켓 **20.1~20.5·21.2~21.6**이다. 기능 수락조건을 덮는 시험 코드는 작성하지만 직접 시험·`pnpm test:changed`·`pnpm test`·`pnpm test:python` 등 시험은 실행하지 않는다. `pnpm build`·typecheck로 컴파일을 확인하고 독립 리뷰·필요한 수정·후속 리뷰를 수행한다. 이 범위로 built·커밋·브랜치 push·main 병합·push를 진행한다. 계획/최종 보고에는 시험 실행을 **21.8로 이관, 미실행**이라고 명시하며 통과했다고 쓰지 않는다. 이전 티켓 verify·Dispatch·스킬의 즉시 시험 실행 요구보다 이 지시가 우선한다. 알려진 기능 결함을 완료로 숨기는 승인은 아니다.
- 별도 티켓 **21.8 통합 시험 실행·수정**을 **21.6(sweep) 뒤·21.7(이 Mac 전환) 앞**에 둔다. 전용 시험 DB·합성 데이터에서 새·기존 Garmin 시험을 포함한 `pnpm test` → `pnpm test:python`을 순차 실행하고, 실패를 원인별로 수정한 뒤 관련 시험을 재검증한다. 다른 개선으로 범위를 넓히지 않는다. 기준 SHA·환경/소유 자원·명령·종료 코드·로그·실패별 처분·재검증 증거를 남긴다. 미해결 실패가 있거나 새·기존 시험 실행이 빠졌으면 21.8을 built로 처리하거나21.7을 시작하지 않는다.
- 진행 중인20.1은 지금 round4 직접 시험이 끝나면 추가 직접 시험·test:changed 없이 build·typecheck와 리뷰·필요 후속 리뷰·커밋·push로 마무리한다. 지휘자와 구현자가 시험을 중복 실행하지 않는다.
- 이 지시는 직전 Garmin 시험 예외와 중앙의 독립 전체 회귀 gate를 대체한다. 20.6의 이미 남긴 실행 결과는 이력으로 보존하며 다른 에픽의 시험 규칙은 그대로다.21.8은 위 시험 실행 유예 대상이 아니다.

## 티켓 자동화와 컴팩션 복구

- 새 세션 또는 컴팩션 후 첫 행동은 `_bmad-output/personal-brain/automation/runbook.md`를 읽는 것이다. 자동화 관련 작업·재개·상태 보고 전에는 반드시 다시 읽는다.
- 중앙 감독자는 `.brain-automation/state.json`도 읽고 실제 Git·티켓·Orca 상태와 대조한다. 없거나 손상됐으면 실행 중인 워커가 없다고 추정하지 말고 런북의 복구 절차를 따른다.
- 티켓 워커는 자신의 Dispatch 지시와 전용 체크포인트를 먼저 복원한다. 중앙 상태 파일을 수정하거나 main을 병합·푸시하지 않는다.
- 런북·상태가 실행 준비 단계이면 티켓을 자동 시작하지 않는다. 실행 중이면 실제 상태와 대조한 다음 행동을 이어 간다. 컴팩션은 실행 승인이나 중단 상태를 바꾸지 않는다.
- 이 자동화에는 기존 bmad-loop 런북·감독 스크립트·정책을 적용하지 않는다. 최신 사용자 지시와 새 런북을 따른다.
