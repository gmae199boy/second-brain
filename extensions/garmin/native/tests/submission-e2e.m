#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <string.h>
#include <sys/ioctl.h>
#include "../submission-ui.h"
#include "../broker.h"
static void (^pending)(const brain_local_presence *);
static brain_local_presence receipt;
@implementation BRAINPresenceGate
- (BOOL)begin:(const brain_presence_challenge *)challenge operation:(uint8_t)operation completion:(void (^)(const brain_local_presence *))completion {
  (void)operation;if(pending)return NO;CC_SHA256(challenge->message,(CC_LONG)challenge->length,receipt.challenge_digest);receipt.generation=1;pending=[completion copy];return YES;
}
- (void)cancel { if(pending){[pending release];pending=nil;} }
@end
void brain_xpc_close(brain_xpc_peer *p) { if(p)p->authenticated=0; }
int brain_xpc_send_fd(brain_xpc_peer *p,int fd) {(void)p;(void)fd;return 0;}
static int guard(void *context) {(void)context;return 1;}
typedef struct { brain_auth_broker *broker;brain_presence_scope *scope;uint8_t *capability; } verification;
static int verify_submission(void *context,const uint8_t prompt[16],uint64_t generation) {
  verification *v=context;return generation==v->scope->response_generation && brain_broker_consume(v->broker,v->scope,prompt,v->capability);
}
static int confirm_submission(void *context,const uint8_t prompt[16],uint64_t generation) {verification *v=context;return brain_broker_confirm(v->broker,prompt,generation);}
typedef struct { int fd;int observed; } denial;
static int deny_submission(void *context,const uint8_t prompt[16],uint64_t generation) {
  denial *d=context;(void)prompt;(void)generation;int available=0;
  d->observed=!ioctl(d->fd,FIONREAD,&available) && available>0;return 0;
}
int main(void) { @autoreleasepool {
  brain_auth_binding b={.run_generation=1,.binding_generation=1,.package_generation=1,.connection_epoch=1,.worker_uid=501,.ui_uid=502,.worker_pid=10};
  memset(b.session,1,16);memset(b.work,2,16);memset(b.attempt,3,16);memset(b.launch_lease,4,16);memset(b.package,5,32);memset(b.worker_hash,6,20);memset(b.ui_hash,7,20);
  brain_xpc_peer w={.uid=501,.pid=10,.authenticated=1},u={.uid=502,.pid=20,.authenticated=1};memcpy(w.hash,b.worker_hash,20);memcpy(u.hash,b.ui_hash,20);
  brain_auth_broker broker;if(!brain_broker_init(&broker,&b,&u,&w,3000) || !brain_broker_set_guard(&broker,guard,NULL) || !brain_broker_worker(&broker) || !brain_broker_recorded(&broker) || !brain_broker_attach(&broker,&b) || !brain_broker_prompt(&broker,b.session,0))return 1;
  int wf=-1,uf=-1;if(!brain_broker_prepare_channel(&wf,&uf,1000))return 2;
  brain_auth_channel ui,worker;if(!brain_channel_init(&ui,uf,b.session,1,1000) || !brain_channel_init(&worker,wf,b.session,0,1000))return 3;
  BRAINSubmission *submission=[[BRAINSubmission alloc] init];uint8_t secret[]={1,2,3,4};
  uint64_t generation=[submission freeze:secret length:sizeof secret prompt:b.session operation:1];
  brain_presence_scope scope={.gui_pid=20,.gui_asid=1,.gui_start_sec=1,.policy_generation=1,.response_generation=generation};memset(scope.gui_session,8,16);memset(scope.gui_instance,9,16);memset(scope.gui_boot,10,16);
  brain_presence_challenge challenge;if(!generation || !brain_broker_challenge(&broker,&scope,1000,&challenge))return 4;
  uint8_t capability[32];uint8_t *cap_ptr=capability;brain_auth_broker *broker_ptr=&broker;const uint8_t *prompt_ptr=b.session;__block int completed=0;
  if(![submission approve:&challenge channel:&ui timeout:1000 broker:^BOOL(const brain_local_presence *r){return brain_broker_callback(broker_ptr,r->challenge_digest,cap_ptr) && brain_broker_send_ready(broker_ptr,prompt_ptr,1);} completion:^(BOOL ok){if(ok)completed++;}])return 5;
  if(!pending)return 6;void (^callback)(const brain_local_presence *)=[pending copy];callback(&receipt);callback(&receipt);[callback release];
  if(completed!=1)return 7;
  uint8_t payload[32];size_t length=0;verification verify={&broker,&scope,capability};
  if(!brain_channel_receive_submission(&worker,b.session,generation,verify_submission,confirm_submission,&verify,payload,sizeof payload,&length,1000) || length!=sizeof secret)return 8;
  if(memcmp(secret,payload,length))return 9;
  memset(payload,0,sizeof payload);[submission release];brain_channel_destroy(&ui);brain_channel_destroy(&worker);brain_broker_destroy(&broker);
  if(!brain_broker_prepare_channel(&wf,&uf,1000) || !brain_channel_init(&ui,uf,b.session,1,1000) || !brain_channel_init(&worker,wf,b.session,0,1000))return 10;
  if(!brain_channel_send(&ui,3,b.session,secret,sizeof secret,1000))return 11;
  memset(payload,0xa5,sizeof payload);length=99;
  denial denied={.fd=worker.fd};
  if(brain_channel_receive_submission(&worker,b.session,1,deny_submission,deny_submission,&denied,payload,sizeof payload,&length,1000) || !denied.observed || length || payload[0]!=0xa5)return 12;
  brain_channel_destroy(&ui);brain_channel_destroy(&worker);return 0;
} }
