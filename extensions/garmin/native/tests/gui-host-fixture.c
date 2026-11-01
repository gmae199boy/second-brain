#include "../gui-host.h"
#include "fixture-common.h"
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
int main(int argc,char **argv) {
  if(argc!=2)return 1;uint8_t hash[20];if(!fixture_hash(argv[1],hash))return 2;
  int fds[2];if(pipe(fds) || dup2(fds[1],1)<0)return 3;close(fds[1]);int flags=fcntl(fds[0],F_GETFL);if(flags<0 || fcntl(fds[0],F_SETFL,flags|O_NONBLOCK)<0)return 4;
  brain_gui_process p;if(!brain_gui_start(&p,geteuid(),hash,1))return 5;
  char buf[8];usleep(50000);if(read(fds[0],buf,7)>0){brain_gui_cancel(&p);return 6;}
  if(!brain_gui_resume(&p)){brain_gui_cancel(&p);return 7;}
  ssize_t n=-1;for(int i=0;i<100 && n<0;i++){usleep(10000);n=read(fds[0],buf,7);}
  int ended=brain_gui_cancel(&p);if(n!=7 || memcmp(buf,"started",7) || !ended){dprintf(2,"fixture: read=%zd 종료확인=%d\n",n,ended);close(fds[0]);return 8;}close(fds[0]);return 0;
}
