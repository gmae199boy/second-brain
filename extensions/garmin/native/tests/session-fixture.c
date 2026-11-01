#include <string.h>
#include <unistd.h>
#include "../session.h"
static brain_auth_binding binding(void) {
  brain_auth_binding b = { .run_generation = 1, .binding_generation = 1, .package_generation = 1, .connection_epoch = 1, .worker_uid = 501, .ui_uid = 502, .worker_pid = 99 };
  memset(b.session,1,16); memset(b.launch_lease,7,16); memset(b.work,2,16); memset(b.attempt,3,16); memset(b.package,4,32); memset(b.worker_hash,5,20); memset(b.ui_hash,6,20); return b;
}
static int ready(brain_auth_session *s, brain_auth_binding *b, brain_xpc_peer *worker, brain_xpc_peer *ui) {
  return brain_auth_init(s,b,3000) && brain_auth_worker(s,worker) && brain_auth_recorded(s) && brain_auth_attach(s,ui,b);
}
int main(void) {
  brain_auth_binding b = binding(); brain_auth_session s;
  brain_xpc_peer worker = { .uid = b.worker_uid, .pid = b.worker_pid, .authenticated = 1 };
  brain_xpc_peer ui = { .uid = b.ui_uid, .pid = 100, .authenticated = 1 };
  memcpy(worker.hash,b.worker_hash,20); memcpy(ui.hash,b.ui_hash,20);
  if (!ready(&s,&b,&worker,&ui)) return 1;
  uint8_t prompt[16] = {1};
  if (!brain_auth_prompt(&s,prompt,0) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,1)) return 2;
  for (uint64_t i = 2; i <= 4; i++) { prompt[0] = (uint8_t)i; if (!brain_auth_prompt(&s,prompt,1) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,i)) return 2; }
  prompt[0] = 5;
  if (brain_auth_prompt(&s,prompt,1) || !s.revoked) return 3;
  if (!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,1)) return 4;
  if (brain_auth_response(&s,prompt,1) || !s.revoked) return 5;
  if (!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,1)) return 12;
  if (brain_auth_prompt(&s,prompt,0) || !s.revoked) return 13;
  if (!ready(&s,&b,&worker,&ui)) return 14;
  if (brain_auth_attach(&s,&ui,&b) || !s.revoked) return 15;
  if (!ready(&s,&b,&worker,&ui)) return 16;
  if (brain_auth_init(&s,&b,0) || !s.revoked) return 17;
  if (!brain_auth_init(&s,&b,3000) || !brain_auth_worker(&s,&worker) || !brain_auth_recorded(&s)) return 6;
  brain_auth_binding other = b; other.run_generation++;
  if (brain_auth_attach(&s,&ui,&other) || !s.revoked) return 7;
  for (int mode=0; mode<5; mode++) {
    if (!brain_auth_init(&s,&b,3000) || !brain_auth_worker(&s,&worker) || !brain_auth_recorded(&s)) return 18;
    other=b;
    if (mode==0) other.attempt[0]++; else if (mode==1) other.binding_generation++; else if (mode==2) other.package_generation++;
    else if (mode==3) other.connection_epoch++; else other.launch_lease[0]++;
    if (brain_auth_attach(&s,&ui,&other) || !s.revoked) return 19;
  }
  if (!brain_auth_init(&s,&b,3000) || brain_auth_recorded(&s) || !s.revoked) return 20;
  brain_xpc_peer wrong=worker; wrong.hash[0]++;
  if (!brain_auth_init(&s,&b,3000) || brain_auth_worker(&s,&wrong) || !s.revoked) return 21;
  if (!brain_auth_init(&s,&b,3000) || !brain_auth_worker(&s,&worker) || !brain_auth_recorded(&s) || !brain_auth_attach(&s,&ui,&b)) return 8;
  if (!brain_auth_prompt(&s,prompt,0) || brain_auth_approve(&s,0) || !s.revoked) return 9;
  if (!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || brain_auth_response(&s,prompt,1) || !s.revoked) return 22;
  if (!brain_auth_init(&s,&b,25)) return 10; usleep(40000);
  if (brain_auth_worker(&s,&worker) || !s.revoked) return 11;
  /* 자동 선택만으로 승인할 수 없으며 각 입력마다 별도 승인이 필요하다. */
  if(!ready(&s,&b,&worker,&ui) || brain_auth_approve(&s,1) || !s.revoked)return 23;
  if(!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,1))return 24;
  prompt[0]++;if(!brain_auth_prompt(&s,prompt,1) || brain_auth_response(&s,prompt,2) || !s.revoked)return 25;
  if(!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0))return 26;
  brain_auth_revoke(&s);if(brain_auth_approve(&s,1) || !s.revoked)return 27;
  if(!brain_auth_init(&s,&b,25) || !brain_auth_worker(&s,&worker) || !brain_auth_recorded(&s) || !brain_auth_attach(&s,&ui,&b) || !brain_auth_prompt(&s,prompt,0))return 28;
  usleep(40000);if(brain_auth_approve(&s,1) || !s.revoked)return 29;
  if(!ready(&s,&b,&worker,&ui) || brain_auth_prompt(&s,prompt,1) || !s.revoked)return 30;
  if(!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || !brain_auth_approve(&s,1) || !brain_auth_response(&s,prompt,1))return 31;
  prompt[0]++; if(brain_auth_prompt(&s,prompt,0) || !s.revoked)return 32;
  if(!ready(&s,&b,&worker,&ui) || !brain_auth_prompt(&s,prompt,0) || brain_auth_prompt(&s,prompt,1) || !s.revoked)return 33;
  return 0;
}
