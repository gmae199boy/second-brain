#!/bin/sh
set -eu
mkdir -p "$FAKE_LAUNCHCTL_DIR/loaded"
printf '%s\n' "$*" >> "$FAKE_LAUNCHCTL_DIR/calls"
if [ "${FAKE_LAUNCHCTL_HANG:-}" = "$1" ]; then
  exec sleep 30
fi
case "$1" in
  print)
    label=${2##*/}
    [ -f "$FAKE_LAUNCHCTL_DIR/loaded/$label" ] && exit 0
    exit 113 ;;
  bootstrap)
    if [ ! -f "$3" ]; then
      echo '가짜 launchctl이 plist 파일을 찾지 못했습니다' >&2
      exit 5
    fi
    if [ "${FAKE_LAUNCHCTL_FAIL:-}" = bootstrap ]; then
      echo '가짜 launchctl이 bootstrap을 거절했습니다' >&2
      exit 5
    fi
    label=${3##*/}
    label=${label%.plist}
    [ -f "$FAKE_LAUNCHCTL_DIR/loaded/$label" ] && exit 5
    touch "$FAKE_LAUNCHCTL_DIR/loaded/$label"
    exit 0 ;;
  kill)
    label=${3##*/}
    [ -f "$FAKE_LAUNCHCTL_DIR/loaded/$label" ] && exit 0
    echo '가짜 launchctl에 올라 있는 Label이 없습니다' >&2
    exit 3 ;;
  bootout)
    if [ "${FAKE_LAUNCHCTL_FAIL:-}" = bootout ]; then
      echo '가짜 launchctl이 bootout을 거절했습니다' >&2
      exit 5
    fi
    label=${2##*/}
    [ -f "$FAKE_LAUNCHCTL_DIR/loaded/$label" ] || exit 3
    # An explicit test-only pid file models launchd delivering SIGTERM on bootout.
    if [ -n "${FAKE_LAUNCHCTL_PID_FILE:-}" ] && [ -f "$FAKE_LAUNCHCTL_PID_FILE" ]; then
      kill -TERM "$(cat "$FAKE_LAUNCHCTL_PID_FILE")"
    fi
    rm "$FAKE_LAUNCHCTL_DIR/loaded/$label"
    exit 0 ;;
esac
exit 1
