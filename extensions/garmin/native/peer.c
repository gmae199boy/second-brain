#include "peer.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <bsm/libbsm.h>
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#ifdef BRAIN_PEER_DIAGNOSTIC
#include <signal.h>
#endif
#include <poll.h>
#include <time.h>

int brain_verify_peer(int fd, uid_t uid, pid_t pid, const uint8_t hash[20]) {
  audit_token_t token={0}; socklen_t size = sizeof token; unsigned nonzero = 0;
  if (!hash || uid == 0 || pid <= 0) return 0;
  for (int i = 0; i < 20; i++) nonzero |= hash[i];
  if(!nonzero)return 0;
  int socket_result=getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&size),socket_errno=errno;
  if (socket_result || size != sizeof token || audit_token_to_euid(token) != uid || audit_token_to_pid(token) != pid) {
#ifdef BRAIN_PEER_DIAGNOSTIC
    fprintf(stderr,"PEER_TOKEN fd=%d rc=%d errno=%d size=%u expected_uid=%u actual_uid=%u expected_pid=%d actual_pid=%d alive=%d\n",fd,socket_result,socket_errno,(unsigned)size,(unsigned)uid,(unsigned)audit_token_to_euid(token),pid,audit_token_to_pid(token),kill(pid,0)==0);
#else
    (void)socket_errno;
#endif
    return 0;
  }
  char requirement[64]; memcpy(requirement, "cdhash H\"", 9);
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 20; i++) { requirement[9+i*2] = hex[hash[i] >> 4]; requirement[10+i*2] = hex[hash[i] & 15]; }
  requirement[49] = '"'; requirement[50] = 0;
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof token);
  if (!data) return 0;
  const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { data };
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL; SecRequirementRef req = NULL;
  CFStringRef text = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
  OSStatus guest_status=-1,requirement_status=-1,validity_status=-1;
  if(attrs && text)guest_status=SecCodeCopyGuestWithAttributes(NULL,attrs,kSecCSDefaultFlags,&code);
  if(guest_status==errSecSuccess)requirement_status=SecRequirementCreateWithString(text,kSecCSDefaultFlags,&req);
  if(requirement_status==errSecSuccess)validity_status=SecCodeCheckValidity(code,kSecCSStrictValidate,req);
  int ok=guest_status==errSecSuccess && requirement_status==errSecSuccess && validity_status==errSecSuccess;
#ifdef BRAIN_PEER_DIAGNOSTIC
  if(!ok)fprintf(stderr,"PEER_SIGNATURE pid=%d alive=%d guest=%d requirement=%d validity=%d\n",pid,kill(pid,0)==0,(int)guest_status,(int)requirement_status,(int)validity_status);
#endif
  if (req) CFRelease(req); if (code) CFRelease(code); if (text) CFRelease(text); if (attrs) CFRelease(attrs); CFRelease(data);
  return ok;
}

static int brain_send_fd(int socket_fd, int secret_fd) {
  char marker = 1; struct iovec io = { .iov_base = &marker, .iov_len = 1 };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr msg = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(c), &secret_fd, sizeof secret_fd);
  int no_signal = 1; if (setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE, &no_signal, sizeof no_signal)) return 0;
  ssize_t sent; do { sent = sendmsg(socket_fd, &msg, MSG_DONTWAIT); } while (sent < 0 && errno == EINTR);
  return sent == 1;
}

static int brain_receive_fd(int socket_fd) {
  char marker = 0; struct iovec io = { .iov_base = &marker, .iov_len = 1 };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int) * 8)]; } control = {0};
  struct msghdr msg = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  ssize_t got; do { got = recvmsg(socket_fd, &msg, MSG_DONTWAIT); } while (got < 0 && errno == EINTR);
  int result = -1, count = 0, invalid = got != 1 || marker != 1 || (msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC));
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
    if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len < CMSG_LEN(0)) { invalid = 1; continue; }
    size_t bytes = c->cmsg_len - CMSG_LEN(0); if (bytes % sizeof(int)) invalid = 1;
    for (size_t i = 0; i < bytes / sizeof(int); i++) { int fd; memcpy(&fd, CMSG_DATA(c) + i * sizeof(int), sizeof fd); if (count++ == 0) result = fd; else close(fd); }
  }
  struct stat info;
  if (invalid || count != 1 || fstat(result, &info) || (!S_ISSOCK(info.st_mode) && !S_ISFIFO(info.st_mode))
      || fcntl(result, F_SETFD, FD_CLOEXEC) < 0) { if (result >= 0) close(result); return -1; }
  return result;
}

static int64_t millis(void) {
  struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int transfer(int fd, uint8_t *buf, size_t length, int writing, int64_t deadline) {
  while (length) {
    int64_t now = millis(); if (now < 0 || now >= deadline) return 0;
    int64_t remaining = deadline - now; struct pollfd event = { .fd = fd, .events = writing ? POLLOUT : POLLIN };
    int ready = poll(&event, 1, (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (event.revents & (POLLERR | POLLNVAL))) return 0;
    ssize_t n = writing ? write(fd, buf, length) : read(fd, buf, length);
    if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (n <= 0) return 0; buf += n; length -= (size_t)n;
  }
  return 1;
}
static int prepare_io(int fd, int timeout_ms, int64_t *deadline) {
  if (timeout_ms <= 0 || timeout_ms > 300000) return 0;
  int flags = fcntl(fd, F_GETFL); if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 || fcntl(fd, F_SETNOSIGPIPE, 1) < 0) return 0;
  int64_t now = millis(); if (now < 0) return 0; *deadline = now + timeout_ms; return 1;
}
int brain_read_frame(int fd, uint8_t *buffer, size_t capacity, size_t *length, int timeout_ms) {
  int64_t deadline; uint32_t wire;
  if (!buffer || !length || !prepare_io(fd, timeout_ms, &deadline) || !transfer(fd, (uint8_t *)&wire, sizeof wire, 0, deadline)) return 0;
  size_t size = ntohl(wire); if (!size || size > 16384 || size > capacity || !transfer(fd, buffer, size, 0, deadline)) return 0;
  *length = size; return 1;
}
int brain_write_frame(int fd, const uint8_t *buffer, size_t length, int timeout_ms) {
  int64_t deadline; if (!buffer || !length || length > 16384 || !prepare_io(fd, timeout_ms, &deadline)) return 0;
  uint32_t wire = htonl((uint32_t)length);
  return transfer(fd, (uint8_t *)&wire, sizeof wire, 1, deadline) && transfer(fd, (uint8_t *)buffer, length, 1, deadline);
}

static int wait_fd(int fd, short flags, int timeout_ms) {
  int64_t start = millis(); if (start < 0) return 0; int64_t deadline = start + timeout_ms;
  for (;;) {
    int64_t now = millis(); if (now < 0 || now >= deadline) return 0;
    struct pollfd event = { .fd = fd, .events = flags };
    int ready = poll(&event, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    return ready > 0 && (event.revents & flags) && !(event.revents & (POLLERR | POLLNVAL));
  }
}
int brain_peer_open(brain_peer_session *session, int fd, uid_t uid, pid_t pid, const uint8_t hash[20]) {
  if (!session) return 0;
  *session = (brain_peer_session){ .fd = -1 };
  if (!brain_verify_peer(fd, uid, pid, hash)) { close(fd); return 0; }
  session->fd = fd; session->authenticated = 1; return 1;
}
int brain_peer_send_fd(brain_peer_session *session, int secret_fd, int timeout_ms) {
  if (!session || !session->authenticated || session->sent || secret_fd < 0 || timeout_ms <= 0 || timeout_ms > 300000) return 0;
  session->sent = 1;
  if (!wait_fd(session->fd, POLLOUT, timeout_ms) || !brain_send_fd(session->fd, secret_fd)) { brain_peer_close(session); return 0; }
  return 1;
}
int brain_peer_receive_fd(brain_peer_session *session, int timeout_ms) {
  if (!session || !session->authenticated || session->received || timeout_ms <= 0 || timeout_ms > 300000) return -1;
  session->received = 1;
  if (!wait_fd(session->fd, POLLIN, timeout_ms)) { brain_peer_close(session); return -1; }
  int fd = brain_receive_fd(session->fd);
  if (fd < 0) brain_peer_close(session);
  return fd;
}
void brain_peer_close(brain_peer_session *session) {
  if (!session) return;
  if (session->fd >= 0) close(session->fd);
  *session = (brain_peer_session){ .fd = -1 };
}
