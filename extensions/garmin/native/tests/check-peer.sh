#!/bin/sh
# 별도 합성 프로세스와 익명 FD만 사용한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-peer-fixture.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/tests/peer-parent.c" -lbsm -framework Security -framework CoreFoundation -o "$work/parent"
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/tests/peer-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/approved"
xcrun clang -Wall -Wextra -Werror -DFIXTURE_VARIANT=1 "$base/peer.c" "$base/tests/peer-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/other"
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/tests/frame-fixture.c" -lbsm -framework Security -framework CoreFoundation -o "$work/frame"
"$work/frame"
xcrun clang -Wall -Wextra -Werror -DBRAIN_NATIVE_FIXTURE "$base/session.c" "$base/tests/session-fixture.c" -o "$work/session"
"$work/session"
xcrun clang -Wall -Wextra -Werror "$base/session.c" "$base/tests/presence-closed.c" -o "$work/presence"
"$work/presence"
xcrun clang -Wall -Wextra -Werror -DBRAIN_NATIVE_FIXTURE "$base/peer.c" "$base/session.c" "$base/broker.c" "$base/tests/broker-fixture.c" -lbsm -framework Security -framework CoreFoundation -o "$work/broker"
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/tests/inherited-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/inherited-child"
broker_output=$("$work/broker" "$work/inherited-child" 2>&1)
[ -z "$broker_output" ]
xcrun clang -Wall -Wextra -Werror -DBRAIN_NATIVE_FIXTURE "$base/peer.c" "$base/worker-host.c" "$base/tests/worker-host-fixture.c" -lbsm -framework Security -framework CoreFoundation -o "$work/worker-host"
worker_hash=$(codesign -dv --verbose=4 /usr/bin/true 2>&1 | sed -n 's/^CDHash=//p')
[ ${#worker_hash} -eq 40 ]
"$work/worker-host" "$worker_hash"
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/worker-host.c" "$base/tests/bootstrap-parent.c" -lbsm -framework Security -framework CoreFoundation -o "$work/bootstrap-parent"
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/child-bootstrap.c" "$base/tests/bootstrap-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/bootstrap-child"
bootstrap_parent=$(codesign -dv --verbose=4 "$work/bootstrap-parent" 2>&1 | sed -n 's/^CDHash=//p')
bootstrap_child=$(codesign -dv --verbose=4 "$work/bootstrap-child" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#bootstrap_parent} -eq 40 ] && [ ${#bootstrap_child} -eq 40 ]
"$work/bootstrap-parent" "$work/bootstrap-child" "$bootstrap_child" "$bootstrap_parent" success
"$work/bootstrap-parent" "$work/bootstrap-child" "$bootstrap_child" "$bootstrap_parent" deny
xcrun clang -Wall -Wextra -Werror -fblocks "$base/xpc-peer.c" "$base/tests/xpc-fixture.c" -framework Security -framework CoreFoundation -o "$work/xpc"
xpc_hash=$(codesign -dv --verbose=4 "$work/xpc" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#xpc_hash} -eq 40 ]
"$work/xpc" "$xpc_hash"
parent=$(codesign -dv --verbose=4 "$work/parent" 2>&1 | sed -n 's/^CDHash=//p')
approved=$(codesign -dv --verbose=4 "$work/approved" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#parent} -eq 40 ] && [ ${#approved} -eq 40 ]
"$work/parent" "$work/approved" "$approved" "$parent"
if "$work/parent" "$work/other" "$approved" "$parent"; then exit 1; fi
printf '%s\n' '별도 프로세스 peer·단회 FD 전달 통과'
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/auth-channel.c" "$base/tests/channel-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/channel-child"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$base/../src" python3 "$base/tests/check-channel.py" "$work/channel-child"
printf '%s\n' '네이티브·파이썬 인증 채널 통과'
xcrun clang -Wall -Wextra -Werror "$base/presence.c" "$base/session.c" "$base/tests/presence-signature.c" -framework Security -framework CoreFoundation -o "$work/presence-signature"
"$work/presence-signature"
printf '%s\n' '합성 서명 일회성 검증 통과'
xcrun clang -Wall -Wextra -Werror -fblocks -c "$base/presence-gate.m" -o "$work/presence-gate.o"
xcrun clang -Wall -Wextra -Werror -fblocks -c "$base/secure-prompt.m" -o "$work/secure-prompt.o"
printf '%s\n' '생체 승인·보안 입력 부품 컴파일 통과'
