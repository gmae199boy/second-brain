/* 세 역할별 고정 XPC endpoint와 단일 인증 세션. 운영 승인은 별도 OS 증거가 필요하다. */
#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <xpc/xpc.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <uuid/uuid.h>
#include <stdio.h>
#include "broker.h"
#ifndef BRAIN_NATIVE_FIXTURE
#include "broker-store.h"
#include "broker-credential.h"
extern void PQfinish(PGconn *);
#endif
#ifdef BRAIN_FIXTURE_BROKER_PG
#ifndef BRAIN_NATIVE_FIXTURE
#error fixture_database_is_not_a_production_policy
#endif
#include "broker-store.h"
#include <stdio.h>
typedef struct pg_result PGresult;
extern PGconn *PQconnectdb(const char *);
extern PGresult *PQexec(PGconn *,const char *);
extern int PQresultStatus(const PGresult *);
extern void PQclear(PGresult *);
extern void PQfinish(PGconn *);
#endif

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
#ifndef BRAIN_PRESENCE_POLICY_GENERATION
#define BRAIN_PRESENCE_POLICY_GENERATION 0
#endif
#ifndef BRAIN_BROKER_DATABASE_FILE
#define BRAIN_BROKER_DATABASE_FILE ""
#endif

enum role { SUPERVISOR, WORKER, UI };
typedef struct broker_session broker_session;
typedef struct { brain_xpc_peer peer; enum role role; broker_session *session; } endpoint;
static dispatch_queue_t queue;
struct broker_session {
  endpoint *supervisor,*worker,*ui;
  brain_auth_binding binding;char binding_target[1025];brain_auth_broker broker;brain_presence_scope gui_scope;pid_t gui_pid;
  xpc_object_t waiting_consume;uint8_t waiting_prompt[16];uint64_t waiting_generation;
  int ui_channel,registered,initialized,worker_ready,durable_ready,input_revoked,closing;
#if !defined(BRAIN_NATIVE_FIXTURE) || defined(BRAIN_FIXTURE_BROKER_PG)
  PGconn *connection;brain_broker_pg_store store;
#endif
};
/* [ASSUMPTION] 한 서비스의 동시 세션은 64개를 상한으로 두고 초과 연결을 닫는다. */
static broker_session *sessions[64],*current;
static endpoint **session_slot(broker_session *s,enum role role) {return role==SUPERVISOR?&s->supervisor:role==WORKER?&s->worker:&s->ui;}
static broker_session *new_session(void) {
  for(size_t i=0;i<64;i++)if(!sessions[i]){broker_session *s=calloc(1,sizeof *s);if(!s)return NULL;s->ui_channel=-1;sessions[i]=s;return s;}return NULL;
}
static void release_session(broker_session *s) {
  if(!s || s->supervisor || s->worker || s->ui)return;
  for(size_t i=0;i<64;i++)if(sessions[i]==s){sessions[i]=NULL;free(s);return;}
}
static broker_session *find_session(enum role role,pid_t pid) {
  broker_session *found=NULL;
  for(size_t i=0;i<64;i++) {broker_session *s=sessions[i];if(!s || s->closing || !s->registered)continue;
    if((role==WORKER && s->binding.worker_pid==pid) || (role==UI && s->gui_pid==pid)) {if(found || *session_slot(s,role))return NULL;found=s;}}
  return found;
}
static void set_scope_pid(brain_presence_scope *scope,uint64_t pid){scope->gui_pid=pid;}
static void clear_broker_peers(brain_auth_broker *value){value->ui=NULL;value->worker=NULL;}
#define supervisor (current->supervisor)
#define worker (current->worker)
#define ui (current->ui)
#define binding (current->binding)
#define binding_target (current->binding_target)
#define broker (current->broker)
#define gui_scope (current->gui_scope)
#define gui_pid (current->gui_pid)
#define waiting_consume (current->waiting_consume)
#define waiting_prompt (current->waiting_prompt)
#define waiting_generation (current->waiting_generation)
#define ui_channel (current->ui_channel)
#define registered (current->registered)
#define initialized (current->initialized)
#define worker_ready (current->worker_ready)
#define durable_ready (current->durable_ready)
#define input_revoked (current->input_revoked)
#define fixture_connection (current->connection)
#define protected_connection (current->connection)
#define fixture_store (current->store)
#define protected_store (current->store)
#ifdef BRAIN_NATIVE_FIXTURE
static void fixture_step(const char *step){dprintf(2,"fixture-session-%02x-%s\n",binding.work[15],step);}
#endif
#if defined(BRAIN_NATIVE_FIXTURE) && !defined(BRAIN_FIXTURE_BROKER_PG)
static int fixture_guard(void *context) {(void)context;return 1;}
#endif
static int field(xpc_object_t m,const char *name,xpc_type_t type) { xpc_object_t v=xpc_dictionary_get_value(m,name); return v && xpc_get_type(v)==type; }
static void revoke_session(void) {
  if(!current || current->closing)return;current->closing=1;
  if(ui_channel>=0){shutdown(ui_channel,SHUT_RDWR);close(ui_channel);ui_channel=-1;}
  if(waiting_consume){xpc_release(waiting_consume);waiting_consume=NULL;}memset(waiting_prompt,0,sizeof waiting_prompt);waiting_generation=0;
  if(initialized) { brain_broker_cancel(&broker); brain_broker_destroy(&broker); initialized=0; }
#ifdef BRAIN_FIXTURE_BROKER_PG
  if(fixture_connection){PQfinish(fixture_connection);fixture_connection=NULL;}
#elif !defined(BRAIN_NATIVE_FIXTURE)
  if(protected_connection){PQfinish(protected_connection);protected_connection=NULL;}
#endif
  if(supervisor) brain_xpc_close(&supervisor->peer);
  if(worker) brain_xpc_close(&worker->peer);
  if(ui) brain_xpc_close(&ui->peer);
  registered=worker_ready=durable_ready=input_revoked=0; gui_pid=0; memset(binding_target,0,sizeof binding_target);memset(&gui_scope,0,sizeof gui_scope); memset(&binding,0,sizeof binding);
}
/* 역할 단절 뒤에도 supervisor가 동일 세대의 폐기를 확인할 때까지 ACK 상태를 보유한다. */
static int revoke_input_only(void) {
  if(input_revoked)return 1;
  if(ui_channel<0)return 0;
  if(shutdown(ui_channel,SHUT_RDWR) && errno!=ENOTCONN)return 0;
  close(ui_channel);ui_channel=-1;
  if(waiting_consume){xpc_release(waiting_consume);waiting_consume=NULL;}memset(waiting_prompt,0,sizeof waiting_prompt);waiting_generation=0;
  if(initialized){brain_broker_cancel(&broker);clear_broker_peers(&broker);}
  input_revoked=1;return 1;
}
static void reply_ok(xpc_connection_t connection,xpc_object_t message) {
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_session(); return; }
  xpc_dictionary_set_bool(reply,"accepted",true); xpc_connection_send_message(connection,reply); xpc_release(reply);
}
static int register_session(xpc_object_t m) {
  if(registered || xpc_dictionary_get_count(m)!=12 || !field(m,"target",XPC_TYPE_STRING)) return 0;
  const char *uuids[]={"work","attempt","session","lease"};
  const char *numbers[]={"run","binding","package_generation","epoch"};
  for(size_t i=0;i<4;i++) if(!field(m,uuids[i],XPC_TYPE_UUID) || !field(m,numbers[i],XPC_TYPE_UINT64) || !xpc_dictionary_get_uint64(m,numbers[i]))return 0;
  if(!field(m,"pid",XPC_TYPE_INT64) || !field(m,"package",XPC_TYPE_DATA))return 0;
  int64_t pid=xpc_dictionary_get_int64(m,"pid"); size_t size=0; const void *package=xpc_dictionary_get_data(m,"package",&size);
  const char *target=xpc_dictionary_get_string(m,"target");
  if(pid<=0 || pid>INT32_MAX || !package || size!=32 || memcmp(package,BRAIN_PACKAGE_HASH,32) || !target || !*target || strlen(target)>1024)return 0;
  for(const unsigned char *p=(const unsigned char *)target;*p;p++)if(*p<32 || *p==127)return 0;
  memcpy(binding_target,target,strlen(target)+1);
  memcpy(binding.work,xpc_dictionary_get_uuid(m,"work"),16); memcpy(binding.attempt,xpc_dictionary_get_uuid(m,"attempt"),16);
  memcpy(binding.session,xpc_dictionary_get_uuid(m,"session"),16); memcpy(binding.launch_lease,xpc_dictionary_get_uuid(m,"lease"),16);
  memcpy(binding.package,package,32); binding.run_generation=xpc_dictionary_get_uint64(m,"run"); binding.binding_generation=xpc_dictionary_get_uint64(m,"binding");
  binding.package_generation=xpc_dictionary_get_uint64(m,"package_generation"); binding.connection_epoch=xpc_dictionary_get_uint64(m,"epoch");
  binding.worker_pid=(pid_t)pid; binding.worker_uid=BRAIN_WORKER_UID; binding.ui_uid=BRAIN_UI_UID;
  memcpy(binding.worker_hash,BRAIN_WORKER_HASH,20); memcpy(binding.ui_hash,BRAIN_UI_HASH,20); registered=1;
#ifdef BRAIN_NATIVE_FIXTURE
  fixture_step("register");
#endif
  return 1;
}
static int try_initialize(void) {
  if(initialized || !registered || !worker_ready || !worker || !ui || !ui->peer.authenticated) return 1;
  if(!brain_broker_init(&broker,&binding,&ui->peer,&worker->peer,300000))return 0;
  initialized=1;
#ifdef BRAIN_NATIVE_FIXTURE
  fixture_step("initialize");
#endif
#ifdef BRAIN_FIXTURE_BROKER_PG
  char conninfo[128];snprintf(conninfo,sizeof conninfo,"host=127.0.0.1 port=%d dbname=postgres user=postgres connect_timeout=3",FIXTURE_PG_PORT);
  fixture_connection=PQconnectdb(conninfo);PGresult *role=fixture_connection?PQexec(fixture_connection,"set session authorization brain_protected_broker"):NULL;
  int role_ok=role && PQresultStatus(role)==1;if(role)PQclear(role);
  if(!role_ok || !brain_broker_pg_init(&fixture_store,fixture_connection,&binding,binding_target) || !brain_broker_set_guard(&broker,brain_broker_pg_guard,&fixture_store))return 0;
#elif defined(BRAIN_NATIVE_FIXTURE)
  if(!brain_broker_set_guard(&broker,fixture_guard,NULL))return 0;
#else
  protected_connection=brain_broker_connect_protected(BRAIN_BROKER_DATABASE_FILE);
  if(!protected_connection || !brain_broker_pg_init(&protected_store,protected_connection,&binding,binding_target)
    || !brain_broker_set_guard(&broker,brain_broker_pg_guard,&protected_store))return 0;
#endif
  return brain_broker_worker(&broker) && (!durable_ready || brain_broker_recorded(&broker));
}
static void send_target(endpoint *e,xpc_object_t message) {
  if(xpc_dictionary_get_count(message)!=1 || (initialized && broker.session.attached)) { revoke_session(); return; }
  xpc_object_t r=xpc_dictionary_create_reply(message); if(!r){revoke_session();return;}
  if(!initialized || !broker.session.recorded) { xpc_dictionary_set_bool(r,"pending",true); xpc_connection_send_message(e->peer.connection,r); xpc_release(r); return; }
  xpc_dictionary_set_uuid(r,"work",binding.work); xpc_dictionary_set_uuid(r,"attempt",binding.attempt); xpc_dictionary_set_uuid(r,"session",binding.session); xpc_dictionary_set_uuid(r,"lease",binding.launch_lease);
  xpc_dictionary_set_uint64(r,"run",binding.run_generation); xpc_dictionary_set_uint64(r,"binding",binding.binding_generation); xpc_dictionary_set_uint64(r,"package_generation",binding.package_generation); xpc_dictionary_set_uint64(r,"epoch",binding.connection_epoch); xpc_dictionary_set_data(r,"package",binding.package,32); xpc_dictionary_set_string(r,"tokenstore",binding_target);
  xpc_connection_send_message(e->peer.connection,r); xpc_release(r);
}
static int selection_matches(xpc_object_t m) {
  const char *keys[]={"work","attempt","session","lease"}; const uint8_t *values[]={binding.work,binding.attempt,binding.session,binding.launch_lease};
  const char *nums[]={"run","binding","package_generation","epoch"}; uint64_t vals[]={binding.run_generation,binding.binding_generation,binding.package_generation,binding.connection_epoch};
  if(xpc_dictionary_get_count(m)!=10)return 0;
  for(size_t i=0;i<4;i++) if(!field(m,keys[i],XPC_TYPE_UUID) || memcmp(xpc_dictionary_get_uuid(m,keys[i]),values[i],16) || !field(m,nums[i],XPC_TYPE_UINT64) || xpc_dictionary_get_uint64(m,nums[i])!=vals[i])return 0;
  size_t n=0; const void *p=xpc_dictionary_get_data(m,"package",&n); return p && n==32 && !memcmp(p,binding.package,32);
}
/* supervisor가 발급한 GUI 실행 인스턴스만 UI 연결에 결합한다. */
static int record_gui(xpc_object_t m) {
  if(!registered || gui_pid || xpc_dictionary_get_count(m)!=9 || !field(m,"pid",XPC_TYPE_INT64)
    || !field(m,"gui_session",XPC_TYPE_UUID) || !field(m,"instance",XPC_TYPE_UUID) || !field(m,"policy",XPC_TYPE_UINT64)
    || !field(m,"boot",XPC_TYPE_UUID) || !field(m,"asid",XPC_TYPE_UINT64) || !field(m,"start_sec",XPC_TYPE_UINT64) || !field(m,"start_usec",XPC_TYPE_UINT64))return 0;
  int64_t pid=xpc_dictionary_get_int64(m,"pid");uint64_t policy=xpc_dictionary_get_uint64(m,"policy");
  const uint8_t *session=xpc_dictionary_get_uuid(m,"gui_session"),*instance=xpc_dictionary_get_uuid(m,"instance");
  unsigned a=0,b=0;for(size_t i=0;i<16;i++){a|=session[i];b|=instance[i];}
  uint64_t asid=xpc_dictionary_get_uint64(m,"asid"),sec=xpc_dictionary_get_uint64(m,"start_sec"),usec=xpc_dictionary_get_uint64(m,"start_usec");
  if(pid<=0 || pid>INT32_MAX || !BRAIN_PRESENCE_POLICY_GENERATION || policy!=BRAIN_PRESENCE_POLICY_GENERATION || !a || !b || !asid || asid>INT32_MAX || !sec)return 0;
  gui_pid=(pid_t)pid;set_scope_pid(&gui_scope,(uint64_t)pid);gui_scope.policy_generation=policy;gui_scope.gui_asid=asid;gui_scope.gui_start_sec=sec;gui_scope.gui_start_usec=usec;
  memcpy(gui_scope.gui_session,session,16);memcpy(gui_scope.gui_instance,instance,16);memcpy(gui_scope.gui_boot,xpc_dictionary_get_uuid(m,"boot"),16);return 1;
}
static int current_gui(endpoint *e) {
  if(!e || e->role!=UI || !e->peer.authenticated || e->peer.pid!=gui_pid || xpc_connection_get_asid(e->peer.connection)!=(int32_t)gui_scope.gui_asid)return 0;
  struct proc_bsdinfo info;int n=proc_pidinfo(gui_pid,PROC_PIDTBSDINFO,0,&info,sizeof info);
  if(n!=(int)sizeof info || info.pbi_pid!=(uint32_t)gui_pid || info.pbi_uid!=BRAIN_UI_UID || info.pbi_start_tvsec!=gui_scope.gui_start_sec || info.pbi_start_tvusec!=gui_scope.gui_start_usec)return 0;
  char boot[64];size_t size=sizeof boot;uuid_t actual;
  if(sysctlbyname("kern.bootsessionuuid",boot,&size,NULL,0) || size==0 || size>sizeof boot || boot[size-1]!='\0' || uuid_parse(boot,actual) || memcmp(actual,gui_scope.gui_boot,16))return 0;
  uid_t uid=0;gid_t gid=0;CFStringRef user=SCDynamicStoreCopyConsoleUser(NULL,&uid,&gid);
  int ok=user && uid==BRAIN_UI_UID;if(user)CFRelease(user);return ok;
}
static void handle(endpoint *e,xpc_object_t m) {
  if(!brain_xpc_verify_message(&e->peer,m) || !field(m,"op",XPC_TYPE_STRING)){revoke_session();return;}
  const char *op=xpc_dictionary_get_string(m,"op");
  if(input_revoked && !(e->role==SUPERVISOR && !strcmp(op,"revoke_input"))){brain_xpc_close(&e->peer);return;}
  if(e->role==SUPERVISOR && !strcmp(op,"prepare_channel") && !registered && ui_channel<0 && xpc_dictionary_get_count(m)==1) {
    int worker_fd=-1,ui_fd=-1;
    if(brain_broker_prepare_channel(&worker_fd,&ui_fd,15000)) {
      xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){close(worker_fd);close(ui_fd);revoke_session();return;}
      xpc_dictionary_set_fd(r,"worker_fd",worker_fd);xpc_connection_send_message(e->peer.connection,r);xpc_release(r);close(worker_fd);ui_channel=ui_fd;return;
    }
  }
  if(e->role==SUPERVISOR && !strcmp(op,"register") && register_session(m)){reply_ok(e->peer.connection,m);return;}
  if(e->role==SUPERVISOR && !strcmp(op,"gui_instance") && record_gui(m)){reply_ok(e->peer.connection,m);return;}
  if(e->role==WORKER && !strcmp(op,"attach") && registered && !worker_ready && worker==e && e->peer.pid==binding.worker_pid && xpc_dictionary_get_count(m)==1) {
#ifdef BRAIN_NATIVE_FIXTURE
    fixture_step("worker-attach");
#endif
    worker_ready=1; if(try_initialize()){
      xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){revoke_session();return;}
      xpc_dictionary_set_bool(r,"accepted",true);xpc_dictionary_set_uuid(r,"session",binding.session);xpc_connection_send_message(e->peer.connection,r);xpc_release(r);return;
    }
  }
  if(e->role==WORKER && !strcmp(op,"ready") && worker_ready && e==worker && xpc_dictionary_get_count(m)==1) {
    xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){revoke_session();return;}
    xpc_dictionary_set_bool(r,"ready",initialized && broker.session.attached && current_gui(ui));xpc_connection_send_message(e->peer.connection,r);xpc_release(r);return;
  }
  if(e->role==SUPERVISOR && !strcmp(op,"recorded") && registered && !durable_ready && xpc_dictionary_get_count(m)==1) {
    durable_ready=1; if((!initialized || brain_broker_recorded(&broker)) && try_initialize()){reply_ok(e->peer.connection,m);return;}
  }
  if(e->role==SUPERVISOR && !strcmp(op,"revoke_input") && registered && xpc_dictionary_get_count(m)==5
    && field(m,"work",XPC_TYPE_UUID) && field(m,"attempt",XPC_TYPE_UUID) && field(m,"lease",XPC_TYPE_UUID) && field(m,"epoch",XPC_TYPE_UINT64)
    && !memcmp(xpc_dictionary_get_uuid(m,"work"),binding.work,16) && !memcmp(xpc_dictionary_get_uuid(m,"attempt"),binding.attempt,16)
    && !memcmp(xpc_dictionary_get_uuid(m,"lease"),binding.launch_lease,16) && xpc_dictionary_get_uint64(m,"epoch")==binding.connection_epoch) {
    if(!revoke_input_only()){revoke_session();return;}
#ifdef BRAIN_NATIVE_FIXTURE
    (void)write(2,"fixture-revoked\n",16);
#endif
    reply_ok(e->peer.connection,m);return;
  }
  if(e->role==UI && !strcmp(op,"select_target")){send_target(e,m);return;}
  if(e->role==UI && !strcmp(op,"selection") && initialized && current_gui(e) && selection_matches(m) && brain_broker_attach(&broker,&binding)) {
#ifdef BRAIN_NATIVE_FIXTURE
    fixture_step("selection");
#endif
    /* worker 상속과 실제 사용자 존재 검증 전에는 선택 뒤 닫는다. */
#ifndef BRAIN_NATIVE_FIXTURE
    revoke_session(); return;
#endif
    reply_ok(e->peer.connection,m);
    if(ui_channel<0 || !brain_broker_deliver(&broker,ui_channel)){revoke_session();return;}
    return;
  }
  if(e->role==WORKER && !strcmp(op,"prompt") && initialized && broker.session.attached && xpc_dictionary_get_count(m)==3
    && field(m,"prompt",XPC_TYPE_UUID) && field(m,"mfa",XPC_TYPE_BOOL)
    && current_gui(ui) && brain_broker_prompt(&broker,xpc_dictionary_get_uuid(m,"prompt"),xpc_dictionary_get_bool(m,"mfa")?1:0)) {
#ifdef BRAIN_NATIVE_FIXTURE
    (void)write(2,"fixture-prompt\n",15);
#endif
    xpc_object_t event=xpc_dictionary_create(NULL,NULL,0);if(!event){revoke_session();return;}
    xpc_dictionary_set_string(event,"op","prompt");xpc_dictionary_set_uuid(event,"prompt",xpc_dictionary_get_uuid(m,"prompt"));
    xpc_dictionary_set_bool(event,"mfa",xpc_dictionary_get_bool(m,"mfa"));xpc_dictionary_set_uint64(event,"ordinal",broker.session.mfa_count);xpc_connection_send_message(ui->peer.connection,event);xpc_release(event);
    reply_ok(e->peer.connection,m);return;
  }
  if(e->role==UI && !strcmp(op,"challenge") && initialized && current_gui(e) && xpc_dictionary_get_count(m)==2
    && field(m,"response_generation",XPC_TYPE_UINT64)) {
    gui_scope.response_generation=xpc_dictionary_get_uint64(m,"response_generation");brain_presence_challenge c;
    if(brain_broker_challenge(&broker,&gui_scope,300000,&c)) {
      xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){revoke_session();return;}
      xpc_dictionary_set_data(r,"challenge",c.message,c.length);xpc_dictionary_set_int64(r,"deadline",c.deadline_ms);
      xpc_connection_send_message(e->peer.connection,r);xpc_release(r);return;
    }
  }
  if(e->role==UI && !strcmp(op,"assertion") && initialized && current_gui(e) && xpc_dictionary_get_count(m)==2 && field(m,"digest",XPC_TYPE_DATA)) {
    size_t n=0;const uint8_t *digest=xpc_dictionary_get_data(m,"digest",&n);uint8_t capability[32]={0};
    int ok=n==32 && brain_broker_callback(&broker,digest,capability);memset(capability,0,sizeof capability);
    if(ok && waiting_consume) {
      ok=worker && worker->peer.authenticated && waiting_generation==gui_scope.response_generation
        && brain_broker_consume(&broker,&gui_scope,waiting_prompt,broker.capability);
      if(ok){xpc_object_t reply=xpc_dictionary_create_reply(waiting_consume);if(!reply){revoke_session();return;}
        xpc_dictionary_set_bool(reply,"accepted",true);xpc_connection_send_message(worker->peer.connection,reply);xpc_release(reply);
        xpc_release(waiting_consume);waiting_consume=NULL;memset(waiting_prompt,0,sizeof waiting_prompt);waiting_generation=0;}
    }
    if(ok){reply_ok(e->peer.connection,m);return;}
  }
  if(e->role==UI && !strcmp(op,"send_ready") && initialized && current_gui(e) && xpc_dictionary_get_count(m)==3
    && field(m,"prompt",XPC_TYPE_UUID) && field(m,"response_generation",XPC_TYPE_UINT64)
    && brain_broker_send_ready(&broker,xpc_dictionary_get_uuid(m,"prompt"),xpc_dictionary_get_uint64(m,"response_generation"))) {reply_ok(e->peer.connection,m);return;}
  if(e->role==WORKER && !strcmp(op,"confirm") && initialized && current_gui(ui) && xpc_dictionary_get_count(m)==3
    && field(m,"prompt",XPC_TYPE_UUID) && field(m,"response_generation",XPC_TYPE_UINT64)
    && brain_broker_confirm(&broker,xpc_dictionary_get_uuid(m,"prompt"),xpc_dictionary_get_uint64(m,"response_generation"))) {reply_ok(e->peer.connection,m);return;}
  if(e->role==WORKER && !strcmp(op,"consume") && initialized && current_gui(ui) && xpc_dictionary_get_count(m)==3
    && field(m,"prompt",XPC_TYPE_UUID) && field(m,"response_generation",XPC_TYPE_UINT64) && !waiting_consume
    && broker.session.prompt_open && !memcmp(xpc_dictionary_get_uuid(m,"prompt"),broker.session.prompt,16)
    && xpc_dictionary_get_uint64(m,"response_generation")==broker.session.sequence+1) {
    if(broker.capability_ready && gui_scope.response_generation==broker.session.sequence+1
      && brain_broker_consume(&broker,&gui_scope,xpc_dictionary_get_uuid(m,"prompt"),broker.capability)) {reply_ok(e->peer.connection,m);return;}
    if(!broker.capability_ready) {waiting_consume=xpc_retain(m);memcpy(waiting_prompt,xpc_dictionary_get_uuid(m,"prompt"),16);waiting_generation=broker.session.sequence+1;return;}
  }
  revoke_session();
}
static void accept_peer(xpc_connection_t connection,enum role role,uid_t uid,const uint8_t hash[20]) {
  endpoint *e=calloc(1,sizeof *e); if(!e){xpc_connection_cancel(connection);return;} e->role=role;
  if(role==SUPERVISOR){e->session=new_session();if(!e->session){free(e);xpc_connection_cancel(connection);return;}*session_slot(e->session,role)=e;}
  xpc_connection_set_target_queue(connection,queue);
  if(!brain_xpc_configure_service(&e->peer,connection,uid,hash)){broker_session *s=e->session;if(s)*session_slot(s,role)=NULL;free(e);release_session(s);xpc_connection_cancel(connection);return;}
  xpc_connection_set_event_handler(connection,^(xpc_object_t m){
    current=e->session;
    if(xpc_get_type(m)==XPC_TYPE_ERROR){broker_session *s=e->session;
      if(s && e->role==SUPERVISOR)revoke_session();
      else if(s && !input_revoked){
#ifdef BRAIN_NATIVE_FIXTURE
        fixture_step("peer-disconnect");
#endif
        if(!revoke_input_only()){
#ifdef BRAIN_NATIVE_FIXTURE
          fixture_step("auto-revoke-failed");
#endif
          revoke_session();}}
      if(m==XPC_ERROR_CONNECTION_INVALID){if(s)*session_slot(s,e->role)=NULL;free(e);release_session(s);}return;}
    if(!e->peer.authenticated){
      if(!brain_xpc_authenticate(&e->peer,m)){if(current)revoke_session();else brain_xpc_close(&e->peer);return;}
      if(!e->session){e->session=find_session(e->role,e->peer.pid);current=e->session;if(!current){brain_xpc_close(&e->peer);return;}*session_slot(current,e->role)=e;}
      xpc_object_t r=xpc_dictionary_create_reply(m);if(!r){revoke_session();return;}xpc_dictionary_set_bool(r,"hello",true);xpc_connection_send_message(connection,r);xpc_release(r);if(!try_initialize())revoke_session();return;
    }
    handle(e,m);
  });
  xpc_connection_activate(connection);
}
static int listen_role(const char *name,enum role role,uid_t uid,const uint8_t hash[20]) {
  xpc_connection_t listener=xpc_connection_create_mach_service(name,queue,XPC_CONNECTION_MACH_SERVICE_LISTENER); brain_xpc_peer policy;
  if(!listener || !brain_xpc_configure_service(&policy,listener,uid,hash))return 0;
  xpc_connection_set_event_handler(listener,^(xpc_object_t e){if(xpc_get_type(e)==XPC_TYPE_CONNECTION)accept_peer((xpc_connection_t)e,role,uid,hash);});
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
