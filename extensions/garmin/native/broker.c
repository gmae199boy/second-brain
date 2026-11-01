#include "broker.h"
#include "peer.h"
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/random.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <CommonCrypto/CommonDigest.h>

static void cancel_locked(brain_auth_broker *broker) {
  brain_auth_revoke(&broker->session);
  broker->challenge.consumed=1; broker->capability_ready=broker->awaiting_confirmation=broker->send_issued=0; memset(broker->capability,0,sizeof broker->capability);memset(broker->confirmation_prompt,0,16);broker->confirmation_generation=0;
  /* 이미 전달된 복제 FD는 이 close만으로 회수되지 않는다. child/group 종료 증거가 필요하다. */
  broker->needs_reap = 1;
  if (broker->ui) brain_xpc_close(broker->ui);
  if (broker->worker) brain_xpc_close(broker->worker);
}
int brain_broker_init(brain_auth_broker *broker, const brain_auth_binding *binding, brain_xpc_peer *ui, brain_xpc_peer *worker, int ttl_ms) {
  if (!broker || !ui || !worker) return 0;
  memset(broker,0,sizeof *broker); if (pthread_mutex_init(&broker->lock,NULL)) return 0;
  broker->ui=ui; broker->worker=worker;
  if (!brain_auth_init(&broker->session,binding,ttl_ms)) { pthread_mutex_destroy(&broker->lock); return 0; }
  return 1;
}
#define TRANSITION(expr) do { if (!broker || pthread_mutex_lock(&broker->lock)) return 0; int ok=(expr); if (!ok) cancel_locked(broker); pthread_mutex_unlock(&broker->lock); return ok; } while (0)
int brain_broker_worker(brain_auth_broker *broker) { TRANSITION(brain_auth_worker(&broker->session,broker->worker)); }
int brain_broker_recorded(brain_auth_broker *broker) { TRANSITION(brain_auth_recorded(&broker->session)); }
int brain_broker_attach(brain_auth_broker *broker, const brain_auth_binding *selection) { TRANSITION(brain_auth_attach(&broker->session,broker->ui,selection)); }
int brain_broker_approve(brain_auth_broker *broker, int trusted_presence) { TRANSITION(brain_auth_approve(&broker->session,trusted_presence)); }
int brain_broker_set_guard(brain_auth_broker *broker,int (*guard)(void *),void *context) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;int ok=guard && !broker->guard && !broker->session.prompt_count && brain_auth_is_active(&broker->session);
  if(ok){broker->guard=guard;broker->guard_context=context;}else cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
static int guarded(brain_auth_broker *broker) {return broker->guard && broker->guard(broker->guard_context)==1;}
static int challenge_alive(brain_auth_broker *broker) {struct timespec now;return !clock_gettime(CLOCK_MONOTONIC,&now) && (int64_t)now.tv_sec*1000+now.tv_nsec/1000000<broker->challenge.deadline_ms;}
int brain_broker_prompt(brain_auth_broker *broker, const uint8_t prompt[16], int is_mfa) { TRANSITION(!broker->awaiting_confirmation && guarded(broker) && brain_auth_prompt(&broker->session,prompt,is_mfa)); }
int brain_broker_response(brain_auth_broker *broker, const uint8_t prompt[16], uint64_t sequence) { TRANSITION(guarded(broker) && brain_auth_response(&broker->session,prompt,sequence)); }
#undef TRANSITION
int brain_broker_challenge(brain_auth_broker *broker, const brain_presence_scope *scope, int ttl_ms, brain_presence_challenge *out) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;
  int ok=0;
  brain_auth_session *s=&broker->session;
  if(out && scope && guarded(broker) && broker->ui && broker->ui->authenticated && broker->ui->pid>0 && (uint64_t)broker->ui->pid==scope->gui_pid
    && broker->worker && broker->worker->authenticated
    && brain_auth_is_active(s) && s->attached && s->prompt_open && !s->approved && !broker->capability_ready
    && (!broker->challenge.length || broker->challenge.consumed) && scope->response_generation==s->sequence+1
    && brain_presence_issue(&broker->challenge,&s->binding,scope,s->mfa_count ? 2 : 1,s->prompt,ttl_ms)) {
    broker->scope=*scope; *out=broker->challenge; ok=1;
  }
  if(!ok)cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
int brain_broker_callback(brain_auth_broker *broker, const uint8_t digest[32], uint8_t capability[32]) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0; int ok=0;
  uint8_t expected[32]; brain_presence_challenge *c=&broker->challenge; struct timespec now;
  if(digest && capability && guarded(broker) && broker->ui && broker->ui->authenticated && broker->ui->pid>0 && (uint64_t)broker->ui->pid==broker->scope.gui_pid && broker->worker && broker->worker->authenticated
     && c->length && !c->consumed && brain_auth_is_active(&broker->session)
     && !clock_gettime(CLOCK_MONOTONIC,&now) && (int64_t)now.tv_sec*1000+now.tv_nsec/1000000<c->deadline_ms) {
    CC_SHA256(c->message,(CC_LONG)c->length,expected); unsigned diff=0;for(size_t i=0;i<32;i++)diff|=expected[i]^digest[i];
    c->consumed=1;
    if(!diff && !getentropy(broker->capability,32) && brain_auth_approve_callback(&broker->session)) {
      memcpy(capability,broker->capability,32);broker->capability_ready=1;ok=1;
    }
    memset(expected,0,sizeof expected);
  }
  if(!ok)cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
int brain_broker_consume(brain_auth_broker *broker, const brain_presence_scope *scope, const uint8_t prompt[16], const uint8_t capability[32]) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;int ok=0;
  unsigned diff=0;if(capability)for(size_t i=0;i<32;i++)diff|=capability[i]^broker->capability[i];
  struct timespec now;
  if(scope && prompt && capability && !diff && guarded(broker) && broker->ui && broker->ui->authenticated && broker->ui->pid>0 && (uint64_t)broker->ui->pid==broker->scope.gui_pid && broker->worker && broker->worker->authenticated
    && broker->capability_ready && brain_auth_is_active(&broker->session)
    && !clock_gettime(CLOCK_MONOTONIC,&now) && (int64_t)now.tv_sec*1000+now.tv_nsec/1000000<broker->challenge.deadline_ms
    && !memcmp(scope->gui_session,broker->scope.gui_session,16) && !memcmp(scope->gui_instance,broker->scope.gui_instance,16)
    && !memcmp(scope->gui_boot,broker->scope.gui_boot,16) && scope->gui_pid==broker->scope.gui_pid && scope->gui_asid==broker->scope.gui_asid
    && scope->gui_start_sec==broker->scope.gui_start_sec && scope->gui_start_usec==broker->scope.gui_start_usec
    && scope->policy_generation==broker->scope.policy_generation && scope->response_generation==broker->scope.response_generation
    && !memcmp(prompt,broker->session.prompt,16)) {
    broker->capability_ready=0;memset(broker->capability,0,32);
    ok=brain_auth_response(&broker->session,prompt,scope->response_generation);
    if(ok){broker->awaiting_confirmation=1;memcpy(broker->confirmation_prompt,prompt,16);broker->confirmation_generation=scope->response_generation;}
  }
  if(!ok)cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
int brain_broker_send_ready(brain_auth_broker *broker,const uint8_t prompt[16],uint64_t generation) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;
  int ok=prompt && generation && !broker->send_issued && guarded(broker) && brain_auth_is_active(&broker->session) && challenge_alive(broker)
    && broker->ui && broker->ui->authenticated && broker->worker && broker->worker->authenticated
    && ((broker->capability_ready && broker->scope.response_generation==generation && !memcmp(broker->session.prompt,prompt,16))
      || (broker->awaiting_confirmation && broker->confirmation_generation==generation && !memcmp(broker->confirmation_prompt,prompt,16)));
  if(ok)broker->send_issued=1;else cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
int brain_broker_confirm(brain_auth_broker *broker,const uint8_t prompt[16],uint64_t generation) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;
  int ok=prompt && generation && broker->awaiting_confirmation && broker->send_issued && broker->confirmation_generation==generation
    && !memcmp(broker->confirmation_prompt,prompt,16) && guarded(broker) && brain_auth_is_active(&broker->session) && challenge_alive(broker)
    && broker->ui && broker->ui->authenticated && broker->worker && broker->worker->authenticated;
  if(ok){broker->awaiting_confirmation=broker->send_issued=0;broker->confirmation_generation=0;memset(broker->confirmation_prompt,0,16);}else cancel_locked(broker);
  pthread_mutex_unlock(&broker->lock);return ok;
}
void brain_broker_cancel(brain_auth_broker *broker) {
  if (!broker || pthread_mutex_lock(&broker->lock)) return;
  cancel_locked(broker); pthread_mutex_unlock(&broker->lock);
}
void brain_broker_destroy(brain_auth_broker *broker) {
  if (!broker) return;
  brain_broker_cancel(broker); pthread_mutex_destroy(&broker->lock);
}
int brain_broker_prepare_channel(int *worker_fd, int *ui_fd, int timeout_ms) {
  if(!worker_fd || !ui_fd || worker_fd==ui_fd)return 0;
  *worker_fd=*ui_fd=-1; int fds[2]={-1,-1}; uint8_t key[32]={0}; int ok=0;
  if(socketpair(AF_UNIX,SOCK_STREAM,0,fds) || fcntl(fds[0],F_SETFD,FD_CLOEXEC) || fcntl(fds[1],F_SETFD,FD_CLOEXEC) || getentropy(key,sizeof key))goto done;
  for(int i=0;i<2;i++)if(!brain_write_frame(fds[i],key,sizeof key,timeout_ms))goto done;
  *worker_fd=fds[0];*ui_fd=fds[1];fds[0]=fds[1]=-1;ok=1;
done:
  for(volatile size_t i=0;i<sizeof key;i++)((volatile uint8_t *)key)[i]=0;
  if(fds[0]>=0)close(fds[0]);if(fds[1]>=0)close(fds[1]);return ok;
}
int brain_broker_deliver(brain_auth_broker *broker, int ui_fd) {
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;
  struct stat info;int ok=ui_fd>=0 && !fstat(ui_fd,&info) && S_ISSOCK(info.st_mode) && guarded(broker) && brain_auth_is_active(&broker->session)
    && broker->session.recorded && broker->session.attached && broker->worker && broker->worker->authenticated
    && broker->ui && broker->ui->authenticated && !broker->delivered && brain_xpc_send_fd(broker->ui,ui_fd);
  if(ok)broker->delivered=1;else cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return ok;
}
