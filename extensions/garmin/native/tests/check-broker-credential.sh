#!/bin/sh
# libpq 복사본과 합성 파일만 사용한다. 실제 자격·DB에 연결하지 않는다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$base/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-credential.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/lib"
cp "$repo"/extensions/garmin/.venv/lib/python3.14/site-packages/psycopg_binary/.dylibs/*.dylib "$work/lib/"
install_name_tool -id '@rpath/libpq.5.dylib' "$work/lib/libpq.5.dylib"
codesign --force --sign - "$work/lib/libpq.5.dylib" >/dev/null 2>&1
ln -s libpq.5.dylib "$work/lib/libpq.dylib"
xcrun clang -Wall -Wextra -Werror -fsanitize=address "$base/tests/broker-credential-fixture.c" -L"$work/lib" -lpq -Wl,-rpath,"$work/lib" -o "$work/fixture"
"$work/fixture"
printf '%s\n' '합성 자격 길이·크기 변경·단일 endpoint·허용 옵션 검사 통과'
