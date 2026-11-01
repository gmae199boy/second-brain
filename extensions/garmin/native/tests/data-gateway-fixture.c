/* 합성 시험 전용: 실제 설치 registry 또는 봉인 실행물을 대체하지 않는다. */
#include "../data-peer.h"
#include "../sealed-queue-spawn.h"
#include <stdio.h>
#include "fixture-common.h"
#include <arpa/inet.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#define LIMIT (1024U * 1024U)
static int transfer(int fd, void *buf, size_t length, int writing) {
  uint8_t *p=buf;while(length) {ssize_t n=writing?write(fd,p,length):read(fd,p,length);if(n<0 && errno==EINTR)continue;if(n<=0)return 0;p+=n;length-=(size_t)n;}return 1;
}
static int read_frame(int fd,uint8_t *buf,size_t *length) {uint32_t wire;if(!transfer(fd,&wire,4,0))return 0;*length=ntohl(wire);return *length>0 && *length<=LIMIT && transfer(fd,buf,*length,0);}
static int write_frame(int fd,uint8_t *buf,size_t length) {uint32_t wire=htonl((uint32_t)length);return length>0 && length<=LIMIT && transfer(fd,&wire,4,1) && transfer(fd,buf,length,1);}
static int digest_hex(const char *text,uint8_t digest[32]) {
  if(!text || strlen(text)!=64)return 0;
  for(int i=0;i<32;i++){unsigned v;if(sscanf(text+i*2,"%2x",&v)!=1)return 0;digest[i]=(uint8_t)v;}return 1;
}
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--sealed-queue-client")) {
    if(getenv("NODE_OPTIONS") || getenv("NODE_PATH") || getenv("DYLD_INSERT_LIBRARIES") || getenv("DYLD_LIBRARY_PATH") || getenv("HOME"))return 15;
    char cwd[16];if(!getcwd(cwd,sizeof cwd) || strcmp(cwd,"/"))return 16;
    uint8_t hash[20];if(!transfer(6,hash,sizeof hash,0))return 17;brain_data_peer peer;
    if(!brain_data_peer_open(&peer,5,geteuid(),getppid(),hash))return 10;
    uint8_t hello=1;if(!transfer(peer.fd,&hello,1,1))return 19;
    uint8_t admitted=0;if(!transfer(6,&admitted,1,0) || admitted!=1)return 18;close(6);
    uint8_t *buffer=malloc(LIMIT);size_t length=0;if(!buffer)return 11;
    int ok=read_frame(STDIN_FILENO,buffer,&length) && brain_data_peer_write(&peer,buffer,length,3000)
      && brain_data_peer_read(&peer,buffer,LIMIT,&length,3000) && write_frame(STDOUT_FILENO,buffer,length)
      && brain_data_peer_write(&peer,(const uint8_t *)"ack",3,3000)
      && brain_data_peer_read(&peer,buffer,LIMIT,&length,3000) && length==4 && !memcmp(buffer,"done",4);
    free(buffer);brain_data_peer_close(&peer);return ok?0:12;
  }
  if(argc!=4)return 2;
  uint8_t hash[20],digest[32];if(!fixture_hash(argv[1],hash) || !digest_hex(argv[3],digest))return 3;
  char *path=strdup(argv[0]);if(!path)return 4;int root=open(dirname(path),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);free(path);if(root<0)return 4;
  int channel[2],registry[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,channel) || pipe(registry))return 4;
  if(!strcmp(argv[2],"deny-server"))hash[0]^=1;
  if(!transfer(registry[1],hash,sizeof hash,1))return 5;
  if(!strcmp(argv[2],"deny-server"))hash[0]^=1;
  int peer_fd=fcntl(channel[1],F_DUPFD_CLOEXEC,10),registry_fd=fcntl(registry[0],F_DUPFD_CLOEXEC,10);close(channel[1]);close(registry[0]);
  const char *parts[]={"data-gateway"};brain_sealed_file file={.path="data-gateway"};memcpy(file.sha256,digest,32);pid_t child=0;
  uint8_t code_hash[20];memcpy(code_hash,hash,20);if(!strcmp(argv[2],"deny-signature"))code_hash[0]^=1;
  if(peer_fd<0 || registry_fd<0 || !brain_spawn_sealed_queue(root,parts,1,geteuid(),digest,code_hash,&file,1,peer_fd,registry_fd,&child))return 6;
  close(root);close(peer_fd);close(registry_fd);close(STDIN_FILENO);close(STDOUT_FILENO);
  if(!strcmp(argv[2],"deny-client"))hash[0]^=1;
  if(kill(child,SIGCONT)){kill(child,SIGKILL);waitpid(child,NULL,0);return 8;}
  uint8_t hello=0;if(!transfer(channel[0],&hello,1,0) || hello!=1){kill(child,SIGKILL);waitpid(child,NULL,0);return 20;}
  brain_data_peer peer;int accepted=0;
  for(int i=0;i<100;i++) {int fd=dup(channel[0]);if(fd<0)break;
    if(brain_data_peer_open(&peer,fd,geteuid(),!strcmp(argv[2],"deny-instance")?child+1:child,hash)){accepted=1;break;}usleep(10000);}
  if(!accepted){audit_token_t token;socklen_t size=sizeof token;if(!getsockopt(channel[0],SOL_LOCAL,LOCAL_PEERTOKEN,&token,&size))fprintf(stderr,"PEER_ACTUAL=%d EXPECTED=%d\n",audit_token_to_pid(token),child);}
  close(channel[0]);
  if(!accepted){int status=0;pid_t done=waitpid(child,&status,WNOHANG);fprintf(stderr,"PEER_DENY child_done=%d child_status=%d\n",done==child,status);close(registry[1]);if(done==0){kill(child,SIGKILL);waitpid(child,NULL,0);}return 7;}
  uint8_t admitted=1;if(!transfer(registry[1],&admitted,1,1)){kill(child,SIGKILL);waitpid(child,NULL,0);return 19;}close(registry[1]);
  uint8_t *buffer=malloc(LIMIT);size_t length=0;if(!buffer)return 8;
  int ok=brain_data_peer_read(&peer,buffer,LIMIT,&length,3000) && write_frame(3,buffer,length)
    && read_frame(4,buffer,&length) && brain_data_peer_write(&peer,buffer,length,3000)
    && brain_data_peer_read(&peer,buffer,LIMIT,&length,3000) && length==3 && !memcmp(buffer,"ack",3)
    && brain_data_peer_write(&peer,(const uint8_t *)"done",4,3000);
  close(3);close(4);free(buffer);int status;if(waitpid(child,&status,0)!=child)return 9;
  brain_data_peer_close(&peer);return ok && WIFEXITED(status) && WEXITSTATUS(status)==0?0:13;
}
