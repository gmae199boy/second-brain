#!/bin/sh
# 운영 pin 없는 native 바이너리는 실행물이나 DB를 열기 전에 닫혀야 한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$base/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-supervisor-build.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/lib"
cp "$repo"/extensions/garmin/.venv/lib/python3.14/site-packages/psycopg_binary/.dylibs/*.dylib "$work/lib/"
install_name_tool -id '@rpath/libpq.5.dylib' "$work/lib/libpq.5.dylib"
codesign --force --sign - "$work/lib/libpq.5.dylib" >/dev/null 2>&1
ln -s libpq.5.dylib "$work/lib/libpq.dylib"
# 저장소 경로에는 공백이 없다는 가정 없이 별도 positional 인자로 전달한다.
set -- "$base/sealed-files.c" "$base/sealed-bundle.c" "$base/sealed-signature.c" "$base/sealed-registry.c" "$base/peer.c" "$base/data-peer.c" "$base/queue-launcher.c" "$base/sealed-supervisor-store.c" "$base/supervisor-authority.c" "$base/broker-credential.c"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations "$@" "$base/queue-supervisor-host.c" -lbsm -framework Security -framework CoreFoundation -L"$work/lib" -lpq -Wl,-rpath,"$work/lib" -o "$work/host"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations "$@" "$base/queue-policy.c" "$base/queue-endpoint.c" -lbsm -framework Security -framework CoreFoundation -L"$work/lib" -lpq -Wl,-rpath,"$work/lib" -o "$work/endpoint"
if "$work/host" >/dev/null 2>&1; then exit 1; fi
if "$work/endpoint" >/dev/null 2>&1; then exit 1; fi
printf '%s\n' '운영 pin 없는 host와 endpoint 실패 닫힘 통과'
