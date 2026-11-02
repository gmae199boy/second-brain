/* 실제 격리 PG와 제품 launcher/store를 연결하는 합성 fixture다. */
#include "../sealed-supervisor-launch.h"
#include "../sealed-supervisor-store.h"
#include "../sealed-registry.h"
#include "../supervisor-authority.h"
#include "../peer.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
typedef struct pg_result PGresult;
extern PGconn *PQconnectdb(const char *);
extern void PQfinish(PGconn *),PQclear(PGresult *);
extern PGresult *PQexec(PGconn *,const char *);
extern int PQstatus(const PGconn *),PQresultStatus(const PGresult *);
static const char *swap_path;static char moved[PATH_MAX];
void brain_registry_fixture_before_spawn(void) {if(!swap_path)return;if(snprintf(moved,sizeof moved,"%s-moved",swap_path)>=(int)sizeof moved||rename(swap_path,moved)||symlink(moved,swap_path))_exit(20);}
static brain_sealed_supervisor_store real_store;
static int lost_record(void *ctx,pid_t p,uid_t u,uint64_t b,uint64_t t,const uint8_t package[32],const uint8_t node[20]) {
  (void)ctx;(void)real_store.record(real_store.context,p,u,b,t,package,node);return 0;
}
static int lost_confirm(void *ctx,pid_t p,uid_t u,uint64_t b,uint64_t t,const uint8_t package[32],const uint8_t node[20]) {
  (void)ctx;(void)real_store.confirm(real_store.context,p,u,b,t,package,node);return 0;
}
int main(int argc,char **argv) {
  if(argc!=4)return 2;char connection[2049];size_t n=0;while(n<sizeof connection-1){ssize_t r=read(8,connection+n,sizeof connection-1-n);if(r<0&&errno==EINTR)continue;if(r<0)return 3;if(!r)break;n+=(size_t)r;}if(!n||n==sizeof connection-1)return 3;connection[n]=0;
  char config[2049]="{\"mode\":\"probe\"}";char *separator=strchr(connection,'\n');
  if(separator){*separator++=0;if(!*separator||strlen(separator)>=sizeof config)return 3;strcpy(config,separator);}
  PGconn *db=PQconnectdb(connection);memset(connection,0,sizeof connection);if(!db||PQstatus(db)!=0)return 4;
  PGresult *role=PQexec(db,"set session authorization brain_protected_supervisor");int valid=role&&PQresultStatus(role)==1;if(role)PQclear(role);if(!valid){PQfinish(db);return 5;}
  int reg=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),payload=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(reg<0||payload<0){PQfinish(db);return 6;}
  brain_sealed_supervisor_pg_store pg;if(!brain_sealed_supervisor_pg_init(&pg,db))return 7;real_store=brain_sealed_supervisor_pg_ops(&pg);brain_sealed_supervisor_store ops=real_store;
  if(!strcmp(argv[3],"lost"))ops.record=lost_record;
  if(!strcmp(argv[3],"lost-confirm"))ops.confirm=lost_confirm;
  if(!strcmp(argv[3],"swap"))swap_path=argv[2];
  brain_queue_session session;int started=brain_sealed_supervisor_start_fixture(&session,reg,payload,&ops,geteuid());
  if(swap_path && (unlink(swap_path)||rename(moved,swap_path)))return 21;
  if(!started){memset(config,0,sizeof config);close(reg);close(payload);PQfinish(db);return 8;}
  int sent=brain_write_frame(session.supervisor_config_fd,(const uint8_t *)config,strlen(config),5000);memset(config,0,sizeof config);if(!sent){brain_queue_session_close(&session);PQfinish(db);return 25;}
  uint8_t node_hash[20],package_hash[32];if(!brain_supervisor_registry_identity_fixture(reg,payload,geteuid(),node_hash,package_hash))return 22;
  uint8_t data[64];size_t size=0;
  const char *expected=!strcmp(argv[3],"service")?"service-ready":"bootstrap-only";
  if(!brain_data_peer_read(&session.node,data,sizeof data,&size,10000)||size!=strlen(expected)||memcmp(data,expected,size)){brain_queue_session_close(&session);PQfinish(db);return 9;}
  if(!brain_supervisor_authority_fixture(session.node.fd,geteuid(),session.child,node_hash,reg,payload,db,geteuid())||brain_supervisor_authority_fixture(session.node.fd,geteuid(),session.child+1,node_hash,reg,payload,db,geteuid()))return 23;
  uint8_t bad_hash[20];memcpy(bad_hash,node_hash,20);bad_hash[0]^=1;if(brain_supervisor_authority_fixture(session.node.fd,geteuid(),session.child,bad_hash,reg,payload,db,geteuid()))return 24;
  printf("ACTIVE %ld\n",(long)session.child);fflush(stdout);uint8_t release=0;ssize_t got;
  for(;;){do{got=read(9,&release,1);}while(got<0&&errno==EINTR);if(got!=1||release!='V')break;
    int current=brain_supervisor_authority_fixture(session.node.fd,geteuid(),session.child,node_hash,reg,payload,db,geteuid());printf("%s\n",current?"VALID":"REJECT");fflush(stdout);}
  close(reg);close(payload);
  if(!strcmp(argv[3],"reaped")){kill(session.child,SIGKILL);waitpid(session.child,NULL,0);}
  int closed=brain_queue_session_close(&session);int released=got==1&&release==1&&brain_sealed_supervisor_pg_release(&pg,closed);PQfinish(db);
  printf("%s\n",released?"CLOSED":"UNKNOWN");return released?0:10;
}
