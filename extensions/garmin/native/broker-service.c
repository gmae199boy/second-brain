/* 세 역할별 고정 XPC endpoint와 단일 인증 세션. 운영 승인은 별도 OS 증거가 필요하다. */
#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "broker.h"

#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_BROKER_SUPERVISOR_SERVICE "org.secondbrain.broker.supervisor.unconfigured"
#define BRAIN_BROKER_WORKER_SERVICE "org.secondbrain.broker.worker.unconfigured"
#define BRAIN_BROKER_UI_SERVICE "org.secondbrain.broker.ui.unconfigured"
#define BRAIN_BROKER_UID 0
#define BRAIN_SUPERVISOR_UID 0
#define BRAIN_WORKER_UID 0
#define BRAIN_UI_UID 0
static const uint8_t BRAIN_SUPERVISOR_HASH[20]={0}, BRAIN_WORKER_HASH[20]={0}, BRAIN_UI_HASH[20]={0}, BRAIN_PACKAGE_HASH[32]={0};
#endif

enum role { SUPERVISOR, WORKER, UI };
typedef struct { brain_xpc_peer peer; enum role role; } endpoint;
static dispatch_queue_t queue;
static endpoint *supervisor, *worker, *ui;
static brain_auth_binding binding;
static brain_auth_broker broker;
static int registered, initialized, worker_ready, durable_ready;
static int field(xpc_object_t m,const char *name,xpc_type_t type) { xpc_object_t v=xpc_dictionary_get_value(m,name); return v && xpc_get_type(v)==type; }
static void revoke_session(void) {
  if(initialized) { brain_broker_cancel(&broker); brain_broker_destroy(&broker); initialized=0; }
  if(supervisor) brain_xpc_close(&supervisor->peer);
  if(worker) brain_xpc_close(&worker->peer);
  if(ui) brain_xpc_close(&ui->peer);
  registered=worker_ready=durable_ready=0; memset(&binding,0,sizeof binding);
}
static void reply_ok(xpc_connection_t connection,xpc_object_t message) {
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_session(); return; }
  xpc_dictionary_set_bool(reply,"accepted",true); xpc_connection_send_message(connection,reply); xpc_release(reply);
}
static int register_session(xpc_object_t m) {
  if(registered || xpc_dictionary_get_count(m)!=11) return 0;
  const char *uuids[]={"work","attempt","session","lease"};
  const char *numbers[]={"run","binding","package_generation","epoch"};
  for(size_t i=0;i<4;i++) if(!field(m,uuids[i],XPC_TYPE_UUID) || !field(m,numbers[i],XPC_TYPE_UINT64) || !xpc_dictionary_get_uint64(m,numbers[i]))return 0;
  if(!field(m,"pid",XPC_TYPE_INT64) || !field(m,"package",XPC_TYPE_DATA))return 0;
  int64_t pid=xpc_dictionary_get_int64(m,"pid"); size_t size=0; const void *package=xpc_dictionary_get_data(m,"package",&size);
  if(pid<=0 || pid>INT32_MAX || !package || size!=32 || memcmp(package,BRAIN_PACKAGE_HASH,32))return 0;
  memcpy(binding.work,xpc_dictionary_get_uuid(m,"work"),16); memcpy(binding.attempt,xpc_dictionary_get_uuid(m,"attempt"),16);
  memcpy(binding.session,xpc_dictionary_get_uuid(m,"session"),16); memcpy(binding.launch_lease,xpc_dictionary_get_uuid(m,"lease"),16);
  memcpy(binding.package,package,32); binding.run_generation=xpc_dictionary_get_uint64(m,"run"); binding.binding_generation=xpc_dictionary_get_uint64(m,"binding");
  binding.package_generation=xpc_dictionary_get_uint64(m,"package_generation"); binding.connection_epoch=xpc_dictionary_get_uint64(m,"epoch");
  binding.worker_pid=(pid_t)pid; binding.worker_uid=BRAIN_WORKER_UID; binding.ui_uid=BRAIN_UI_UID;
  memcpy(binding.worker_hash,BRAIN_WORKER_HASH,20); memcpy(binding.ui_hash,BRAIN_UI_HASH,20); registered=1; return 1;
}
static int try_initialize(void) {
  if(initialized || !registered || !worker_ready || !worker || !ui || !ui->peer.authenticated) return 1;
  if(!brain_broker_init(&broker,&binding,&ui->peer,&worker->peer,300000))return 0;
  initialized=1;
  return brain_broker_worker(&broker) && (!durable_ready || brain_broker_recorded(&broker));
}
static void send_target(endpoint *e,xpc_object_t message) {
  if(xpc_dictionary_get_count(message)!=1 || (initialized && broker.session.attached)) { revoke_session(); return; }
  xpc_object_t r=xpc_dictionary_create_reply(message); if(!r){revoke_session();return;}
  if(!initialized || !broker.session.recorded) { xpc_dictionary_set_bool(r,"pending",true); xpc_connection_send_message(e->peer.connection,r); xpc_release(r); return; }
  xpc_dictionary_set_uuid(r,"work",binding.work); xpc_dictionary_set_uuid(r,"attempt",binding.attempt); xpc_dictionary_set_uuid(r,"session",binding.session); xpc_dictionary_set_uuid(r,"lease",binding.launch_lease);
  xpc_dictionary_set_uint64(r,"run",binding.run_generation); xpc_dictionary_set_uint64(r,"binding",binding.binding_generation); xpc_dictionary_set_uint64(r,"package_generation",binding.package_generation); xpc_dictionary_set_uint64(r,"epoch",binding.connection_epoch); xpc_dictionary_set_data(r,"package",binding.package,32);
  xpc_connection_send_message(e->peer.connection,r); xpc_release(r);
}
static int selection_matches(xpc_object_t m) {
  const char *keys[]={"work","attempt","session","lease"}; const uint8_t *values[]={binding.work,binding.attempt,binding.session,binding.launch_lease};
  const char *nums[]={"run","binding","package_generation","epoch"}; uint64_t vals[]={binding.run_generation,binding.binding_generation,binding.package_generation,binding.connection_epoch};
  if(xpc_dictionary_get_count(m)!=10)return 0;
  for(size_t i=0;i<4;i++) if(!field(m,keys[i],XPC_TYPE_UUID) || memcmp(xpc_dictionary_get_uuid(m,keys[i]),values[i],16) || !field(m,nums[i],XPC_TYPE_UINT64) || xpc_dictionary_get_uint64(m,nums[i])!=vals[i])return 0;
  size_t n=0; const void *p=xpc_dictionary_get_data(m,"package",&n); return p && n==32 && !memcmp(p,binding.package,32);
}
static void handle(endpoint *e,xpc_object_t m) {
  if(!brain_xpc_verify_message(&e->peer,m) || !field(m,"op",XPC_TYPE_STRING)){revoke_session();return;}
  const char *op=xpc_dictionary_get_string(m,"op");
  if(e->role==SUPERVISOR && !strcmp(op,"register") && register_session(m)){reply_ok(e->peer.connection,m);return;}
  if(e->role==WORKER && !strcmp(op,"attach") && registered && !worker_ready && worker==e && e->peer.pid==binding.worker_pid && xpc_dictionary_get_count(m)==1) {
    worker_ready=1; if(try_initialize()){reply_ok(e->peer.connection,m);return;}
  }
  if(e->role==SUPERVISOR && !strcmp(op,"recorded") && registered && worker_ready && !durable_ready && xpc_dictionary_get_count(m)==1) {
    durable_ready=1; if((!initialized || brain_broker_recorded(&broker)) && try_initialize()){reply_ok(e->peer.connection,m);return;}
  }
  if(e->role==UI && !strcmp(op,"select_target")){send_target(e,m);return;}
  if(e->role==UI && !strcmp(op,"selection") && initialized && selection_matches(m) && brain_broker_attach(&broker,&binding)) {
    /* worker 상속과 실제 사용자 존재 검증 전에는 선택 뒤 닫는다. */
    revoke_session(); return;
  }
  revoke_session();
}
static void accept(xpc_connection_t connection,enum role role,uid_t uid,const uint8_t hash[20]) {
  endpoint **slot=role==SUPERVISOR?&supervisor:role==WORKER?&worker:&ui;
  if(*slot){xpc_connection_cancel(connection);return;}
  endpoint *e=calloc(1,sizeof *e); if(!e){xpc_connection_cancel(connection);return;} e->role=role; *slot=e;
  xpc_connection_set_target_queue(connection,queue);
  if(!brain_xpc_configure_service(&e->peer,connection,uid,hash)){*slot=NULL;free(e);xpc_connection_cancel(connection);return;}
  xpc_connection_set_event_handler(connection,^(xpc_object_t m){
    if(xpc_get_type(m)==XPC_TYPE_ERROR){revoke_session();if(m==XPC_ERROR_CONNECTION_INVALID){*slot=NULL;free(e);}return;}
    if(!e->peer.authenticated){if(!brain_xpc_authenticate(&e->peer,m)){revoke_session();return;} xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){revoke_session();return;}xpc_dictionary_set_bool(r,"hello",true);xpc_connection_send_message(connection,r);xpc_release(r);if(!try_initialize())revoke_session();return;}
    handle(e,m);
  });
  xpc_connection_activate(connection);
}
static int listen_role(const char *name,enum role role,uid_t uid,const uint8_t hash[20]) {
  xpc_connection_t listener=xpc_connection_create_mach_service(name,queue,XPC_CONNECTION_MACH_SERVICE_LISTENER); brain_xpc_peer policy;
  if(!listener || !brain_xpc_configure_service(&policy,listener,uid,hash))return 0;
  xpc_connection_set_event_handler(listener,^(xpc_object_t e){if(xpc_get_type(e)==XPC_TYPE_CONNECTION)accept((xpc_connection_t)e,role,uid,hash);});
  xpc_connection_activate(listener); return 1;
}
int main(void) {
  if(!BRAIN_BROKER_UID || geteuid()!=BRAIN_BROKER_UID || !BRAIN_SUPERVISOR_UID || !BRAIN_WORKER_UID || !BRAIN_UI_UID || geteuid()==0) return 78;
#ifndef BRAIN_NATIVE_FIXTURE
  if(BRAIN_WORKER_UID==BRAIN_UI_UID || BRAIN_BROKER_UID==BRAIN_UI_UID || BRAIN_SUPERVISOR_UID==BRAIN_WORKER_UID)return 78;
#endif
  queue=dispatch_queue_create("org.secondbrain.broker",DISPATCH_QUEUE_SERIAL); if(!queue)return 78;
  if(!listen_role(BRAIN_BROKER_SUPERVISOR_SERVICE,SUPERVISOR,BRAIN_SUPERVISOR_UID,BRAIN_SUPERVISOR_HASH)
    || !listen_role(BRAIN_BROKER_WORKER_SERVICE,WORKER,BRAIN_WORKER_UID,BRAIN_WORKER_HASH)
    || !listen_role(BRAIN_BROKER_UI_SERVICE,UI,BRAIN_UI_UID,BRAIN_UI_HASH))return 78;
  dispatch_main(); return 0;
}
