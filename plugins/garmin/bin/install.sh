#!/bin/sh
# All package verification, locking and installation belong to the core CLI.
BRAIN_HOME=${SECOND_BRAIN_HOME:-$HOME/.second_brain}
if [ ! -f "$BRAIN_HOME/installed.json" ] || [ ! -x "$BRAIN_HOME/bin/brain" ]; then
  printf '%s\n' 'Personal Brain core를 먼저 설치한 뒤 Garmin을 다시 실행하세요.'
  exit 0
fi
exec "$BRAIN_HOME/bin/brain" ext install garmin "$@"
