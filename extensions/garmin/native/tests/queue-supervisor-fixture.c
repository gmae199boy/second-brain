/* 합성 supervisor: host 및 service PID를 직접 소유한다. */
#include "../peer.h"
#include "../data-peer.h"
#include <stdio.h>
#include "fixture-common.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#define LIMIT (1024U*1024U)
static int io(int fd,void *buf,size_t n,int out){unsigned char *p=buf;while(n){ssize_t r=out?write(fd,p,n):read(fd,p,n);if(r<0&&errno==EINTR)continue;if(r<=0)return 0;p+=r;n-=(size_t)r;}return 1;}
int main(int argc,char **argv) {
  if(argc!=7)return 2;uint8_t self_hash[20],host_hash[20];if(!fixture_hash(argv[4],self_hash)||!fixture_hash(argv[5],host_hash))return 3;
  int reg=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),payload=open(argv[3],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),control[2],service[2],gate[2];
  if(reg<0||payload<0||socketpair(AF_UNIX,SOCK_STREAM,0,control)||socketpair(AF_UNIX,SOCK_STREAM,0,service)||pipe(gate))return 4;
  pid_t server=fork();if(server<0)return 5;
  if(!server){close(service[0]);close(control[0]);close(control[1]);close(gate[1]);uint8_t hello=1;if(!io(service[1],&hello,1,1))_exit(10);
    pid_t host;if(!io(gate[0],&host,sizeof host,0))_exit(11);struct pollfd e={.fd=service[1],.events=POLLIN};if(poll(&e,1,5000)!=1)_exit(12);
    brain_data_peer peer;if(!brain_data_peer_open(&peer,service[1],geteuid(),host,host_hash))_exit(13);
    uint8_t *buf=malloc(LIMIT);size_t n=0;uint32_t wire;int ok=buf&&brain_data_peer_read(&peer,buf,LIMIT,&n,5000);wire=htonl((uint32_t)n);
    if(ok)ok=io(3,&wire,4,1)&&io(3,buf,n,1)&&io(4,&wire,4,0);n=ntohl(wire);
    if(ok)ok=n>0&&n<=LIMIT&&io(4,buf,n,0)&&brain_data_peer_write(&peer,buf,n,5000);free(buf);
    if(ok){uint8_t end;ssize_t r;do{r=read(peer.fd,&end,1);}while(r<0&&errno==EINTR);ok=r==0;}brain_data_peer_close(&peer);_exit(ok?0:14);
  }
  close(service[1]);close(gate[0]);close(3);close(4);
  int c=fcntl(control[1],F_DUPFD_CLOEXEC,10),r=fcntl(reg,F_DUPFD_CLOEXEC,10),p=fcntl(payload,F_DUPFD_CLOEXEC,10);if(c<0||r<0||p<0)return 6;
  posix_spawn_file_actions_t a;if(posix_spawn_file_actions_init(&a))return 7;
  int ok=!posix_spawn_file_actions_adddup2(&a,c,5)&&!posix_spawn_file_actions_adddup2(&a,r,6)&&!posix_spawn_file_actions_adddup2(&a,p,7);
  char *const args[]={argv[1],NULL};char *const env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};pid_t host=0;if(ok)ok=posix_spawn(&host,argv[1],&a,NULL,args,env)==0;
  posix_spawn_file_actions_destroy(&a);close(c);close(r);close(p);close(reg);close(payload);close(control[1]);if(!ok)return 8;
  if(!io(gate[1],&host,sizeof host,1))return 9;close(gate[1]);
  uint8_t service_hello=0;struct pollfd service_event={.fd=service[0],.events=POLLIN};
  if(poll(&service_event,1,5000)!=1||!io(service[0],&service_hello,1,0)||service_hello!=1)return 18;
  uint8_t hello=0;struct pollfd ev={.fd=control[0],.events=POLLIN};
  if(poll(&ev,1,5000)!=1||!io(control[0],&hello,1,0)||hello!=1)return 15;
  if(!strcmp(argv[6],"deny-host"))host_hash[0]^=1;
  brain_peer_session peer;if(!brain_peer_open(&peer,control[0],geteuid(),host,host_hash))return 16;
  uint32_t uid=htonl((uint32_t)geteuid()),pid=htonl((uint32_t)server);uint8_t record[28];memcpy(record,&uid,4);memcpy(record+4,&pid,4);memcpy(record+8,self_hash,20);
  ok=brain_write_frame(peer.fd,record,sizeof record,5000)&&brain_peer_send_fd(&peer,service[0],5000);close(service[0]);
  if(!strcmp(argv[6],"disconnect")){brain_peer_close(&peer);kill(server,SIGKILL);waitpid(server,NULL,0);int status=0;waitpid(host,&status,0);return WIFEXITED(status)&&WEXITSTATUS(status)!=0?19:20;}
  if(ok){struct pollfd end_event={.fd=peer.fd,.events=POLLIN|POLLHUP};uint8_t end;ssize_t n=-1;if(poll(&end_event,1,5000)>0){do{n=read(peer.fd,&end,1);}while(n<0&&errno==EINTR);}ok=n==0;}brain_peer_close(&peer);
  int host_status=0,server_status=0;waitpid(host,&host_status,0);waitpid(server,&server_status,0);
  if(!ok||!WIFEXITED(host_status)||WEXITSTATUS(host_status)||!WIFEXITED(server_status)||WEXITSTATUS(server_status))fprintf(stderr,"supervisor ok=%d host=%d service=%d\n",ok,host_status,server_status);
  return ok&&WIFEXITED(host_status)&&WEXITSTATUS(host_status)==0&&WIFEXITED(server_status)&&WEXITSTATUS(server_status)==0?0:17;
}
