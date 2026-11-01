#include "child-bootstrap.h"
#include "peer.h"
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>

int brain_child_bootstrap(const uint8_t host_hash[20], int timeout_ms) {
  if (!host_hash || timeout_ms <= 0 || timeout_ms > 300000 || geteuid() == 0) return 0;
  struct timespec begin; if (clock_gettime(CLOCK_MONOTONIC,&begin)) return 0;
  if (fcntl(3,F_SETFD,FD_CLOEXEC) || fcntl(4,F_SETFD,FD_CLOEXEC)
      || !brain_verify_peer(4,geteuid(),getppid(),host_hash)
      || !brain_write_frame(4,(const uint8_t *)"hello",5,timeout_ms)) { close(3); close(4); return 0; }
  int64_t deadline=(int64_t)begin.tv_sec*1000+begin.tv_nsec/1000000+timeout_ms;
  for (;;) {
    struct timespec current; if (clock_gettime(CLOCK_MONOTONIC,&current)) break;
    int64_t remaining=deadline-((int64_t)current.tv_sec*1000+current.tv_nsec/1000000); if (remaining<=0) break;
    struct pollfd event={.fd=3,.events=POLLIN}; int n=poll(&event,1,(int)remaining);
    if (n<0 && errno==EINTR) continue;
    if (n<=0 || !(event.revents&POLLIN)) break;
    unsigned char ack=0; ssize_t got=read(3,&ack,1); close(3);
    if (got==1 && ack==1) return 1;
    close(4); return 0;
  }
  close(3); close(4); return 0;
}
