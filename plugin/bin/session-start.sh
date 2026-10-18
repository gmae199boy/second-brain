#!/bin/sh
# Written by second-brain. The SessionStart launcher of the Claude Code plugin.
#
# A hook inherits the harness's own environment, and on a GUI launch that PATH
# holds no nvm and sometimes not even Homebrew (epic-capture-research 1). So
# this script finds a node itself, puts that node's folder in front of PATH so
# that pnpm and git can be found too, and hands over to the bootstrap copy
# beside it.
#
# It prints nothing unless it cannot act at all, in which case it prints one
# JSON line and exits 0: a SessionStart hook never stops a session.

ROOT=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fi

BRAIN_HOME=${SECOND_BRAIN_HOME:-$HOME/.second_brain}

# --- node finding (second-brain). One copy: apps/cli/src/install/shim.ts.
SECOND_BRAIN_NODE_FLOOR='24.16.0'
SECOND_BRAIN_NVM_DIR=${NVM_DIR:-$HOME/.nvm}
if [ -z "${SECOND_BRAIN_NODE_DIRS+set}" ]; then
  SECOND_BRAIN_NODE_DIRS='/opt/homebrew/bin:/usr/local/bin'
fi
brain_version=''
brain_node=''

# Whether version $1 is at or above version $2, as numbers and not as text.
brain_at_least() {
  brain_left=$1
  brain_right=$2
  brain_field=0
  while [ "$brain_field" -lt 3 ]; do
    brain_one=${brain_left%%.*}
    brain_two=${brain_right%%.*}
    case $brain_left in *.*) brain_left=${brain_left#*.} ;; *) brain_left=0 ;; esac
    case $brain_right in *.*) brain_right=${brain_right#*.} ;; *) brain_right=0 ;; esac
    brain_one=${brain_one%%[!0123456789]*}
    brain_two=${brain_two%%[!0123456789]*}
    [ -n "$brain_one" ] || brain_one=0
    [ -n "$brain_two" ] || brain_two=0
    if [ "$brain_one" -gt "$brain_two" ]; then return 0; fi
    if [ "$brain_one" -lt "$brain_two" ]; then return 1; fi
    brain_field=$((brain_field + 1))
  done
  return 0
}

# The version the node at $1 answers with, in brain_version.
brain_node_version() {
  brain_version=''
  [ -x "$1" ] || return 1
  brain_version=$("$1" --version 2>/dev/null) || return 1
  brain_version=${brain_version#v}
  case $brain_version in [0123456789]*) ;; *) return 1 ;; esac
  return 0
}

# Whether the node at $1 is one this build can run on.
brain_node_enough() {
  brain_node_version "$1" || return 1
  brain_at_least "$brain_version" "$SECOND_BRAIN_NODE_FLOOR"
}

# A node of at least the floor, in brain_node: the highest nvm version
# first, then the fixed folders in the order they are named.
brain_find_node() {
  brain_node=''
  brain_best=''
  for brain_candidate in "$SECOND_BRAIN_NVM_DIR"/versions/node/v*/bin/node; do
    brain_node_enough "$brain_candidate" || continue
    if [ -z "$brain_node" ] || brain_at_least "$brain_version" "$brain_best"; then
      brain_node=$brain_candidate
      brain_best=$brain_version
    fi
  done
  [ -z "$brain_node" ] || return 0

  brain_folders=$SECOND_BRAIN_NODE_DIRS
  while [ -n "$brain_folders" ]; do
    brain_folder=${brain_folders%%:*}
    case $brain_folders in *:*) brain_folders=${brain_folders#*:} ;; *) brain_folders='' ;; esac
    [ -n "$brain_folder" ] || continue
    if brain_node_enough "$brain_folder/node"; then
      brain_node=$brain_folder/node
      return 0
    fi
  done
  return 1
}

# Where it looked, for the one line that says nothing was found.
brain_node_places() {
  printf '%s' "$SECOND_BRAIN_NVM_DIR/versions/node/v*/bin/node, $SECOND_BRAIN_NODE_DIRS"
}
# --- end of node finding

# One string, safe to put inside a JSON string: the two characters JSON forbids
# unescaped, in a path that could carry either.
brain_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# The one line this script is allowed to say. It goes into the model's context
# on the next turn and not onto the user's screen (2.5 human check 4), so there
# is one of these per run at most and it is written to be passed on.
brain_say() {
  printf '{"systemMessage":"%s"}\n' "$(brain_json_escape "$1")"
}

# The node the shim pinned, in brain_node. It is asked before the search
# because it is the node this installation was built with, and because reading
# one line is cheaper than running every node on the machine.
brain_pinned_node() {
  brain_shim=$BRAIN_HOME/bin/brain
  [ -r "$brain_shim" ] || return 1
  brain_line=$(grep '^NODE=' "$brain_shim" 2>/dev/null | head -n 1) || return 1
  [ -n "$brain_line" ] || return 1
  brain_pinned=${brain_line#NODE=\'}
  brain_pinned=${brain_pinned%\'}
  brain_node_enough "$brain_pinned" || return 1
  brain_node=$brain_pinned
  return 0
}

# The commit this plugin asks to be installed: one line of 40 hex characters.
# Anything else is a plugin folder that cannot say what it wants installed,
# which is worth one line — it is broken packaging, not a routine state.
brain_ref=$(tr -d ' \t\n\r' < "$ROOT/app-ref" 2>/dev/null) || brain_ref=''
case $brain_ref in
  *[!0123456789abcdef]*) brain_ref='' ;;
esac
if [ "${#brain_ref}" -ne 40 ]; then
  brain_say "second-brain 플러그인의 app-ref를 읽을 수 없어서 아무것도 하지 않았습니다: $ROOT/app-ref. 이것을 사용자에게 한 줄로 전해 주세요"
  exit 0
fi

if brain_pinned_node; then
  :
elif brain_find_node; then
  :
else
  # The bootstrap never runs on this path, so there is no record of it for
  # `brain doctor run` to report: this one line is the whole account, and the
  # model is the only one who will see it unless it passes it on.
  brain_say "second-brain: node $SECOND_BRAIN_NODE_FLOOR 이상을 찾지 못해서 아무것도 하지 않았습니다. 찾아본 곳: $(brain_node_places). 이것을 사용자에게 한 줄로 전해 주세요"
  exit 0
fi

# The bootstrap looks pnpm and git up on PATH, so the node that was just found
# goes in front of it with the two fixed folders behind it. A hook's own PATH
# stays last rather than being replaced: a machine that does have the tools on
# it should keep finding them where it always has.
PATH=$(dirname "$brain_node"):/opt/homebrew/bin:/usr/local/bin:$PATH
export PATH

exec "$brain_node" "$ROOT/bootstrap.mjs" --yes --ref "$brain_ref" --plugin-root "$ROOT"
