<!-- bmad:context -->
<!-- Verified 2026-10-18 against 24f0063. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## brain

Personal Brain (`second-brain`): a local-first memory of agent sessions whose source of truth is a local SQLite file. TypeScript on Node, pnpm workspace. Planning lives in `_bmad-output/personal-brain/`, tickets in its `tickets.toml`.

## Policy

- Never write absolute home paths (`/Users/<name>/…`) in docs, plans, reviews, commit messages, or prompts handed to subagents — the OS user name is a real name and the remote is public. Write `~/…` for the home folder and `<repo>/…` or a repo-relative path inside the repo, including when pasting command output as evidence. `.githooks/` refuses such commits; fix the text, never bypass it with `--no-verify`.
- When you change `plugin/app-ref`, bump `version` in `plugin/.claude-plugin/plugin.json` in the same commit — the remote marketplace caches the plugin by version, so without it nobody gets the new ref, and the local marketplace hides the miss. Point `app-ref` at an earlier commit, never at the one that changes it (README "릴리스").

<!-- /bmad:context -->
