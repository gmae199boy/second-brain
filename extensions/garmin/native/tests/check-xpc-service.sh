#!/bin/sh
# 사용자 도메인의 일회용 합성 MachService만 등록하고 종료한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-xpc-service.XXXXXX")
label="org.secondbrain.fixture.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)"
owned=0
uncertain=0
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  if [ "$owned" -eq 1 ]; then
    if ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then
      printf '%s\n' 'fixture 서비스 종료 확인 실패: 임시 파일을 보존합니다.' >&2
      return 1
    fi
  fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror -fblocks "$base/xpc-peer.c" "$base/tests/xpc-service.c" -framework Security -framework CoreFoundation -o "$work/service"
xcrun clang -Wall -Wextra -Werror -fblocks "$base/xpc-peer.c" "$base/tests/xpc-client.c" -framework Security -framework CoreFoundation -o "$work/client"
xcrun clang -Wall -Wextra -Werror -fblocks -DFIXTURE_VARIANT=1 "$base/xpc-peer.c" "$base/tests/xpc-client.c" -framework Security -framework CoreFoundation -o "$work/other"
service_hash=$(codesign -dv --verbose=4 "$work/service" 2>&1 | sed -n 's/^CDHash=//p')
client_hash=$(codesign -dv --verbose=4 "$work/client" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#service_hash} -eq 40 ] && [ ${#client_hash} -eq 40 ]
cat > "$work/fixture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>$work/service</string><string>$label</string><string>$client_hash</string></array><key>StandardErrorPath</key><string>$work/service-error</string><key>MachServices</key><dict><key>$label</key><true/></dict></dict></plist>
PLIST
if ! launchctl bootstrap "$domain" "$work/fixture.plist"; then
  uncertain=1
  exit 1
fi
owned=1
if ! first=$("$work/client" "$label" "$service_hash"); then
  [ ! -f "$work/service-error" ] || cat "$work/service-error" >&2
  exit 1
fi
if "$work/other" "$label" "$service_hash" >/dev/null 2>&1; then printf '%s\n' '다른 실행물이 허용되었습니다.' >&2; exit 1; fi
if "$work/client" "$label" "$client_hash" >/dev/null 2>&1; then printf '%s\n' '다른 서비스 해시가 허용되었습니다.' >&2; exit 1; fi
launchctl kickstart -k "$domain/$label"
second=$("$work/client" "$label" "$service_hash")
[ -n "$first" ] && [ -n "$second" ] && [ "$first" != "$second" ]
printf '%s\n' '별도 XPC 서비스 상호 인증·다른 binary 거부·재시작 통과'
