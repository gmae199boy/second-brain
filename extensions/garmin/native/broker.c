#include "broker.h"
#include "peer.h"
#include <sys/socket.h>
#include <sys/random.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static void cancel_locked(brain_auth_broker *broker) {
  brain_auth_revoke(&broker->session);
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
int brain_broker_prompt(brain_auth_broker *broker, const uint8_t prompt[16], int is_mfa) { TRANSITION(brain_auth_prompt(&broker->session,prompt,is_mfa)); }
int brain_broker_response(brain_auth_broker *broker, const uint8_t prompt[16], uint64_t sequence) { TRANSITION(brain_auth_response(&broker->session,prompt,sequence)); }
#undef TRANSITION
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
int brain_broker_deliver(brain_auth_broker *broker, int timeout_ms) {
  (void)timeout_ms;
  /* host의 실제 spawn 상속과 UI FD 연결이 완성되기 전에는 실패 닫힘이다. */
  if(!broker || pthread_mutex_lock(&broker->lock))return 0;
  cancel_locked(broker);pthread_mutex_unlock(&broker->lock);return 0;
}
