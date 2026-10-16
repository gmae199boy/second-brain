#!/bin/sh
# Set up a throwaway brain and the Claude Code settings file that points a Stop
# hook at it, so one real conversation can be watched going into the database.
#
# It is the manual half of story 2.2's verification: `pnpm test` proves the
# pieces, and this proves the wiring, because nothing in the test suite is a
# real editor writing a real transcript.
#
# Nothing it touches is yours. The brain goes in a fresh temporary folder, the
# settings file goes in there too, and `claude --settings <file>` is what makes
# the editor read it -- your own ~/.claude/settings.json is never opened
# (Boundaries). Remove the folder and nothing is left behind.
#
# Usage:
#   sh tooling/dev/tracer-session.sh            # a fresh temporary home
#   sh tooling/dev/tracer-session.sh <folder>   # a folder you name, reused

set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
bin="$repo_root/apps/cli/dist/bin.js"

if [ ! -f "$bin" ]; then
  echo "$bin does not exist. Run \`pnpm build\` first." >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  home=$1
  mkdir -p "$home"
  home=$(cd "$home" && pwd)
else
  home=$(mktemp -d "${TMPDIR:-/tmp}/brain-tracer-XXXXXX")
fi

echo "configuration folder: $home"

# `--yes` because nothing can be asked here, and `--json` so the install's own
# lines do not drown the instructions below. The envelope goes to the folder,
# for reading if something went wrong.
SECOND_BRAIN_HOME="$home" node "$bin" setup run --yes --json > "$home/setup-run.json"
echo "installed, and the envelope is in $home/setup-run.json"

settings="$home/claude-settings.json"

# The hook Claude Code runs when a turn ends. It is written by hand here
# because registering it properly is story 2.14's plugin, and `--settings`
# is the one way to try a hook without writing anything a later run of the
# editor would keep.
#
# `SECOND_BRAIN_HOME` is in the command rather than in the environment: a hook
# starts with none of your shell, which is the whole reason the shim exists.
cat > "$settings" <<JSON
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "SECOND_BRAIN_HOME=$home exec node $bin sessions ingest claude-code"
          }
        ]
      }
    ]
  }
}
JSON

echo "wrote $settings"
echo
echo "Now have a two-turn conversation in a throwaway folder:"
echo
echo "  claude --settings $settings"
echo
echo "Then look at what landed, and ingest the same turn again to see that"
echo "nothing moves:"
echo
echo "  sqlite3 $home/brain.db \\"
echo "    'select seq, role, substr(body, 1, 40) from messages order by seq'"
echo "  sqlite3 $home/brain.db 'select id, name, is_self from users'"
echo
echo "Expected: the conversation from seq 0 in the order it happened, one row"
echo "in users, and a second ingest of the same payload that changes no count."
echo
echo "Nothing outside $home was touched. Remove it when you are done:"
echo
echo "  rm -rf $home"
