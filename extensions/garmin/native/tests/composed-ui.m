#import <Foundation/Foundation.h>
#include "../submission-ui.h"
#include "../submission-ipc.h"
#include "fixture-code-hash.h"
#include <CommonCrypto/CommonDigest.h>
#include <unistd.h>
#ifdef FIXTURE_NATIVE_STORE
typedef struct pg_conn PGconn;typedef struct pg_result PGresult;
extern PGconn *PQconnectdb(const char *);extern PGresult *PQexec(PGconn *,const char *);extern int PQresultStatus(const PGresult *);extern void PQclear(PGresult *);extern void PQfinish(PGconn *);
static int inject_boundary(int mode) {
  char info[128];snprintf(info,sizeof info,"host=127.0.0.1 port=%d dbname=postgres user=postgres connect_timeout=3",FIXTURE_PG_PORT);
  PGconn *connection=PQconnectdb(info);if(!connection)return 0;
  /* DB superuser 우회 주입이며 제품 권한 경로와 별도로 평가한다. */
  const char *query=mode==6?"set session_replication_role=replica; update brain.work_items set cancel_requested_at=now() where kind='garmin.auth'":"set session_replication_role=replica; insert into brain.work_hold_groups(name,held_at) values ('extension:garmin',now())";
  PGresult *r=PQexec(connection,query);int ok=r && PQresultStatus(r)==1;if(r)PQclear(r);PQfinish(connection);return ok;
}
static int await_revoke(void) {
  char info[128];snprintf(info,sizeof info,"host=127.0.0.1 port=%d dbname=postgres user=postgres connect_timeout=3",FIXTURE_PG_PORT);
  PGconn *connection=PQconnectdb(info);if(!connection)return 0;PGresult *r=PQexec(connection,"insert into fixture_sync(mark) values ('ready')");
  int ok=r && PQresultStatus(r)==1;if(r)PQclear(r);
  for(int i=0;ok && i<100;i++){r=PQexec(connection,"select 1/(case when exists(select 1 from fixture_sync where mark='continue') then 1 else 0 end)");
    int ready=r && PQresultStatus(r)==2;if(r)PQclear(r);if(ready){PQfinish(connection);return 1;}usleep(100000);}
  PQfinish(connection);return 0;
}
#endif
static void (^pending)(const brain_local_presence *);
static brain_local_presence receipt;
@implementation BRAINPresenceGate
- (BOOL)begin:(const brain_presence_challenge *)challenge operation:(uint8_t)operation completion:(void (^)(const brain_local_presence *))completion {
  (void)operation;CC_SHA256(challenge->message,(CC_LONG)challenge->length,receipt.challenge_digest);receipt.generation=1;pending=[completion copy];return YES;
}
- (void)cancel {if(pending){[pending release];pending=nil;}}
@end
int main(void) {@autoreleasepool {
  uint8_t hash[20];if(!fixture_code_hash(FIXTURE_BROKER_PATH,hash))return 1;
  xpc_connection_t connection=xpc_connection_create_mach_service(FIXTURE_BROKER_UI,NULL,0);__block brain_xpc_peer peer={0};
  if(!connection || !brain_xpc_configure_service(&peer,connection,geteuid(),hash))return 2;
  dispatch_semaphore_t fd_ready=dispatch_semaphore_create(0),prompt_ready=dispatch_semaphore_create(0);__block int fd=-1;__block uint64_t ordinal=UINT64_MAX;__block int mfa=-1;__block struct {uuid_t bytes;} prompt;
  xpc_connection_set_event_handler(connection,^(xpc_object_t event){
    if(xpc_get_type(event)!=XPC_TYPE_DICTIONARY)return;
    if(xpc_dictionary_get_value(event,"fd")){fd=brain_xpc_receive_fd(&peer,event);dispatch_semaphore_signal(fd_ready);return;}
    if(brain_xpc_verify_message(&peer,event) && xpc_dictionary_get_count(event)==4 && xpc_dictionary_get_string(event,"op")
      && !strcmp(xpc_dictionary_get_string(event,"op"),"prompt") && xpc_dictionary_get_uuid(event,"prompt")) {
      xpc_object_t number=xpc_dictionary_get_value(event,"ordinal"),kind=xpc_dictionary_get_value(event,"mfa");
      if(!number || xpc_get_type(number)!=XPC_TYPE_UINT64 || !kind || xpc_get_type(kind)!=XPC_TYPE_BOOL)return;
      ordinal=xpc_uint64_get_value(number);mfa=xpc_bool_get_value(kind)?1:0;
      memcpy(prompt.bytes,xpc_dictionary_get_uuid(event,"prompt"),16);dispatch_semaphore_signal(prompt_ready);
    }
  });xpc_connection_activate(connection);
  xpc_object_t hello=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_bool(hello,"hello",true);xpc_object_t reply=xpc_connection_send_message_with_reply_sync(connection,hello);xpc_release(hello);
  if(!reply || !brain_xpc_authenticate(&peer,reply))return 3;xpc_release(reply);
  xpc_object_t target=NULL;
  for(int i=0;i<150;i++){xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","select_target");reply=brain_submission_call(&peer,m,1000);xpc_release(m);
    if(!reply)return 4;if(xpc_dictionary_get_count(reply)==10){target=reply;break;}xpc_release(reply);usleep(100000);}
  if(!target || !xpc_dictionary_get_string(target,"tokenstore") || strcmp(xpc_dictionary_get_string(target,"tokenstore"),"fixture"))return 5;uint8_t session[16];const uint8_t *session_ptr=xpc_dictionary_get_uuid(target,"session");if(!session_ptr)return 6;memcpy(session,session_ptr,16);
  xpc_object_t selection=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(selection,"op","selection");
  const char *keys[]={"work","attempt","session","lease","run","binding","package_generation","epoch","package"};
  for(size_t i=0;i<9;i++){xpc_object_t value=xpc_dictionary_get_value(target,keys[i]);if(!value)return 7;xpc_dictionary_set_value(selection,keys[i],value);}xpc_release(target);
  reply=brain_submission_call(&peer,selection,1000);xpc_release(selection);if(!reply || !xpc_dictionary_get_bool(reply,"accepted"))return 8;xpc_release(reply);
  if(dispatch_semaphore_wait(fd_ready,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC)) || fd<0)return 9;
  brain_auth_channel channel;if(!brain_channel_init(&channel,fd,session,1,1000))return 10;
  BRAINSubmission *submission=[[BRAINSubmission alloc] init];uint8_t secret[]={1,2,3,4};brain_xpc_peer *ptr=&peer;
  for(uint64_t expected=1;expected<=4;expected++) {
    if(dispatch_semaphore_wait(prompt_ready,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC)) || ordinal!=expected-1 || mfa!=(expected>1))return 11;
    uint64_t generation=[submission freeze:secret length:sizeof secret prompt:prompt.bytes operation:expected==1?1:2];
#ifdef FIXTURE_NATIVE_STORE
    if((FIXTURE_CASE==6 || FIXTURE_CASE==7) && !inject_boundary(FIXTURE_CASE)){(void)write(1,"bad",3);return 16;}
#endif
    brain_presence_challenge challenge;if(generation!=expected || !brain_submission_challenge(&peer,generation,&challenge,1000))return 12;
#ifdef FIXTURE_NATIVE_STORE
    if(FIXTURE_CASE==6 || FIXTURE_CASE==7){(void)write(1,"bad",3);return 17;}
    if(FIXTURE_CASE==8 && !inject_boundary(FIXTURE_CASE)){(void)write(1,"bad",3);return 18;}
#endif
    __block int completed=0;
    if(![submission approve:&challenge channel:&channel timeout:1000 broker:^BOOL(const brain_local_presence *r){
      BOOL ok=brain_submission_assertion(ptr,r->challenge_digest,5000) && brain_submission_send_ready(ptr,prompt.bytes,generation,5000);
#ifdef FIXTURE_NATIVE_STORE
      if(ok && FIXTURE_CASE==9 && !inject_boundary(FIXTURE_CASE)){(void)write(1,"bad",3);return NO;}
      if(ok && FIXTURE_CASE>=10 && FIXTURE_CASE<=16 && !await_revoke()){(void)write(1,"bad",3);return NO;}
#endif
      return ok;
    } completion:^(BOOL ok){completed=ok?1:-1;}])return 13;
    if(!pending)return 14;void (^callback)(const brain_local_presence *)=[pending copy];
    if(FIXTURE_CASE==1)receipt.challenge_digest[0]^=1;
    if(FIXTURE_CASE==2)[submission cancel];
    callback(&receipt);if(FIXTURE_CASE==4)callback(&receipt);[callback release];
    if(FIXTURE_CASE==1 || FIXTURE_CASE==2){brain_channel_close(&channel);brain_xpc_close(&peer);[submission release];return 0;}
    if(FIXTURE_CASE==8){if(completed!=-1)(void)write(1,"bad",3);brain_channel_close(&channel);brain_xpc_close(&peer);[submission release];return 0;}
    if(FIXTURE_CASE==9){if(completed!=1)(void)write(1,"bad",3);usleep(300000);brain_channel_close(&channel);brain_xpc_close(&peer);[submission release];return 0;}
    if(FIXTURE_CASE>=10 && FIXTURE_CASE<=16){if(completed!=-1)(void)write(1,"bad",3);brain_channel_close(&channel);brain_xpc_close(&peer);[submission release];return 0;}
    if(completed!=1)return 15;
  }
  usleep(300000);[submission release];brain_channel_destroy(&channel);brain_xpc_close(&peer);dispatch_release(fd_ready);dispatch_release(prompt_ready);return 0;
}}
