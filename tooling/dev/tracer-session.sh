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
  echo "$bin 이 없습니다. 먼저 \`pnpm build\`를 실행하세요." >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  home=$1
  mkdir -p "$home"
  home=$(cd "$home" && pwd)
else
  home=$(mktemp -d "${TMPDIR:-/tmp}/brain-tracer-XXXXXX")
fi

echo "설정 폴더: $home"

# `--yes` because nothing can be asked here, and `--json` so the install's own
# lines do not drown the instructions below. The envelope goes to the folder,
# for reading if something went wrong.
SECOND_BRAIN_HOME="$home" node "$bin" setup run --yes --json > "$home/setup-run.json"
echo "설치했습니다. 결과 엔벨로프는 $home/setup-run.json 에 있습니다."

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

echo "$settings 를 썼습니다."
echo
echo "이제 버려도 되는 폴더에서 두 턴 대화해 보세요:"
echo
echo "  claude --settings $settings"
echo
echo "그다음 들어간 내용을 보고, 같은 턴을 다시 수집해도 아무것도 바뀌지"
echo "않는지 확인하세요:"
echo
echo "  sqlite3 $home/brain.db \\"
echo "    'select seq, role, substr(body, 1, 40) from messages order by seq'"
echo "  sqlite3 $home/brain.db 'select id, name, is_self from users'"
echo
echo "기대 결과: 대화가 seq 0부터 일어난 순서대로 있고, users에는 한 행이 있으며,"
echo "같은 payload를 다시 수집해도 건수가 바뀌지 않습니다."
echo
echo "$home 밖은 아무것도 건드리지 않았습니다. 다 쓰면 지우세요:"
echo
echo "  rm -rf $home"
