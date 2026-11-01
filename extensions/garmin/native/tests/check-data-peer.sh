#!/bin/sh
# 별도 합성 프로세스의 양방향 OS 신원과 연결 교체를 검사한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-data-peer.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
for role in parent child; do
  xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/data-peer.c" "$base/tests/data-peer-$role.c" -lbsm -framework Security -framework CoreFoundation -o "$work/$role"
done
xcrun clang -Wall -Wextra -Werror -DFIXTURE_VARIANT=1 "$base/peer.c" "$base/data-peer.c" "$base/tests/data-peer-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/other"
parent=$(codesign -dv --verbose=4 "$work/parent" 2>&1 | sed -n 's/^CDHash=//p')
child=$(codesign -dv --verbose=4 "$work/child" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#parent} -eq 40 ] && [ ${#child} -eq 40 ]
"$work/parent" "$work/child" "$child" "$parent" normal
"$work/parent" "$work/child" "$child" "$parent" replace
if "$work/parent" "$work/other" "$child" "$parent" normal; then exit 1; fi
if "$work/parent" "$work/child" "$child" "$child" normal; then exit 1; fi
printf '%s\n' '일반 데이터 양방향 peer와 연결 교체 검사 통과'
