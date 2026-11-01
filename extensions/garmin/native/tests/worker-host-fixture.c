#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <signal.h>
#include "../worker-host.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  uint8_t hash[20], bad[20]; if (!fixture_hash(argv[1], hash)) return 2;
  for (int i=0;i<20;i++) bad[i]=hash[i]; bad[0]^=1;
  brain_worker worker;
  if (brain_spawn_worker(bad, geteuid(), &worker)) return 3;
  if (brain_spawn_worker(hash, 0, &worker)) return 4;
  int fds[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,fds))return 5;
  if(brain_spawn_worker_with_channel(hash,geteuid(),STDIN_FILENO,&worker))return 10;
  if(!brain_spawn_worker_with_channel(hash,geteuid(),fds[0],&worker))return 5;
  close(fds[0]);close(fds[1]);
  if (worker.pid <= 0 || worker.bootstrap_write < 0 || worker.stdout_read < 0 || worker.stderr_read < 0 || worker.control_fd < 0) return 6;
  if (brain_worker_ack(&worker) || brain_worker_recorded(&worker,worker.pid)) return 9;
  int status, reaped = 0;
  for (int i=0;i<300;i++) { int result=brain_worker_reap(&worker,&status); if (result==1) { reaped=1; break; } if (result<0) return 7; usleep(10000); }
  if (!reaped || brain_worker_signal(&worker,SIGKILL) || brain_worker_group_state(&worker)!=0) return 7;
  brain_worker_close(&worker);
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 8;
}
