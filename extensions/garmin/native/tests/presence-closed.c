#include <string.h>
#include "../session.h"
int main(void) {
  brain_auth_binding b = { .run_generation=1, .binding_generation=1, .package_generation=1, .connection_epoch=1, .worker_uid=501, .ui_uid=502, .worker_pid=10 };
  memset(b.session,1,16); memset(b.work,2,16); memset(b.attempt,3,16); memset(b.launch_lease,4,16); memset(b.package,5,32); memset(b.worker_hash,6,20); memset(b.ui_hash,7,20);
  brain_xpc_peer worker = { .uid=501, .pid=10, .authenticated=1 }, ui = { .uid=502, .pid=20, .authenticated=1 };
  memcpy(worker.hash,b.worker_hash,20); memcpy(ui.hash,b.ui_hash,20); brain_auth_session session;
  if (!brain_auth_init(&session,&b,3000) || !brain_auth_worker(&session,&worker) || !brain_auth_recorded(&session) || !brain_auth_attach(&session,&ui,&b)) return 1;
  return !brain_auth_approve(&session,1) && session.revoked ? 0 : 2;
}
