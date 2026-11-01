/* launchd가 Garmin principal로 실행하는 고정 worker host다. 보호 policy 없이는 시작하지 않는다. */
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/random.h>
#include <sys/wait.h>
#include <signal.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <xpc/xpc.h>
#include "worker-host.h"
#include "xpc-peer.h"
#include "peer.h"

#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_MACH_SERVICE "org.secondbrain.unconfigured"
#define BRAIN_SUPERVISOR_UID 0
#define BRAIN_WORKER_UID 0
static const uint8_t BRAIN_SUPERVISOR_HASH[20] = {0}, BRAIN_WORKER_HASH[20] = {0}, BRAIN_PACKAGE_HASH[32] = {0};
#endif

typedef struct {
  brain_xpc_peer peer;
  brain_worker worker;
  uint8_t work[16], attempt[16], lease[16];
  uint64_t run, binding, epoch, start_sec, start_usec;
  int active, revoked, unknown, connection_invalid, ledger_index, metadata_sent, auth, exit_event_sent;
  dispatch_queue_t queue;
  dispatch_source_t exit_source;
} host_connection;

/* [ASSUMPTION] host 재시작 전 one-shot 이력 4096건을 보존한다. 초과 시 닫힌다. */
static pthread_mutex_t ledger_lock=PTHREAD_MUTEX_INITIALIZER;
static struct { uint8_t work[16], attempt[16]; int active; } ledger[4096];
static size_t ledger_count;
static int nonzero_uuid(const uint8_t value[16]) { unsigned v=0; for(int i=0;i<16;i++)v|=value[i]; return v!=0; }
static int reserve_launch(const uint8_t work[16], const uint8_t attempt[16]) {
  if (!nonzero_uuid(work) || !nonzero_uuid(attempt) || pthread_mutex_lock(&ledger_lock)) return -1;
  int result=-1;
  if (ledger_count < sizeof ledger/sizeof ledger[0]) {
    int conflict=0;
    for(size_t i=0;i<ledger_count;i++) if (!memcmp(ledger[i].attempt,attempt,16) || (ledger[i].active && !memcmp(ledger[i].work,work,16))) { conflict=1; break; }
    if (!conflict) { size_t index=ledger_count++; memcpy(ledger[index].work,work,16); memcpy(ledger[index].attempt,attempt,16); ledger[index].active=1; result=(int)index; }
  }
  pthread_mutex_unlock(&ledger_lock); return result;
}
static void settle_launch(int index) {
  if (index<0 || pthread_mutex_lock(&ledger_lock)) return;
  if ((size_t)index<ledger_count) ledger[index].active=0;
  pthread_mutex_unlock(&ledger_lock);
}
static int field(xpc_object_t message, const char *key, xpc_type_t type) {
  xpc_object_t value=xpc_dictionary_get_value(message,key); return value && xpc_get_type(value)==type;
}
static int same_uuid(xpc_object_t message, const char *key, const uint8_t value[16]) {
  const uint8_t *received=xpc_dictionary_get_uuid(message,key); return received && !memcmp(received,value,16);
}
static void revoke_host(host_connection *host) {
  if (!host || host->revoked) return; host->revoked=1;
  if (host->active) {
    brain_worker_close(&host->worker);
    /* 연결이 끊겼거나 신원이 불명이면 별도 신호를 추측하지 않고 holder를 보존한다. */
    host->unknown=1;
  }
  brain_xpc_close(&host->peer);
}
static int current_identity(host_connection *host) {
  if(host->worker.exit_observed && !host->worker.reaped)return brain_worker_observe_exit(&host->worker,NULL)==1;
  struct proc_bsdinfo info;
  int n=proc_pidinfo(host->worker.pid,PROC_PIDTBSDINFO,0,&info,sizeof info);
  return n==(int)sizeof info && info.pbi_pid==(uint32_t)host->worker.pid && info.pbi_pgid==(uint32_t)host->worker.pid
    && info.pbi_start_tvsec==host->start_sec && info.pbi_start_tvusec==host->start_usec;
}
static void on_child_exit(host_connection *host) {
  int status=0, observed=brain_worker_observe_exit(&host->worker,&status);
  host->unknown = observed!=1;
  if (host->peer.authenticated && !host->revoked) {
    xpc_object_t event=xpc_dictionary_create(NULL,NULL,0);
    if (event) {
      xpc_dictionary_set_string(event,"op",observed==1 ? "leader_exit" : "unknown");
      xpc_dictionary_set_int64(event,"pid",host->worker.pid);
      if (observed==1) xpc_dictionary_set_int64(event,"wait_status",status);
      xpc_connection_send_message(host->peer.connection,event); xpc_release(event);
      if(observed==1)host->exit_event_sent=1;
#ifdef BRAIN_NATIVE_FIXTURE
      if(observed==1)(void)write(2,"fixture-leader-observed\n",24);
#endif
    }
  }
  if (host->exit_source) { dispatch_source_cancel(host->exit_source); dispatch_release(host->exit_source); host->exit_source=NULL; }
  if (host->connection_invalid && !host->active) { dispatch_release(host->queue); free(host); }
}
static void handle_start(host_connection *host, xpc_object_t message, int auth) {
  if (host->active || host->unknown || xpc_dictionary_get_count(message)!=(auth?8u:7u) || (auth && !field(message,"channel",XPC_TYPE_FD)) || !field(message,"work",XPC_TYPE_UUID)
      || !field(message,"attempt",XPC_TYPE_UUID) || !field(message,"run",XPC_TYPE_UINT64)
      || !field(message,"binding",XPC_TYPE_UINT64) || !field(message,"epoch",XPC_TYPE_UINT64)
      || !field(message,"package",XPC_TYPE_DATA)) { revoke_host(host); return; }
  size_t size=0; const void *package=xpc_dictionary_get_data(message,"package",&size);
  uint64_t run=xpc_dictionary_get_uint64(message,"run"), binding=xpc_dictionary_get_uint64(message,"binding"), epoch=xpc_dictionary_get_uint64(message,"epoch");
  if (!package || size!=32 || memcmp(package,BRAIN_PACKAGE_HASH,32) || !run || !binding || !epoch) { revoke_host(host); return; }
  memcpy(host->work,xpc_dictionary_get_uuid(message,"work"),16); memcpy(host->attempt,xpc_dictionary_get_uuid(message,"attempt"),16);
  host->run=run; host->binding=binding; host->epoch=epoch; host->auth=auth;
  host->ledger_index=reserve_launch(host->work,host->attempt);
  if (host->ledger_index<0) { revoke_host(host); return; }
  int channel=-1;
  if(auth) {channel=xpc_dictionary_dup_fd(message,"channel");if(channel<0 || fcntl(channel,F_SETFD,FD_CLOEXEC)<0){if(channel>=0)close(channel);settle_launch(host->ledger_index);revoke_host(host);return;}}
  int spawned=!getentropy(host->lease,sizeof host->lease) && (auth?brain_spawn_worker_with_channel(BRAIN_WORKER_HASH,BRAIN_WORKER_UID,channel,&host->worker):brain_spawn_worker(BRAIN_WORKER_HASH,BRAIN_WORKER_UID,&host->worker));
  if(channel>=0)close(channel);
  if(!spawned) { settle_launch(host->ledger_index); revoke_host(host); return; }
  host->active=1;
#ifdef BRAIN_NATIVE_FIXTURE
  (void)write(2,"fixture-spawned\n",16);
#endif
  host->exit_source=dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,(uintptr_t)host->worker.pid,DISPATCH_PROC_EXIT,host->queue);
  if (!host->exit_source) { revoke_host(host); return; }
  dispatch_source_set_event_handler(host->exit_source,^{ on_child_exit(host); }); dispatch_resume(host->exit_source);
  /* [ASSUMPTION] exec·peer 확인의 10초 상한은 실제 배포에서 검증한다. */
  if (!brain_worker_verify_peer(&host->worker,BRAIN_WORKER_UID,BRAIN_WORKER_HASH,10000)) { revoke_host(host); return; }
  struct proc_bsdinfo info; int n=proc_pidinfo(host->worker.pid,PROC_PIDTBSDINFO,0,&info,sizeof info);
  if (n!=(int)sizeof info || info.pbi_pid!=(uint32_t)host->worker.pid || info.pbi_pgid!=(uint32_t)host->worker.pid) { revoke_host(host); return; }
  host->start_sec=info.pbi_start_tvsec; host->start_usec=info.pbi_start_tvusec;
  host->worker.start_sec=host->start_sec;host->worker.start_usec=host->start_usec;
#if defined(BRAIN_NATIVE_FIXTURE) && defined(BRAIN_FIXTURE_IDENTITY_CASE) && BRAIN_FIXTURE_IDENTITY_CASE==1
  host->worker.start_usec^=1;
#endif
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_host(host); return; }
  xpc_dictionary_set_int64(reply,"pid",host->worker.pid); xpc_dictionary_set_uint64(reply,"start_sec",host->start_sec);
  xpc_dictionary_set_uint64(reply,"start_usec",host->start_usec); xpc_dictionary_set_uuid(reply,"lease",host->lease);
  xpc_dictionary_set_fd(reply,"stdout",host->worker.stdout_read); xpc_dictionary_set_fd(reply,"stderr",host->worker.stderr_read);
  xpc_connection_send_message(host->peer.connection,reply); xpc_release(reply);
  close(host->worker.stdout_read); close(host->worker.stderr_read); host->worker.stdout_read=host->worker.stderr_read=-1;
}
static void handle_recorded(host_connection *host, xpc_object_t message) {
#if !defined(BRAIN_NATIVE_FIXTURE) || defined(BRAIN_FIXTURE_REQUIRE_METADATA)
  if(host->auth && !host->metadata_sent){revoke_host(host);return;}
#endif
  if (!host->active || host->unknown || xpc_dictionary_get_count(message)!=8 || !field(message,"work",XPC_TYPE_UUID)
      || !field(message,"attempt",XPC_TYPE_UUID) || !field(message,"lease",XPC_TYPE_UUID)
      || !field(message,"run",XPC_TYPE_UINT64) || !field(message,"binding",XPC_TYPE_UINT64) || !field(message,"epoch",XPC_TYPE_UINT64)
      || !field(message,"pid",XPC_TYPE_INT64) || !same_uuid(message,"work",host->work) || !same_uuid(message,"attempt",host->attempt)
      || !same_uuid(message,"lease",host->lease) || xpc_dictionary_get_uint64(message,"run")!=host->run
      || xpc_dictionary_get_uint64(message,"binding")!=host->binding || xpc_dictionary_get_uint64(message,"epoch")!=host->epoch
      || xpc_dictionary_get_int64(message,"pid")!=host->worker.pid || !current_identity(host)
      || !brain_worker_recorded(&host->worker,host->worker.pid) || !brain_worker_ack(&host->worker)) { revoke_host(host); return; }
#ifdef BRAIN_NATIVE_FIXTURE
  (void)write(2,"fixture-ack\n",12);
#endif
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_host(host); return; }
  xpc_dictionary_set_bool(reply,"accepted",true); xpc_connection_send_message(host->peer.connection,reply); xpc_release(reply);
}
static void handle_metadata(host_connection *host,xpc_object_t message) {
  if(!host->active || host->unknown || host->metadata_sent || host->worker.identity_recorded || xpc_dictionary_get_count(message)!=3
    || !field(message,"lease",XPC_TYPE_UUID) || !same_uuid(message,"lease",host->lease) || !field(message,"frame",XPC_TYPE_DATA)) {revoke_host(host);return;}
  size_t n=0;const uint8_t *p=xpc_dictionary_get_data(message,"frame",&n);
  if(!p || n<47 || n>1235 || p[0]!=1 || memcmp(p+1,host->work,16) || memcmp(p+17,host->attempt,16)){revoke_host(host);return;}
  uint64_t run=0;for(int i=33;i<41;i++)run=(run<<8)|p[i];
  size_t zone=(size_t)p[41]*256+p[42],target=(size_t)p[43]*256+p[44],id=p[46];
  if(run!=host->run || !zone || zone>128 || !target || target>1024 || (p[45]!=1 && p[45]!=2) || !id || id>36 || n!=47+zone+target+id || memchr(p+47+zone,0,target)){revoke_host(host);return;}
  if(memchr(p+47+zone+target,0,id)){revoke_host(host);return;}
  char target_id[37];memcpy(target_id,p+47+zone+target,id);target_id[id]=0;uuid_t parsed;
  if((p[45]==1 && strcmp(target_id,"garmin")) || (p[45]==2 && (id!=36 || uuid_parse(target_id,parsed) || uuid_is_null(parsed)))){revoke_host(host);return;}
  for(size_t i=0;i<zone;i++){uint8_t c=p[47+i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='/'||c=='_'||c=='-'||c=='+')){revoke_host(host);return;}}
  if(!brain_write_frame(host->worker.control_fd,p,n,2000)){revoke_host(host);return;}host->metadata_sent=1;
  xpc_object_t reply=xpc_dictionary_create_reply(message);if(!reply){revoke_host(host);return;}
  xpc_dictionary_set_bool(reply,"accepted",true);xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
}
static void handle_inspect(host_connection *host, xpc_object_t message) {
  if(!host->active || host->unknown || xpc_dictionary_get_count(message)!=3 || !field(message,"lease",XPC_TYPE_UUID)
    || !same_uuid(message,"lease",host->lease) || !field(message,"pid",XPC_TYPE_INT64) || xpc_dictionary_get_int64(message,"pid")!=host->worker.pid
    || !current_identity(host)){revoke_host(host);return;}
  int group=brain_worker_group_state(&host->worker);if(group<0){host->unknown=1;revoke_host(host);return;}
  xpc_object_t reply=xpc_dictionary_create_reply(message);if(!reply){revoke_host(host);return;}
  xpc_dictionary_set_int64(reply,"pid",host->worker.pid);xpc_dictionary_set_uint64(reply,"start_sec",host->start_sec);
  xpc_dictionary_set_uint64(reply,"start_usec",host->start_usec);xpc_dictionary_set_int64(reply,"group",group);
  xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
}
static void handle_signal(host_connection *host, xpc_object_t message) {
  if(!host->active || host->unknown || xpc_dictionary_get_count(message)!=4 || !field(message,"lease",XPC_TYPE_UUID)
    || !same_uuid(message,"lease",host->lease) || !field(message,"pid",XPC_TYPE_INT64) || xpc_dictionary_get_int64(message,"pid")!=host->worker.pid
    || !field(message,"signal",XPC_TYPE_INT64) || !current_identity(host)){revoke_host(host);return;}
  int64_t signal_value=xpc_dictionary_get_int64(message,"signal");
  if((signal_value!=SIGTERM && signal_value!=SIGKILL) || !brain_worker_signal(&host->worker,(int)signal_value)){host->unknown=1;revoke_host(host);return;}
#ifdef BRAIN_NATIVE_FIXTURE
  (void)write(2,"fixture-signalled\n",18);
#endif
  xpc_object_t reply=xpc_dictionary_create_reply(message);if(!reply){revoke_host(host);return;}
  xpc_dictionary_set_bool(reply,"sent",true);xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
}
static int control_identity(host_connection *host,xpc_object_t message) {
  return host->active && !host->unknown && xpc_dictionary_get_count(message)==3 && field(message,"lease",XPC_TYPE_UUID)
    && same_uuid(message,"lease",host->lease) && field(message,"pid",XPC_TYPE_INT64) && xpc_dictionary_get_int64(message,"pid")==host->worker.pid && current_identity(host);
}
static void handle_members(host_connection *host,xpc_object_t message) {
  if(!control_identity(host,message)){revoke_host(host);return;}
#if defined(BRAIN_NATIVE_FIXTURE) && defined(BRAIN_FIXTURE_IDENTITY_CASE) && BRAIN_FIXTURE_IDENTITY_CASE==4
  /* 합성 자식만 회수해 이전 waitable identity가 사라진 반례를 만든다. */
  (void)kill(host->worker.pid,SIGKILL);int fixture_status=0;(void)waitpid(host->worker.pid,&fixture_status,0);
  host->worker.exit_observed=1;host->worker.wait_status=fixture_status;
#endif
  /* [ASSUMPTION] 그룹 관찰 응답은 24명까지며 초과는 불명으로 보존한다. */
  brain_group_member members[24];size_t count=0;
  /* [ASSUMPTION] 종료 중인 구성원이 열거와 조회 사이 사라질 수 있어 1초간 재조회한다. */
  int inspected=0;for(int i=0;i<100;i++){
#if defined(BRAIN_NATIVE_FIXTURE) && defined(BRAIN_FIXTURE_IDENTITY_CASE) && BRAIN_FIXTURE_IDENTITY_CASE==3
    (void)members;(void)count;
#else
    if(brain_worker_members(&host->worker,members,24,&count)==1){inspected=1;break;}
#endif
    usleep(10000);}
  if(!inspected){
#ifdef BRAIN_NATIVE_FIXTURE
    (void)write(2,"fixture-members-unknown\n",24);
#endif
    host->unknown=1;revoke_host(host);return;}
#ifdef BRAIN_NATIVE_FIXTURE
  dprintf(2,"fixture-members-%zu\n",count);
#endif
  xpc_object_t reply=xpc_dictionary_create_reply(message),array=xpc_array_create(NULL,0);
  if(!reply || !array){if(reply)xpc_release(reply);if(array)xpc_release(array);revoke_host(host);return;}
  for(size_t i=0;i<count;i++) {xpc_object_t item=xpc_dictionary_create(NULL,NULL,0);if(!item){xpc_release(array);xpc_release(reply);revoke_host(host);return;}
    xpc_dictionary_set_int64(item,"pid",members[i].pid);xpc_dictionary_set_uint64(item,"start_sec",members[i].start_sec);xpc_dictionary_set_uint64(item,"start_usec",members[i].start_usec);xpc_array_append_value(array,item);xpc_release(item);}
  xpc_dictionary_set_value(reply,"members",array);xpc_release(array);xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
}
static void handle_reap(host_connection *host,xpc_object_t message) {
  if(!control_identity(host,message) || !host->exit_event_sent || !host->worker.exit_observed){revoke_host(host);return;}
  brain_group_member members[24];size_t count=0;int status=0,expected=host->worker.wait_status;
  if(brain_worker_members(&host->worker,members,24,&count)!=1 || count || brain_worker_reap(&host->worker,&status)!=1 || status!=expected || brain_worker_group_state(&host->worker)!=0){host->unknown=1;revoke_host(host);return;}
  xpc_object_t event=xpc_dictionary_create(NULL,NULL,0),reply=xpc_dictionary_create_reply(message);
  if(!event || !reply){if(event)xpc_release(event);if(reply)xpc_release(reply);host->unknown=1;revoke_host(host);return;}
  xpc_dictionary_set_string(event,"op","exit");xpc_dictionary_set_int64(event,"pid",host->worker.pid);xpc_dictionary_set_int64(event,"wait_status",status);
  xpc_connection_send_message(host->peer.connection,event);xpc_release(event);
  xpc_dictionary_set_bool(reply,"reaped",true);xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
#ifdef BRAIN_NATIVE_FIXTURE
  (void)write(2,"fixture-reaped\n",15);
#endif
  brain_worker_close(&host->worker);host->active=0;settle_launch(host->ledger_index);
}
static void on_connection(xpc_connection_t connection) {
  host_connection *host=calloc(1,sizeof *host); if (!host) return;
  host->ledger_index=-1;
  host->queue=dispatch_queue_create("org.secondbrain.worker.connection",DISPATCH_QUEUE_SERIAL);
  if (!host->queue) { free(host); return; }
  xpc_connection_set_target_queue(connection,host->queue);
  if (!brain_xpc_configure_service(&host->peer,connection,BRAIN_SUPERVISOR_UID,BRAIN_SUPERVISOR_HASH)) { dispatch_release(host->queue); free(host); return; }
  xpc_connection_set_event_handler(connection,^(xpc_object_t message) {
    if (xpc_get_type(message)==XPC_TYPE_ERROR) {
      if (message==XPC_ERROR_CONNECTION_INVALID) { host->connection_invalid=1; revoke_host(host); if (!host->active) { dispatch_release(host->queue); free(host); } }
      else revoke_host(host);
      return;
    }
    if (!host->peer.authenticated) {
      if (!brain_xpc_authenticate(&host->peer,message)) { revoke_host(host); return; }
      xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_host(host); return; }
      xpc_dictionary_set_bool(reply,"hello",true); xpc_connection_send_message(connection,reply); xpc_release(reply); return;
    }
    if (!brain_xpc_verify_message(&host->peer,message) || !field(message,"op",XPC_TYPE_STRING)) { revoke_host(host); return; }
    const char *op=xpc_dictionary_get_string(message,"op");
    if (!strcmp(op,"start")) handle_start(host,message,0);
    else if (!strcmp(op,"start_auth")) handle_start(host,message,1);
    else if (!strcmp(op,"metadata")) handle_metadata(host,message);
    else if (!strcmp(op,"recorded")) handle_recorded(host,message);
    else if (!strcmp(op,"inspect")) handle_inspect(host,message);
    else if (!strcmp(op,"signal")) handle_signal(host,message);
    else if (!strcmp(op,"members")) handle_members(host,message);
    else if (!strcmp(op,"reap")) handle_reap(host,message);
    else if (!strcmp(op,"cancel") && host->active && xpc_dictionary_get_count(message)==2
      && field(message,"lease",XPC_TYPE_UUID) && same_uuid(message,"lease",host->lease)) revoke_host(host);
    else revoke_host(host);
  });
  xpc_connection_activate(connection);
}
int main(void) {
  if (!BRAIN_WORKER_UID || geteuid()!=BRAIN_WORKER_UID || geteuid()==0 || !BRAIN_SUPERVISOR_UID) return 78;
#ifndef BRAIN_NATIVE_FIXTURE
  if (BRAIN_WORKER_UID==BRAIN_SUPERVISOR_UID) return 78;
#endif
  xpc_connection_t listener=xpc_connection_create_mach_service(BRAIN_MACH_SERVICE,NULL,XPC_CONNECTION_MACH_SERVICE_LISTENER);
  if (!listener) return 78; brain_xpc_peer policy;
  if (!brain_xpc_configure_service(&policy,listener,BRAIN_SUPERVISOR_UID,BRAIN_SUPERVISOR_HASH)) return 78;
  xpc_connection_set_event_handler(listener,^(xpc_object_t event) { if(xpc_get_type(event)==XPC_TYPE_CONNECTION) on_connection((xpc_connection_t)event); });
  xpc_connection_activate(listener); dispatch_main(); return 0;
}
