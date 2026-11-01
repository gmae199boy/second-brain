#include "supervisor-native.h"
#include "supervisor-store.h"
#include "broker-credential.h"
#include "peer.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <uuid/uuid.h>

#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_SUPERVISOR_UID 0
#define BRAIN_HOST_UID 0
#define BRAIN_BROKER_UID 0
#define BRAIN_GUI_UID 0
#define BRAIN_BRIDGE_HOST_SERVICE "org.secondbrain.host.unconfigured"
#define BRAIN_BRIDGE_BROKER_SERVICE "org.secondbrain.broker.unconfigured"
#define BRAIN_BRIDGE_GUI_SERVICE "org.secondbrain.gui.unconfigured"
#define BRAIN_SUPERVISOR_CREDENTIAL ""
#define BRAIN_PACKAGE_GENERATION 0
#define BRAIN_SUPERVISOR_EXECUTABLE "/Library/Application Support/SecondBrain/libexec/supervisor"
static const uint8_t BRAIN_SUPERVISOR_HASH[20]={0},BRAIN_HOST_HASH[20]={0},BRAIN_BROKER_HASH[20]={0},BRAIN_GUI_HASH[20]={0},BRAIN_PACKAGE_HASH[32]={0};
#endif
#if defined(BRAIN_FIXTURE_PG_PORT) && !defined(BRAIN_NATIVE_FIXTURE)
#error 합성_DB는_fixture에서만_허용된다
#endif
extern void PQfinish(PGconn *);
#ifdef BRAIN_FIXTURE_PG_PORT
#include "tests/fixture-code-hash.h"
#include <stdio.h>
typedef struct pg_result PGresult;
extern PGconn *PQconnectdb(const char *);
extern PGresult *PQexec(PGconn *,const char *);
extern int PQresultStatus(const PGresult *);
extern void PQclear(PGresult *);
#endif
static uint64_t u64(const uint8_t *p) {uint64_t n=0;for(size_t i=0;i<8;i++)n=(n<<8)|p[i];return n;}
static void put64(uint8_t *p,uint64_t n){for(int i=7;i>=0;i--){p[i]=(uint8_t)n;n>>=8;}}
static void put32(uint8_t *p,uint32_t n){n=htonl(n);memcpy(p,&n,4);}
static int send_reply(const uint8_t *data,size_t n){return brain_write_frame(3,data,n,2000);}
static PGconn *connect_supervisor(void) {
#ifdef BRAIN_FIXTURE_PG_PORT
  char info[128];snprintf(info,sizeof info,"host=127.0.0.1 port=%d dbname=postgres user=postgres connect_timeout=3",BRAIN_FIXTURE_PG_PORT);
  PGconn *connection=PQconnectdb(info);if(!connection)return NULL;
  PGresult *result=PQexec(connection,"set session authorization brain_protected_supervisor");
  int ok=result && PQresultStatus(result)==1;if(result)PQclear(result);if(!ok){PQfinish(connection);return NULL;}return connection;
#else
  return brain_supervisor_connect_protected(BRAIN_SUPERVISOR_CREDENTIAL);
#endif
}
typedef struct {int input,output;uint8_t bytes[16384];size_t begin,end;int eof;} stream;
static int nonblocking(int fd){int flags=fcntl(fd,F_GETFL);return flags>=0 && !fcntl(fd,F_SETFL,flags|O_NONBLOCK);}
static int read_stream(stream *s) {
  if(s->eof || s->end==sizeof s->bytes)return 1;
  ssize_t n=read(s->input,s->bytes+s->end,sizeof s->bytes-s->end);
  if(n>0){s->end+=(size_t)n;return 1;}if(n==0){s->eof=1;return 1;}
  return errno==EAGAIN || errno==EWOULDBLOCK || errno==EINTR;
}
static int write_stream(stream *s) {
  if(s->begin==s->end)return 1;ssize_t n=write(s->output,s->bytes+s->begin,s->end-s->begin);
  if(n>0){s->begin+=(size_t)n;if(s->begin==s->end)s->begin=s->end=0;return 1;}
  return n<0 && (errno==EAGAIN || errno==EWOULDBLOCK || errno==EINTR);
}
/* 입력 secret은 이 제어 연결이나 stdout을 통과하지 않는다. */
int main(void) {
  uint8_t supervisor_hash[20],host_hash[20],broker_hash[20],gui_hash[20];
#ifdef BRAIN_FIXTURE_PG_PORT
  if(!fixture_code_hash(BRAIN_FIXTURE_NODE_PATH,supervisor_hash) || !fixture_code_hash(BRAIN_FIXTURE_HOST_PATH,host_hash)
    || !fixture_code_hash(BRAIN_FIXTURE_BROKER_PATH,broker_hash) || !fixture_code_hash(BRAIN_FIXTURE_GUI_PATH,gui_hash))return 78;
#else
  memcpy(supervisor_hash,BRAIN_SUPERVISOR_HASH,20);memcpy(host_hash,BRAIN_HOST_HASH,20);
  memcpy(broker_hash,BRAIN_BROKER_HASH,20);memcpy(gui_hash,BRAIN_GUI_HASH,20);
#endif
#ifndef BRAIN_NATIVE_FIXTURE
  /* 일반 인터프리터의 서명만으로 임의 script를 보호 supervisor로 인정하지 않는다. */
#ifndef BRAIN_SEALED_SUPERVISOR_POLICY
  return 78;
#else
  char parent_path[PROC_PIDPATHINFO_MAXSIZE];int parent_size=proc_pidpath(getppid(),parent_path,sizeof parent_path);
  if(parent_size<=0 || strcmp(parent_path,BRAIN_SUPERVISOR_EXECUTABLE))return 78;
#endif
#endif
  if(!BRAIN_SUPERVISOR_UID || geteuid()!=BRAIN_SUPERVISOR_UID || geteuid()==0 || !BRAIN_HOST_UID || !BRAIN_BROKER_UID || !BRAIN_GUI_UID
    || !BRAIN_PACKAGE_GENERATION || !brain_verify_peer(3,BRAIN_SUPERVISOR_UID,getppid(),supervisor_hash))return 78;
  signal(SIGPIPE,SIG_IGN);PGconn *connection=connect_supervisor();if(!connection)return 78;
  brain_host_client host={0};host.stdout_fd=host.stderr_fd=-1;brain_xpc_peer broker={0},gui_peer={0};brain_gui_client gui={0};
  brain_supervisor_pg_store store={0};brain_supervisor_store_ops ops={0};brain_auth_binding binding={0};int started=0,authorized=0,ok=1;
  stream out={.input=-1,.output=1},err={.input=-1,.output=2};
  if(!nonblocking(1) || !nonblocking(2))ok=0;
  while(ok) {
    struct pollfd fds[5]={{.fd=3,.events=POLLIN},{.fd=out.input,.events=(!out.eof && out.end<sizeof out.bytes)?POLLIN:0},
      {.fd=out.output,.events=out.begin<out.end?POLLOUT:0},{.fd=err.input,.events=(!err.eof && err.end<sizeof err.bytes)?POLLIN:0},
      {.fd=err.output,.events=err.begin<err.end?POLLOUT:0}};
    int ready=poll(fds,5,250);if(ready<0 && errno==EINTR)continue;if(ready<0)break;
    if(fds[0].revents&(POLLHUP|POLLERR|POLLNVAL))break;
    if(fds[0].revents&POLLIN) {
      uint8_t frame[1243];size_t size=0;if(!brain_read_frame(3,frame,sizeof frame,&size,2000))break;
      if(frame[0]==1 && !started && size>=55) {
        size_t zone_size=(size_t)frame[49]*256+frame[50],target_size=(size_t)frame[51]*256+frame[52],id_size=frame[54];
        if(!zone_size || zone_size>128 || !target_size || target_size>1024 || (frame[53]!=1 && frame[53]!=2) || !id_size || id_size>36 || size!=55+zone_size+target_size+id_size || memchr(frame+55+zone_size,0,target_size))break;
        if(memchr(frame+55+zone_size+target_size,0,id_size))break;
        char zone[129],target_id[37];memcpy(zone,frame+55,zone_size);zone[zone_size]=0;memcpy(target_id,frame+55+zone_size+target_size,id_size);target_id[id_size]=0;
        uuid_t parsed_id;if((frame[53]==1 && strcmp(target_id,"garmin")) || (frame[53]==2 && (id_size!=36 || uuid_parse(target_id,parsed_id) || uuid_is_null(parsed_id))))break;
        for(size_t i=0;i<zone_size;i++){unsigned char c=(unsigned char)zone[i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='/'||c=='_'||c=='-'||c=='+'))ok=0;}
        if(!ok)break;memcpy(binding.work,frame+1,16);memcpy(binding.attempt,frame+17,16);binding.run_generation=u64(frame+33);binding.connection_epoch=u64(frame+41);
        binding.package_generation=BRAIN_PACKAGE_GENERATION;memcpy(binding.package,BRAIN_PACKAGE_HASH,32);uuid_generate_random(binding.session);
        char target[1025];uint64_t generation=0;
        if(!binding.run_generation || !binding.connection_epoch || !brain_supervisor_pg_admission_context(connection,&binding,target,&generation)
          || strlen(target)!=target_size || memcmp(target,frame+55+zone_size,target_size)
          || !brain_supervisor_pg_work_target(connection,&binding,frame[53]==1?"extension":"account",target_id))break;
        binding.binding_generation=generation;
        if(!brain_supervisor_pg_init(&store,connection,&binding,target,zone))break;ops=brain_supervisor_pg_ops(&store);
        if(!brain_host_connect(&host,BRAIN_BRIDGE_HOST_SERVICE,BRAIN_HOST_UID,host_hash)
          || !brain_submission_connect(&broker,BRAIN_BRIDGE_BROKER_SERVICE,BRAIN_BROKER_UID,broker_hash,5000)
          || !brain_submission_connect(&gui_peer,BRAIN_BRIDGE_GUI_SERVICE,BRAIN_GUI_UID,gui_hash,5000))break;
        gui=(brain_gui_client){.peer=&gui_peer,.timeout_ms=5000};
        if(!brain_supervisor_native_start_admitted(&host,&broker,&binding,&ops,5000))break;
        started=1;uint8_t metadata[1235];memcpy(metadata,frame,41);memcpy(metadata+41,frame+49,size-49);
        if(!brain_host_metadata(&host,metadata,size-8))break;
        out.input=host.stdout_fd;err.input=host.stderr_fd;
        if(!nonblocking(out.input) || !nonblocking(err.input) || host.start_usec>=1000000 || host.start_sec>UINT64_MAX/1000000)break;
        uint8_t reply[29]={0x81};put32(reply+1,(uint32_t)host.pid);put64(reply+5,host.start_sec*1000000+host.start_usec);memcpy(reply+13,host.lease,16);
        if(!send_reply(reply,sizeof reply))break;
      } else if(frame[0]==2 && size==1 && started && !authorized) {
        authorized=brain_supervisor_native_authorize_recorded(&host,&broker,&gui,&binding,&ops,5000);
        uint8_t reply[2]={0x82,(uint8_t)(authorized?1:0)};if(!send_reply(reply,sizeof reply) || !authorized)break;
      } else if(frame[0]==3 && size==1 && started) {
        int status=0,state=brain_host_observe(&host,&status);
        if(state==0){int observed=brain_host_leader_observed(&host,&status);if(observed<0)state=-1;else if(observed==1)state=3;}
#ifdef BRAIN_NATIVE_FIXTURE
        if(state==3)(void)write(2,"fixture-observed-wire\n",22);
#endif
        uint8_t reply[6]={0x83,(uint8_t)(state<0?2:state)};put32(reply+2,(uint32_t)status);if(!send_reply(reply,sizeof reply))break;
      } else if(frame[0]==7 && size==1 && started) {
#ifdef BRAIN_NATIVE_FIXTURE
        (void)write(2,"fixture-members-wire\n",21);
#endif
        brain_group_member members[24];size_t count=0;int state=brain_host_members(&host,members,24,&count);
        uint8_t reply[2+24*12]={0x87,(uint8_t)(state==1?count:255)};
        if(state==1)for(size_t i=0;i<count;i++){if(members[i].start_sec>UINT64_MAX/1000000 || members[i].start_usec>=1000000){state=-1;break;}
          put32(reply+2+i*12,(uint32_t)members[i].pid);put64(reply+6+i*12,members[i].start_sec*1000000+members[i].start_usec);}
        if(state!=1)reply[1]=255;
        if(!send_reply(reply,state==1?2+count*12:2))break;
      } else if(frame[0]==8 && size==1 && started) {
#ifdef BRAIN_NATIVE_FIXTURE
        (void)write(2,"fixture-reap-wire\n",18);
#endif
        int reaped=brain_host_reap(&host);uint8_t reply[2]={0x88,(uint8_t)(reaped?1:0)};if(!send_reply(reply,sizeof reply) || !reaped)break;
      } else if(frame[0]==6 && size==1 && started && authorized) {
#ifdef BRAIN_NATIVE_FIXTURE
        (void)write(2,"fixture-revoke-wire\n",20);
#endif
        int revoked=brain_submission_revoke(&broker,&binding,5000);uint8_t reply[2]={0x86,(uint8_t)(revoked?1:0)};
        if(!send_reply(reply,sizeof reply) || !revoked)break;authorized=0;
      } else if(frame[0]==5 && size==2 && started && (frame[1]==SIGTERM || frame[1]==SIGKILL)) {
        int sent=brain_host_signal(&host,frame[1]);uint8_t reply[2]={0x85,(uint8_t)(sent?1:0)};
        if(!send_reply(reply,sizeof reply))break;
      } else if(frame[0]==4 && size==2 && started && authorized && frame[1]>=1 && frame[1]<=3) {
        int revoked=brain_supervisor_pg_revoke_action(&store,&broker,&binding,(brain_protected_action)frame[1],5000);
        uint8_t reply[2]={0x84,(uint8_t)(revoked?1:0)};if(!send_reply(reply,sizeof reply) || !revoked)break;authorized=0;
      } else break;
    }
    if((fds[1].revents&(POLLIN|POLLHUP)) && !read_stream(&out))break;
    if((fds[2].revents&POLLOUT) && !write_stream(&out))break;
    if((fds[3].revents&(POLLIN|POLLHUP)) && !read_stream(&err))break;
    if((fds[4].revents&POLLOUT) && !write_stream(&err))break;
    if(out.eof && out.begin==out.end && out.output>=0){close(out.output);out.output=-1;}
    if(err.eof && err.begin==err.end && err.output>=0){close(err.output);err.output=-1;}
    for(int i=1;i<5;i++)if(fds[i].revents&(POLLERR|POLLNVAL))ok=0;
  }
  if(started){if(authorized)(void)brain_submission_revoke(&broker,&binding,2000);(void)brain_gui_client_cancel(&gui);brain_host_cancel(&host);}
  brain_xpc_close(&gui_peer);brain_xpc_close(&broker);brain_host_close(&host);PQfinish(connection);return 78;
}
