# second-brain

A personal brain for one Mac: Postgres holds the originals, the `brain` CLI is a
thin shell over the `second_brain` SDK. This repository is not published to npm.

## Layout

```text
packages/core/          domain types, use cases, ports -- no runtime dependencies
packages/postgres/      the Store port on Postgres + pgvector
packages/claude-code/   Claude Code connector (placeholder)
packages/modelstudio/   embeddings and reranking (placeholder)
packages/second_brain/  the one writing surface: re-exports only
apps/cli/               the brain command
tooling/test-db/        dev-only throwaway test databases
```

## Build

```sh
pnpm install && pnpm build
```

`pnpm` is pinned to 12.10.1 through `packageManager`. If your pnpm does not
switch automatically, run the commands through `npx pnpm@12.10.1 ...`.

## Test database

The Postgres tests use a real database and are never mocked or skipped. Start
the test-only container, then point `BRAIN_TEST_DATABASE_URL` at it:

```sh
docker compose -f compose.test.yaml up -d --wait
export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres
pnpm test
docker compose -f compose.test.yaml down
```

The container keeps no volume, so stopping it discards the data.

## Check the install

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm brain admin doctor --json
```

Exit 0 means every check passed, 1 means a check failed (a stopped database
reports `DB_UNAVAILABLE`), and 2 means the command could not run at all.
