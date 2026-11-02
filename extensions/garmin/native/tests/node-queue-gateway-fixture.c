/* 합성 시험 전용: root 설치·실제 서비스 신원의 증거가 아니다. */
#include "../sealed-registry.h"
#include "../data-peer.h"
#include <stdio.h>
#include "fixture-common.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#define LIMIT (1024U*1024U)
void brain_registry_fixture_before_spawn(void) {}
static int transfer(int fd,void *buffer,size_t length,int writing) {
  unsigned char *p=buffer;while(length){ssize_t n=writing?write(fd,p,length):read(fd,p,length);if(n<0&&errno==EINTR)continue;if(n<=0)return 0;p+=n;length-=(size_t)n;}return 1;
}
/* Security framework를 초기화한 부모에서 fork 후 API를 호출하지 않는다. */
static int run_service(const char *hash_text) {
  fprintf(stderr,"SERVICE_EXEC pid=%ld parent=%ld\n",(long)getpid(),(long)getppid());
  uint8_t hash[20];if(!fixture_hash(hash_text,hash))return 20;
  uint8_t hello=1;if(!transfer(5,&hello,1,1))return 21;
  brain_data_peer upstream;if(!brain_data_peer_open(&upstream,5,geteuid(),getppid(),hash)){fprintf(stderr,"SERVICE_OPEN_FAILED\n");return 22;}
  uint8_t *data=malloc(LIMIT);size_t size=0;uint32_t header;int stage=0;
  int ok=data&&brain_data_peer_read(&upstream,data,LIMIT,&size,5000);header=htonl((uint32_t)size);
  if(ok){stage=1;ok=transfer(3,&header,4,1)&&transfer(3,data,size,1)&&transfer(4,&header,4,0);}
  size=ntohl(header);if(ok){stage=2;ok=size>0&&size<=LIMIT&&transfer(4,data,size,0)&&brain_data_peer_write(&upstream,data,size,5000);}
  if(!ok)fprintf(stderr,"SERVICE_IO_FAIL stage=%d size=%zu errno=%d\n",stage,size,errno);
  free(data);if(ok){uint8_t end;ssize_t n;do{n=read(upstream.fd,&end,1);}while(n<0&&errno==EINTR);ok=n==0;}
  brain_data_peer_close(&upstream);return ok?0:23;
}
int main(int argc,char **argv) {
  if(argc==3&&!strcmp(argv[1],"--service"))return run_service(argv[2]);
  if(argc!=6)return 2;int failure_step=0;
  int reg=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),payload=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);uint8_t hash[20];
  if(reg<0||payload<0||!fixture_hash(argv[3],hash))return 3;
  int channel[2],ack[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,channel)||socketpair(AF_UNIX,SOCK_STREAM,0,ack))return 4;
  int peer=fcntl(channel[1],F_DUPFD_CLOEXEC,10),bootstrap=fcntl(ack[0],F_DUPFD_CLOEXEC,10);close(channel[1]);close(ack[0]);
  pid_t child=0;if(peer<0||bootstrap<0||!brain_spawn_queue_registry_fixture(reg,payload,geteuid(),peer,bootstrap,&child))return 5;
  close(peer);close(bootstrap);close(reg);close(payload);
  int service_pair[2];failure_step=1;if(socketpair(AF_UNIX,SOCK_STREAM,0,service_pair))goto fail;
  uint8_t service_hash[20];failure_step=2;if(!fixture_hash(argv[5],service_hash))goto fail;
  failure_step=3;int service_fd=fcntl(service_pair[1],F_DUPFD_CLOEXEC,10);if(service_fd<0)goto fail;
  posix_spawn_file_actions_t actions;posix_spawnattr_t attr;
  if(posix_spawn_file_actions_init(&actions)){close(service_fd);goto fail;}
  if(posix_spawnattr_init(&attr)){posix_spawn_file_actions_destroy(&actions);close(service_fd);goto fail;}
  int spawn_ok=!posix_spawn_file_actions_adddup2(&actions,0,0)&&!posix_spawn_file_actions_adddup2(&actions,1,1)
    &&!posix_spawn_file_actions_adddup2(&actions,2,2)&&!posix_spawn_file_actions_adddup2(&actions,3,3)
    &&!posix_spawn_file_actions_adddup2(&actions,4,4)&&!posix_spawn_file_actions_adddup2(&actions,service_fd,5)
    &&!posix_spawnattr_setflags(&attr,POSIX_SPAWN_CLOEXEC_DEFAULT);
  char *const service_args[]={argv[0],"--service",argv[5],NULL};char *const service_env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};pid_t service=0;
  if(spawn_ok)spawn_ok=posix_spawn(&service,argv[0],&actions,&attr,service_args,service_env)==0;
  posix_spawnattr_destroy(&attr);posix_spawn_file_actions_destroy(&actions);close(service_fd);
  if(!spawn_ok)goto fail;
  close(service_pair[1]);close(3);close(4);
  uint8_t service_hello=0;struct pollfd service_event={.fd=service_pair[0],.events=POLLIN};
  failure_step=4;int service_poll=poll(&service_event,1,5000);int service_errno=errno;
  if(service_poll!=1||!transfer(service_pair[0],&service_hello,1,0)||service_hello!=1){fprintf(stderr,"SERVICE_HELLO poll=%d events=%d errno=%d hello=%u\n",service_poll,service_event.revents,service_errno,service_hello);kill(service,SIGKILL);waitpid(service,NULL,0);goto fail;}
  if(!strcmp(argv[4],"deny-service"))service_hash[0]^=1;
  brain_data_peer downstream;
  failure_step=5;if(!brain_data_peer_open(&downstream,service_pair[0],geteuid(),!strcmp(argv[4],"deny-service-pid")?service+1:service,service_hash)){kill(service,SIGKILL);waitpid(service,NULL,0);goto fail;}
  if(kill(child,SIGCONT)){brain_data_peer_close(&downstream);kill(service,SIGKILL);waitpid(service,NULL,0);return 6;}
  struct pollfd event={.fd=channel[0],.events=POLLIN};uint8_t hello=0;
  failure_step=6;int node_poll=poll(&event,1,5000);int node_errno=errno;
  if(node_poll!=1||!transfer(channel[0],&hello,1,0)||hello!=1){fprintf(stderr,"NODE_HELLO poll=%d events=%d errno=%d hello=%u\n",node_poll,event.revents,node_errno,hello);goto service_fail;}
  if(!strcmp(argv[4],"deny-hash"))hash[0]^=1;
  brain_data_peer authenticated;
  failure_step=7;if(!brain_data_peer_open(&authenticated,channel[0],geteuid(),!strcmp(argv[4],"deny-pid")?child+1:child,hash)){channel[0]=-1;goto service_fail;}
  channel[0]=-1;
  failure_step=8;if(!strcmp(argv[4],"deny-ack")){brain_data_peer_close(&authenticated);goto service_fail;}
  failure_step=9;uint8_t allowed=1;if(!transfer(ack[1],&allowed,1,1)){brain_data_peer_close(&authenticated);goto service_fail;}
  if(!strcmp(argv[4],"replace")) {
    int replacement[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,replacement))goto service_fail;
    if(dup2(replacement[0],authenticated.fd)<0){close(replacement[0]);close(replacement[1]);goto service_fail;}
    close(replacement[0]);close(replacement[1]);
  }
  uint8_t *buffer=malloc(LIMIT);size_t length=0;
  int stage=0;int ok=buffer && brain_data_peer_read(&authenticated,buffer,LIMIT,&length,5000);
  if(ok){stage=1;ok=brain_data_peer_write(&downstream,buffer,length,5000);}
  if(ok){stage=2;ok=brain_data_peer_read(&downstream,buffer,LIMIT,&length,5000);}
  if(ok){stage=3;ok=brain_data_peer_write(&authenticated,buffer,length,5000);}
  if(ok){stage=4;ok=brain_data_peer_read(&authenticated,buffer,LIMIT,&length,5000)&&length==3&&!memcmp(buffer,"ack",3);}
  if(!ok)fprintf(stderr,"gateway relay stage=%d\n",stage);
  free(buffer);brain_data_peer_close(&authenticated);brain_data_peer_close(&downstream);
  int status=0,service_status=0;if(waitpid(child,&status,0)!=child||waitpid(service,&service_status,0)!=service)return 8;
  if(!ok||!WIFEXITED(status)||WEXITSTATUS(status)||!WIFEXITED(service_status)||WEXITSTATUS(service_status))fprintf(stderr,"GATEWAY_EXIT ok=%d node_status=%d service_status=%d\n",ok,status,service_status);
  close(ack[1]);return ok&&WIFEXITED(status)&&WEXITSTATUS(status)==0&&WIFEXITED(service_status)&&WEXITSTATUS(service_status)==0?0:9;
service_fail:
  brain_data_peer_close(&downstream);kill(service,SIGKILL);waitpid(service,NULL,0);
fail:
  fprintf(stderr,"GATEWAY_FAIL step=%d child_alive=%d\n",failure_step,kill(child,0)==0);
  if(channel[0]>=0)close(channel[0]);if(ack[1]>=0)close(ack[1]);kill(child,SIGKILL);waitpid(child,NULL,0);return 7;
}
