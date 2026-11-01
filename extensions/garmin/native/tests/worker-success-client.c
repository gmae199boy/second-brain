#include "../host-client.h"
#include "fixture-common.h"
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <signal.h>
#include <errno.h>
int main(int argc,char **argv) {
  if(argc!=3)return 2;uint8_t hash[20],package[32];if(!fixture_hash(argv[2],hash))return 3;memset(package,1,sizeof package);
  brain_host_client c;if(!brain_host_connect(&c,argv[1],geteuid(),hash))return 4;uuid_t work,attempt;uuid_generate_random(work);uuid_generate_random(attempt);
  int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 11;
  if(!brain_host_start_auth(&c,work,attempt,1,1,1,package,pair[0]))return 5;
  if(write(pair[1],"x",1)!=1)return 12;
  int flags=fcntl(c.stdout_fd,F_GETFL);if(flags<0 || fcntl(c.stdout_fd,F_SETFL,flags|O_NONBLOCK)<0)return 6;
  char output[8];if(read(c.stdout_fd,output,7)>0)return 7;
  int unread=0;if(ioctl(pair[0],FIONREAD,&unread) || unread!=1)return 13;close(pair[0]);
  int group=-1;if(brain_host_inspect(&c,&group)!=1 || group!=1 || !brain_host_recorded(&c))return 8;
  ssize_t n=-1;for(int i=0;i<200 && n<0;i++){usleep(10000);n=read(c.stdout_fd,output,7);}
  if(n!=7 || memcmp(output,"entered",7))return 9;
  int state=0,status=-1;for(int i=0;i<300 && state==0;i++){usleep(10000);state=brain_host_observe(&c,&status);}
#ifdef BRAIN_FIXTURE_DESCENDANT
  int open_group=kill(-c.pid,0)==0;
  errno=0;ssize_t extra=read(c.stdout_fd,output,1);int open_pipe=extra<0 && (errno==EAGAIN || errno==EWOULDBLOCK);
  int inspected=brain_host_inspect(&c,&group);
  int killed=kill(-c.pid,SIGKILL)==0;
  close(pair[1]);brain_host_close(&c);
  return state==1 && status==0 && open_group && open_pipe && inspected==-1 && killed ? 0 : 14;
#else
  close(pair[1]);brain_host_close(&c);return state==1 && status==0 ? 0 : 10;
#endif
}
