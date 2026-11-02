/* 제품 launcher를 호출하는 합성 peer. 운영 서비스 설치가 아니다. */
#include "../queue-launcher.h"
#include <stdio.h>
#include "fixture-common.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#define LIMIT (1024U*1024U)
void brain_registry_fixture_before_spawn(void) {}
static int io(int fd,void *buf,size_t n,int send_data){unsigned char *p=buf;while(n){ssize_t r=send_data?write(fd,p,n):read(fd,p,n);if(r<0&&errno==EINTR)continue;if(r<=0)return 0;p+=r;n-=(size_t)r;}return 1;}
int main(int argc,char **argv) {
  if(argc!=6)return 2;
  if(!strcmp(argv[4],"cleanup")) {
    int sync[2];if(pipe(sync))return 30;pid_t leader=fork();if(leader<0)return 31;
    if(!leader){close(sync[0]);if(setpgid(0,0))_exit(32);pid_t grandchild=fork();if(grandchild<0)_exit(33);if(!grandchild){for(;;)pause();}uint8_t ready=1;if(write(sync[1],&ready,1)!=1)_exit(34);for(;;)pause();}
    close(sync[1]);uint8_t ready=0;if(read(sync[0],&ready,1)!=1||ready!=1)return 35;
    brain_queue_session session={.node={.fd=-1},.service={.fd=-1},.child=leader,.bootstrap_fd=-1};
    int result=brain_queue_session_close(&session);if(!result&&!session.cleanup_unknown)return 36;
    if(!result&&brain_queue_session_close(&session))return 37;
    struct pollfd event={.fd=sync[0],.events=POLLIN|POLLHUP};if(poll(&event,1,3000)!=1||read(sync[0],&ready,1)!=0)return 38;close(sync[0]);
    pid_t gone=fork();if(gone<0)return 39;if(!gone)_exit(0);waitpid(gone,NULL,0);
    brain_queue_session lost={.node={.fd=-1},.service={.fd=-1},.child=gone,.bootstrap_fd=-1};
    if(brain_queue_session_close(&lost)||!lost.cleanup_unknown)return 40;
    return 0;
  }
  uint8_t hash[20];if(!fixture_hash(argv[5],hash))return 3;
  int reg=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),payload=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),pair[2];
  if(reg<0||payload<0||socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 4;
  pid_t server=fork();if(server<0)return 5;
  if(!server){close(pair[0]);uint8_t hello=1;if(!io(pair[1],&hello,1,1))_exit(10);
    brain_data_peer peer;if(!brain_data_peer_open(&peer,pair[1],geteuid(),getppid(),hash))_exit(11);
    uint8_t *buf=malloc(LIMIT);size_t n=0;uint32_t wire;int ok=buf&&brain_data_peer_read(&peer,buf,LIMIT,&n,5000);wire=htonl((uint32_t)n);
    if(ok)ok=io(3,&wire,4,1)&&io(3,buf,n,1)&&io(4,&wire,4,0);n=ntohl(wire);
    if(ok)ok=n>0&&n<=LIMIT&&io(4,buf,n,0)&&brain_data_peer_write(&peer,buf,n,5000);
    free(buf);if(ok){uint8_t end;ssize_t r;do{r=read(peer.fd,&end,1);}while(r<0&&errno==EINTR);ok=r==0;}
    brain_data_peer_close(&peer);_exit(ok?0:12);
  }
  close(pair[1]);close(3);close(4);struct pollfd event={.fd=pair[0],.events=POLLIN};uint8_t hello;
  if(poll(&event,1,5000)!=1||!io(pair[0],&hello,1,0)||hello!=1){kill(server,SIGKILL);waitpid(server,NULL,0);return 6;}
  if(!strcmp(argv[4],"deny-service"))hash[0]^=1;
  brain_queue_session session;
  if(!brain_queue_session_open_fixture(&session,reg,payload,pair[0],geteuid(),!strcmp(argv[4],"deny-service-pid")?server+1:server,hash,geteuid())){kill(server,SIGKILL);waitpid(server,NULL,0);return 7;}
  close(reg);close(payload);
  if(!strcmp(argv[4],"replace")){int replacement[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,replacement))return 19;if(dup2(replacement[0],session.node.fd)<0)return 20;close(replacement[0]);close(replacement[1]);}
  int ok=brain_queue_session_relay(&session);if(ok && !strcmp(argv[4],"repeat") && brain_queue_session_relay(&session))ok=0;int status=0;
  if(ok){ok=waitpid(session.child,&status,0)==session.child&&WIFEXITED(status)&&WEXITSTATUS(status)==0;session.child=0;}
  brain_queue_session_close(&session);int server_status=0;waitpid(server,&server_status,0);
  return ok&&WIFEXITED(server_status)&&WEXITSTATUS(server_status)==0?0:8;
}
