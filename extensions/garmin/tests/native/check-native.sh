#!/bin/sh
# macOS 합성 peer 실험. 실계정, tokenstore, Garmin 네트워크를 사용하지 않는다.
set -eu
case "$(uname -s)" in Darwin) ;; *) printf '%s\n' 'macOS가 필요합니다.'; exit 1;; esac
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/brain-native-spike.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
xcrun clang "$source_dir/peer-child.c" -DLABEL=1 -o "$test_dir/approved"
xcrun clang "$source_dir/peer-child.c" -DLABEL=2 -o "$test_dir/other"
xcrun clang "$source_dir/peer-parent.c" -lbsm -framework Security -framework CoreFoundation -o "$test_dir/parent"
xcrun clang -fblocks "$source_dir/xpc-spike.c" -o "$test_dir/xpc"
requirement=$(codesign -dr - "$test_dir/approved" 2>&1 | sed -n 's/^# designated => //p')
xpc_requirement=$(codesign -dr - "$test_dir/xpc" 2>&1 | sed -n 's/^# designated => //p')
[ -n "$requirement" ] && [ -n "$xpc_requirement" ]
approved=$("$test_dir/parent" "$test_dir/approved" "$requirement")
other=$("$test_dir/parent" "$test_dir/other" "$requirement")
xpc_ok=$("$test_dir/xpc" "$xpc_requirement")
xpc_rejected=$("$test_dir/xpc" 'anchor apple')
printf '%s\n' "$approved" "$other" "$xpc_ok" "$xpc_rejected"
approved_pair=$(printf '%s\n' "$approved" | sed -n 's/^peer_pid=\([0-9]*\) child_pid=\([0-9]*\).*/\1 \2/p')
set -- $approved_pair
[ "$#" -eq 2 ] && [ "$1" = "$2" ]
other_pair=$(printf '%s\n' "$other" | sed -n 's/^peer_pid=\([0-9]*\) child_pid=\([0-9]*\).*/\1 \2/p')
set -- $other_pair
[ "$#" -eq 2 ] && [ "$1" = "$2" ]
printf '%s\n' "$approved" | rg 'lookup=0 requirement=0 verdict=0$' >/dev/null
printf '%s\n' "$other" | rg 'lookup=0 requirement=0 verdict=-[0-9]+$' >/dev/null
printf '%s\n' "$xpc_ok" | rg 'reply_is_dictionary=1 ok=1' >/dev/null
printf '%s\n' "$xpc_rejected" | rg 'reply_is_dictionary=0 ok=0' >/dev/null
