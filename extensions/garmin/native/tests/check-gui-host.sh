#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-gui-host.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror "$base/tests/gui-host-child.c" -o "$work/child"
hash=$(codesign -dv --verbose=4 "$work/child" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#hash} -eq 40 ]
xcrun clang -Wall -Wextra -Werror -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_GUI_PATH="\"$work/child\"" "$base/gui-host.c" "$base/tests/gui-host-fixture.c" -lbsm -framework Security -framework CoreFoundation -framework SystemConfiguration -o "$work/fixture"
"$work/fixture" "$hash"
printf '%s\n' '합성 GUI 중단 spawn·신원·재개·종료 검사 통과'
