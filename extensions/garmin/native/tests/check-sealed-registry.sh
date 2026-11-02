#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-registry.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -m 700 "$work/registry" "$work/payload" "$work/payload/bin" "$work/payload/cli"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations -DBRAIN_REGISTRY_FIXTURE \
  "$base/sealed-files.c" "$base/sealed-bundle.c" "$base/sealed-signature.c" "$base/sealed-registry.c" "$base/tests/sealed-registry-fixture.c" \
  -framework Security -framework CoreFoundation -o "$work/fixture"
cp "$(command -v node)" "$work/payload/bin/node"
codesign --force --sign - "$work/payload/bin/node" >/dev/null 2>&1
cat > "$work/payload/cli/bin.js" <<'JS'
import './loader.js';
if (process.argv.length !== 3 || process.argv[2] !== '--sealed-queue-client' || process.cwd() !== '/' || process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.HOME || process.env.DYLD_LIBRARY_PATH) process.exit(1);
JS
printf 'export {};\n' > "$work/payload/cli/loader.js"
cp "$work/payload/bin/node" "$work/payload/cli/peer.node"
cdhash=$(codesign -d --verbose=4 "$work/payload/bin/node" 2>&1 | sed -n 's/^CDHash=//p')
[ "${#cdhash}" -eq 40 ]
make_registry() {
  { printf 'brain-queue-registry-v2\n%s\n%s\n' "$cdhash" "$cdhash"; (cd "$work/payload" && shasum -a 256 bin/node cli/bin.js cli/loader.js cli/peer.node | sed 's/  / /'); } > "$work/registry/queue.registry"
}
check() { "$work/fixture" "$work/registry" "$work/payload" "$1"; }
make_registry
check 1
NODE_OPTIONS=--require=/tmp/injected.cjs NODE_PATH=/tmp DYLD_LIBRARY_PATH=/tmp "$work/fixture" "$work/registry" "$work/payload" spawn
"$work/fixture" "$work/registry" "$work/payload" swap
check 1
printf 'tamper\n' >> "$work/payload/cli/loader.js"
check 0
printf 'export {};\n' > "$work/payload/cli/loader.js"
touch "$work/payload/cli/extra.js"
check 0
rm "$work/payload/cli/extra.js"
chmod 777 "$work/registry"
check 0
chmod 700 "$work/registry"
chmod 777 "$work/payload/cli"
check 0
chmod 700 "$work/payload/cli"
ln "$work/registry/queue.registry" "$work/registry/link"
check 0
rm "$work/registry/link"
chmod 666 "$work/registry/queue.registry"
check 0
chmod 600 "$work/registry/queue.registry"
chmod +a 'everyone allow write' "$work/registry/queue.registry"
check 0
chmod -N "$work/registry/queue.registry"
cp "$work/registry/queue.registry" "$work/original"
sed '2s/^./0/' "$work/original" > "$work/registry/queue.registry"
check 0
sed '3s/^./0/' "$work/original" > "$work/registry/queue.registry"
check 0
sed '/cli\/loader.js/d' "$work/original" > "$work/registry/queue.registry"
check 0
cat "$work/original" "$work/original" > "$work/registry/queue.registry"
check 0
rm "$work/registry/queue.registry"
ln -s "$work/original" "$work/registry/queue.registry"
check 0
printf '%s\n' '합성 registry·Node 서명·전체 목록 부정 시험 통과'
