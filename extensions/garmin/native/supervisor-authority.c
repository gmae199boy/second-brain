#include "supervisor-authority.h"
#include "sealed-registry.h"
#include "sealed-supervisor-store.h"
#include "broker-credential.h"
#include "peer.h"
#include <fcntl.h>
#include <libproc.h>
#include <stdint.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>
#ifndef BRAIN_SUPERVISOR_REGISTRY_DIR
#define BRAIN_SUPERVISOR_REGISTRY_DIR ""
#endif
#ifndef BRAIN_SUPERVISOR_PAYLOAD_DIR
#define BRAIN_SUPERVISOR_PAYLOAD_DIR ""
#endif
#ifndef BRAIN_SUPERVISOR_CREDENTIAL
#define BRAIN_SUPERVISOR_CREDENTIAL ""
#endif
extern void PQfinish(PGconn *);
static int identity(pid_t pid,uint64_t *boot,uint64_t *start){struct timeval t;size_t n=sizeof t;struct proc_bsdinfo info;
  if(sysctlbyname("kern.boottime",&t,&n,NULL,0)||n!=sizeof t||t.tv_sec<=0||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof info)!=(int)sizeof info||info.pbi_pid!=(uint32_t)pid||!info.pbi_start_tvsec||info.pbi_start_tvusec>=1000000)return 0;
  *boot=(uint64_t)t.tv_sec;*start=(uint64_t)info.pbi_start_tvsec*1000000+info.pbi_start_tvusec;return 1;}
static int check(int fd,uid_t uid,pid_t pid,const uint8_t expected[20],int reg,int payload,PGconn *db,uid_t owner){
  uint8_t node[20],package[32],again_node[20],again_package[32];uint64_t boot=0,start=0,again_boot=0,again_start=0;
  if(!brain_verify_peer(fd,uid,pid,expected)||!identity(pid,&boot,&start))return 0;
#ifdef BRAIN_REGISTRY_FIXTURE
  int valid=brain_supervisor_registry_identity_fixture(reg,payload,owner,node,package);
#else
  int valid=owner==0&&brain_supervisor_registry_identity(reg,payload,node,package);
#endif
  if(!valid||memcmp(node,expected,20))return 0;
  brain_sealed_supervisor_pg_store store;if(!brain_sealed_supervisor_pg_init(&store,db)||!brain_sealed_supervisor_pg_current(&store,pid,uid,boot,start,package,node))return 0;
#ifdef BRAIN_REGISTRY_FIXTURE
  valid=brain_supervisor_registry_identity_fixture(reg,payload,owner,again_node,again_package);
#else
  valid=brain_supervisor_registry_identity(reg,payload,again_node,again_package);
#endif
  return valid&&!memcmp(node,again_node,20)&&!memcmp(package,again_package,32)&&identity(pid,&again_boot,&again_start)&&boot==again_boot&&start==again_start&&brain_verify_peer(fd,uid,pid,expected);
}
int brain_supervisor_authority(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]) {
  if(!BRAIN_SUPERVISOR_REGISTRY_DIR[0]||!BRAIN_SUPERVISOR_PAYLOAD_DIR[0]||!BRAIN_SUPERVISOR_CREDENTIAL[0])return 0;
  int reg=open(BRAIN_SUPERVISOR_REGISTRY_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),payload=open(BRAIN_SUPERVISOR_PAYLOAD_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(reg<0||payload<0){if(reg>=0)close(reg);if(payload>=0)close(payload);return 0;}
  PGconn *db=brain_supervisor_connect_protected(BRAIN_SUPERVISOR_CREDENTIAL);int ok=db&&check(fd,uid,pid,hash,reg,payload,db,0);
  if(db)PQfinish(db);close(reg);close(payload);return ok;
}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_supervisor_authority_fixture(int fd,uid_t uid,pid_t pid,const uint8_t hash[20],int reg,int payload,PGconn *db,uid_t owner){return check(fd,uid,pid,hash,reg,payload,db,owner);}
#ifdef BRAIN_FIXTURE_SUPERVISOR_AUTHORITY
extern PGconn *PQconnectdb(const char *);
extern int PQstatus(const PGconn *);
/* 시험 전용 FD: 운영 credential 경로와 같은 인스턴스 검증 함수를 통과한다. */
int brain_supervisor_authority_fixture_fd(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]) {
  static PGconn *db=NULL;static int attempted=0;
  if(!attempted){attempted=1;char data[2049];size_t n=0;ssize_t count;
    while(n<sizeof data-1&&(count=read(8,data+n,sizeof data-1-n))>0)n+=(size_t)count;
    close(8);if(n&&n<sizeof data-1){data[n]=0;db=PQconnectdb(data);}memset(data,0,sizeof data);
    if(db&&PQstatus(db)){PQfinish(db);db=NULL;}}
  int reg=open(BRAIN_SUPERVISOR_REGISTRY_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),payload=open(BRAIN_SUPERVISOR_PAYLOAD_DIR,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  int ok=db&&reg>=0&&payload>=0&&check(fd,uid,pid,hash,reg,payload,db,geteuid());
  if(reg>=0)close(reg);if(payload>=0)close(payload);return ok;
}
#endif
#endif
