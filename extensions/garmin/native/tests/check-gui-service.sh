#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-gui-service.XXXXXX")
label="org.secondbrain.guifixture.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)";owned=0;uncertain=0
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  if [ "$owned" -eq 1 ] && ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then printf 'fixture 종료 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror -fblocks "$base/gui-client.c" "$base/submission-ipc.c" "$base/auth-channel.c" "$base/peer.c" "$base/xpc-peer.c" "$base/tests/gui-service-client.c" -lbsm -framework Security -framework CoreFoundation -o "$work/client"
xcrun clang -Wall -Wextra -Werror "$base/tests/gui-host-child.c" -o "$work/child"
client_hash=$(codesign -dv --verbose=4 "$work/client" 2>&1 | sed -n 's/^CDHash=//p')
child_hash=$(codesign -dv --verbose=4 "$work/child" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#client_hash} -eq 40 ] && [ ${#child_hash} -eq 40 ]
python3 - "$work/policy.h" "$label" "$(id -u)" "$client_hash" "$child_hash" <<'PY'
import sys
path,label,uid,supervisor,gui=sys.argv[1:]
def values(value): return ','.join('0x'+value[i:i+2] for i in range(0,len(value),2))
with open(path,'w',encoding='utf-8') as out:
    out.write(f'#define BRAIN_GUI_SERVICE "{label}"\n#define BRAIN_GUI_UID {uid}\n#define BRAIN_SUPERVISOR_UID {uid}\n#define BRAIN_PRESENCE_POLICY_GENERATION 1\n')
    out.write(f'static const uint8_t BRAIN_SUPERVISOR_HASH[20]={{{values(supervisor)}}};\nstatic const uint8_t BRAIN_GUI_HASH[20]={{{values(gui)}}};\n')
PY
xcrun clang -Wall -Wextra -Werror -fblocks -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_GUI_PATH="\"$work/child\"" -DBRAIN_NATIVE_POLICY_HEADER="\"$work/policy.h\"" "$base/gui-service.c" "$base/gui-host.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -framework SystemConfiguration -o "$work/service"
service_hash=$(codesign -dv --verbose=4 "$work/service" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#service_hash} -eq 40 ]
: > "$work/output"
cat > "$work/fixture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>$work/service</string></array><key>StandardOutPath</key><string>$work/output</string><key>MachServices</key><dict><key>$label</key><true/></dict></dict></plist>
PLIST
if ! launchctl bootstrap "$domain" "$work/fixture.plist"; then uncertain=1; exit 1; fi
owned=1
"$work/client" "$label" "$service_hash" "$work/output"
printf '%s\n' '합성 GUI host XPC 신원·중단·재개·종료 검사 통과'
