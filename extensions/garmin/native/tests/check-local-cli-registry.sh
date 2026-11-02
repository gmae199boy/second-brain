#!/bin/sh
# 로컬 build를 사용하는 비배포 fixture. 설치 또는 동적 로딩 격리의 증거가 아니다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(git rev-parse --show-toplevel)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-cli-registry.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -m 700 "$work/registry" "$work/payload" "$work/payload/bin" "$work/payload/cli"
cd "$repo"
node node_modules/.pnpm/rolldown@1.2.12/node_modules/rolldown/bin/cli.mjs apps/cli/dist/daemon/sealed-queue-entry.js --platform node --format esm --no-codeSplitting --file "$work/payload/cli/bin.js"
cp "$(command -v node)" "$work/payload/bin/node"
codesign --force --sign - "$work/payload/bin/node" >/dev/null 2>&1
node_prefix=$(dirname "$(dirname "$(command -v node)")")
xcrun clang -bundle -undefined dynamic_lookup -Wno-deprecated-declarations -I"$node_prefix/include/node" "$base/queue-peer-addon.c" "$base/peer.c" -lbsm -framework Security -framework CoreFoundation -o "$work/payload/cli/peer.node"
codesign --force --sign - "$work/payload/cli/peer.node" >/dev/null 2>&1
cdhash=$(codesign -d --verbose=4 "$work/payload/bin/node" 2>&1 | sed -n 's/^CDHash=//p')
[ "${#cdhash}" -eq 40 ]
addon_hash=$(codesign -d --verbose=4 "$work/payload/cli/peer.node" 2>&1 | sed -n 's/^CDHash=//p')
[ "${#addon_hash}" -eq 40 ]
{ printf 'brain-queue-registry-v2\n%s\n%s\n' "$cdhash" "$addon_hash"; (cd "$work/payload" && shasum -a 256 bin/node cli/bin.js cli/peer.node | sed 's/  / /'); } > "$work/registry/queue.registry"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations -DBRAIN_REGISTRY_FIXTURE \
  "$base/sealed-files.c" "$base/sealed-bundle.c" "$base/sealed-signature.c" "$base/sealed-registry.c" "$base/tests/sealed-registry-fixture.c" \
  -framework Security -framework CoreFoundation -o "$work/fixture"
"$work/fixture" "$work/registry" "$work/payload" 1
set +e
env -i PATH=/usr/bin:/bin LANG=C "$work/payload/bin/node" "$work/payload/cli/bin.js" --sealed-queue-client > "$work/out" 2> "$work/err"
status=$?
set -e
[ "$status" -eq 2 ]
[ ! -s "$work/out" ] && [ ! -s "$work/err" ]
if rg -q '__require\(|import\(' "$work/payload/cli/bin.js"; then exit 1; fi
printf '\n' >> "$work/payload/cli/bin.js"
"$work/fixture" "$work/registry" "$work/payload" 0
printf '%s\n' '제한 queue 후보·고정 목록과 실패 닫힘 통과'
