#include "sealed-supervisor-store.h"
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <uuid/uuid.h>
typedef struct pg_result PGresult;
extern int PQstatus(const PGconn *),PQtransactionStatus(const PGconn *),PQresultStatus(const PGresult *),PQntuples(const PGresult *),PQnfields(const PGresult *);
extern int PQsetnonblocking(PGconn *,int),PQsendQueryParams(PGconn *,const char *,int,const unsigned int *,const char *const *,const int *,const int *,int);
extern int PQflush(PGconn *),PQconsumeInput(PGconn *),PQisBusy(PGconn *),PQsocket(const PGconn *);
extern PGresult *PQgetResult(PGconn *);
extern char *PQgetvalue(const PGresult *,int,int);
extern void PQclear(PGresult *);
static int64_t millis(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return -1;return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000;}
/* 단일 자동 commit statement의 완료까지 실제 경과 시간 2초를 제한한다. 불명 연결은 재사용하지 않는다. */
static int query(brain_sealed_supervisor_pg_store *s,const char *sql,int count,const char *const *values){
  if(!s||!s->connection||s->unusable||PQstatus(s->connection)!=0||PQtransactionStatus(s->connection)!=0)return 0;
  int64_t now=millis();if(now<0||!PQsendQueryParams(s->connection,sql,count,NULL,values,NULL,NULL,0)){s->unusable=1;return 0;}int64_t deadline=now+2000;
  int flushed=0,seen=0,ok=0;
  for(;;){
    if(!flushed){int f=PQflush(s->connection);if(f<0)break;if(f==0)flushed=1;}
    if(flushed&&!PQisBusy(s->connection)){
      PGresult *r=PQgetResult(s->connection);
      if(!r){if(seen==1&&ok&&PQstatus(s->connection)==0&&PQtransactionStatus(s->connection)==0)return 1;break;}
      seen++;ok=seen==1&&PQresultStatus(r)==2&&PQntuples(r)==1&&PQnfields(r)==1&&!strcmp(PQgetvalue(r,0,0),"true");PQclear(r);continue;
    }
    now=millis();int fd=PQsocket(s->connection);if(now<0||now>=deadline||fd<0)break;
    struct pollfd event={.fd=fd,.events=flushed?POLLIN:POLLOUT};int ready=poll(&event,1,(int)(deadline-now));
    if(ready<0&&errno==EINTR)continue;if(ready<=0||(event.revents&(POLLERR|POLLHUP|POLLNVAL)))break;
    if(flushed&&!PQconsumeInput(s->connection))break;
  }
  s->unusable=1;return 0;
}
static void hex(const uint8_t *value,size_t n,char *out){static const char h[]="0123456789abcdef";for(size_t i=0;i<n;i++){out[2*i]=h[value[i]>>4];out[2*i+1]=h[value[i]&15];}out[n*2]=0;}
static int run(brain_sealed_supervisor_pg_store *s,int confirm,pid_t pid,uid_t uid,uint64_t boot,uint64_t start,const uint8_t package[32],const uint8_t node[20]){
  if(!s||!package||!node||pid<=0||!uid||!boot||!start||(confirm?!s->recorded:s->recorded))return 0;
  char p[32],u[32],b[32],t[32],package_text[65],node_text[41];snprintf(p,sizeof p,"%ld",(long)pid);snprintf(u,sizeof u,"%lu",(unsigned long)uid);snprintf(b,sizeof b,"%llu",(unsigned long long)boot);snprintf(t,sizeof t,"%llu",(unsigned long long)start);hex(package,32,package_text);hex(node,20,node_text);
  const char *args[]={s->token,p,u,b,t,package_text,node_text};
  const char *sql=confirm?"select brain.confirm_sealed_supervisor($1::uuid,$2::integer,$3::bigint,$4::bigint,$5::bigint,$6,$7)::text":"select brain.record_sealed_supervisor($1::uuid,$2::integer,$3::bigint,$4::bigint,$5::bigint,$6,$7)::text";
  if(!query(s,sql,7,args))return 0;if(confirm)s->confirmed=1;else s->recorded=1;return 1;
}
int brain_sealed_supervisor_pg_current(brain_sealed_supervisor_pg_store *s,pid_t pid,uid_t uid,uint64_t boot,uint64_t start,const uint8_t package[32],const uint8_t node[20]) {
  if(!s||!package||!node||pid<=0||!uid||!boot||!start)return 0;
  char p[32],u[32],b[32],t[32],package_text[65],node_text[41];snprintf(p,sizeof p,"%ld",(long)pid);snprintf(u,sizeof u,"%lu",(unsigned long)uid);snprintf(b,sizeof b,"%llu",(unsigned long long)boot);snprintf(t,sizeof t,"%llu",(unsigned long long)start);hex(package,32,package_text);hex(node,20,node_text);
  const char *args[]={p,u,b,t,package_text,node_text};return query(s,"select brain.sealed_supervisor_current($1::integer,$2::bigint,$3::bigint,$4::bigint,$5,$6)::text",6,args);
}
static int record(void *ctx,pid_t p,uid_t u,uint64_t b,uint64_t t,const uint8_t package[32],const uint8_t node[20]){return run(ctx,0,p,u,b,t,package,node);}
static int confirm(void *ctx,pid_t p,uid_t u,uint64_t b,uint64_t t,const uint8_t package[32],const uint8_t node[20]){return run(ctx,1,p,u,b,t,package,node);}
int brain_sealed_supervisor_pg_init(brain_sealed_supervisor_pg_store *s,PGconn *connection){if(!s||!connection||PQsetnonblocking(connection,1))return 0;memset(s,0,sizeof *s);s->connection=connection;uuid_t token;uuid_generate_random(token);uuid_unparse_lower(token,s->token);return 1;}
brain_sealed_supervisor_store brain_sealed_supervisor_pg_ops(brain_sealed_supervisor_pg_store *s){return (brain_sealed_supervisor_store){.context=s,.record=record,.confirm=confirm};}
int brain_sealed_supervisor_pg_release(brain_sealed_supervisor_pg_store *s,int confirmed){if(!s||!confirmed||!s->recorded)return 0;const char *args[]={s->token};if(!query(s,"select brain.release_sealed_supervisor($1::uuid)::text",1,args))return 0;s->recorded=0;s->confirmed=0;return 1;}
