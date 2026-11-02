#include "sealed-supervisor-launch.h"
#include "sealed-registry.h"
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>
static int identity(pid_t pid,uint64_t *boot,uint64_t *start) {
  struct timeval time;size_t len=sizeof time;struct proc_bsdinfo info;
  if(sysctlbyname("kern.boottime",&time,&len,NULL,0)||len!=sizeof time||time.tv_sec<=0||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof info)!=(int)sizeof info
    ||info.pbi_pid!=(uint32_t)pid||info.pbi_ppid!=(uint32_t)getpid()||!info.pbi_start_tvsec||info.pbi_start_tvusec>=1000000)return 0;
  *boot=(uint64_t)time.tv_sec;*start=(uint64_t)info.pbi_start_tvsec*1000000+info.pbi_start_tvusec;return 1;
}
static int start_supervisor(brain_queue_session *s,int reg,int payload,const brain_sealed_supervisor_store *store,uid_t owner) {
  if(!s||!store||!store->record||!store->confirm||geteuid()==0)return 0;
  *s=(brain_queue_session){.node={.fd=-1},.service={.fd=-1},.bootstrap_fd=-1};
  uint8_t node[20],package[32],again_node[20],again_package[32];int peer[2]={-1,-1},ack[2]={-1,-1},config[2]={-1,-1},p=-1,a=-1,c=-1;
#ifdef BRAIN_REGISTRY_FIXTURE
  int valid=brain_supervisor_registry_identity_fixture(reg,payload,owner,node,package);
#else
  int valid=owner==0&&brain_supervisor_registry_identity(reg,payload,node,package);
#endif
  if(!valid||socketpair(AF_UNIX,SOCK_STREAM,0,peer)||socketpair(AF_UNIX,SOCK_STREAM,0,ack)||socketpair(AF_UNIX,SOCK_STREAM,0,config))goto fail;
  p=fcntl(peer[1],F_DUPFD_CLOEXEC,10);a=fcntl(ack[1],F_DUPFD_CLOEXEC,10);c=fcntl(config[1],F_DUPFD_CLOEXEC,10);if(p<0||a<0||c<0)goto fail;
#ifdef BRAIN_REGISTRY_FIXTURE
  if(!brain_spawn_supervisor_registry_fixture(reg,payload,owner,p,a,c,&s->child))goto fail;
#else
  if(!brain_spawn_supervisor_registry(reg,payload,p,a,c,&s->child))goto fail;
#endif
  close(p);p=-1;close(a);a=-1;close(c);c=-1;close(peer[1]);peer[1]=-1;close(ack[1]);ack[1]=-1;close(config[1]);config[1]=-1;
  uint64_t boot=0,start=0;if(!identity(s->child,&boot,&start)||!store->record(store->context,s->child,geteuid(),boot,start,package,node))goto fail;
#ifdef BRAIN_REGISTRY_FIXTURE
  valid=brain_supervisor_registry_identity_fixture(reg,payload,owner,again_node,again_package);
#else
  valid=brain_supervisor_registry_identity(reg,payload,again_node,again_package);
#endif
  uint64_t again_boot=0,again_start=0;
  if(!valid||memcmp(node,again_node,20)||memcmp(package,again_package,32)||!identity(s->child,&again_boot,&again_start)||boot!=again_boot||start!=again_start||kill(s->child,SIGCONT))goto fail;
  struct pollfd e={.fd=peer[0],.events=POLLIN};uint8_t hello=0;if(poll(&e,1,5000)!=1||read(peer[0],&hello,1)!=1||hello!=1)goto fail;
  if(!brain_data_peer_open(&s->node,peer[0],geteuid(),s->child,node)){peer[0]=-1;goto fail;}peer[0]=-1;
  if(!store->confirm(store->context,s->child,geteuid(),boot,start,package,node))goto fail;
  s->bootstrap_fd=ack[0];ack[0]=-1;int no_signal=1;if(setsockopt(s->bootstrap_fd,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof no_signal))goto fail;
  uint8_t allow=1;if(write(s->bootstrap_fd,&allow,1)!=1)goto fail;
  s->supervisor_config_fd=config[0];s->supervisor_config_open=1;config[0]=-1;return 1;
fail:
  if(p>=0)close(p);if(a>=0)close(a);if(c>=0)close(c);for(int i=0;i<2;i++){if(peer[i]>=0)close(peer[i]);if(ack[i]>=0)close(ack[i]);if(config[i]>=0)close(config[i]);}
  brain_queue_session_close(s);return 0;
}
int brain_sealed_supervisor_start(brain_queue_session *s,int r,int p,const brain_sealed_supervisor_store *store){return start_supervisor(s,r,p,store,0);}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_sealed_supervisor_start_fixture(brain_queue_session *s,int r,int p,const brain_sealed_supervisor_store *store,uid_t owner){return start_supervisor(s,r,p,store,owner);}
#endif
