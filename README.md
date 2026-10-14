# second-brain

A personal brain for one Mac: a local SQLite file holds the originals, the
`brain` CLI is a thin shell over the `second_brain` SDK. This repository is not
published to npm.

## Install

On a Mac with nothing but [Node](https://nodejs.org) 24.16 or newer and git:

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

There is no database server to install and no Docker to start: the originals
live in one SQLite file. The installer asks two questions and nothing more:

- **Where the database file should go.** Anything absolute; the default is
  `~/.second_brain/brain.db`. It creates the file at mode 0600 before the
  migrations run, so neither it nor its write-ahead log is ever readable by
  anyone else, and it creates a parent folder it had to make at 0700.
- **Where the mirror folder should go.** Anything absolute; the default is
  `~/.second_brain/mirror`. Nothing creates that folder yet.

It then asks whether to turn embeddings on — which is still "not supported
yet", so saying yes only says so and writes nothing.

After the questions it writes the configuration, creates and migrates the
database file, creates the file store's root at mode 0700
(`~/.second_brain/files` by default), writes the shim (below), offers to connect
the harnesses it found, and finishes by running the same checks as
`brain admin doctor`. Exit 0 means every check passed. Running it again changes
nothing: it offers the recorded paths as the defaults, applies no migration the
file already has, leaves the index config rows the migrations wrote alone, and
leaves the shim and the harness entries alone when they already say the right
thing. Point it at another database file and it makes a new one — the old file
stays exactly where it is, and the install says so in one line.

Where there is no terminal to ask in — a script, or CI — `--yes` is the consent,
and the flags say the rest:

```sh
node apps/cli/dist/install.js --yes
node apps/cli/dist/install.js --store-path /Volumes/notes/brain.db --yes
```

Without a terminal nothing is asked, so each path keeps whatever is recorded (or
the default) and no harness is connected unless `--connect` names it.

| Flag | What it does |
| --- | --- |
| `--store-path <path>` | Absolute path for the database file |
| `--mirror-path <path>` | Absolute path for the mirror folder |
| `--connect <harness>` | Connect this harness; repeat it for more than one |
| `--yes` | Agree in advance to what the install has to do |

## Re-configure, and connect a harness

The installer is also a command, so there is nothing to re-run from a clone:

```sh
brain setup run [--store-path <path>] [--mirror-path <path>] \
                [--connect <harness>]… [--yes]
brain setup connect <harness>
```

`brain setup run` is the same flow in the same order, idempotent, showing what
is recorded as the default. It is one of two commands that need neither the
configuration nor the database to exist — it is what writes the configuration —
and with `--json` it hands back every line of the flow in `data.lines`.

`--json` runs non-interactively, exactly as a run with no terminal does: it
asks nothing, so it needs `--yes`, and it exits 2 saying so if it has none.

`brain setup connect <harness>` registers this brain with one harness, for a
harness installed after the install. The entry it writes carries a Brain mark,
and that mark is the only thing "already connected" is ever decided by, so
running it twice registers once (`changed: false` the second time) and nothing
you put in that file yourself is ever touched. It reports `SHIM_MISSING` if the
shim is not there, and exits 2 naming the harnesses this build knows if the
name is not one of them. This build knows none yet: the Claude Code connector
is a later epic, so `brain setup run` says there is no harness to connect and
carries on.

## The shim

The installer writes `~/.second_brain/bin/brain`, mode 0755, and that is the
`brain` a harness hook calls. A hook starts with none of your shell
environment, so the shim carries everything it needs as literals: the `node`
that ran the installer, the built entry point beside it, and the configuration
folder of that install. It never calls `npx`.

```sh
#!/bin/sh
# Written by second-brain. `brain setup run` rewrites it.
SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-'/Users/me/.second_brain'}; export SECOND_BRAIN_HOME
exec '/opt/homebrew/bin/node' '/Users/me/.second_brain/app/apps/cli/dist/bin.js' "$@"
```

A `SECOND_BRAIN_HOME` already in the environment wins, so a second
installation's shim does not fight the first one. Change node — a new `nvm`
version, a Homebrew upgrade — and run `brain setup run` again to point the shim
at it.

## Layout

```text
packages/core/          domain types, use cases, ports -- no runtime dependencies
packages/sqlite/        the Store port on the local SQLite source -- the originals
packages/postgres/      the Store port on Postgres + pgvector -- a replica, epic 7
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

`packages/postgres` is the replication target of epic 7, and its tests use a
real database rather than a mock. Nothing else needs one: the CLI and
`packages/sqlite` run against files in a temporary folder. Start the test-only
container, then point `BRAIN_TEST_DATABASE_URL` at it:

```sh
docker compose -f compose.test.yaml up -d --wait
export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres
pnpm test
docker compose -f compose.test.yaml down
```

The container keeps no volume, so stopping it discards the data.

## Check the install

Configuration lives outside the repository, in `~/.second_brain` (or the folder
`SECOND_BRAIN_HOME` names). `config.toml` holds the time zone and three absolute
paths — the database file, the file store's root and the mirror — and no key
values; a key value would live in `.env` at mode 0600, and this version has
none. The installer writes both — there is nothing to write by hand. To check a
working tree without touching the real folder, point the installer somewhere
else:

```sh
export SECOND_BRAIN_HOME=$(mktemp -d)
node apps/cli/dist/install.js --yes

pnpm brain admin doctor --json

# the shim of that install, which carries the folder it belongs to
env -u SECOND_BRAIN_HOME "$SECOND_BRAIN_HOME/bin/brain" admin doctor
```

Exit 0 means every check passed, 1 means a check failed (a database file that
has been removed reports `DB_UNAVAILABLE`), and 2 means the command could not
run at all. A runtime command opens the file and never creates it, so a missing
`brain.db` is reported rather than quietly replaced with an empty one.
