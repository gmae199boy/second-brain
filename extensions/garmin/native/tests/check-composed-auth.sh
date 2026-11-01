#!/bin/sh
# 별도 합성 프로세스·임시 사용자 서비스와 격리 PostgreSQL을 사용한다. 생체는 합성이다.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/brain-composed-auth.XXXXXX")
prefix="org.secondbrain.composed.$(uuidgen | tr '[:upper:]' '[:lower:]')"
domain="gui/$(id -u)";broker_owned=0;host_owned=0;gui_owned=0;db_owned=0;uncertain=0
db="brain162g4-$(uuidgen | tr '[:upper:]' '[:lower:]')"
cleanup() {
  if [ "$uncertain" -eq 1 ]; then printf 'fixture 등록 상태 불명: %s, %s\n' "$prefix" "$work" >&2; return 1; fi
  for role in gui host broker; do
    eval "owned=\${${role}_owned}"
    if [ "$owned" -eq 1 ] && ! launchctl bootout "$domain/$prefix.$role" >/dev/null 2>&1; then printf 'fixture 종료 상태 불명: %s.%s, %s\n' "$prefix" "$role" "$work" >&2; return 1; fi
  done
  if [ "$db_owned" -eq 1 ] && ! docker rm -fv "$db" >/dev/null; then printf 'fixture DB 종료 상태 불명: %s\n' "$db" >&2; return 1; fi
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
if [ "${BRAIN_FIXTURE_NATIVE_STORE:-}" = 1 ]; then
  docker run -d -p 127.0.0.1::5432 --name "$db" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18 >/dev/null
else
  docker run -d --network none --name "$db" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18 >/dev/null
fi
db_owned=1
ready=0
for attempt in $(seq 1 100); do
  if docker logs "$db" 2>&1 | rg -q 'PostgreSQL init process complete' && docker exec "$db" pg_isready -U postgres >/dev/null 2>&1; then ready=1;break;fi
  sleep 0.1
done
[ "$ready" -eq 1 ]
created=0
for attempt in $(seq 1 100); do
  if docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'create table fixture_admission(work uuid primary key,attempt uuid not null,pid integer,start_sec bigint,start_usec bigint)' >/dev/null 2>&1; then created=1;break;fi
  sleep 0.1
done
[ "$created" -eq 1 ]
if [ "${BRAIN_FIXTURE_NATIVE_STORE:-}" = 1 ]; then
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'create table fixture_sync(mark text primary key)' >/dev/null
fi
if [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]; then
  repo=$(CDPATH= cd -- "$base/../../.." && pwd)
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create role brain_owner; create role brain_app; create role brain_maintenance; create role brain_ext_garmin; create role brain_protected_supervisor; create role brain_protected_broker; create role brain_protected_worker; create schema brain; create schema garmin; create table brain.schema_migrations(owner text not null,version integer not null,name text not null,checksum text not null,applied_at timestamptz not null,primary key(owner,version));" >/dev/null
  for migration in "$repo"/packages/postgres/migrations/*.sql "$repo"/packages/postgres/protected-migrations/*.sql "$repo"/extensions/garmin/migrations/*.sql "$repo"/extensions/garmin/protected-migrations/*.sql; do
    docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$migration" >/dev/null
  done
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "insert into garmin.account_protection(id) values ('00000000-0000-4000-8000-000000000001'); insert into garmin.account_binding(target,protection_id) values ('fixture','00000000-0000-4000-8000-000000000001'); insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('garmin','1',now(),true,now());" >/dev/null
fi
if [ "${BRAIN_FIXTURE_GENERIC:-}" = 1 ]; then
  [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]
  docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into brain.protected_work_kinds(kind,hold_group,extension_name,requires_input_revoke) values
 ('fixture.auth','extension:fixture','fixture',true),('fixture.collect','extension:fixture','fixture',false);
insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('fixture','1',now(),true,now()),('ordinary','1',now(),true,now());
set session authorization brain_protected_supervisor;
insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values
 ('00000000-0000-4000-8000-000000000201','fixture.auth','extension','fixture',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:fixture'),
 ('00000000-0000-4000-8000-000000000301','ordinary.auth','extension','ordinary',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:ordinary'),
 ('00000000-0000-4000-8000-000000000401','fixture.collect','extension','fixture',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:fixture'),
 ('00000000-0000-4000-8000-000000000501','garmin.auth','extension','garmin',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:garmin');
insert into brain.work_attempts(token,work_item_id,started_at,protected_launch_lease,protected_connection_epoch) values
 ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000201',now(),'00000000-0000-4000-8000-000000000203',1),
 ('00000000-0000-4000-8000-000000000302','00000000-0000-4000-8000-000000000301',now(),'00000000-0000-4000-8000-000000000303',1),
 ('00000000-0000-4000-8000-000000000402','00000000-0000-4000-8000-000000000401',now(),'00000000-0000-4000-8000-000000000403',1),
 ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000501',now(),'00000000-0000-4000-8000-000000000503',1);
update brain.work_items set current_attempt_token=case id
 when '00000000-0000-4000-8000-000000000201' then '00000000-0000-4000-8000-000000000202'::uuid
 when '00000000-0000-4000-8000-000000000301' then '00000000-0000-4000-8000-000000000302'::uuid
 when '00000000-0000-4000-8000-000000000401' then '00000000-0000-4000-8000-000000000402'::uuid
 when '00000000-0000-4000-8000-000000000501' then '00000000-0000-4000-8000-000000000502'::uuid end;
SQL
  for statement in "update brain.work_items set cancel_requested_at=now() where kind='fixture.auth'" "update brain.work_items set hold_group='extension:ordinary' where kind='fixture.auth'" "insert into brain.work_hold_groups(name,held_at) values ('extension:fixture',now())" "update brain.extensions set enabled=false where name='fixture'"; do
    if docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; $statement" >/dev/null 2>&1; then exit 1;fi
  done
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; update brain.work_items set cancel_requested_at=now() where kind in ('ordinary.auth','fixture.collect'); insert into brain.work_hold_groups(name,held_at) values ('extension:ordinary',now()); update brain.extensions set enabled=false where name='ordinary'; select 1/(case when brain.record_protected_auth_revoke('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000202',1,1,'00000000-0000-4000-8000-000000000203') then 1 else 0 end); update brain.work_items set cancel_requested_at=now() where kind='fixture.auth'; insert into brain.work_hold_groups(name,held_at) values ('extension:fixture',now()); update brain.extensions set enabled=false where name='fixture'" >/dev/null
  if docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',now())" >/dev/null 2>&1; then exit 1;fi
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_items where kind in ('ordinary.auth','fixture.collect','fixture.auth') and cancel_requested_at is not null")
  [ "$count" = 3 ]
  printf '%s\n' '일반 registry 기반 보호 입력 경계 및 일반 일감 비간섭 통과'
  exit 0
fi
if [ "${BRAIN_FIXTURE_RACE:-}" = 1 ]; then
  [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ('00000000-0000-4000-8000-000000000101','garmin.auth','extension','garmin',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:garmin'); insert into brain.work_attempts(token,work_item_id,started_at) values ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000101',now())" >/dev/null
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "/* fixture_hold_barrier */ begin; set session authorization brain_protected_supervisor; insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',now()); select pg_sleep(2); commit" >/dev/null 2>&1 &
  holder=$!;sleeping=0
  for attempt in $(seq 1 100); do
    count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from pg_stat_activity where query like '%fixture_hold_barrier%' and wait_event='PgSleep'")
    if [ "$count" = 1 ]; then sleeping=1;break;fi
    sleep 0.05
  done
  [ "$sleeping" -eq 1 ]
  if docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; update brain.work_items set current_attempt_token='00000000-0000-4000-8000-000000000102' where id='00000000-0000-4000-8000-000000000101'" >/dev/null 2>&1; then
    wait "$holder";exit 1
  fi
  wait "$holder"
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_items where id='00000000-0000-4000-8000-000000000101' and current_attempt_token is null")
  [ "$count" = 1 ]
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; delete from brain.work_hold_groups where name='extension:garmin'; update brain.work_items set current_attempt_token='00000000-0000-4000-8000-000000000102' where id='00000000-0000-4000-8000-000000000101'; update brain.work_attempts set protected_launch_lease='00000000-0000-4000-8000-000000000103',protected_connection_epoch=1 where token='00000000-0000-4000-8000-000000000102'; select 1/(case when brain.record_protected_auth_revoke('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102',1,1,'00000000-0000-4000-8000-000000000103') then 1 else 0 end); update brain.work_attempts set protected_connection_epoch=2 where token='00000000-0000-4000-8000-000000000102'" >/dev/null
  if docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "set session authorization brain_protected_supervisor; update brain.work_items set cancel_requested_at=now() where id='00000000-0000-4000-8000-000000000101'" >/dev/null 2>&1; then exit 1;fi
  printf '%s\n' '보호 claim·hold 경합과 이전 epoch 폐기 증거 거부 통과'
  exit 0
fi
common="-Wall -Wextra -Werror -fblocks"
native_flags="";native_source="";native_lib="";broker_flags="";broker_source=""
if [ "${BRAIN_FIXTURE_NATIVE_STORE:-}" = 1 ]; then
  [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]
  repo=$(CDPATH= cd -- "$base/../../.." && pwd)
  mkdir "$work/lib"
  cp "$repo"/extensions/garmin/.venv/lib/python3.14/site-packages/psycopg_binary/.dylibs/*.dylib "$work/lib/"
  install_name_tool -id '@rpath/libpq.5.dylib' "$work/lib/libpq.5.dylib"
  codesign --force --sign - "$work/lib/libpq.5.dylib" >/dev/null 2>&1
  ln -s libpq.5.dylib "$work/lib/libpq.dylib"
  port=$(docker port "$db" 5432/tcp | sed -n 's/^127\.0\.0\.1://p')
  [ -n "$port" ]
  native_flags="-DFIXTURE_NATIVE_STORE=1 -DFIXTURE_PG_PORT=$port"
  native_source="$base/supervisor-store.c"
  native_lib="-L$work/lib -lpq -Wl,-rpath,$work/lib"
  broker_flags="-DBRAIN_FIXTURE_BROKER_PG -DFIXTURE_PG_PORT=$port"
  broker_source="$base/broker-store.c"
fi
fixture_abi=
if [ "${BRAIN_FIXTURE_MULTI_SESSION:-}" = 1 ]; then
  mkdir "$work/barrier"
  fixture_abi="-DBRAIN_FIXTURE_MULTI_SESSION -DBRAIN_FIXTURE_BARRIER=\"$work/barrier\""
fi
if [ "${BRAIN_FIXTURE_CORE:-}" = 1 ]; then
  [ "${BRAIN_FIXTURE_NATIVE_STORE:-}" = 1 ] && [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]
  fixture_abi=-DBRAIN_FIXTURE_ABI
  if [ "${BRAIN_FIXTURE_CORE_SIGNAL:-}" = 1 ]; then fixture_abi="$fixture_abi -DBRAIN_FIXTURE_SIGNAL"; fi
  if [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = host-restart ] || [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = restart ]; then fixture_abi="$fixture_abi -DBRAIN_FIXTURE_HOST_CRASH"; fi
  if [ "${BRAIN_FIXTURE_CORE_DESCENDANT:-}" = 1 ]; then fixture_abi="$fixture_abi -DBRAIN_FIXTURE_CORE_DESCENDANT"; fi
  docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "alter role brain_protected_supervisor login; insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('core',29,'fixture','fixture',now()); set session authorization brain_protected_supervisor; insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group) values ('00000000-0000-4000-8000-000000000151','garmin.auth','extension','garmin',now(),now(),'supervised','extension:garmin')" >/dev/null
  if [ "${BRAIN_FIXTURE_TWO_CORE:-}" = 1 ]; then
    docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "update garmin.account_protection set profile_id='fixture-profile-1' where id='00000000-0000-4000-8000-000000000001'; insert into garmin.account_protection(id,profile_id) values ('00000000-0000-4000-8000-000000000002','fixture-profile-2'); insert into garmin.account_binding(target,protection_id) values ('fixture2','00000000-0000-4000-8000-000000000002'); set session authorization brain_protected_supervisor; update brain.work_items set target_kind='account',target_id='00000000-0000-4000-8000-000000000001' where id='00000000-0000-4000-8000-000000000151'; insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group) values ('00000000-0000-4000-8000-000000000152','garmin.auth','account','00000000-0000-4000-8000-000000000002',now(),now(),'supervised','extension:garmin')" >/dev/null
  fi
  if [ "${BRAIN_FIXTURE_CORE_RECORD:-}" = deny ]; then
    docker exec "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create function brain.fixture_reject_identity() returns trigger language plpgsql as \$\$ begin if old.pid is null and new.pid is not null then raise exception 'fixture'; end if; return new; end \$\$; create trigger fixture_reject_identity before update on brain.work_attempts for each row execute function brain.fixture_reject_identity()" >/dev/null
  fi
fi
case "${BRAIN_FIXTURE_CASE:-0}" in 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16) fixture_case=${BRAIN_FIXTURE_CASE:-0};; *) exit 1;; esac
if [ "$fixture_case" -ge 6 ]; then [ "${BRAIN_FIXTURE_NATIVE_STORE:-}" = 1 ]; fi
xcrun clang $common $fixture_abi -DFIXTURE_CASE="$fixture_case" -DFIXTURE_HOST_PATH="\"$work/host\"" -DFIXTURE_BROKER_PATH="\"$work/broker\"" -DFIXTURE_BROKER_WORKER="\"$prefix.broker.worker\"" \
  "$base/tests/composed-worker.c" "$base/child-bootstrap.c" "$base/submission-ipc.c" "$base/auth-channel.c" "$base/peer.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -o "$work/worker"
xcrun clang $common $native_flags -DFIXTURE_CASE="$fixture_case" -DFIXTURE_BROKER_PATH="\"$work/broker\"" -DFIXTURE_BROKER_UI="\"$prefix.broker.ui\"" \
  "$base/tests/composed-ui.m" "$base/submission-ui.m" "$base/submission-ipc.c" "$base/auth-channel.c" "$base/peer.c" "$base/xpc-peer.c" $native_lib -lbsm -framework AppKit -framework Security -framework CoreFoundation -o "$work/ui"
xcrun clang $common $fixture_abi $native_flags -DFIXTURE_CASE="$fixture_case" -DFIXTURE_HOST_PATH="\"$work/host\"" -DFIXTURE_BROKER_PATH="\"$work/broker\"" -DFIXTURE_GUI_PATH="\"$work/gui\"" \
  -DFIXTURE_HOST_SERVICE="\"$prefix.host\"" -DFIXTURE_GUI_SERVICE="\"$prefix.gui\"" -DFIXTURE_BROKER_SUPERVISOR="\"$prefix.broker.supervisor\"" \
  -DFIXTURE_DB_CONTAINER="\"$db\"" \
  "$base/tests/composed-supervisor.c" "$base/supervisor-native.c" "$base/supervisor-bootstrap.c" "$base/gui-client.c" "$base/host-client.c" "$base/submission-ipc.c" "$base/auth-channel.c" "$base/peer.c" "$base/xpc-peer.c" $native_source $native_lib -lbsm -framework Security -framework CoreFoundation -o "$work/supervisor"
hash() { codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
if [ "${BRAIN_FIXTURE_CORE:-}" = 1 ]; then
  node_path=$(command -v node)
  python3 - "$work/bridge-policy.h" "$prefix" "$(id -u)" <<'PYBRIDGE'
import sys
path,prefix,uid=sys.argv[1:]
with open(path,'w',encoding='utf-8') as out:
    out.write(f'#define BRAIN_SUPERVISOR_UID {uid}\n#define BRAIN_HOST_UID {uid}\n#define BRAIN_BROKER_UID {uid}\n#define BRAIN_GUI_UID {uid}\n#define BRAIN_PACKAGE_GENERATION 1\n')
    out.write(f'#define BRAIN_BRIDGE_HOST_SERVICE "{prefix}.host"\n#define BRAIN_BRIDGE_BROKER_SERVICE "{prefix}.broker.supervisor"\n#define BRAIN_BRIDGE_GUI_SERVICE "{prefix}.gui"\n')
    out.write('static const uint8_t BRAIN_PACKAGE_HASH[32]={' + ','.join(['1']*32) + '};\n')
PYBRIDGE
  xcrun clang $common -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_PG_PORT="$port" -DBRAIN_NATIVE_POLICY_HEADER="\"$work/bridge-policy.h\"" \
    -DBRAIN_FIXTURE_NODE_PATH="\"$node_path\"" -DBRAIN_FIXTURE_HOST_PATH="\"$work/host\"" -DBRAIN_FIXTURE_BROKER_PATH="\"$work/broker\"" -DBRAIN_FIXTURE_GUI_PATH="\"$work/gui\"" \
    "$base/supervisor-bridge.c" "$base/supervisor-native.c" "$base/supervisor-bootstrap.c" "$base/supervisor-store.c" "$base/gui-client.c" "$base/host-client.c" "$base/submission-ipc.c" "$base/auth-channel.c" "$base/peer.c" "$base/xpc-peer.c" $native_lib -lbsm -framework Security -framework CoreFoundation -o "$work/bridge"
  supervisor_hash=$(hash "$work/bridge")
else
  supervisor_hash=$(hash "$work/supervisor")
fi
worker_hash=$(hash "$work/worker");ui_hash=$(hash "$work/ui")
[ ${#supervisor_hash} -eq 40 ] && [ ${#worker_hash} -eq 40 ] && [ ${#ui_hash} -eq 40 ]
python3 - "$work" "$prefix" "$(id -u)" "$supervisor_hash" "$worker_hash" "$ui_hash" <<'PY'
import sys
from pathlib import Path
work,prefix,uid,sup,worker,ui=sys.argv[1:]
def value(s):return ','.join('0x'+s[i:i+2] for i in range(0,len(s),2))
package=','.join(['1']*32)
common=f'#define BRAIN_SUPERVISOR_UID {uid}\nstatic const uint8_t BRAIN_SUPERVISOR_HASH[20]={{{value(sup)}}};\n'
Path(work,'broker-policy.h').write_text(common+f'#define BRAIN_BROKER_UID {uid}\n#define BRAIN_WORKER_UID {uid}\n#define BRAIN_UI_UID {uid}\n#define BRAIN_PRESENCE_POLICY_GENERATION 1\n'+''.join(f'#define BRAIN_BROKER_{role.upper()}_SERVICE "{prefix}.broker.{role}"\n' for role in ('supervisor','worker','ui'))+f'static const uint8_t BRAIN_WORKER_HASH[20]={{{value(worker)}}},BRAIN_UI_HASH[20]={{{value(ui)}}},BRAIN_PACKAGE_HASH[32]={{{package}}};\n')
Path(work,'host-policy.h').write_text(common+f'#define BRAIN_MACH_SERVICE "{prefix}.host"\n#define BRAIN_WORKER_UID {uid}\nstatic const uint8_t BRAIN_WORKER_HASH[20]={{{value(worker)}}},BRAIN_PACKAGE_HASH[32]={{{package}}};\n')
Path(work,'gui-policy.h').write_text(common+f'#define BRAIN_GUI_SERVICE "{prefix}.gui"\n#define BRAIN_GUI_UID {uid}\n#define BRAIN_PRESENCE_POLICY_GENERATION 1\nstatic const uint8_t BRAIN_GUI_HASH[20]={{{value(ui)}}};\n')
PY
xcrun clang $common $broker_flags -DBRAIN_NATIVE_FIXTURE -DBRAIN_SAME_UID_FIXTURE -DBRAIN_NATIVE_POLICY_HEADER="\"$work/broker-policy.h\"" \
  "$base/broker-service.c" "$base/broker.c" "$base/session.c" "$base/presence.c" "$base/peer.c" "$base/xpc-peer.c" $broker_source $native_lib -lbsm -framework Security -framework CoreFoundation -framework SystemConfiguration -o "$work/broker"
xcrun clang $common -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_WORKER_PATH="\"$work/worker\"" -DBRAIN_NATIVE_POLICY_HEADER="\"$work/host-policy.h\"" \
  "$base/worker-service.c" "$base/worker-host.c" "$base/peer.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -o "$work/host"
xcrun clang $common -DBRAIN_NATIVE_FIXTURE -DBRAIN_FIXTURE_GUI_PATH="\"$work/ui\"" -DBRAIN_NATIVE_POLICY_HEADER="\"$work/gui-policy.h\"" \
  "$base/gui-service.c" "$base/gui-host.c" "$base/xpc-peer.c" -lbsm -framework Security -framework CoreFoundation -framework SystemConfiguration -o "$work/gui"
for role in broker host gui; do
  if [ "$role" = broker ]; then services="<key>$prefix.broker.supervisor</key><true/><key>$prefix.broker.worker</key><true/><key>$prefix.broker.ui</key><true/>"; else services="<key>$prefix.$role</key><true/>"; fi
  cat > "$work/$role.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$prefix.$role</string><key>ProgramArguments</key><array><string>$work/$role</string></array><key>StandardOutPath</key><string>$work/$role.out</string><key>StandardErrorPath</key><string>$work/$role.err</string><key>MachServices</key><dict>$services</dict></dict></plist>
PLIST
  if ! launchctl bootstrap "$domain" "$work/$role.plist"; then uncertain=1;exit 1;fi
  case "$role" in broker) broker_owned=1;; host) host_owned=1;; gui) gui_owned=1;; esac
done
if [ "${BRAIN_FIXTURE_CORE:-}" = 1 ]; then
  if ! node "$base/tests/core-native-runner.mjs" "$work/bridge" "$port" "$work/worker" "${BRAIN_FIXTURE_CORE_SIGNAL:-0}" "$domain/$prefix.host"; then
    rg '^fixture-' "$work/broker.err" >&2 || :
    exit 1
  fi
  if [ -n "${BRAIN_FIXTURE_CORE_RECORD:-}" ]; then
    rg -q '^fixture-spawned$' "$work/host.err"
    if rg -q '^fixture-ack$' "$work/host.err" || rg -q '^fixture-prompt$' "$work/broker.err"; then exit 1; fi
  fi
  if [ "${BRAIN_FIXTURE_CORE_SIGNAL:-}" = 1 ] && [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" != restart ] && [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" != host-restart ]; then
    rg -q '^fixture-revoked$' "$work/broker.err"
    rg -q '^fixture-signalled$' "$work/host.err"
    if [ "${BRAIN_FIXTURE_TWO_CORE:-}" = 1 ]; then
      [ "$(rg -c '^fixture-revoked$' "$work/broker.err")" = 2 ]
    fi
  fi
  if [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = restart ] || [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = host-restart ]; then
    if rg -q '^fixture-signalled$' "$work/host.err"; then exit 1; fi
  fi
  if [ "${BRAIN_FIXTURE_CORE_DESCENDANT:-}" = 1 ]; then
    rg -q '^fixture-leader-observed$' "$work/host.err"
    rg -q '^fixture-signalled$' "$work/host.err"
    rg -q '^fixture-reaped$' "$work/host.err"
    rg -q '^fixture-revoked$' "$work/broker.err"
  fi
  if [ -n "${BRAIN_FIXTURE_CORE_MUTATION:-}" ]; then
    case "$BRAIN_FIXTURE_CORE_MUTATION" in
      cancel) condition="exists(select 1 from brain.work_items where id='00000000-0000-4000-8000-000000000151' and cancel_requested_at is not null)";;
      hold) condition="exists(select 1 from brain.work_hold_groups where name='extension:garmin')";;
      disable) condition="exists(select 1 from brain.extensions where name='garmin' and not enabled) and exists(select 1 from brain.work_hold_groups where name='extension:garmin')";;
      *) exit 1;;
    esac
    count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.protected_auth_revocations r join brain.work_attempts a on a.token=r.attempt_token where r.work_id='00000000-0000-4000-8000-000000000151' and r.launch_lease=a.protected_launch_lease and r.connection_epoch=a.protected_connection_epoch and ($condition)")
    if [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = missing ] || [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = restart ] || [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = host-restart ] || [ -n "${BRAIN_FIXTURE_CORE_ACK_FAIL:-}" ]; then
      [ "$count" = 0 ]
      count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_hold_groups where name='extension:garmin'")
      [ "$count" = 0 ]
    else [ "$count" = 1 ]; fi
    if [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = pending ] || [ "${BRAIN_FIXTURE_CORE_MULTIPLE:-}" = race ]; then
      count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.protected_input_launches where work_id='00000000-0000-4000-8000-000000000251' and state='closed'")
      [ "$count" = 1 ]
    fi
    if [ "${BRAIN_FIXTURE_TWO_CORE:-}" = 1 ]; then
      count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.protected_auth_revocations r join brain.work_attempts a on a.token=r.attempt_token where r.work_id in ('00000000-0000-4000-8000-000000000151','00000000-0000-4000-8000-000000000152') and r.launch_lease=a.protected_launch_lease and r.connection_epoch=a.protected_connection_epoch")
      if [ -n "${BRAIN_FIXTURE_CORE_ACK_FAIL:-}" ]; then [ "$count" = 0 ]; elif [ "${BRAIN_FIXTURE_CORE_MUTATION:-}" = cancel ]; then [ "$count" = 1 ]; else [ "$count" = 2 ]; fi
    fi
  fi
else
  if [ "${BRAIN_FIXTURE_MULTI_SESSION:-}" = 1 ]; then
    [ "${BRAIN_FIXTURE_AUTHORITY:-}" != 1 ]
    BRAIN_FIXTURE_MULTI_REVOKE=1 "$work/supervisor" & first=$!
    "$work/supervisor" & second=$!
    ready=0
    for attempt in $(seq 1 200); do
      count=$(find "$work/barrier" -name 'worker-*' -type f | wc -l | tr -d ' ')
      if [ "$count" = 2 ]; then ready=1;break;fi
      sleep 0.05
    done
    : > "$work/barrier/revoke"
    revoked=0
    for attempt in $(seq 1 200); do if [ -f "$work/barrier/revoked" ]; then revoked=1;break;fi;sleep 0.05;done
    : > "$work/barrier/release"
    first_ok=0;second_ok=0
    wait "$first" || first_ok=$?
    wait "$second" || second_ok=$?
    [ "$ready" = 1 ] && [ "$revoked" = 1 ] && [ "$first_ok" = 0 ] && [ "$second_ok" = 0 ]
  else "$work/supervisor"; fi
fi
if [ -s "$work/gui.out" ]; then printf '%s\n' '합성 GUI 경계 검증 실패' >&2;exit 1;fi
if [ "$fixture_case" -eq 15 ] || [ "$fixture_case" -eq 16 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_items where kind='garmin.auth' and cancel_requested_at is null")
  [ "$count" = 1 ]
elif [ "$fixture_case" -eq 6 ] || [ "$fixture_case" -eq 10 ] || [ "$fixture_case" -eq 12 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_items where kind='garmin.auth' and cancel_requested_at is not null")
  [ "$count" = 1 ]
elif [ "$fixture_case" -ge 7 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_hold_groups where name='extension:garmin'")
  [ "$count" = 1 ]
fi
if [ "$fixture_case" -ge 10 ] && [ "$fixture_case" -ne 16 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from brain.protected_auth_revocations r join brain.work_items w on w.id=r.work_id and w.current_attempt_token=r.attempt_token where r.run_generation=w.attempts and r.connection_epoch=1')
  [ "$count" = 1 ]
fi
if [ "$fixture_case" -eq 15 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from brain.protected_auth_revocations r join brain.work_attempts a on a.token=r.attempt_token where r.connection_epoch<>a.protected_connection_epoch')
  [ "$count" = 1 ]
elif [ "$fixture_case" -eq 16 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from brain.protected_auth_revocations')
  [ "$count" = 0 ]
fi
if [ "$fixture_case" -eq 14 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.extensions where name='garmin' and not enabled")
  [ "$count" = 1 ]
fi
if [ "${BRAIN_FIXTURE_CORE_RECORD:-}" = deny ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_attempts a join garmin.admission_holder h on h.attempt_token=a.token where a.pid is null")
elif [ "${BRAIN_FIXTURE_CORE_RECORD:-}" = lost ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_attempts a join garmin.admission_holder h on h.attempt_token=a.token where a.pid>0 and a.protected_launch_lease is not null")
elif [ "${BRAIN_FIXTURE_CORE_SIGNAL:-}" = 1 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_attempts a join brain.work_items w on w.id=a.work_item_id where w.id='00000000-0000-4000-8000-000000000151' and a.pid>0 and a.last_progress_at is not null and a.outcome is not null and exists(select 1 from garmin.admission_holder h where h.work_id=w.id)")
elif [ "${BRAIN_FIXTURE_CORE:-}" = 1 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc "select count(*) from brain.work_attempts a join brain.work_items w on w.id=a.work_item_id where w.id='00000000-0000-4000-8000-000000000151' and w.outcome='succeeded' and a.pid>0 and a.os_started_at is not null and a.os_boot_at is not null and a.protected_launch_lease is not null and a.protected_connection_epoch>0 and not exists(select 1 from garmin.admission_holder h where h.work_id=w.id)")
elif [ "${BRAIN_FIXTURE_AUTHORITY:-}" = 1 ]; then
  if [ "${BRAIN_FIXTURE_DENY_RECORD:-}" = 1 ]; then
    count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from garmin.admission_holder h join brain.work_attempts a on a.token=h.attempt_token where a.pid is null')
  else
    count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from garmin.admission_holder h join brain.work_attempts a on a.token=h.attempt_token where a.pid > 0 and a.os_started_at is not null and a.os_boot_at is not null')
  fi
elif [ "${BRAIN_FIXTURE_DENY_RECORD:-}" = 1 ]; then
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from fixture_admission where pid is null and start_sec is null')
else
  count=$(docker exec "$db" psql -U postgres -d postgres -Atc 'select count(*) from fixture_admission where pid > 0 and start_sec > 0')
fi
if [ "${BRAIN_FIXTURE_MULTI_SESSION:-}" = 1 ]; then [ "$count" = 2 ]; else [ "$count" = 1 ]; fi
printf '%s\n' '합성 supervisor·broker·GUI·별도 worker 제출 종단 검사 통과'
