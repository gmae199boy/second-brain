/* 고정 보호 supervisor의 자식으로만 실행하는 queue host. 기본 빌드는 닫힌다. */
#include "queue-launcher.h"
#include "peer.h"
#include "supervisor-authority.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#ifndef BRAIN_QUEUE_SUPERVISOR_UID
#define BRAIN_QUEUE_SUPERVISOR_UID 0
#endif
#ifndef BRAIN_QUEUE_SUPERVISOR_HASH
#define BRAIN_QUEUE_SUPERVISOR_HASH ""
#endif
#ifndef BRAIN_QUEUE_REGISTRY_DIR
#define BRAIN_QUEUE_REGISTRY_DIR ""
#endif
#ifndef BRAIN_QUEUE_PAYLOAD_DIR
#define BRAIN_QUEUE_PAYLOAD_DIR ""
#endif
#ifdef BRAIN_REGISTRY_FIXTURE
void brain_registry_fixture_before_spawn(void) {}
#endif
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int pin(uint8_t hash[20]){const char *s=BRAIN_QUEUE_SUPERVISOR_HASH;if(BRAIN_QUEUE_SUPERVISOR_UID==0||strlen(s)!=40)return 0;for(int i=0;i<20;i++){int a=digit(s[i*2]),b=digit(s[i*2+1]);if(a<0||b<0)return 0;hash[i]=(uint8_t)((a<<4)|b);}return 1;}
static int current_parent(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]) {
#if defined(BRAIN_REGISTRY_FIXTURE) && defined(BRAIN_FIXTURE_SUPERVISOR_AUTHORITY)
  return brain_supervisor_authority_fixture_fd(fd,uid,pid,hash);
#elif defined(BRAIN_REGISTRY_FIXTURE)
  return brain_verify_peer(fd,uid,pid,hash);
#else
  return brain_supervisor_authority(fd,uid,pid,hash);
#endif
}
int main(void) {
  uint8_t hash[20],hello=0;uid_t uid=(uid_t)BRAIN_QUEUE_SUPERVISOR_UID;pid_t parent=getppid();
  if(!pin(hash)||!current_parent(3,uid,parent,hash)||!brain_verify_peer(4,uid,parent,hash))return 2;
  struct pollfd event={.fd=4,.events=POLLIN};if(poll(&event,1,5000)!=1||read(4,&hello,1)!=1||hello!=1||!brain_verify_peer(4,uid,parent,hash))return 3;
  int reg=open(BRAIN_QUEUE_REGISTRY_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),payload=open(BRAIN_QUEUE_PAYLOAD_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  brain_queue_session s={.node={.fd=-1},.service={.fd=-1},.bootstrap_fd=-1};int opened=0,ok=0,closed=0;
  if(reg>=0&&payload>=0) {
#ifdef BRAIN_REGISTRY_FIXTURE
    opened=brain_queue_session_open_fixture(&s,reg,payload,4,uid,parent,hash,geteuid());
#else
    opened=brain_queue_session_open(&s,reg,payload,4,uid,parent,hash);
#endif
    if(opened) {
      s.supervisor_fd=dup(3);if(s.supervisor_fd>=0){s.supervisor_bound=1;s.supervisor_uid=uid;s.supervisor_pid=parent;memcpy(s.supervisor_hash,hash,20);ok=brain_queue_session_relay(&s);}
    }
  } else close(4);
  if(reg>=0)close(reg);if(payload>=0)close(payload);
  closed=brain_queue_session_close(&s);
  if(!current_parent(3,uid,parent,hash))return 4;
  uint8_t result=closed?'C':'U';int no_signal=1;setsockopt(3,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof no_signal);
  if(write(3,&result,1)!=1)return 5;
  return ok&&closed?0:6;
}
