/* 격리 테스트 전용. 정해진 두 UID 사이의 실제 audit token·코드 신원을 검사한다. */
#include "../../extensions/garmin/native/peer.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
static int digest(const char *text,uint8_t out[20]) {
  if(strlen(text)!=40)return 0;for(int i=0;i<20;i++){unsigned n;if(sscanf(text+i*2,"%2x",&n)!=1)return 0;out[i]=(uint8_t)n;}return 1;
}
int main(int argc,char **argv) {
  if(argc<3 || strlen(argv[2])>=sizeof(((struct sockaddr_un *)0)->sun_path))return 2;
  struct sockaddr_un address={.sun_family=AF_UNIX};memcpy(address.sun_path,argv[2],strlen(argv[2])+1);
  int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)return 3;
  if(!strcmp(argv[1],"client")) {
    if(connect(fd,(struct sockaddr *)&address,sizeof address))return 4;
    char b=1;if(write(fd,&b,1)!=1 || read(fd,&b,1)!=1)return 5;close(fd);return 0;
  }
  if(strcmp(argv[1],"server") || argc!=6)return 6;
  uid_t expected=(uid_t)strtoul(argv[3],NULL,10);int control=atoi(argv[4]);uint8_t hash[20];if(!digest(argv[5],hash))return 7;
  if(bind(fd,(struct sockaddr *)&address,sizeof address) || chmod(argv[2],0666) || listen(fd,1))return 8;
  puts("ready");fflush(stdout);char text[32]={0};ssize_t n=read(control,text,sizeof text-1);if(n<=0)return 9;
  pid_t expected_pid=(pid_t)strtol(text,NULL,10);int peer=accept(fd,NULL,NULL);if(peer<0)return 10;
  char b=0;if(read(peer,&b,1)!=1 || b!=1)return 11;
  int accepted=brain_verify_peer(peer,expected,expected_pid,hash);b=1;(void)write(peer,&b,1);
  puts(accepted?"accepted":"rejected");fflush(stdout);close(peer);close(fd);return 0;
}
