#!/bin/sh
# 합성 자식으로 ACK·검사·종료를 검증한다. 실제 Garmin 실행물·계정은 사용하지 않는다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-worker-service.XXXXXX")
label="org.secondbrain.workersuccess.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)"; owned=0; uncertain=0
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  if [ "$owned" -eq 1 ] && ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then
    printf 'fixture 종료 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1
  fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror -fblocks "$base/xpc-peer.c" "$base/host-client.c" "$base/tests/worker-success-client.c" -framework Security -framework CoreFoundation -o "$work/client"
client_hash=$(codesign -dv --verbose=4 "$work/client" 2>&1 | sed -n 's/^CDHash=//p')
xcrun clang -Wall -Wextra -Werror "$base/peer.c" "$base/tests/worker-success-child.c" -lbsm -framework Security -framework CoreFoundation -o "$work/child"
worker_hash=$(codesign -dv --verbose=4 "$work/child" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#client_hash} -eq 40 ] && [ ${#worker_hash} -eq 40 ]
python3 - "$work/policy.h" "$label" "$(id -u)" "$client_hash" "$worker_hash" <<'PY'
import sys
path, label, uid, supervisor, worker = sys.argv[1:]
def values(value): return ','.join('0x' + value[i:i+2] for i in range(0,len(value),2))
with open(path,'w',encoding='utf-8') as out:
    out.write(f'#define BRAIN_MACH_SERVICE "{label}"\n#define BRAIN_SUPERVISOR_UID {uid}\n#define BRAIN_WORKER_UID {uid}\n')
    out.write(f'static const uint8_t BRAIN_SUPERVISOR_HASH[20]={{{values(supervisor)}}};\n')
    out.write(f'static const uint8_t BRAIN_WORKER_HASH[20]={{{values(worker)}}};\n')
    out.write('static const uint8_t BRAIN_PACKAGE_HASH[32]={' + ','.join(['1']*32) + '};\n')
PY
xcrun clang -Wall -Wextra -Werror -fblocks -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_WORKER_PATH="\"$work/child\"" -DBRAIN_NATIVE_POLICY_HEADER="\"$work/policy.h\"" \
  "$base/worker-service.c" "$base/worker-host.c" "$base/peer.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -o "$work/service"
service_hash=$(codesign -dv --verbose=4 "$work/service" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#service_hash} -eq 40 ]
cat > "$work/fixture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>$work/service</string></array><key>StandardErrorPath</key><string>$work/service-error</string><key>MachServices</key><dict><key>$label</key><true/></dict></dict></plist>
PLIST
if ! launchctl bootstrap "$domain" "$work/fixture.plist"; then uncertain=1; exit 1; fi
owned=1
"$work/client" "$label" "$service_hash"
rg -q '^fixture-spawned$' "$work/service-error"
printf '%s\n' '합성 자식의 ACK 전 차단·원격 검사·종료 관찰 통과'
