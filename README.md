# second-brain

A personal brain for one Mac: Postgres holds the originals, the `brain` CLI is a
thin shell over the `second_brain` SDK. This repository is not published to npm.

## Install

On a Mac with nothing but [Node](https://nodejs.org) 24 or newer and git:

```sh
npx github:gmae199boy/second-brain
```

That runs one committed, dependency-free file. It checks node and git, clones
this repository into `~/.second_brain/app` (fast-forwarding it on a later run),
offers to install the latest pnpm if yours is older than 12, builds the clone,
and starts the installer. It never resets or discards anything you changed
under `~/.second_brain/app`: if the folder is not a clean clone of this
repository, it says so and stops.

Two environment variables move it off the defaults:

| Variable | Default | What it does |
| --- | --- | --- |
| `SECOND_BRAIN_HOME` | `~/.second_brain` | Where the configuration and the clone go |
| `SECOND_BRAIN_REPO` | `https://github.com/gmae199boy/second-brain.git` | Which repository to clone, for a fork or a test |

The installer itself is still being built: today it only prints what it found.

## Layout

```text
packages/core/          domain types, use cases, ports -- no runtime dependencies
packages/postgres/      the Store port on Postgres + pgvector
packages/claude-code/   Claude Code connector (placeholder)
packages/modelstudio/   embeddings and reranking (placeholder)
packages/second_brain/  the one writing surface: re-exports only
apps/cli/               the brain command
tooling/bootstrap/      the install entry point: src/ plus its committed build
tooling/test-db/        dev-only throwaway test databases
```

## Build

```sh
pnpm install && pnpm build
```

`pnpm` is not pinned: the root manifest asks for `>=12` and nothing more, so
whatever current pnpm you have is the one that runs. A pinned `packageManager`
only moved the failure earlier — a newer pnpm would refuse to downgrade itself
and die before any work started.

`tooling/bootstrap/bin/second-brain.js` is a build output that is committed,
because npm installs this repository from git without building it. Change
`tooling/bootstrap/src/bootstrap.ts`, run `pnpm build`, and commit both; a test
fails if the two disagree.

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

Configuration lives outside the repository, in `~/.second_brain` (or the folder
`SECOND_BRAIN_HOME` names). `config.toml` holds variable names only; the values
live in `.env` at mode 0600. Until the installer exists, write the two files by
hand:

```sh
mkdir -p ~/.second_brain
cat > ~/.second_brain/config.toml <<'TOML'
schema_version = 1
timezone = "Asia/Seoul"

[database]
url_env = "SECOND_BRAIN_DATABASE_URL"
TOML
cat > ~/.second_brain/.env <<'ENV'
SECOND_BRAIN_DATABASE_URL="postgres://postgres:postgres@localhost:54329/postgres"
ENV
chmod 600 ~/.second_brain/.env

pnpm brain admin doctor --json
```

Exit 0 means every check passed, 1 means a check failed (a stopped database
reports `DB_UNAVAILABLE`), and 2 means the command could not run at all.
