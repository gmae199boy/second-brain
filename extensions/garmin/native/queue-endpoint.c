/* 고정된 queue-only endpoint. 보호 supervisor가 소유한 자식에서만 동작한다. */
#include "data-peer.h"
#include "peer.h"
#include "queue-policy.h"
#include "sealed-registry.h"
#include "supervisor-authority.h"
#include <bsm/libbsm.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef BRAIN_QUEUE_SUPERVISOR_UID
#define BRAIN_QUEUE_SUPERVISOR_UID 0
#endif
#ifndef BRAIN_QUEUE_SUPERVISOR_HASH
#define BRAIN_QUEUE_SUPERVISOR_HASH ""
#endif
#ifndef BRAIN_QUEUE_POLICY_DIR
#define BRAIN_QUEUE_POLICY_DIR ""
#endif
#ifndef BRAIN_QUEUE_SOCKET_DIR
#define BRAIN_QUEUE_SOCKET_DIR ""
#endif
#define LIMIT (1024U*1024U)
#ifdef BRAIN_REGISTRY_FIXTURE
void brain_registry_fixture_before_spawn(void) {}
#endif
static volatile sig_atomic_t stopped=0;
static void stop(int sig){(void)sig;stopped=1;}
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int pin(uint8_t h[20]){const char *s=BRAIN_QUEUE_SUPERVISOR_HASH;if(!BRAIN_QUEUE_SUPERVISOR_UID||strlen(s)!=40)return 0;for(int i=0;i<20;i++){int a=digit(s[i*2]),b=digit(s[i*2+1]);if(a<0||b<0)return 0;h[i]=(uint8_t)((a<<4)|b);}return 1;}
static int one(int fd,uint8_t *b,int out){ssize_t n;do{n=out?write(fd,b,1):read(fd,b,1);}while(n<0&&errno==EINTR);return n==1;}
static int current_parent(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]) {
#if defined(BRAIN_REGISTRY_FIXTURE) && defined(BRAIN_FIXTURE_SUPERVISOR_AUTHORITY)
  return brain_supervisor_authority_fixture_fd(fd,uid,pid,hash);
#elif defined(BRAIN_REGISTRY_FIXTURE)
  return brain_verify_peer(fd,uid,pid,hash);
#else
  return brain_supervisor_authority(fd,uid,pid,hash);
#endif
}
int main(void){uint8_t supervisor[20],client_hash[20];uid_t supervisor_uid=(uid_t)BRAIN_QUEUE_SUPERVISOR_UID,client_uid=0;pid_t parent=getppid();
  if(!pin(supervisor)||!current_parent(3,supervisor_uid,parent,supervisor)||!brain_verify_peer(4,supervisor_uid,parent,supervisor))return 2;
  struct pollfd start={.fd=4,.events=POLLIN};uint8_t hello=0;if(poll(&start,1,5000)!=1||!one(4,&hello,0)||hello!=1)return 2;
  brain_data_peer backend;if(!brain_data_peer_open(&backend,4,supervisor_uid,parent,supervisor))return 2;
  int policy=open(BRAIN_QUEUE_POLICY_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),dir=open(BRAIN_QUEUE_SOCKET_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(policy<0||dir<0)goto fail;
#ifdef BRAIN_REGISTRY_FIXTURE
  if(!brain_queue_client_policy_fixture(policy,geteuid(),&client_uid,client_hash))goto fail;
#else
  if(!brain_queue_client_policy(policy,&client_uid,client_hash)||!brain_sealed_trusted_dir(dir,supervisor_uid))goto fail;
#endif
  char path[sizeof(((struct sockaddr_un *)0)->sun_path)];size_t len=strlen(BRAIN_QUEUE_SOCKET_DIR);
  if(!len||len+sizeof "/queue.sock">sizeof path)goto fail;memcpy(path,BRAIN_QUEUE_SOCKET_DIR,len);memcpy(path+len,"/queue.sock",sizeof "/queue.sock");
  int listener=socket(AF_UNIX,SOCK_STREAM,0);if(listener<0)goto fail;struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,path);address.sun_len=sizeof address;
  if(bind(listener,(struct sockaddr *)&address,sizeof address)){close(listener);goto fail;}
  struct stat socket_info;if(fstatat(dir,"queue.sock",&socket_info,AT_SYMLINK_NOFOLLOW)||!S_ISSOCK(socket_info.st_mode)){close(listener);goto fail;}
  if(fchmodat(dir,"queue.sock",0666,0)||listen(listener,8)){close(listener);goto remove_socket;}
  signal(SIGTERM,stop);signal(SIGINT,stop);uint8_t *buf=malloc(LIMIT);if(!buf){close(listener);goto remove_socket;}
  while(!stopped){struct pollfd events[2]={{.fd=listener,.events=POLLIN},{.fd=3,.events=POLLIN|POLLHUP}};int ready=poll(events,2,1000);if(ready<0&&errno==EINTR)continue;
    if(ready<0||events[1].revents||!brain_verify_peer(3,supervisor_uid,parent,supervisor))break;if(!(events[0].revents&POLLIN))continue;
    int fd=accept(listener,NULL,NULL);if(fd<0)continue;int no_signal=1;setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof no_signal);
    struct pollfd event={.fd=fd,.events=POLLIN};uint8_t marker=0;if(poll(&event,1,5000)!=1||!one(fd,&marker,0)||marker!=1){close(fd);continue;}
    audit_token_t token;socklen_t size=sizeof token;if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&size)||size!=sizeof token){close(fd);continue;}
    brain_data_peer client;if(!brain_data_peer_open(&client,fd,client_uid,audit_token_to_pid(token),client_hash))continue;
    marker=1;if(!one(client.fd,&marker,1)){brain_data_peer_close(&client);continue;}
    size_t n=0;int ok=brain_data_peer_read(&client,buf,LIMIT,&n,5000)&&current_parent(3,supervisor_uid,parent,supervisor)&&brain_data_peer_write(&backend,buf,n,5000)
      &&brain_data_peer_read(&backend,buf,LIMIT,&n,5000)&&current_parent(3,supervisor_uid,parent,supervisor)&&brain_data_peer_write(&client,buf,n,5000)
      &&brain_data_peer_read(&client,buf,LIMIT,&n,5000)&&n==3&&!memcmp(buf,"ack",3);
    brain_data_peer_close(&client);if(!ok&&!backend.authenticated)break;
  }
  free(buf);close(listener);
remove_socket:;
  struct stat current;if(!fstatat(dir,"queue.sock",&current,AT_SYMLINK_NOFOLLOW)&&current.st_dev==socket_info.st_dev&&current.st_ino==socket_info.st_ino&&S_ISSOCK(current.st_mode))unlinkat(dir,"queue.sock",0);
  close(policy);close(dir);brain_data_peer_close(&backend);return 0;
fail:if(policy>=0)close(policy);if(dir>=0)close(dir);brain_data_peer_close(&backend);return 2;
}
