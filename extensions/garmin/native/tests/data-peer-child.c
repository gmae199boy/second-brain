#include "../data-peer.h"
#include <stdio.h>
#include "fixture-common.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef FIXTURE_VARIANT
#define FIXTURE_VARIANT 0
#endif
int main(int argc, char **argv) {
  volatile int variant = FIXTURE_VARIANT; if (variant < 0 || argc != 3) return 2;
  uint8_t hash[20]; if (!fixture_hash(argv[2], hash)) return 3;
  brain_data_peer peer;
  if (!brain_data_peer_open(&peer, atoi(argv[1]), geteuid(), getppid(), hash)) return 4;
  const uint8_t request[] = "{\"operation\":\"queue.list.v1\"}";
  uint8_t reply[128]; size_t length = 0;
  int ok = brain_data_peer_write(&peer, request, sizeof request - 1, 3000)
    && brain_data_peer_read(&peer, reply, sizeof reply, &length, 3000)
    && length == 11 && !memcmp(reply, "{\"ok\":true}", 11);
  uint8_t large[32768]; memset(large, 'x', sizeof large);
  ok = ok && brain_data_peer_write(&peer, large, sizeof large, 3000);
  length = 0;
  int acknowledged = ok && brain_data_peer_read(&peer, reply, sizeof reply, &length, 3000) && length == 3 && !memcmp(reply, "ack", 3);
  if (!acknowledged) fprintf(stderr, "하위 프로세스 완료 ACK 확인 실패\n");
  ok = ok && acknowledged;
  brain_data_peer_close(&peer); return ok ? 0 : 5;
}
