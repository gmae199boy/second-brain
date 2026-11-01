#!/bin/sh
# 임시 사용자 launchd와 합성 XPC 메시지만 사용한다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-broker-service.XXXXXX")
label="org.secondbrain.brokerfixture.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)"; owned=0; uncertain=0
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  if [ "$owned" -eq 1 ] && ! launchctl bootout "$domain/$label" >/dev/null 2>&1; then printf 'fixture 종료 상태 불명: %s, %s\n' "$label" "$work" >&2; return 1; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
xcrun clang -Wall -Wextra -Werror -fblocks "$base/xpc-peer.c" "$base/peer.c" "$base/auth-channel.c" "$base/tests/broker-service-client.c" -lbsm -framework Security -framework CoreFoundation -o "$work/client"
client_hash=$(codesign -dv --verbose=4 "$work/client" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#client_hash} -eq 40 ]
python3 - "$work/policy.h" "$label" "$(id -u)" "$client_hash" <<'PY'
import sys
path,label,uid,digest=sys.argv[1:]
values=','.join('0x'+digest[i:i+2] for i in range(0,len(digest),2))
with open(path,'w',encoding='utf-8') as out:
    for role in ('SUPERVISOR','WORKER','UI'):
        out.write(f'#define BRAIN_BROKER_{role}_SERVICE "{label}.{role.lower()}"\n#define BRAIN_{role}_UID {uid}\n')
        out.write(f'static const uint8_t BRAIN_{role}_HASH[20]={{{values}}};\n')
    out.write(f'#define BRAIN_BROKER_UID {uid}\nstatic const uint8_t BRAIN_PACKAGE_HASH[32]={{'+','.join(['1']*32)+'};\n')
PY
xcrun clang -Wall -Wextra -Werror -fblocks -DBRAIN_NATIVE_FIXTURE -DBRAIN_SAME_UID_FIXTURE -DBRAIN_NATIVE_POLICY_HEADER="\"$work/policy.h\"" "$base/broker-service.c" "$base/broker.c" "$base/session.c" "$base/peer.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -o "$work/service"
service_hash=$(codesign -dv --verbose=4 "$work/service" 2>&1 | sed -n 's/^CDHash=//p')
[ ${#service_hash} -eq 40 ]
cat > "$work/fixture.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$label</string><key>ProgramArguments</key><array><string>$work/service</string></array><key>MachServices</key><dict><key>$label.supervisor</key><true/><key>$label.worker</key><true/><key>$label.ui</key><true/></dict></dict></plist>
PLIST
if ! launchctl bootstrap "$domain" "$work/fixture.plist"; then uncertain=1; exit 1; fi
owned=1
"$work/client" "$label" "$service_hash"
printf '%s\n' 'broker 세 역할 연결과 승인 차단 통과'
