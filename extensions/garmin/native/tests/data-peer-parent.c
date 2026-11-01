#include "../data-peer.h"
#include "../peer.h"
#include <stdio.h>
#include "fixture-common.h"
#include <stdlib.h>
#include <signal.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 5) return 2;
  uint8_t expected[20]; if (!fixture_hash(argv[2], expected)) return 3;
  int channel[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, channel)) return 4;
  pid_t child = fork(); if (child < 0) return 5;
  if (!child) { close(channel[0]); char number[32]; snprintf(number, sizeof number, "%d", channel[1]); execl(argv[1], argv[1], number, argv[3], NULL); _exit(6); }
  close(channel[1]);
  brain_data_peer peer; int accepted = 0;
  for (int i = 0; i < 100; i++) {
    int duplicate = dup(channel[0]); if (duplicate < 0) break;
    if (brain_data_peer_open(&peer, duplicate, geteuid(), child, expected)) { accepted = 1; break; }
    usleep(10000);
  }
  close(channel[0]);
  if (!accepted) { int status; waitpid(child, &status, 0); return 7; }
  uint8_t request[128]; size_t length = 0;
  const uint8_t reply[] = "{\"ok\":true}";
  int ok = brain_data_peer_read(&peer, request, sizeof request, &length, 3000)
    && length == 29 && !memcmp(request, "{\"operation\":\"queue.list.v1\"}", 29)
    && brain_data_peer_write(&peer, reply, sizeof reply - 1, 3000);
  uint8_t large[32768]; size_t large_length = 0;
  ok = ok && brain_data_peer_read(&peer, large, sizeof large, &large_length, 3000) && large_length == sizeof large;
  for (size_t i = 0; ok && i < large_length; i++) ok = large[i] == 'x';
  if (!ok) fprintf(stderr, "상위 프로세스 데이터 수신 또는 내용 검사 실패\n");
  int status;
  if (!strcmp(argv[4], "replace")) {
    uint8_t parent_hash[20]; if (!fixture_hash(argv[3], parent_hash)) return 12;
    // 원래 상대가 살아 있고 기존 연결도 유효한 상태를 먼저 확인한다.
    if (!ok || waitpid(child, &status, WNOHANG) != 0 || !brain_verify_peer(peer.fd, geteuid(), child, expected)) return 13;
    int original = dup(peer.fd); if (original < 0) return 14;
    int other[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, other)) return 8;
    if (dup2(other[0], peer.fd) < 0) return 9;
    close(other[0]);
    // 대체 연결이 현재 프로세스의 것이고 원래 자식이 아님을 각각 검사한다.
    int actual_other = brain_verify_peer(peer.fd, geteuid(), getpid(), parent_hash);
    int rejects_child = !brain_verify_peer(peer.fd, geteuid(), child, expected);
    int still_alive = waitpid(child, &status, WNOHANG) == 0;
    int rejected = !brain_data_peer_write(&peer, reply, sizeof reply - 1, 3000);
    fprintf(stderr, "REPLACE_LIVE=%d OTHER_ID=%d OLD_ID_REJECTED=%d WRITE_REJECTED=%d\n", still_alive, actual_other, rejects_child, rejected);
    close(other[1]);
    if (kill(child, SIGTERM)) return 15;
    close(original);
    if (waitpid(child, &status, 0) != child) return 11;
    brain_data_peer_close(&peer);
    return still_alive && actual_other && rejects_child && rejected && WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM ? 0 : 16;
  }
  const uint8_t ack[] = "ack";
  int acknowledged = ok && brain_data_peer_write(&peer, ack, sizeof ack - 1, 3000);
  if (!acknowledged) fprintf(stderr, "상위 프로세스 완료 ACK 전송 실패\n");
  ok = ok && acknowledged;
  if (waitpid(child, &status, 0) != child) return 11;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) fprintf(stderr, "하위 프로세스 종료 상태 확인 실패\n");
  brain_data_peer_close(&peer);
  return ok && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 10;
}
