#!/bin/sh
# Written by second-brain. Collection delegates node discovery to the shim.
ROOT=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fi
BRAIN_HOME=${SECOND_BRAIN_HOME:-$HOME/.second_brain}
shim=$BRAIN_HOME/bin/brain
[ -x "$shim" ] || exit 0
SECOND_BRAIN_PLUGIN_ROOT=$ROOT
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
export SECOND_BRAIN_PLUGIN_ROOT PATH
exec "$shim" "$@"
