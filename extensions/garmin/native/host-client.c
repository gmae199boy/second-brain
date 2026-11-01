#include "host-client.h"
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <string.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <pthread.h>
#include <unistd.h>
#include <signal.h>

typedef struct { atomic_int refs; dispatch_semaphore_t done; xpc_object_t reply; } bounded_request;
static void request_release(bounded_request *r) {
  if(atomic_fetch_sub(&r->refs,1)==1){if(r->reply)xpc_release(r->reply);dispatch_release(r->done);free(r);}
}
/* [ASSUMPTION] 서비스 응답 상한 15초는 실제 OS fixture에서 재평가한다. */
static xpc_object_t bounded_call(xpc_connection_t c,xpc_object_t message) {
  bounded_request *r=calloc(1,sizeof *r); if(!r)return NULL;
  r->done=dispatch_semaphore_create(0);if(!r->done){free(r);return NULL;}atomic_init(&r->refs,2);
  xpc_connection_send_message_with_reply(c,message,dispatch_get_global_queue(QOS_CLASS_DEFAULT,0),^(xpc_object_t reply){
    if(reply)r->reply=xpc_retain(reply);dispatch_semaphore_signal(r->done);request_release(r);
  });
  xpc_object_t result=NULL;
  if(!dispatch_semaphore_wait(r->done,dispatch_time(DISPATCH_TIME_NOW,15*NSEC_PER_SEC)) && r->reply)result=xpc_retain(r->reply);
  request_release(r); return result;
}
static int field(xpc_object_t m,const char *key,xpc_type_t type) { xpc_object_t v=xpc_dictionary_get_value(m,key); return v && xpc_get_type(v)==type; }
struct brain_host_observer { atomic_int refs; pthread_mutex_t lock; brain_xpc_peer peer; pid_t pid; int state,status; };
static void observer_release(brain_host_observer *o) { if(atomic_fetch_sub(&o->refs,1)==1){pthread_mutex_destroy(&o->lock);free(o);} }
static void observe_event(brain_host_observer *o,xpc_object_t event) {
  pthread_mutex_lock(&o->lock);
  if(xpc_get_type(event)==XPC_TYPE_ERROR) { if(o->state!=1)o->state=-1; }
  else if(o->state==0) {
    if(!o->peer.authenticated || !brain_xpc_verify_message(&o->peer,event) || !field(event,"op",XPC_TYPE_STRING) || !field(event,"pid",XPC_TYPE_INT64) || !o->pid || xpc_dictionary_get_int64(event,"pid")!=o->pid) o->state=-1;
    else {
      const char *op=xpc_dictionary_get_string(event,"op");
      if(!strcmp(op,"exit") && xpc_dictionary_get_count(event)==3 && field(event,"wait_status",XPC_TYPE_INT64)) { o->status=(int)xpc_dictionary_get_int64(event,"wait_status");o->state=1; }
      else o->state=-1;
    }
  }
  pthread_mutex_unlock(&o->lock);
  if(event==XPC_ERROR_CONNECTION_INVALID)observer_release(o);
}
static int descriptor(xpc_object_t m,const char *key) {
  if(!field(m,key,XPC_TYPE_FD))return -1; int fd=xpc_dictionary_dup_fd(m,key);
  if(fd<0 || fcntl(fd,F_SETFD,FD_CLOEXEC)<0){if(fd>=0)close(fd);return -1;} return fd;
}
int brain_host_connect(brain_host_client *c,const char *name,uid_t uid,const uint8_t hash[20]) {
  if(!c || !name || !uid || !hash)return 0; memset(c,0,sizeof *c); c->stdout_fd=c->stderr_fd=-1;
  xpc_connection_t connection=xpc_connection_create_mach_service(name,NULL,0);
  if(!connection || !brain_xpc_configure_service(&c->service,connection,uid,hash)){if(connection)xpc_release(connection);return 0;}
  c->connection=connection;
  c->observer=calloc(1,sizeof *c->observer);
  if(!c->observer || pthread_mutex_init(&c->observer->lock,NULL)){free(c->observer);c->observer=NULL;brain_host_close(c);return 0;}
  brain_host_observer *observer=c->observer; atomic_init(&observer->refs,2);
  xpc_connection_set_event_handler(connection,^(xpc_object_t event){observe_event(observer,event);}); xpc_connection_activate(connection);
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); if(!m){brain_host_close(c);return 0;} xpc_dictionary_set_bool(m,"hello",true);
  xpc_object_t r=bounded_call(connection,m); xpc_release(m);
  int ok=r && brain_xpc_authenticate(&c->service,r); if(r)xpc_release(r);
  if(ok){pthread_mutex_lock(&observer->lock);observer->peer=c->service;pthread_mutex_unlock(&observer->lock);}else brain_host_close(c); return ok;
}
static int start(brain_host_client *c,const uuid_t work,const uuid_t attempt,uint64_t run,uint64_t binding,uint64_t epoch,const uint8_t package[32],int channel_fd) {
  if(!c || !c->service.authenticated || c->started || !work || !attempt || !run || !binding || !epoch || !package)return 0;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); if(!m)return 0;
  xpc_dictionary_set_string(m,"op",channel_fd>=0?"start_auth":"start");xpc_dictionary_set_uuid(m,"work",work);xpc_dictionary_set_uuid(m,"attempt",attempt);
  if(channel_fd>=0)xpc_dictionary_set_fd(m,"channel",channel_fd);
  xpc_dictionary_set_uint64(m,"run",run);xpc_dictionary_set_uint64(m,"binding",binding);xpc_dictionary_set_uint64(m,"epoch",epoch);xpc_dictionary_set_data(m,"package",package,32);
  xpc_object_t r=bounded_call(c->service.connection,m);xpc_release(m);
  int ok=r && brain_xpc_verify_message(&c->service,r) && xpc_dictionary_get_count(r)==6 && field(r,"pid",XPC_TYPE_INT64)
    && field(r,"start_sec",XPC_TYPE_UINT64) && field(r,"start_usec",XPC_TYPE_UINT64) && field(r,"lease",XPC_TYPE_UUID);
  int64_t pid=ok?xpc_dictionary_get_int64(r,"pid"):0;
  if(ok && pid>0 && pid<=INT32_MAX) {
    c->stdout_fd=descriptor(r,"stdout"); c->stderr_fd=descriptor(r,"stderr");
    if(c->stdout_fd>=0 && c->stderr_fd>=0) {
      c->pid=(pid_t)pid;c->start_sec=xpc_dictionary_get_uint64(r,"start_sec");c->start_usec=xpc_dictionary_get_uint64(r,"start_usec");
      memcpy(c->work,work,16);memcpy(c->attempt,attempt,16);memcpy(c->lease,xpc_dictionary_get_uuid(r,"lease"),16);
      c->run=run;c->binding=binding;c->epoch=epoch;c->started=1;
      pthread_mutex_lock(&c->observer->lock);c->observer->pid=c->pid;pthread_mutex_unlock(&c->observer->lock);
    }
  }
  if(r)xpc_release(r); if(!c->started || brain_host_observe(c,NULL)!=0){brain_host_close(c);return 0;} return 1;
}
int brain_host_start(brain_host_client *c,const uuid_t work,const uuid_t attempt,uint64_t run,uint64_t binding,uint64_t epoch,const uint8_t package[32]) {return start(c,work,attempt,run,binding,epoch,package,-1);}
int brain_host_start_auth(brain_host_client *c,const uuid_t work,const uuid_t attempt,uint64_t run,uint64_t binding,uint64_t epoch,const uint8_t package[32],int channel_fd) {return channel_fd>=0 && start(c,work,attempt,run,binding,epoch,package,channel_fd);}
int brain_host_recorded(brain_host_client *c) {
  if(!c || !c->service.authenticated || !c->started || c->recorded)return 0;
  if(brain_host_observe(c,NULL)!=0){brain_host_close(c);return 0;}
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); if(!m){brain_host_close(c);return 0;}
  xpc_dictionary_set_string(m,"op","recorded");xpc_dictionary_set_uuid(m,"work",c->work);xpc_dictionary_set_uuid(m,"attempt",c->attempt);xpc_dictionary_set_uuid(m,"lease",c->lease);
  xpc_dictionary_set_uint64(m,"run",c->run);xpc_dictionary_set_uint64(m,"binding",c->binding);xpc_dictionary_set_uint64(m,"epoch",c->epoch);xpc_dictionary_set_int64(m,"pid",c->pid);
  xpc_object_t r=bounded_call(c->service.connection,m);xpc_release(m);
  int ok=r && brain_xpc_verify_message(&c->service,r) && xpc_dictionary_get_count(r)==1 && field(r,"accepted",XPC_TYPE_BOOL) && xpc_dictionary_get_bool(r,"accepted");
  if(r)xpc_release(r);if(!ok){brain_host_close(c);return 0;}c->recorded=1;return 1;
}
int brain_host_inspect(brain_host_client *c,int *group) {
  if(!c || !group || !c->started || !c->service.authenticated || brain_host_observe(c,NULL)!=0)return -1;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return -1;
  xpc_dictionary_set_string(m,"op","inspect");xpc_dictionary_set_uuid(m,"lease",c->lease);xpc_dictionary_set_int64(m,"pid",c->pid);
  xpc_object_t r=bounded_call(c->service.connection,m);xpc_release(m);
  int ok=r && brain_xpc_verify_message(&c->service,r) && xpc_dictionary_get_count(r)==4 && field(r,"pid",XPC_TYPE_INT64)
    && field(r,"start_sec",XPC_TYPE_UINT64) && field(r,"start_usec",XPC_TYPE_UINT64) && field(r,"group",XPC_TYPE_INT64)
    && xpc_dictionary_get_int64(r,"pid")==c->pid && xpc_dictionary_get_uint64(r,"start_sec")==c->start_sec && xpc_dictionary_get_uint64(r,"start_usec")==c->start_usec;
  int64_t value=ok?xpc_dictionary_get_int64(r,"group"):-1;if(r)xpc_release(r);
  if(!ok || (value!=0 && value!=1)){brain_host_close(c);return -1;}*group=(int)value;return 1;
}
int brain_host_signal(brain_host_client *c,int signal_number) {
  if(!c || !c->started || !c->service.authenticated || (signal_number!=SIGTERM && signal_number!=SIGKILL) || brain_host_observe(c,NULL)!=0)return 0;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","signal");xpc_dictionary_set_uuid(m,"lease",c->lease);xpc_dictionary_set_int64(m,"pid",c->pid);xpc_dictionary_set_int64(m,"signal",signal_number);
  xpc_object_t r=bounded_call(c->service.connection,m);xpc_release(m);
  int ok=r && brain_xpc_verify_message(&c->service,r) && xpc_dictionary_get_count(r)==1 && field(r,"sent",XPC_TYPE_BOOL) && xpc_dictionary_get_bool(r,"sent");
  if(r)xpc_release(r);if(!ok)brain_host_close(c);return ok;
}
int brain_host_observe(brain_host_client *c,int *wait_status) {
  if(!c || !c->observer)return -1;brain_host_observer *o=c->observer;pthread_mutex_lock(&o->lock);
  int result=o->state;if(result==1 && wait_status)*wait_status=o->status;pthread_mutex_unlock(&o->lock);return result;
}
void brain_host_cancel(brain_host_client *c) {
  if(!c)return; if(c->service.authenticated && c->started) { xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(m){xpc_dictionary_set_string(m,"op","cancel");xpc_dictionary_set_uuid(m,"lease",c->lease);xpc_connection_send_message(c->service.connection,m);xpc_release(m);} }
  brain_host_close(c);
}
void brain_host_close(brain_host_client *c) {
  if(!c)return; xpc_connection_t connection=c->connection;c->connection=NULL;brain_xpc_close(&c->service);if(connection){xpc_connection_cancel(connection);xpc_release(connection);}
  if(c->observer){observer_release(c->observer);c->observer=NULL;}
  if(c->stdout_fd>=0)close(c->stdout_fd);if(c->stderr_fd>=0)close(c->stderr_fd);c->stdout_fd=c->stderr_fd=-1;c->started=0;
}
