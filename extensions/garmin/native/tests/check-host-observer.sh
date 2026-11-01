#!/bin/sh
# 합성 XPC host의 종료 event만 시험한다. 실제 자식 종료 증거가 아니다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-host-observer.XXXXXX")
mode=${1:-valid}
case "$mode" in valid) fixture_flag= ;; wrong-pid) fixture_flag=-DBRAIN_WRONG_PID_FIXTURE ;; *) exit 2 ;; esac
label="org.secondbrain.observerfixture.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)"; owned=0; uncertain=0
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  if [ "$owned" -eq 1 ] && ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then printf 'fixture 종료 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror -fblocks $fixture_flag "$base/host-client.c" "$base/xpc-peer.c" "$base/tests/host-observer-client.c" -framework Security -framework CoreFoundation -o "$work/client"
client_hash=$(codesign -dv --verbose=4 "$work/client" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#client_hash} -eq 40 ]
python3 - "$work/policy.h" "$label" "$(id -u)" "$client_hash" <<'PY'
import sys
path,label,uid,digest=sys.argv[1:]
values=','.join('0x'+digest[i:i+2] for i in range(0,len(digest),2))
with open(path,'w',encoding='utf-8') as out:
    out.write(f'#define BRAIN_TEST_SERVICE "{label}"\n#define BRAIN_CLIENT_UID {uid}\nstatic const uint8_t BRAIN_CLIENT_HASH[20]={{{values}}};\n')
PY
xcrun clang -Wall -Wextra -Werror -fblocks $fixture_flag -DBRAIN_NATIVE_POLICY_HEADER="\"$work/policy.h\"" "$base/xpc-peer.c" "$base/tests/host-observer-service.c" -framework Security -framework CoreFoundation -o "$work/service"
service_hash=$(codesign -dv --verbose=4 "$work/service" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#service_hash} -eq 40 ]
cat > "$work/fixture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>$work/service</string></array><key>MachServices</key><dict><key>$label</key><true/></dict></dict></plist>
PLIST
if ! launchctl bootstrap "$domain" "$work/fixture.plist"; then uncertain=1; exit 1; fi
owned=1
"$work/client" "$label" "$service_hash"
printf '합성 native host 종료 event 검증 통과: %s\n' "$mode"
