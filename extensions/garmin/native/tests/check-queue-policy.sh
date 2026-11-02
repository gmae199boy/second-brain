#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-queue-policy.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -m 700 "$work/policy"
xcrun clang -Wall -Wextra -Werror -Wno-deprecated-declarations -DBRAIN_REGISTRY_FIXTURE "$base/sealed-files.c" "$base/sealed-bundle.c" "$base/sealed-signature.c" "$base/sealed-registry.c" "$base/queue-policy.c" "$base/tests/queue-policy-fixture.c" -framework Security -framework CoreFoundation -o "$work/fixture"
printf '%s 1111111111111111111111111111111111111111\n' "$(id -u)" > "$work/policy/queue-client.pin"
"$work/fixture" "$work/policy" 1
chmod 666 "$work/policy/queue-client.pin"
"$work/fixture" "$work/policy" 0
chmod 600 "$work/policy/queue-client.pin"
chmod +a 'everyone allow write' "$work/policy/queue-client.pin"
"$work/fixture" "$work/policy" 0
chmod -N "$work/policy/queue-client.pin"
printf '%s invalid\n' "$(id -u)" > "$work/policy/queue-client.pin"
"$work/fixture" "$work/policy" 0
rm "$work/policy/queue-client.pin"
ln -s /dev/null "$work/policy/queue-client.pin"
"$work/fixture" "$work/policy" 0
printf '%s\n' 'queue client pin 소유권·ACL·형식 거부 통과'
