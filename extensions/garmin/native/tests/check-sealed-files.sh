#!/bin/sh
# 사용자 소유 합성 디렉터리로 검사 부품만 검증한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-sealed-files.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -m 700 "$work/root"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations "$base/sealed-files.c" "$base/sealed-bundle.c" "$base/tests/sealed-files-fixture.c" -o "$work/fixture"
"$work/fixture" "$work/root"
chmod +a 'everyone allow write' "$work/root/bundle/cli.js"
"$work/fixture" "$work/root" acl
