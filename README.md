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
and the flags say the rest. Without it the install stops before it writes
anything and exits 3, "a confirmation nobody gave": not a mistake in the
command, and nothing broken — a question for the person running it.

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
asks nothing, so it needs `--yes`. Without it nothing is written and the
envelope says what to run instead:

```json
{
  "ok": false,
  "warnings": [],
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This is not a terminal, so nothing can be asked. Agree in advance with --yes",
    "exit_code": 3,
    "retryable": false,
    "hint": "ask the person whether to go ahead, and make the call in `error.retry` only if they say yes",
    "retry": { "ns": "setup", "verb": "run", "args": { "confirm": true } },
    "retry_argv": ["brain", "setup", "run", "--yes", "--json"]
  }
}
```

`retry` is the same call with the consent added, and never more than that: the
flags you gave travel in it, the defaults you did not give do not. `retry_argv`
is that call as a command line. Both are there so the consent can be asked for
once, by a person — not attached by whatever is reading this.

`brain setup connect <harness>` registers this brain with one harness, for a
harness installed after the install. The entry it writes carries a Brain mark,
and that mark is the only thing "already connected" is ever decided by, so
running it twice registers once (`changed: false` the second time) and nothing
you put in that file yourself is ever touched. It reports `SHIM_MISSING` if the
shim is not there, and exits 2 naming the harnesses this build knows if the
name is not one of them. Every argument you type after a verb is an id — a body
is read from stdin, never typed as an argument — so one that is empty, or that
carries control or invisible characters, is refused as a `USAGE` before
anything is read: an empty argument is nearly always a `$(…)` that produced
nothing, and looking it up would answer "not found" to a broken command line.
This build knows no harness yet: the Claude Code connector is a later epic, so
`brain setup run` says there is no harness to connect and carries on.

## Exit codes

| Code | What it means |
|------|---------------|
| 0 | it worked |
| 1 | it ran and failed, or came back degraded |
| 2 | it could not run at all: the command line, the configuration, no database |
| 3 | it needs a confirmation nobody gave |

Under `--json` the same number is in `error.exit_code`, so a caller reading the
envelope never has to look at the shell to find out which it was. `error.hint`
says what to do about it, and `error.retryable` says whether running the same
command again could work at all — `false` on a usage mistake, `true` on a lock
somebody else is holding, absent when it depends.

A command on a harness hook path always exits 0, whatever happened, so a brain
that is broken never breaks a turn (the failure goes to stderr as one line). A
hook that runs into exit 3 does not do the thing and does not ask: it stops.

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

`admin doctor` reports one line per check and then a summary line counting
them. These are the checks:

| Check | What it says |
|-------|--------------|
| `db` | the source answered at all, and which SQLite version it is |
| `writable` | this process could really write: a transaction is opened, a table created and the whole thing rolled back, so nothing is left behind. Opening a database file succeeds even at mode 0444, which is why it is asked separately. It waits for nobody — a brain another process is writing to answers `warn` and says the question was not settled |
| `wal` | the file is in write-ahead mode, which is what lets a reader and the writer share it |
| `fts5-trigram` | this Node's SQLite was built with FTS5 and the `trigram` tokenizer, proved by indexing a row and searching it |
| `foreign-keys` | they are enforced on this connection |
| `schema-version` | the stored version is the one this build was made for; a mismatch is `SCHEMA_MISMATCH`, and `brain setup run` is what migrates. `skip` when `db` failed, since there was nothing to ask |
| `config` | `config.toml` is there and understandable, and where it is |
| `shim` | `<home>/bin/brain` is there, executable, written by brain, and names an entry point that exists |
| `node-path` | the node that shim names runs and is at least the version in `engines.node`. `skip` when there is no shim to read it from |
| `node-version` | the node running the command is at least that version too |

Every check comes to one of four answers: `ok`, `warn` — it ran and settled
nothing, which is neither a pass nor a problem — `fail`, or `skip`, which says
in its detail which check made it pointless (`prereq failed: db`). The last
line is the counts:

```text
summary: 9 passed, 1 warned, 0 failed, 0 skipped
```

They are in `data.summary` under `--json`, so nothing has to add up ten lines
to find the one `warn` among them.

Only a `fail` fails the command: exit 0 means nothing failed, 1 means something
did, and 2 means the command could not run at all. Nothing is ever repaired:
doctor reports, and `setup run` is what fixes things.

If `writable` fails, fix `brain.db-wal` and `brain.db-shm` along with
`brain.db`: SQLite gives the sidecars the database file's own permissions, so a
database that was once read-only keeps failing this check after its own mode is
put right, until theirs is too.

A runtime command opens the database file and never creates it, so a missing
`brain.db` is reported as `DB_UNAVAILABLE` rather than quietly replaced with an
empty one — and when the database cannot be reached there is nothing to say
about its probes, so those lines are absent rather than guessed at. The schema
version still gets its line, as a `skip` naming `db`: "not checked" and
"checked and fine" are different answers, and leaving the line out would make
you work out which one was meant from what is missing.

`admin doctor` is the one command that runs without a configuration, because it
is the command to run when the install is already broken: a missing or
unreadable `config.toml` is a failing `config` check and an exit 1, with `db`
failing for want of a path and the shim and node checks reported as usual. Every
other command exits 2 on the same folder.
