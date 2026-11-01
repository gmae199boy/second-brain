#include "submission-ipc.h"
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

typedef struct { pthread_mutex_t lock; int references,waiting; xpc_object_t reply; dispatch_semaphore_t done; } pending;
static void drop(pending *p) {
  pthread_mutex_lock(&p->lock);int last=!--p->references;pthread_mutex_unlock(&p->lock);
  if(last){if(p->reply)xpc_release(p->reply);dispatch_release(p->done);pthread_mutex_destroy(&p->lock);free(p);}
}
static xpc_object_t request(brain_xpc_peer *peer,xpc_object_t message,int timeout_ms,int authenticated) {
  if(!peer || !peer->configured || (authenticated && !peer->authenticated) || !message || timeout_ms<=0 || timeout_ms>300000)return NULL;
  pending *p=calloc(1,sizeof *p);if(!p)return NULL;
  if(pthread_mutex_init(&p->lock,NULL)){free(p);return NULL;}
  p->references=2;p->waiting=1;p->done=dispatch_semaphore_create(0);
  if(!p->done){pthread_mutex_destroy(&p->lock);free(p);return NULL;}
  xpc_connection_send_message_with_reply(peer->connection,message,dispatch_get_global_queue(QOS_CLASS_DEFAULT,0),^(xpc_object_t r){
    pthread_mutex_lock(&p->lock);if(p->waiting && r)p->reply=xpc_retain(r);pthread_mutex_unlock(&p->lock);
    dispatch_semaphore_signal(p->done);drop(p);
  });
  int timed_out=dispatch_semaphore_wait(p->done,dispatch_time(DISPATCH_TIME_NOW,(int64_t)timeout_ms*NSEC_PER_MSEC))!=0;
  pthread_mutex_lock(&p->lock);p->waiting=0;xpc_object_t reply=p->reply;p->reply=NULL;pthread_mutex_unlock(&p->lock);
  if(timed_out || !reply || xpc_get_type(reply)!=XPC_TYPE_DICTIONARY || (authenticated && !brain_xpc_verify_message(peer,reply))) {
    if(reply)xpc_release(reply);reply=NULL;brain_xpc_close(peer);
  }
  drop(p);return reply;
}
xpc_object_t brain_submission_call(brain_xpc_peer *peer,xpc_object_t message,int timeout_ms) {return request(peer,message,timeout_ms,1);}
int brain_submission_connect(brain_xpc_peer *peer,const char *service,uid_t uid,const uint8_t hash[20],int timeout_ms) {
  if(!peer || !service || !uid || !hash)return 0;xpc_connection_t c=xpc_connection_create_mach_service(service,NULL,0);
  if(!c || !brain_xpc_configure_service(peer,c,uid,hash)){if(c)xpc_release(c);return 0;}
  xpc_connection_set_event_handler(c,^(xpc_object_t e){(void)e;});xpc_connection_activate(c);
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m){brain_xpc_close(peer);return 0;}xpc_dictionary_set_bool(m,"hello",true);
  xpc_object_t r=request(peer,m,timeout_ms,0);xpc_release(m);int ok=r && brain_xpc_authenticate(peer,r);
  if(r)xpc_release(r);if(!ok)brain_xpc_close(peer);return ok;
}
static int accepted(brain_xpc_peer *peer,xpc_object_t message,int timeout_ms) {
  xpc_object_t r=brain_submission_call(peer,message,timeout_ms);int ok=r && xpc_dictionary_get_count(r)==1 && xpc_dictionary_get_bool(r,"accepted");
  if(r)xpc_release(r);if(!ok && peer)brain_xpc_close(peer);return ok;
}
int brain_submission_prompt(brain_xpc_peer *peer,const uint8_t prompt[16],int is_mfa,int timeout_ms) {
  if(!prompt || (is_mfa!=0 && is_mfa!=1))return 0;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","prompt");xpc_dictionary_set_uuid(m,"prompt",prompt);xpc_dictionary_set_bool(m,"mfa",is_mfa);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
int brain_submission_worker_attach(brain_xpc_peer *peer,uint8_t session[16],int timeout_ms) {
  if(!session)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;xpc_dictionary_set_string(m,"op","attach");
  xpc_object_t r=brain_submission_call(peer,m,timeout_ms);xpc_release(m);xpc_object_t s=r?xpc_dictionary_get_value(r,"session"):NULL;
  int ok=r && xpc_dictionary_get_count(r)==2 && xpc_dictionary_get_bool(r,"accepted") && s && xpc_get_type(s)==XPC_TYPE_UUID;
  if(ok)memcpy(session,xpc_uuid_get_bytes(s),16);if(r)xpc_release(r);if(!ok && peer)brain_xpc_close(peer);return ok;
}
int brain_submission_ready(brain_xpc_peer *peer,int timeout_ms) {
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return -1;xpc_dictionary_set_string(m,"op","ready");
  xpc_object_t r=brain_submission_call(peer,m,timeout_ms);xpc_release(m);xpc_object_t v=r?xpc_dictionary_get_value(r,"ready"):NULL;
  int result=r && xpc_dictionary_get_count(r)==1 && v && xpc_get_type(v)==XPC_TYPE_BOOL?(xpc_bool_get_value(v)?1:0):-1;
  if(r)xpc_release(r);if(result<0 && peer)brain_xpc_close(peer);return result;
}
int brain_submission_challenge(brain_xpc_peer *peer,uint64_t generation,brain_presence_challenge *challenge,int timeout_ms) {
  if(!generation || !challenge)return 0;memset(challenge,0,sizeof *challenge);challenge->consumed=1;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","challenge");xpc_dictionary_set_uint64(m,"response_generation",generation);
  xpc_object_t r=brain_submission_call(peer,m,timeout_ms);xpc_release(m);size_t n=0;const void *bytes=r?xpc_dictionary_get_data(r,"challenge",&n):NULL;
  xpc_object_t d=r?xpc_dictionary_get_value(r,"deadline"):NULL;
  int ok=r && xpc_dictionary_get_count(r)==2 && bytes && n>=73 && n<=sizeof challenge->message && d && xpc_get_type(d)==XPC_TYPE_INT64 && xpc_int64_get_value(d)>0;
  if(ok){memcpy(challenge->message,bytes,n);challenge->length=n;challenge->deadline_ms=xpc_int64_get_value(d);challenge->consumed=0;}
  if(r)xpc_release(r);if(!ok && peer)brain_xpc_close(peer);return ok;
}
int brain_submission_assertion(brain_xpc_peer *peer,const uint8_t digest[32],int timeout_ms) {
  if(!digest)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","assertion");xpc_dictionary_set_data(m,"digest",digest,32);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
static int submit_operation(brain_xpc_peer *peer,const char *op,const uint8_t prompt[16],uint64_t generation,int timeout_ms) {
  if(!peer || !prompt || !generation)return 0;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op",op);xpc_dictionary_set_uuid(m,"prompt",prompt);xpc_dictionary_set_uint64(m,"response_generation",generation);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
int brain_submission_send_ready(brain_xpc_peer *peer,const uint8_t prompt[16],uint64_t generation,int timeout_ms){return submit_operation(peer,"send_ready",prompt,generation,timeout_ms);}
int brain_submission_verify(void *context,const uint8_t prompt[16],uint64_t generation) {brain_submission_control *c=context;return c && submit_operation(c->peer,"consume",prompt,generation,c->timeout_ms);}
int brain_submission_confirm(void *context,const uint8_t prompt[16],uint64_t generation) {brain_submission_control *c=context;return c && submit_operation(c->peer,"confirm",prompt,generation,c->timeout_ms);}
int brain_submission_receive(brain_submission_control *control,brain_auth_channel *channel,const uint8_t prompt[16],uint64_t generation,uint8_t *payload,size_t capacity,size_t *length,int timeout_ms) {
  if(!control || !control->peer || !control->peer->authenticated){if(channel)brain_channel_close(channel);if(length)*length=0;return 0;}
  int ok=brain_channel_receive_submission(channel,prompt,generation,brain_submission_verify,brain_submission_confirm,control,payload,capacity,length,timeout_ms);
  if(!ok)brain_xpc_close(control->peer);return ok;
}
int brain_submission_prepare(brain_xpc_peer *peer,int timeout_ms) {
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return -1;xpc_dictionary_set_string(m,"op","prepare_channel");
  xpc_object_t r=brain_submission_call(peer,m,timeout_ms);xpc_release(m);int fd=-1;struct stat info;
  xpc_object_t v=r?xpc_dictionary_get_value(r,"worker_fd"):NULL;
  if(r && xpc_dictionary_get_count(r)==1 && v && xpc_get_type(v)==XPC_TYPE_FD)fd=xpc_dictionary_dup_fd(r,"worker_fd");
  if(r)xpc_release(r);
  if(fd<0 || fstat(fd,&info) || !S_ISSOCK(info.st_mode) || fcntl(fd,F_SETFD,FD_CLOEXEC)<0){if(fd>=0)close(fd);if(peer)brain_xpc_close(peer);return -1;}return fd;
}
int brain_submission_register(brain_xpc_peer *peer,const brain_auth_binding *b,const char *target,int timeout_ms) {
  if(!b || b->worker_pid<=0 || !target || !*target || strlen(target)>1024)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","register");xpc_dictionary_set_uuid(m,"work",b->work);xpc_dictionary_set_uuid(m,"attempt",b->attempt);
  xpc_dictionary_set_string(m,"target",target);
  xpc_dictionary_set_uuid(m,"session",b->session);xpc_dictionary_set_uuid(m,"lease",b->launch_lease);xpc_dictionary_set_data(m,"package",b->package,32);
  xpc_dictionary_set_uint64(m,"run",b->run_generation);xpc_dictionary_set_uint64(m,"binding",b->binding_generation);
  xpc_dictionary_set_uint64(m,"package_generation",b->package_generation);xpc_dictionary_set_uint64(m,"epoch",b->connection_epoch);xpc_dictionary_set_int64(m,"pid",b->worker_pid);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
int brain_submission_gui(brain_xpc_peer *peer,const brain_presence_scope *scope,int timeout_ms) {
  if(!scope || !scope->gui_pid || scope->gui_pid>INT32_MAX)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","gui_instance");xpc_dictionary_set_int64(m,"pid",(int64_t)scope->gui_pid);
  xpc_dictionary_set_uuid(m,"gui_session",scope->gui_session);xpc_dictionary_set_uuid(m,"instance",scope->gui_instance);xpc_dictionary_set_uuid(m,"boot",scope->gui_boot);
  xpc_dictionary_set_uint64(m,"policy",scope->policy_generation);xpc_dictionary_set_uint64(m,"asid",scope->gui_asid);
  xpc_dictionary_set_uint64(m,"start_sec",scope->gui_start_sec);xpc_dictionary_set_uint64(m,"start_usec",scope->gui_start_usec);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
int brain_submission_recorded(brain_xpc_peer *peer,int timeout_ms) {
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;xpc_dictionary_set_string(m,"op","recorded");
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
int brain_submission_revoke(brain_xpc_peer *peer,const brain_auth_binding *b,int timeout_ms) {
  if(!b)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","revoke_input");xpc_dictionary_set_uuid(m,"work",b->work);xpc_dictionary_set_uuid(m,"attempt",b->attempt);
  xpc_dictionary_set_uuid(m,"lease",b->launch_lease);xpc_dictionary_set_uint64(m,"epoch",b->connection_epoch);
  int ok=accepted(peer,m,timeout_ms);xpc_release(m);return ok;
}
