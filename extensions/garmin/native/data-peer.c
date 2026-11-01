#include "data-peer.h"
#include "peer.h"
#include <sys/socket.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* [ASSUMPTION] 일반 데이터 frame 상한은 실제 목록 부하와 함께 재평가한다. */
#define DATA_FRAME_MAX (1024U * 1024U)
static int64_t millis(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int transfer(int fd, uint8_t *buffer, size_t length, int writing, int64_t deadline) {
  while (length) {
    int64_t now = millis(); if (now < 0 || now >= deadline) return 0;
    struct pollfd event = { .fd = fd, .events = writing ? POLLOUT : POLLIN };
    int ready = poll(&event, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (event.revents & (POLLERR | POLLNVAL))) return 0;
    ssize_t count = writing ? send(fd, buffer, length, MSG_DONTWAIT) : recv(fd, buffer, length, MSG_DONTWAIT);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count <= 0) return 0;
    buffer += count; length -= (size_t)count;
  }
  return 1;
}
static int valid(brain_data_peer *peer, int timeout_ms, int64_t *deadline) {
  if (!peer || !peer->authenticated || timeout_ms <= 0 || timeout_ms > 300000 ||
      !brain_verify_peer(peer->fd, peer->uid, peer->pid, peer->hash)) return 0;
  int64_t now = millis(); if (now < 0) return 0;
  *deadline = now + timeout_ms; return 1;
}
int brain_data_peer_open(brain_data_peer *peer, int fd, uid_t uid, pid_t pid, const uint8_t hash[20]) {
  if (!peer) { if (fd >= 0) close(fd); return 0; }
  *peer = (brain_data_peer){ .fd = -1 };
  if (fd < 0 || !brain_verify_peer(fd, uid, pid, hash) || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETNOSIGPIPE, 1) < 0) {
    if (fd >= 0) close(fd); return 0;
  }
  peer->fd = fd; peer->uid = uid; peer->pid = pid; memcpy(peer->hash, hash, 20); peer->authenticated = 1; return 1;
}
int brain_data_peer_read(brain_data_peer *peer, uint8_t *buffer, size_t capacity, size_t *length, int timeout_ms) {
  int64_t deadline; uint32_t wire;
  if (!buffer || !length || !valid(peer, timeout_ms, &deadline) || !transfer(peer->fd, (uint8_t *)&wire, sizeof wire, 0, deadline)) goto fail;
  size_t size = ntohl(wire);
  if (!size || size > DATA_FRAME_MAX || size > capacity || !transfer(peer->fd, buffer, size, 0, deadline) || !brain_verify_peer(peer->fd, peer->uid, peer->pid, peer->hash)) goto fail;
  *length = size; return 1;
fail: brain_data_peer_close(peer); return 0;
}
int brain_data_peer_write(brain_data_peer *peer, const uint8_t *buffer, size_t length, int timeout_ms) {
  int64_t deadline;
  if (!buffer || !length || length > DATA_FRAME_MAX || !valid(peer, timeout_ms, &deadline)) goto fail;
  uint32_t wire = htonl((uint32_t)length);
  if (!transfer(peer->fd, (uint8_t *)&wire, sizeof wire, 1, deadline) || !transfer(peer->fd, (uint8_t *)buffer, length, 1, deadline) || !brain_verify_peer(peer->fd, peer->uid, peer->pid, peer->hash)) goto fail;
  return 1;
fail: brain_data_peer_close(peer); return 0;
}
void brain_data_peer_close(brain_data_peer *peer) {
  if (!peer) return;
  if (peer->fd >= 0) close(peer->fd);
  memset(peer, 0, sizeof *peer); peer->fd = -1;
}
