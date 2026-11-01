#include "supervisor-store.h"
#include <uuid/uuid.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <stdio.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
/* libpq 공개 ABI. 연결과 자격은 보호 service의 소유이며 이 모듈은 URL을 받지 않는다. */
typedef struct pg_result PGresult;
extern int PQstatus(const PGconn *);
extern int PQtransactionStatus(const PGconn *);
extern PGresult *PQexec(PGconn *,const char *);
extern PGresult *PQexecParams(PGconn *,const char *,int,const unsigned int *,const char *const *,const int *,const int *,int);
extern int PQresultStatus(const PGresult *);
extern int PQntuples(const PGresult *);
extern int PQnfields(const PGresult *);
extern char *PQgetvalue(const PGresult *,int,int);
extern void PQclear(PGresult *);
enum { CONNECTION_OK=0, TRANSACTION_IDLE=0, COMMAND_OK=1, TUPLES_OK=2 };
static int command(brain_supervisor_pg_store *s,const char *query) {
  PGresult *r=PQexec(s->connection,query);int ok=r && PQresultStatus(r)==COMMAND_OK;if(r)PQclear(r);return ok;
}
static int begin(brain_supervisor_pg_store *s) {
  if(!s || !s->connection || s->unusable || PQstatus(s->connection)!=CONNECTION_OK || PQtransactionStatus(s->connection)!=TRANSACTION_IDLE)return 0;
  if(command(s,"begin") && command(s,"set local statement_timeout='2s'") && command(s,"set local lock_timeout='2s'")
    && command(s,"set local transaction_timeout='2s'") && command(s,"set local idle_in_transaction_session_timeout='2s'"))return 1;
  (void)command(s,"rollback");s->unusable=1;return 0;
}
static int finish(brain_supervisor_pg_store *s,int success) {
  if(!success){if(!command(s,"rollback"))s->unusable=1;return 0;}
  if(!command(s,"commit")){s->unusable=1;return 0;}return 1;
}
static int same(const brain_auth_binding *a,const brain_auth_binding *b) {
  return a && b && !memcmp(a->work,b->work,16) && !memcmp(a->attempt,b->attempt,16) && a->run_generation==b->run_generation && a->binding_generation==b->binding_generation && a->package_generation==b->package_generation && a->connection_epoch==b->connection_epoch && !memcmp(a->package,b->package,32);
}
static int single(brain_supervisor_pg_store *s,const char *query,int count,const char *const *params,const char *expected) {
  PGresult *r=PQexecParams(s->connection,query,count,NULL,params,NULL,NULL,0);
  int ok=r && PQresultStatus(r)==TUPLES_OK && PQntuples(r)==1 && PQnfields(r)==1 && !strcmp(PQgetvalue(r,0,0),expected);
  if(r)PQclear(r);return ok;
}
static int identity(brain_supervisor_pg_store *s) {
  return single(s,"select (session_user='brain_protected_supervisor')::text",0,NULL,"true");
}
static void params(const brain_auth_binding *b,char work[37],char token[37],char run[32]) {
  uuid_unparse_lower(b->work,work);uuid_unparse_lower(b->attempt,token);snprintf(run,32,"%llu",(unsigned long long)b->run_generation);
}
static int admit(void *context,const brain_auth_binding *binding) {
  brain_supervisor_pg_store *s=context;if(!s || s->admitted || !same(&s->binding,binding) || !begin(s))return 0;
  char work[37],token[37],run[32],generation[32];params(binding,work,token,run);
  snprintf(generation,sizeof generation,"%llu",(unsigned long long)binding->binding_generation);const char *p[]={work,token,run,s->target,generation,s->zone};
  int ok=identity(s) && single(s,"select garmin.reserve_admission($1::uuid,$2::uuid,$3::bigint,$4,$5::bigint,$6)::text",6,p,"true");
  if(!finish(s,ok))return 0;s->admitted=1;return 1;
}
static int admission_current(void *context,const brain_auth_binding *binding) {
  brain_supervisor_pg_store *s=context;if(!s || !same(&s->binding,binding) || !begin(s))return 0;
  char work[37],token[37],run[32],generation[32];params(binding,work,token,run);
  snprintf(generation,sizeof generation,"%llu",(unsigned long long)binding->binding_generation);const char *p[]={work,token,run,s->target,generation};
  int ok=identity(s) && single(s,"select brain.begin_protected_input_launch($1::uuid,$2::uuid,$3::bigint)::text",3,p,"true")
    && single(s,"select garmin.supervisor_admission_valid($1::uuid,$2::uuid,$3::bigint,$4,$5::bigint)::text",5,p,"true");
  if(!finish(s,ok))return 0;s->admitted=1;return 1;
}
static int identity_current(void *context,const brain_auth_binding *binding,uint64_t sec,uint64_t usec) {
  brain_supervisor_pg_store *s=context;if(!s || !s->admitted || !same(&s->binding,binding) || binding->worker_pid<=0 || !sec || usec>=1000000 || !begin(s))return 0;
  struct timeval boot;size_t size=sizeof boot;if(sysctlbyname("kern.boottime",&boot,&size,NULL,0) || size!=sizeof boot)return finish(s,0);
  char work[37],token[37],run[32],pid[32],bootsec[32],start[64],lease[37],epoch[32],generation[32];params(binding,work,token,run);
  uuid_unparse_lower(binding->launch_lease,lease);snprintf(epoch,sizeof epoch,"%llu",(unsigned long long)binding->connection_epoch);
  snprintf(pid,sizeof pid,"%ld",(long)binding->worker_pid);snprintf(bootsec,sizeof bootsec,"%lld",(long long)boot.tv_sec);
  snprintf(start,sizeof start,"%llu.%06llu",(unsigned long long)sec,(unsigned long long)usec);
  snprintf(generation,sizeof generation,"%llu",(unsigned long long)binding->binding_generation);
  const char *p[]={work,token,run,pid,bootsec,start,lease,epoch,s->target,generation};
  int ok=identity(s) && single(s,"select (brain.attempt_is_current($1::uuid,$2::uuid) and garmin.supervisor_admission_valid($1::uuid,$2::uuid,$3::bigint,$9,$10::bigint) and exists(select 1 from brain.work_items w join brain.work_attempts a on a.token=w.current_attempt_token where w.id=$1::uuid and w.attempts=$3::bigint and w.cancel_requested_at is null and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group) and a.pid=$4::integer and a.pgid=$4::integer and a.os_boot_at=to_timestamp($5::double precision) and a.os_started_at=to_timestamp($6::double precision) and a.protected_launch_lease=$7::uuid and a.protected_connection_epoch=$8::bigint and exists(select 1 from brain.protected_input_launches l where l.work_id=w.id and l.attempt_token=a.token and l.run_generation=w.attempts and l.state='spawning')))::text",10,p,"true");
  return finish(s,ok);
}
static int record(void *context,const brain_auth_binding *binding,uint64_t sec,uint64_t usec) {
  brain_supervisor_pg_store *s=context;if(!s || !s->admitted || !same(&s->binding,binding) || binding->worker_pid<=0 || !sec || usec>=1000000)return 0;
  unsigned lease_nonzero=0;for(size_t i=0;i<16;i++)lease_nonzero|=binding->launch_lease[i];if(!lease_nonzero || !begin(s))return 0;
  struct timeval boot;size_t size=sizeof boot;if(sysctlbyname("kern.boottime",&boot,&size,NULL,0) || size!=sizeof boot)return finish(s,0);
  char work[37],token[37],run[32],pid[32],bootsec[32],start[64],lease[37],epoch[32];params(binding,work,token,run);uuid_unparse_lower(binding->launch_lease,lease);snprintf(epoch,sizeof epoch,"%llu",(unsigned long long)binding->connection_epoch);
  snprintf(pid,sizeof pid,"%ld",(long)binding->worker_pid);snprintf(bootsec,sizeof bootsec,"%lld",(long long)boot.tv_sec);snprintf(start,sizeof start,"%llu.%06llu",(unsigned long long)sec,(unsigned long long)usec);
  const char *p[]={work,token,run,pid,bootsec,start,lease,epoch};
  int ok=identity(s) && single(s,"with updated as (update brain.work_attempts set pid=$4::integer,pgid=$4::integer,os_boot_at=to_timestamp($5::double precision),os_started_at=to_timestamp($6::double precision),protected_launch_lease=$7::uuid,protected_connection_epoch=$8::bigint where token=$2::uuid and work_item_id=$1::uuid and (protected_launch_lease is null or (protected_launch_lease=$7::uuid and protected_connection_epoch=$8::bigint and pid=$4::integer and os_boot_at=to_timestamp($5::double precision) and os_started_at=to_timestamp($6::double precision))) and brain.attempt_is_current($1::uuid,$2::uuid) and exists(select 1 from brain.work_items w where w.id=$1::uuid and w.attempts=$3::bigint and w.kind='garmin.auth' and w.cancel_requested_at is null and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group) and exists(select 1 from brain.protected_input_launches l where l.work_id=w.id and l.attempt_token=$2::uuid and l.run_generation=w.attempts and l.state='spawning')) returning 1) select count(*)::text from updated",8,p,"1");
  return finish(s,ok);
}
static int cancelled(void *context) {
  brain_supervisor_pg_store *s=context;if(!s || !begin(s))return 1;char work[37],token[37],run[32];params(&s->binding,work,token,run);const char *p[]={work,token,run};
  int ok=identity(s) && single(s,"select (brain.attempt_is_current($1::uuid,$2::uuid) and exists(select 1 from brain.work_items w where w.id=$1::uuid and w.attempts=$3::bigint and w.kind='garmin.auth' and w.cancel_requested_at is null and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group)))::text",3,p,"true");
  return !finish(s,ok);
}
int brain_supervisor_pg_admission_context(PGconn *connection,const brain_auth_binding *binding,char target[1025],uint64_t *generation) {
  if(!connection || !binding || !target || !generation || !binding->run_generation)return 0;
  target[0]=0;*generation=0;brain_supervisor_pg_store s={.connection=connection};if(!begin(&s))return 0;
  char work[37],token[37],run[32];params(binding,work,token,run);const char *p[]={work,token,run};
  PGresult *r=identity(&s)?PQexecParams(s.connection,"select target,binding_generation::text from garmin.supervisor_admission_context($1::uuid,$2::uuid,$3::bigint)",3,NULL,p,NULL,NULL,0):NULL;
  int ok=r && PQresultStatus(r)==TUPLES_OK && PQntuples(r)==1 && PQnfields(r)==2;
  if(ok) {
    const char *text=PQgetvalue(r,0,0),*number=PQgetvalue(r,0,1);char *end=NULL;errno=0;
    unsigned long long value=strtoull(number,&end,10);size_t n=strlen(text);
    ok=n>0 && n<1025 && *number && number[0]!='-' && end && !*end && !errno && value>0;
    if(ok){memcpy(target,text,n+1);*generation=(uint64_t)value;}
  }
  if(r)PQclear(r);if(!finish(&s,ok)){target[0]=0;*generation=0;return 0;}return 1;
}
int brain_supervisor_pg_init(brain_supervisor_pg_store *s,PGconn *connection,const brain_auth_binding *binding,const char *target,const char *zone) {
  if(!s)return 0;memset(s,0,sizeof *s);s->unusable=1;
  if(!connection || !binding || !target || !*target || strlen(target)>=sizeof s->target || !zone || !*zone || strlen(zone)>=sizeof s->zone || !binding->run_generation || !binding->binding_generation || !binding->package_generation || !binding->connection_epoch)return 0;
  s->connection=connection;s->binding=*binding;memcpy(s->target,target,strlen(target)+1);memcpy(s->zone,zone,strlen(zone)+1);s->unusable=0;
  if(!begin(s))return 0;return finish(s,identity(s));
}
brain_supervisor_store_ops brain_supervisor_pg_ops(brain_supervisor_pg_store *s) {return (brain_supervisor_store_ops){.context=s,.target=s?s->target:NULL,.admit=admit,.record_identity=record,.admission_current=admission_current,.identity_current=identity_current,.cancelled=cancelled};}
int brain_supervisor_pg_revoke_action(brain_supervisor_pg_store *s,brain_xpc_peer *broker,const brain_auth_binding *b,brain_protected_action action,int timeout_ms) {
  if(!s || !s->admitted || !same(&s->binding,b) || !broker || (action!=BRAIN_PROTECTED_CANCEL && action!=BRAIN_PROTECTED_HOLD && action!=BRAIN_PROTECTED_DISABLE)
    || !brain_submission_revoke(broker,b,timeout_ms) || !begin(s))return 0;
  char work[37],token[37],run[32],epoch[32],lease[37];params(b,work,token,run);uuid_unparse_lower(b->launch_lease,lease);
  snprintf(epoch,sizeof epoch,"%llu",(unsigned long long)b->connection_epoch);const char *p[]={work,token,run,epoch,lease};
  int ok=identity(s) && single(s,"select brain.record_protected_auth_revoke($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::uuid)::text",5,p,"true");
  if(ok && action==BRAIN_PROTECTED_CANCEL)ok=single(s,"with changed as (update brain.work_items set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where id=$1::uuid and current_attempt_token=$2::uuid and kind='garmin.auth' returning 1) select count(*)::text from changed",2,p,"1");
  if(ok && action==BRAIN_PROTECTED_DISABLE)ok=single(s,"with changed as (update brain.extensions set enabled=false,enabled_changed_at=case when enabled then clock_timestamp() else enabled_changed_at end where name='garmin' returning 1) select count(*)::text from changed",0,NULL,"1");
  if(ok && (action==BRAIN_PROTECTED_HOLD || action==BRAIN_PROTECTED_DISABLE))ok=command(s,"insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',clock_timestamp()) on conflict(name) do nothing");
  return finish(s,ok);
}
