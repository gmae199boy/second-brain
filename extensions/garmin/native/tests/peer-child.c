#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include "../peer.h"
#include "fixture-common.h"
#ifndef FIXTURE_VARIANT
#define FIXTURE_VARIANT 0
#endif
int main(int argc, char **argv) {
  volatile int variant = FIXTURE_VARIANT; if (variant < 0) return 8;
  if (argc != 3) return 2;
  int socket_fd = atoi(argv[1]); uint8_t hash[20];
  if (!fixture_hash(argv[2], hash)) return 3;
  brain_peer_session peer;
  if (!brain_peer_open(&peer, socket_fd, geteuid(), getppid(), hash)) return 4;
  int secret = brain_peer_receive_fd(&peer, 3000); if (secret < 0) return 5;
  char buffer[16] = {0}; ssize_t n = read(secret, buffer, sizeof buffer); close(secret);
  int ok = n == 11 && memcmp(buffer, "fixture-key", 11) == 0 && brain_peer_receive_fd(&peer, 3000) == -1;
  memset(buffer, 0, sizeof buffer); brain_peer_close(&peer);
  return ok ? 0 : 6;
}
