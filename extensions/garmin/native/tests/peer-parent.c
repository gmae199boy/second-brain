#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include "../peer.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  uint8_t expected[20]; if (!fixture_hash(argv[2], expected)) return 3;
  int channel[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, channel)) return 4;
  pid_t child = fork(); if (child < 0) return 5;
  if (!child) { close(channel[0]); char number[32]; snprintf(number, sizeof number, "%d", channel[1]); execl(argv[1], argv[1], number, argv[3], NULL); _exit(6); }
  close(channel[1]);
  /* exec 완료를 알리는 사용자 데이터는 신원이 아니라 lookup 재시도 신호다. */
  brain_peer_session peer; int accepted = 0;
  for (int i = 0; i < 100; i++) { int duplicate = dup(channel[0]); if (duplicate < 0) break;
    if (brain_peer_open(&peer, duplicate, geteuid(), child, expected)) { accepted = 1; break; } usleep(10000); }
  close(channel[0]);
  if (!accepted) { int status; waitpid(child, &status, 0); return 7; }
  int secret[2]; if (pipe(secret)) return 8;
  if (write(secret[1], "fixture-key", 11) != 11) return 9; close(secret[1]);
  int first = brain_peer_send_fd(&peer, secret[0], 3000); int second = brain_peer_send_fd(&peer, secret[0], 3000); close(secret[0]);
  brain_peer_close(&peer); int status; waitpid(child, &status, 0);
  return first && !second && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 10;
}
