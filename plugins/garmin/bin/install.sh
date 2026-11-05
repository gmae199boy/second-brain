#!/bin/sh
# All package verification, locking and installation belong to the core CLI.
ROOT=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
fi
BRAIN_HOME=${SECOND_BRAIN_HOME:-$HOME/.second_brain}
if [ ! -f "$BRAIN_HOME/installed.json" ] || [ ! -x "$BRAIN_HOME/bin/brain" ]; then
  printf '%s\n' 'Personal Brain core를 먼저 설치한 뒤 Garmin을 다시 실행하세요.'
  exit 0
fi
exec "$BRAIN_HOME/bin/brain" ext install --package "$ROOT/package" "$@"
