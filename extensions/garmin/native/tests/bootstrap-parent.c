#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include "../worker-host.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  if (argc != 5) return 2; uint8_t child_hash[20]; if (!fixture_hash(argv[2],child_hash)) return 3;
  int control[2], ack[2], output[2]; if (socketpair(AF_UNIX,SOCK_STREAM,0,control) || pipe(ack) || pipe(output)) return 4;
  pid_t child=fork(); if(child<0)return 5;
  if (!child) {
    int a=fcntl(ack[0],F_DUPFD,10), c=fcntl(control[1],F_DUPFD,10), o=fcntl(output[1],F_DUPFD,10);
    if(a<0||c<0||o<0||dup2(a,3)<0||dup2(c,4)<0||dup2(o,1)<0)_exit(6);
    for(int fd=5;fd<64;fd++)close(fd);
    execl(argv[1],argv[1],argv[3],NULL); _exit(7);
  }
  close(ack[0]); close(control[1]); close(output[1]);
  brain_worker worker = { .pid=child, .bootstrap_write=ack[1], .stdout_read=output[0], .stderr_read=-1, .control_fd=control[0] };
  if (!brain_worker_verify_peer(&worker,geteuid(),child_hash,3000)) return 8;
  struct pollfd poller = { .fd=worker.stdout_read, .events=POLLIN };
  if (poll(&poller,1,50)!=0) return 9;
  int denied = argv[4][0]=='d';
  if (denied) { if (brain_worker_ack(&worker)) return 10; }
  else {
    if (!brain_worker_recorded(&worker,child) || !brain_worker_ack(&worker)) return 11;
    char output_bytes[7]; if (read(worker.stdout_read,output_bytes,sizeof output_bytes)!=7) return 12;
  }
  int status; if(waitpid(child,&status,0)!=child)return 13; brain_worker_close(&worker);
  return WIFEXITED(status) && (denied ? WEXITSTATUS(status)!=0 : WEXITSTATUS(status)==0) ? 0 : 14;
}
