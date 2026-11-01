#include "child-bootstrap.h"
#include "peer.h"
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <uuid/uuid.h>

static int bootstrap_acknowledged=0,bootstrap_started=0;
int brain_child_bootstrap(const uint8_t host_hash[20], int timeout_ms) {
  if (bootstrap_started || !host_hash || timeout_ms <= 0 || timeout_ms > 300000 || geteuid() == 0) return 0;
  bootstrap_started=1;
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
    if (got==1 && ack==1) {bootstrap_acknowledged=1;return 1;}
    close(4); return 0;
  }
  close(3); close(4); return 0;
}
int brain_child_read_metadata(brain_child_metadata *m,int timeout_ms) {
  static int consumed=0;if(!bootstrap_acknowledged || consumed)return 0;consumed=1;
  uint8_t p[1235];size_t n=0;if(!m || !brain_read_frame(4,p,sizeof p,&n,timeout_ms))return 0;
  return brain_child_decode_metadata(m,p,n);
}
int brain_child_decode_metadata(brain_child_metadata *m,const uint8_t *p,size_t n) {
  if(!m || !p || n<47 || n>1235 || p[0]!=1)return 0;
  size_t zone=(size_t)p[41]*256+p[42],target=(size_t)p[43]*256+p[44],id=p[46];
  if(!zone || zone>128 || !target || target>1024 || (p[45]!=1 && p[45]!=2) || !id || id>36 || n!=47+zone+target+id || memchr(p+47+zone,0,target))return 0;
  if(memchr(p+47+zone+target,0,id))return 0;
  char target_id[37];memcpy(target_id,p+47+zone+target,id);target_id[id]=0;uuid_t parsed;
  if((p[45]==1 && strcmp(target_id,"garmin")) || (p[45]==2 && (id!=36 || uuid_parse(target_id,parsed) || uuid_is_null(parsed))))return 0;
  unsigned work=0,attempt=0;for(int i=0;i<16;i++){work|=p[1+i];attempt|=p[17+i];}if(!work || !attempt)return 0;
  uint64_t run=0;for(int i=33;i<41;i++)run=(run<<8)|p[i];if(!run)return 0;
  for(size_t i=0;i<zone;i++){uint8_t c=p[47+i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='/'||c=='_'||c=='-'||c=='+'))return 0;}
  memset(m,0,sizeof *m);memcpy(m->work,p+1,16);memcpy(m->attempt,p+17,16);m->run=run;
  memcpy(m->timezone,p+47,zone);memcpy(m->tokenstore,p+47+zone,target);memcpy(m->target_id,target_id,id);m->account_target=p[45]==2;return 1;
}
