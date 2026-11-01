#include "../supervisor-native.h"
#include "fixture-code-hash.h"
#include <fcntl.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#ifdef FIXTURE_NATIVE_STORE
#include "../supervisor-store.h"
typedef struct pg_result PGresult;
extern PGconn *PQconnectdb(const char *);
extern PGresult *PQexec(PGconn *,const char *);
extern int PQresultStatus(const PGresult *);
extern void PQclear(PGresult *);
extern void PQfinish(PGconn *);
#endif
extern char **environ;
typedef struct {int admission,recorded;} store;
static int sql(const char *statement) {
  posix_spawn_file_actions_t actions;if(posix_spawn_file_actions_init(&actions))return 0;
  int error=posix_spawn_file_actions_addopen(&actions,1,"/dev/null",O_WRONLY,0) || posix_spawn_file_actions_addopen(&actions,2,"/dev/null",O_WRONLY,0);
  char *const argv[]={"docker","exec",FIXTURE_DB_CONTAINER,"psql","-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1","-c",(char *)statement,NULL};pid_t pid=-1;
  if(!error)error=posix_spawnp(&pid,"docker",&actions,NULL,argv,environ);posix_spawn_file_actions_destroy(&actions);if(error)return 0;
  int status=0;if(waitpid(pid,&status,0)!=pid)return 0;return WIFEXITED(status) && WEXITSTATUS(status)==0;
}
static int admit(void *p,const brain_auth_binding *b){store *s=p;if(!b || s->admission)return 0;char work[37],attempt[37],query[2048];uuid_unparse_lower(b->work,work);uuid_unparse_lower(b->attempt,attempt);
  if(getenv("BRAIN_FIXTURE_AUTHORITY"))snprintf(query,sizeof query,"set session authorization brain_protected_supervisor; set statement_timeout='2s'; set lock_timeout='2s'; insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ('%s','garmin.auth','extension','garmin',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:garmin'); insert into brain.work_attempts(token,work_item_id,started_at) values ('%s','%s',now()); update brain.work_items set current_attempt_token='%s' where id='%s'; select 1/(case when garmin.reserve_work_admission('%s','%s',1,'fixture','UTC')->>'state'='admitted' then 1 else 0 end)",work,attempt,work,attempt,work,work,attempt);
  else snprintf(query,sizeof query,"insert into fixture_admission(work,attempt) values ('%s','%s')",work,attempt);
  if(!sql(query))return 0;s->admission=1;return 1;}
static int record(void *p,const brain_auth_binding *b,uint64_t sec,uint64_t usec){store *s=p;if(!s->admission || !b || b->worker_pid<=0 || !sec)return 0;char work[37],attempt[37],query[2048];uuid_unparse_lower(b->work,work);uuid_unparse_lower(b->attempt,attempt);
  if(getenv("BRAIN_FIXTURE_DENY_RECORD"))return sql("select 1/0");
  if(getenv("BRAIN_FIXTURE_AUTHORITY")){
    struct timeval boot;size_t n=sizeof boot;if(sysctlbyname("kern.boottime",&boot,&n,NULL,0) || n!=sizeof boot)return 0;
    snprintf(query,sizeof query,"set session authorization brain_protected_supervisor; set statement_timeout='2s'; set lock_timeout='2s'; with updated as (update brain.work_attempts set pid=%d,pgid=%d,os_boot_at=to_timestamp(%lld),os_started_at=to_timestamp(%llu + %llu/1000000.0) where token='%s' and work_item_id='%s' and brain.attempt_is_current('%s','%s') and exists(select 1 from brain.work_items w where w.id='%s' and w.cancel_requested_at is null and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group)) returning 1) select 1/count(*) from updated",b->worker_pid,b->worker_pid,(long long)boot.tv_sec,(unsigned long long)sec,(unsigned long long)usec,attempt,work,work,attempt,work);
  } else snprintf(query,sizeof query,"with updated as (update fixture_admission set pid=%d,start_sec=%llu,start_usec=%llu where work='%s' and attempt='%s' returning 1) select 1/count(*) from updated",b->worker_pid,(unsigned long long)sec,(unsigned long long)usec,work,attempt);
  if(!sql(query))return 0;s->recorded=1;return 1;}
static int fixture_admission_current(void *p,const brain_auth_binding *b){return b && ((store *)p)->admission;}
static int fixture_identity_current(void *p,const brain_auth_binding *b,uint64_t sec,uint64_t usec){(void)usec;return b && b->worker_pid>0 && sec && ((store *)p)->recorded;}
static int cancelled(void *p){(void)p;return 0;}
#ifdef FIXTURE_NATIVE_STORE
static int claim(const brain_auth_binding *b) {
  char work[37],attempt[37],query[1400];uuid_unparse_lower(b->work,work);uuid_unparse_lower(b->attempt,attempt);
  snprintf(query,sizeof query,"set session authorization brain_protected_supervisor; insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ('%s','garmin.auth','extension','garmin',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:garmin'); insert into brain.work_attempts(token,work_item_id,started_at) values ('%s','%s',now()); update brain.work_items set current_attempt_token='%s' where id='%s'",work,attempt,work,attempt,work);
  return sql(query);
}
#endif
int main(void){
  uint8_t hh[20],bh[20],gh[20];if(!fixture_code_hash(FIXTURE_HOST_PATH,hh) || !fixture_code_hash(FIXTURE_BROKER_PATH,bh) || !fixture_code_hash(FIXTURE_GUI_PATH,gh))return 1;
  brain_host_client host;if(!brain_host_connect(&host,FIXTURE_HOST_SERVICE,geteuid(),hh))return 2;
  brain_xpc_peer broker,gui_peer;if(!brain_submission_connect(&broker,FIXTURE_BROKER_SUPERVISOR,geteuid(),bh,5000) || !brain_submission_connect(&gui_peer,FIXTURE_GUI_SERVICE,geteuid(),gh,5000))return 3;
  brain_gui_client gui={.peer=&gui_peer,.timeout_ms=5000};brain_auth_binding b={.run_generation=1,.binding_generation=1,.package_generation=1,.connection_epoch=1};
  uuid_generate_random(b.work);uuid_generate_random(b.attempt);uuid_generate_random(b.session);memset(b.package,1,32);
  store state={0};brain_supervisor_store_ops ops={.context=&state,.target="fixture",.admit=admit,.record_identity=record,.admission_current=fixture_admission_current,.identity_current=fixture_identity_current,.cancelled=cancelled};
#ifdef FIXTURE_NATIVE_STORE
  if(!claim(&b))return 10;
  if(getenv("BRAIN_FIXTURE_DENY_RECORD") && !sql("create function brain.fixture_reject_record() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$; create trigger fixture_reject_record before update on brain.work_attempts for each row execute function brain.fixture_reject_record()"))return 11;
  if(FIXTURE_CASE==16 && !sql("create function brain.fixture_reject_revoke() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$; create trigger fixture_reject_revoke before insert on brain.protected_auth_revocations for each row execute function brain.fixture_reject_revoke()"))return 18;
  char conninfo[128];snprintf(conninfo,sizeof conninfo,"host=127.0.0.1 port=%d dbname=postgres user=postgres connect_timeout=3",FIXTURE_PG_PORT);
  PGconn *connection=PQconnectdb(conninfo);if(!connection)return 12;PGresult *role=PQexec(connection,"set session authorization brain_protected_supervisor");
  if(!role || PQresultStatus(role)!=1)return 13;PQclear(role);brain_supervisor_pg_store pg;
  if(!brain_supervisor_pg_init(&pg,connection,&b,"fixture","UTC"))return 14;ops=brain_supervisor_pg_ops(&pg);
#endif
  int started=0;
#ifdef FIXTURE_NATIVE_STORE
  if(getenv("BRAIN_FIXTURE_SPLIT")) {
    int stage=ops.admit(ops.context,&b)?1:0;
    if(stage) {
      char target[1025];uint64_t generation=0;brain_auth_binding stale=b;stale.run_generation++;
      if(brain_supervisor_pg_admission_context(connection,&stale,target,&generation)
        || !brain_supervisor_pg_admission_context(connection,&b,target,&generation) || strcmp(target,"fixture") || generation!=b.binding_generation)stage=0;
    }
    if(stage && brain_supervisor_native_start_admitted(&host,&broker,&b,&ops,5000)) {
      stage=2;
      if(ops.record_identity(ops.context,&b,host.start_sec,host.start_usec)) {
        stage=3;started=brain_supervisor_native_authorize_recorded(&host,&broker,&gui,&b,&ops,5000);
      }
      else {brain_host_cancel(&host);brain_xpc_close(&broker);}
    }
    if(!started)dprintf(2,"fixture 분리 단계=%d\n",stage);
  } else
#endif
    started=brain_supervisor_native_bootstrap(&host,&broker,&gui,&b,&ops,5000);
#ifdef FIXTURE_NATIVE_STORE
  if(getenv("BRAIN_FIXTURE_DENY_RECORD")){if(started || !pg.admitted)return 9;brain_host_close(&host);brain_xpc_close(&gui_peer);PQfinish(connection);return 0;}
  if(!started || !pg.admitted)return 4;
#else
  if(getenv("BRAIN_FIXTURE_DENY_RECORD")){if(started || !state.admission || state.recorded)return 9;brain_host_close(&host);brain_xpc_close(&gui_peer);return 0;}
  if(!started || !state.admission || !state.recorded)return 4;
#endif
#ifdef BRAIN_FIXTURE_MULTI_SESSION
  if(getenv("BRAIN_FIXTURE_MULTI_REVOKE")) {
    char request[1024],ack[1024];snprintf(request,sizeof request,"%s/revoke",BRAIN_FIXTURE_BARRIER);snprintf(ack,sizeof ack,"%s/revoked",BRAIN_FIXTURE_BARRIER);
    int found=0;for(int i=0;i<300;i++){if(!access(request,F_OK)){found=1;break;}usleep(100000);}if(!found || !brain_submission_revoke(&broker,&b,5000))return 20;
    int fd=open(ack,O_WRONLY|O_CREAT|O_EXCL,0600);if(fd<0)return 21;close(fd);
  }
#endif
#ifdef FIXTURE_NATIVE_STORE
  if(FIXTURE_CASE>=10 && FIXTURE_CASE<=16) {
    int ready=0;for(int i=0;i<100;i++){if(sql("select 1/(case when exists(select 1 from fixture_sync where mark='ready') then 1 else 0 end)")){ready=1;break;}usleep(100000);}
    brain_protected_action action=(FIXTURE_CASE==10 || FIXTURE_CASE==12 || FIXTURE_CASE==15 || FIXTURE_CASE==16)?BRAIN_PROTECTED_CANCEL:FIXTURE_CASE==14?BRAIN_PROTECTED_DISABLE:BRAIN_PROTECTED_HOLD;
    if(FIXTURE_CASE>=12 && FIXTURE_CASE<=14) {
      const char *direct=action==BRAIN_PROTECTED_CANCEL?"set session authorization brain_protected_supervisor; update brain.work_items set cancel_requested_at=now() where kind='garmin.auth'":action==BRAIN_PROTECTED_HOLD?"set session authorization brain_protected_supervisor; insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',now())":"set session authorization brain_protected_supervisor; update brain.extensions set enabled=false where name='garmin'";
      if(sql(direct))return 17;
    }
    if(!ready)return 15;int mutated=brain_supervisor_pg_revoke_action(&pg,&broker,&b,action,5000);
    if((FIXTURE_CASE==16 && mutated) || (FIXTURE_CASE!=16 && !mutated))return 15;
    if(FIXTURE_CASE==15){
      if(!sql("set session_replication_role=replica; update brain.work_items set cancel_requested_at=null where kind='garmin.auth'; update brain.work_attempts set protected_connection_epoch=2")
        || sql("set session authorization brain_protected_supervisor; update brain.work_items set cancel_requested_at=now() where kind='garmin.auth'"))return 19;
    }
    if(!sql("insert into fixture_sync(mark) values ('continue')"))return 16;
  }
#endif
  int flags=fcntl(host.stdout_fd,F_GETFL);if(flags<0 || fcntl(host.stdout_fd,F_SETFL,flags|O_NONBLOCK)<0)return 5;
  char result[3]={0};ssize_t n=-1;for(int i=0;i<300 && n<0;i++){usleep(10000);n=read(host.stdout_fd,result,2);}
  int outcome=0,status=-1;for(int i=0;i<300 && !outcome;i++){usleep(10000);outcome=brain_host_leader_observed(&host,&status);}
  int negative=(FIXTURE_CASE>=1 && FIXTURE_CASE<=3) || (FIXTURE_CASE>=5 && FIXTURE_CASE<=16) || getenv("BRAIN_FIXTURE_MULTI_REVOKE")!=NULL;
  if((!negative && (n!=2 || memcmp(result,"ok",2))) || (negative && n!=0)) {
    int stage=outcome==1 && WIFEXITED(status)?WEXITSTATUS(status):-1;dprintf(2,"fixture worker 단계=%d\n",stage);return 6;
  }
  if(outcome!=1 || !WIFEXITED(status) || (negative ? WEXITSTATUS(status)==0 : WEXITSTATUS(status)!=0))return 7;
  brain_group_member members[24];size_t member_count=0;int empty=0;
  for(int i=0;i<300;i++){if(brain_host_members(&host,members,24,&member_count)!=1)break;if(!member_count){empty=1;break;}usleep(10000);}
  if(!empty || !brain_host_reap(&host))return 22;
  if(!brain_gui_client_cancel(&gui))return 8;brain_host_close(&host);brain_xpc_close(&broker);brain_xpc_close(&gui_peer);
#ifdef FIXTURE_NATIVE_STORE
  PQfinish(connection);
#endif
  return 0;
}
