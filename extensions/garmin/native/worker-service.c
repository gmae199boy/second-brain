/* launchd가 Garmin principal로 실행하는 고정 worker host다. 보호 policy 없이는 시작하지 않는다. */
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/random.h>
#include <signal.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "worker-host.h"
#include "xpc-peer.h"

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
  int active, revoked, unknown, connection_invalid, ledger_index;
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
    if (!brain_worker_signal(&host->worker,SIGTERM)) host->unknown=1;
    /* leader 종료만으로 그룹이 비었다고 가정하지 않는다. D4 inspector가 확인한다. */
    host->unknown=1;
  }
  brain_xpc_close(&host->peer);
}
static int current_identity(host_connection *host) {
  struct proc_bsdinfo info;
  int n=proc_pidinfo(host->worker.pid,PROC_PIDTBSDINFO,0,&info,sizeof info);
  return n==(int)sizeof info && info.pbi_pid==(uint32_t)host->worker.pid && info.pbi_pgid==(uint32_t)host->worker.pid
    && info.pbi_start_tvsec==host->start_sec && info.pbi_start_tvusec==host->start_usec;
}
static void on_child_exit(host_connection *host) {
  int status=0, reaped=brain_worker_reap(&host->worker,&status);
  int group=brain_worker_group_state(&host->worker);
  host->unknown = reaped!=1 || group!=0;
  if (host->peer.authenticated && !host->revoked) {
    xpc_object_t event=xpc_dictionary_create(NULL,NULL,0);
    if (event) {
      xpc_dictionary_set_string(event,"op",host->unknown ? "unknown" : "exit");
      xpc_dictionary_set_int64(event,"pid",host->worker.pid);
      if (!host->unknown) xpc_dictionary_set_int64(event,"wait_status",status);
      xpc_connection_send_message(host->peer.connection,event); xpc_release(event);
    }
  }
  if (!host->unknown) { brain_worker_close(&host->worker); host->active=0; settle_launch(host->ledger_index); }
  if (host->exit_source) { dispatch_source_cancel(host->exit_source); dispatch_release(host->exit_source); host->exit_source=NULL; }
  if (host->connection_invalid && !host->active) { dispatch_release(host->queue); free(host); }
}
static void handle_start(host_connection *host, xpc_object_t message) {
  if (host->active || host->unknown || xpc_dictionary_get_count(message)!=7 || !field(message,"work",XPC_TYPE_UUID)
      || !field(message,"attempt",XPC_TYPE_UUID) || !field(message,"run",XPC_TYPE_UINT64)
      || !field(message,"binding",XPC_TYPE_UINT64) || !field(message,"epoch",XPC_TYPE_UINT64)
      || !field(message,"package",XPC_TYPE_DATA)) { revoke_host(host); return; }
  size_t size=0; const void *package=xpc_dictionary_get_data(message,"package",&size);
  uint64_t run=xpc_dictionary_get_uint64(message,"run"), binding=xpc_dictionary_get_uint64(message,"binding"), epoch=xpc_dictionary_get_uint64(message,"epoch");
  if (!package || size!=32 || memcmp(package,BRAIN_PACKAGE_HASH,32) || !run || !binding || !epoch) { revoke_host(host); return; }
  memcpy(host->work,xpc_dictionary_get_uuid(message,"work"),16); memcpy(host->attempt,xpc_dictionary_get_uuid(message,"attempt"),16);
  host->run=run; host->binding=binding; host->epoch=epoch;
  host->ledger_index=reserve_launch(host->work,host->attempt);
  if (host->ledger_index<0) { revoke_host(host); return; }
  if (getentropy(host->lease,sizeof host->lease) || !brain_spawn_worker(BRAIN_WORKER_HASH,BRAIN_WORKER_UID,&host->worker)) { settle_launch(host->ledger_index); revoke_host(host); return; }
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
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_host(host); return; }
  xpc_dictionary_set_int64(reply,"pid",host->worker.pid); xpc_dictionary_set_uint64(reply,"start_sec",host->start_sec);
  xpc_dictionary_set_uint64(reply,"start_usec",host->start_usec); xpc_dictionary_set_uuid(reply,"lease",host->lease);
  xpc_dictionary_set_fd(reply,"stdout",host->worker.stdout_read); xpc_dictionary_set_fd(reply,"stderr",host->worker.stderr_read);
  xpc_connection_send_message(host->peer.connection,reply); xpc_release(reply);
  close(host->worker.stdout_read); close(host->worker.stderr_read); host->worker.stdout_read=host->worker.stderr_read=-1;
}
static void handle_recorded(host_connection *host, xpc_object_t message) {
  if (!host->active || host->unknown || xpc_dictionary_get_count(message)!=8 || !field(message,"work",XPC_TYPE_UUID)
      || !field(message,"attempt",XPC_TYPE_UUID) || !field(message,"lease",XPC_TYPE_UUID)
      || !field(message,"run",XPC_TYPE_UINT64) || !field(message,"binding",XPC_TYPE_UINT64) || !field(message,"epoch",XPC_TYPE_UINT64)
      || !field(message,"pid",XPC_TYPE_INT64) || !same_uuid(message,"work",host->work) || !same_uuid(message,"attempt",host->attempt)
      || !same_uuid(message,"lease",host->lease) || xpc_dictionary_get_uint64(message,"run")!=host->run
      || xpc_dictionary_get_uint64(message,"binding")!=host->binding || xpc_dictionary_get_uint64(message,"epoch")!=host->epoch
      || xpc_dictionary_get_int64(message,"pid")!=host->worker.pid || !current_identity(host)
      || !brain_worker_recorded(&host->worker,host->worker.pid) || !brain_worker_ack(&host->worker)) { revoke_host(host); return; }
  xpc_object_t reply=xpc_dictionary_create_reply(message); if (!reply) { revoke_host(host); return; }
  xpc_dictionary_set_bool(reply,"accepted",true); xpc_connection_send_message(host->peer.connection,reply); xpc_release(reply);
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
  xpc_object_t reply=xpc_dictionary_create_reply(message);if(!reply){revoke_host(host);return;}
  xpc_dictionary_set_bool(reply,"sent",true);xpc_connection_send_message(host->peer.connection,reply);xpc_release(reply);
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
    if (!strcmp(op,"start")) handle_start(host,message);
    else if (!strcmp(op,"recorded")) handle_recorded(host,message);
    else if (!strcmp(op,"inspect")) handle_inspect(host,message);
    else if (!strcmp(op,"signal")) handle_signal(host,message);
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
