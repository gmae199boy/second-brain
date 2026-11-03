<!-- bmad:context -->
<!-- Verified 2026-10-18 against 24f0063. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## brain

Personal Brain (`second-brain`): a local-first memory of agent sessions whose source of truth is PostgreSQL in an OrbStack Docker container. TypeScript on Node, pnpm workspace. Planning lives in `_bmad-output/personal-brain/`, tickets in its `tickets.toml`.

## Policy

- Never write absolute home paths (`/Users/<name>/…`) in docs, plans, reviews, commit messages, or prompts handed to subagents — the OS user name is a real name and the remote is public. Write `~/…` for the home folder and `<repo>/…` or a repo-relative path inside the repo, including when pasting command output as evidence. `.githooks/` refuses such commits; fix the text, never bypass it with `--no-verify`.
- When you change `plugin/app-ref`, bump `version` in `plugin/.claude-plugin/plugin.json` in the same commit — the remote marketplace caches the plugin by version, so without it nobody gets the new ref, and the local marketplace hides the miss. Point `app-ref` at an earlier commit, never at the one that changes it (README "릴리스").

<!-- /bmad:context -->

## 시험 실행 범위

- 구현·리뷰 수정·재검증을 반복하는 동안에는 `pnpm test:changed`만 돌린다(기본 `origin/main` 대비, `pnpm test:changed -- <ref>`로 기준 변경). 바뀐 파일의 TS 의존 시험은 Vitest `--changed`로, Python 통합 시험은 `tooling/test-changed/rules.mjs`의 경로 규칙으로 고른다. 규칙에 걸리지 않으면 Python 시험은 생략된다.
- 작업(티켓)을 마무리하기 직전, 커밋·push 전에만 전체 `pnpm test`와 `pnpm test:python`을 한 번씩 순차로 돌린다. 이 마지막 전체 회귀를 생략하지 않는다 — 경로 규칙과 `--changed`가 못 따라가는 의존을 여기서 잡는다.
- `pnpm test`와 `pnpm test:python`은 둘 다 build하므로 동시에 돌리지 않는다. Python·SQL·자식 프로세스로만 쓰이는 새 경로를 만들면 `rules.mjs`에 규칙을 더한다.

## 티켓 자동화와 컴팩션 복구

- 새 세션 또는 컴팩션 후 첫 행동은 `_bmad-output/personal-brain/automation/runbook.md`를 읽는 것이다. 자동화 관련 작업·재개·상태 보고 전에는 반드시 다시 읽는다.
- 중앙 감독자는 `.brain-automation/state.json`도 읽고 실제 Git·티켓·Orca 상태와 대조한다. 없거나 손상됐으면 실행 중인 워커가 없다고 추정하지 말고 런북의 복구 절차를 따른다.
- 티켓 워커는 자신의 Dispatch 지시와 전용 체크포인트를 먼저 복원한다. 중앙 상태 파일을 수정하거나 main을 병합·푸시하지 않는다.
- 런북·상태가 실행 준비 단계이면 티켓을 자동 시작하지 않는다. 실행 중이면 실제 상태와 대조한 다음 행동을 이어 간다. 컴팩션은 실행 승인이나 중단 상태를 바꾸지 않는다.
- 이 자동화에는 기존 bmad-loop 런북·감독 스크립트·정책을 적용하지 않는다. 최신 사용자 지시와 새 런북을 따른다.
