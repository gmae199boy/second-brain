#include "../broker.h"
#include <CommonCrypto/CommonDigest.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>
void brain_xpc_close(brain_xpc_peer *peer) { if(peer)peer->authenticated=0; }
int brain_xpc_send_fd(brain_xpc_peer *peer,int fd) {(void)peer;(void)fd;return 0;}
static int guard(void *context) {return !context || *(int *)context;}
static brain_auth_binding binding(void) {
  brain_auth_binding b={.run_generation=1,.binding_generation=1,.package_generation=1,.connection_epoch=1,.worker_uid=501,.ui_uid=502,.worker_pid=10};
  memset(b.session,1,16);memset(b.work,2,16);memset(b.attempt,3,16);memset(b.launch_lease,4,16);memset(b.package,5,32);memset(b.worker_hash,6,20);memset(b.ui_hash,7,20);return b;
}
static int start(brain_auth_broker *broker,brain_xpc_peer *w,brain_xpc_peer *u,brain_auth_binding *b,brain_presence_scope *scope,brain_presence_challenge *c,uint8_t digest[32]) {
  *b=binding();*w=(brain_xpc_peer){.uid=501,.pid=10,.authenticated=1};*u=(brain_xpc_peer){.uid=502,.pid=20,.authenticated=1};memcpy(w->hash,b->worker_hash,20);memcpy(u->hash,b->ui_hash,20);
  *scope=(brain_presence_scope){.gui_pid=20,.gui_asid=1,.gui_start_sec=1,.policy_generation=1,.response_generation=1};memset(scope->gui_session,8,16);memset(scope->gui_instance,9,16);memset(scope->gui_boot,10,16);
  if(!brain_broker_init(broker,b,u,w,3000) || !brain_broker_set_guard(broker,guard,NULL) || !brain_broker_worker(broker) || !brain_broker_recorded(broker) || !brain_broker_attach(broker,b) || !brain_broker_prompt(broker,b->session,0) || !brain_broker_challenge(broker,scope,1000,c))return 0;
  CC_SHA256(c->message,(CC_LONG)c->length,digest);return 1;
}
typedef struct { brain_auth_broker *broker; uint8_t *digest; int result; uint8_t cap[32]; } callback;
static void *invoke(void *arg) { callback *c=arg;c->result=brain_broker_callback(c->broker,c->digest,c->cap);return NULL; }
int main(void) {
  brain_auth_broker broker;brain_xpc_peer w,u;brain_auth_binding b;brain_presence_scope scope;brain_presence_challenge c;uint8_t digest[32],cap[32];
  for(int mode=0;mode<12;mode++) {
    if(!start(&broker,&w,&u,&b,&scope,&c,digest))return 1;
    int allowed=1;broker.guard_context=&allowed;
    if(mode==0) { digest[0]^=1;if(brain_broker_callback(&broker,digest,cap))return 2; }
    if(mode==1) { if(brain_broker_consume(&broker,&scope,b.session,digest))return 3; }
    if(mode==2) { if(!brain_broker_callback(&broker,digest,cap))return 4;scope.response_generation++;if(brain_broker_consume(&broker,&scope,b.session,cap))return 5; }
    if(mode==3) { if(!brain_broker_callback(&broker,digest,cap))return 6;cap[0]^=1;if(brain_broker_consume(&broker,&scope,b.session,cap))return 7; }
    if(mode==4) { brain_broker_cancel(&broker);if(brain_broker_callback(&broker,digest,cap))return 8; }
    if(mode==5) { callback a={.broker=&broker,.digest=digest},d={.broker=&broker,.digest=digest};pthread_t x,y;
      if(pthread_create(&x,NULL,invoke,&a) || pthread_create(&y,NULL,invoke,&d))return 9;
      pthread_join(x,NULL);pthread_join(y,NULL);if(a.result+d.result!=1)return 10;
    }
    if(mode==6) { if(!brain_broker_callback(&broker,digest,cap))return 12;scope.gui_instance[0]^=1;if(brain_broker_consume(&broker,&scope,b.session,cap))return 13; }
    if(mode==7) { if(!brain_broker_callback(&broker,digest,cap))return 14;w.authenticated=0;if(brain_broker_consume(&broker,&scope,b.session,cap))return 15; }
    if(mode==8) { usleep(1010000);if(brain_broker_callback(&broker,digest,cap))return 16; }
    if(mode==9) { allowed=0;if(brain_broker_callback(&broker,digest,cap))return 19; }
    if(mode==10) { if(!brain_broker_callback(&broker,digest,cap))return 20;allowed=0;if(brain_broker_send_ready(&broker,b.session,1))return 21; }
    if(mode==11) { if(!brain_broker_callback(&broker,digest,cap) || !brain_broker_send_ready(&broker,b.session,1) || !brain_broker_consume(&broker,&scope,b.session,cap))return 22;
      allowed=0;if(brain_broker_confirm(&broker,b.session,1))return 23; }
    if(!broker.session.revoked)return 11;brain_broker_destroy(&broker);
  }
  b=binding();w=(brain_xpc_peer){.uid=501,.pid=10,.authenticated=1};u=(brain_xpc_peer){.uid=502,.pid=20,.authenticated=1};memcpy(w.hash,b.worker_hash,20);memcpy(u.hash,b.ui_hash,20);
  if(!brain_broker_init(&broker,&b,&u,&w,3000) || !brain_broker_worker(&broker) || !brain_broker_recorded(&broker) || !brain_broker_attach(&broker,&b))return 17;
  if(brain_broker_prompt(&broker,b.session,0) || !broker.session.revoked)return 18;brain_broker_destroy(&broker);
  return 0;
}
