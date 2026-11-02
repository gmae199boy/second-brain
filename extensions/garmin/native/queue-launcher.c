#include "queue-launcher.h"
#include "sealed-registry.h"
#include "peer.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef BRAIN_REGISTRY_FIXTURE
#include <stdio.h>
#endif
#define LIMIT (1024U*1024U)
int brain_queue_session_close(brain_queue_session *s) {
  if(!s)return 0;brain_data_peer_close(&s->node);brain_data_peer_close(&s->service);
  if(s->supervisor_bound){close(s->supervisor_fd);s->supervisor_bound=0;}
  if(s->bootstrap_fd>=0)close(s->bootstrap_fd);s->bootstrap_fd=-1;
  if(s->supervisor_config_open){close(s->supervisor_config_fd);s->supervisor_config_open=0;}
  if(s->cleanup_unknown)return 0;
  if(s->child>0) {
    /* 이 host만 자식을 reap한다. 이미 종료·reap됐으면 그룹 신원을 추정하지 않는다. */
    pid_t initial;do {initial=waitpid(s->child,NULL,WNOHANG);} while(initial<0&&errno==EINTR);
    if(initial==s->child){errno=0;if(kill(-s->child,0)<0&&errno==ESRCH){s->child=0;return 1;}s->cleanup_unknown=1;return 0;}
    if(initial!=0){s->cleanup_unknown=1;return 0;}
    if(getpgid(s->child)!=s->child){s->cleanup_unknown=1;return 0;}
    if(kill(-s->child,SIGKILL) && errno!=ESRCH){s->cleanup_unknown=1;return 0;}
    pid_t state=0;for(int i=0;i<40 && state==0;i++){do {state=waitpid(s->child,NULL,WNOHANG);} while(state<0&&errno==EINTR);if(state==0)usleep(50000);}
    if(state!=s->child){s->cleanup_unknown=1;return 0;}
    errno=0;if(kill(-s->child,0)==0||errno!=ESRCH){s->cleanup_unknown=1;return 0;}
    s->child=0;
  }
  return 1;
}
static int open_session(brain_queue_session *s,int reg,int payload,int service_fd,uid_t service_uid,pid_t service_pid,const uint8_t service_hash[20],uid_t owner) {
  if(!s)return 0;*s=(brain_queue_session){.node={.fd=-1},.service={.fd=-1},.bootstrap_fd=-1};
  uint8_t node_hash[20];int sockets[2]={-1,-1},bootstrap[2]={-1,-1},p=-1,b=-1;
#ifdef BRAIN_REGISTRY_FIXTURE
  int verified=brain_queue_registry_node_hash_fixture(reg,payload,owner,node_hash);
#else
  int verified=owner==0 && brain_queue_registry_node_hash(reg,payload,node_hash);
#endif
  if(!verified){if(service_fd>=0)close(service_fd);goto fail;}
  if(!brain_data_peer_open(&s->service,service_fd,service_uid,service_pid,service_hash))goto fail;
  if(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)||socketpair(AF_UNIX,SOCK_STREAM,0,bootstrap))goto fail;
  p=fcntl(sockets[1],F_DUPFD_CLOEXEC,10);b=fcntl(bootstrap[1],F_DUPFD_CLOEXEC,10);if(p<0||b<0)goto fail;
#ifdef BRAIN_REGISTRY_FIXTURE
  if(!brain_spawn_queue_registry_fixture(reg,payload,owner,p,b,&s->child))goto fail;
#else
  if(!brain_spawn_queue_registry(reg,payload,p,b,&s->child))goto fail;
#endif
  close(p);p=-1;close(b);b=-1;close(sockets[1]);sockets[1]=-1;close(bootstrap[1]);bootstrap[1]=-1;
  if(kill(s->child,SIGCONT))goto fail;
  struct pollfd event={.fd=sockets[0],.events=POLLIN};uint8_t hello;
  if(poll(&event,1,5000)!=1||read(sockets[0],&hello,1)!=1||hello!=1)goto fail;
  if(!brain_data_peer_open(&s->node,sockets[0],geteuid(),s->child,node_hash)){sockets[0]=-1;goto fail;}
  sockets[0]=-1;s->bootstrap_fd=bootstrap[0];bootstrap[0]=-1;uint8_t ack=1;int no_signal=1;
  if(setsockopt(s->bootstrap_fd,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof no_signal))goto fail;
  if(write(s->bootstrap_fd,&ack,1)!=1)goto fail;
  return 1;
fail:
  if(p>=0)close(p);if(b>=0)close(b);for(int i=0;i<2;i++){if(sockets[i]>=0)close(sockets[i]);if(bootstrap[i]>=0)close(bootstrap[i]);}
  brain_queue_session_close(s);return 0;
}
int brain_queue_session_open(brain_queue_session *s,int r,int p,int fd,uid_t uid,pid_t pid,const uint8_t hash[20]){return open_session(s,r,p,fd,uid,pid,hash,0);}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_queue_session_open_fixture(brain_queue_session *s,int r,int p,int fd,uid_t uid,pid_t pid,const uint8_t hash[20],uid_t owner){return open_session(s,r,p,fd,uid,pid,hash,owner);}
#endif
static int supervisor_valid(brain_queue_session *s) {
  if(!s->supervisor_bound)return 1;
  if(!brain_verify_peer(s->supervisor_fd,s->supervisor_uid,s->supervisor_pid,s->supervisor_hash))return 0;
  uint8_t unexpected;ssize_t n=recv(s->supervisor_fd,&unexpected,1,MSG_PEEK|MSG_DONTWAIT);
  return n<0&&(errno==EAGAIN||errno==EWOULDBLOCK);
}
int brain_queue_session_relay(brain_queue_session *s) {
  if(!s||s->child<=0||s->relayed)return 0;s->relayed=1;
  if(!supervisor_valid(s)){brain_queue_session_close(s);return 0;}uint8_t *buf=malloc(LIMIT);if(!buf){brain_queue_session_close(s);return 0;}size_t n=0;
  int stage=0;int ok=brain_data_peer_read(&s->node,buf,LIMIT,&n,5000);if(ok){stage=1;ok=brain_data_peer_write(&s->service,buf,n,5000);}
  if(ok){stage=2;ok=brain_data_peer_read(&s->service,buf,LIMIT,&n,5000);}if(ok){stage=3;ok=brain_data_peer_write(&s->node,buf,n,5000);}
  if(ok){stage=4;ok=brain_data_peer_read(&s->node,buf,LIMIT,&n,5000)&&n==3&&!memcmp(buf,"ack",3);}
#ifdef BRAIN_REGISTRY_FIXTURE
  if(!ok)fprintf(stderr,"launcher relay stage=%d\n",stage);
#else
  (void)stage;
#endif
  if(ok)ok=supervisor_valid(s);
  brain_data_peer_close(&s->node);free(buf);if(!ok)brain_queue_session_close(s);return ok;
}
