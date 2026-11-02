/* 고정 queue-only 서비스와 상호 OS 신원을 확인한다. 기본 pin은 닫힘이다. */
#include "data-peer.h"
#include <bsm/libbsm.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef BRAIN_QUEUE_ENDPOINT_PATH
#define BRAIN_QUEUE_ENDPOINT_PATH ""
#endif
#ifndef BRAIN_QUEUE_ENDPOINT_UID
#define BRAIN_QUEUE_ENDPOINT_UID 0
#endif
#ifndef BRAIN_QUEUE_ENDPOINT_HASH
#define BRAIN_QUEUE_ENDPOINT_HASH ""
#endif
#define LIMIT (1024U*1024U)
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int pin(uint8_t h[20]){const char *s=BRAIN_QUEUE_ENDPOINT_HASH;if(!BRAIN_QUEUE_ENDPOINT_UID||strlen(s)!=40)return 0;for(int i=0;i<20;i++){int a=digit(s[i*2]),b=digit(s[i*2+1]);if(a<0||b<0)return 0;h[i]=(uint8_t)((a<<4)|b);}return 1;}
static int io(int fd,void *buf,size_t n,int out){uint8_t *p=buf;while(n){ssize_t r=out?write(fd,p,n):read(fd,p,n);if(r<0&&errno==EINTR)continue;if(r<=0)return 0;p+=r;n-=(size_t)r;}return 1;}
int main(int argc,char **argv){(void)argv;uint8_t hash[20];const char *path=BRAIN_QUEUE_ENDPOINT_PATH;
  if(argc!=1||!pin(hash)||!path[0]||strlen(path)>=sizeof(((struct sockaddr_un *)0)->sun_path))return 2;
  int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)return 2;struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,path);address.sun_len=sizeof address;
  if(connect(fd,(struct sockaddr *)&address,sizeof address)){close(fd);return 2;}
  int no_signal=1;if(setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof no_signal)){close(fd);return 2;}
  uint8_t hello=1,reply=0;struct pollfd event={.fd=fd,.events=POLLIN};if(!io(fd,&hello,1,1)||poll(&event,1,5000)!=1||!io(fd,&reply,1,0)||reply!=1){close(fd);return 2;}
  audit_token_t token;socklen_t size=sizeof token;if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&size)||size!=sizeof token){close(fd);return 2;}
  brain_data_peer peer;if(!brain_data_peer_open(&peer,fd,(uid_t)BRAIN_QUEUE_ENDPOINT_UID,audit_token_to_pid(token),hash))return 2;
  uint8_t *buf=malloc(LIMIT+1);if(!buf){brain_data_peer_close(&peer);return 2;}size_t n=0;
  for(;;){ssize_t got=read(0,buf+n,LIMIT+1-n);if(got<0&&errno==EINTR)continue;if(got<0){n=0;break;}if(!got)break;n+=(size_t)got;if(n>LIMIT)break;}
  size_t response=0;int ok=n>0&&n<=LIMIT&&brain_data_peer_write(&peer,buf,n,5000)&&brain_data_peer_read(&peer,buf,LIMIT,&response,5000)&&io(1,buf,response,1)
    &&brain_data_peer_write(&peer,(const uint8_t *)"ack",3,5000);
  if(ok){uint8_t end;ssize_t r=-1;struct pollfd done={.fd=peer.fd,.events=POLLIN|POLLHUP};if(poll(&done,1,5000)>0){do{r=read(peer.fd,&end,1);}while(r<0&&errno==EINTR);}ok=r==0;}
  free(buf);brain_data_peer_close(&peer);return ok?0:2;
}
