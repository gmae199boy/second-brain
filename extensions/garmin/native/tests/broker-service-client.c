#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include <CommonCrypto/CommonDigest.h>
#include <bsm/audit.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <pthread.h>
#include <stdatomic.h>
#include "../xpc-peer.h"
#include "../submission-ipc.h"
#include "fixture-common.h"
static dispatch_semaphore_t ui_fd_ready;
static int received_ui_fd=-1;
static int connect_role(brain_xpc_peer *peer,const char *base,const char *role,const uint8_t hash[20]) {
  char service[256]; if(snprintf(service,sizeof service,"%s.%s",base,role)>=(int)sizeof service)return 0;
  xpc_connection_t c=xpc_connection_create_mach_service(service,NULL,0); if(!c || !brain_xpc_configure_service(peer,c,geteuid(),hash))return 0;
  xpc_connection_set_event_handler(c,^(xpc_object_t event){
    if(!strcmp(role,"ui") && xpc_get_type(event)==XPC_TYPE_DICTIONARY && xpc_dictionary_get_value(event,"fd")) {
      received_ui_fd=brain_xpc_receive_fd(peer,event);dispatch_semaphore_signal(ui_fd_ready);
    }
  }); xpc_connection_activate(c);
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(m,"hello",true);
  xpc_object_t r=xpc_connection_send_message_with_reply_sync(c,m); xpc_release(m);
  int ok=brain_xpc_authenticate(peer,r); if(r)xpc_release(r); return ok;
}
static xpc_object_t call(brain_xpc_peer *peer,xpc_object_t message) { return xpc_connection_send_message_with_reply_sync(peer->connection,message); }
static int accepted(brain_xpc_peer *peer,xpc_object_t message) {
  xpc_object_t r=call(peer,message); int ok=r && brain_xpc_verify_message(peer,r) && xpc_dictionary_get_bool(r,"accepted"); if(r)xpc_release(r); return ok;
}
typedef struct { brain_submission_control *control;brain_auth_channel *channel;const uint8_t *prompt;_Atomic int done;int result;uint8_t payload[32];size_t length; } waiting_worker;
static void *wait_for_approval(void *arg) { waiting_worker *w=arg;w->result=brain_submission_receive(w->control,w->channel,w->prompt,1,w->payload,sizeof w->payload,&w->length,2000);atomic_store(&w->done,1);return NULL; }
int main(int argc,char **argv) {
  if(argc!=3)return 2; uint8_t hash[20]; if(!fixture_hash(argv[2],hash))return 3;
  brain_xpc_peer supervisor={0},worker={0},ui={0}; if(!connect_role(&supervisor,argv[1],"supervisor",hash))return 4;
  ui_fd_ready=dispatch_semaphore_create(0);if(!ui_fd_ready)return 20;
  int worker_fd=brain_submission_prepare(&supervisor,2000);if(worker_fd<0)return 22;
  xpc_object_t m;uuid_t ids[4];uint8_t package[32];memset(package,1,sizeof package);const char *keys[]={"work","attempt","session","lease"};
  for(int i=0;i<4;i++)uuid_generate_random(ids[i]);
  brain_auth_binding binding={.worker_pid=getpid(),.run_generation=1,.binding_generation=1,.package_generation=1,.connection_epoch=1};
  memcpy(binding.work,ids[0],16);memcpy(binding.attempt,ids[1],16);memcpy(binding.session,ids[2],16);memcpy(binding.launch_lease,ids[3],16);memcpy(binding.package,package,32);
  if(!brain_submission_register(&supervisor,&binding,"fixture",2000))return 5;
  uuid_t gui_session,gui_instance;uuid_generate_random(gui_session);uuid_generate_random(gui_instance);
  struct proc_bsdinfo info;auditinfo_addr_t audit;char boot_text[64];size_t boot_length=sizeof boot_text;uuid_t boot;
  if(proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&info,sizeof info)!=(int)sizeof info || getaudit_addr(&audit,sizeof audit)
    || sysctlbyname("kern.bootsessionuuid",boot_text,&boot_length,NULL,0) || uuid_parse(boot_text,boot))return 17;
  brain_presence_scope scope={.gui_pid=(uint64_t)getpid(),.gui_asid=(uint64_t)audit.ai_asid,.gui_start_sec=info.pbi_start_tvsec,.gui_start_usec=info.pbi_start_tvusec,.policy_generation=1};
  memcpy(scope.gui_session,gui_session,16);memcpy(scope.gui_instance,gui_instance,16);memcpy(scope.gui_boot,boot,16);
  if(!brain_submission_gui(&supervisor,&scope,2000))return 12;
  if(!brain_submission_recorded(&supervisor,2000))return 8;
  if(!connect_role(&worker,argv[1],"worker",hash))return 6;
  m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","attach");if(!accepted(&worker,m))return 7;xpc_release(m);
  if(!connect_role(&ui,argv[1],"ui",hash))return 9;
  m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","select_target");xpc_object_t r=call(&ui,m);xpc_release(m);
  if(!r || !brain_xpc_verify_message(&ui,r) || xpc_dictionary_get_count(r)!=10 || memcmp(xpc_dictionary_get_uuid(r,"work"),ids[0],16))return 10;
  xpc_release(r); m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","selection");
  for(int i=0;i<4;i++)xpc_dictionary_set_uuid(m,keys[i],ids[i]);
  xpc_dictionary_set_uint64(m,"run",1);xpc_dictionary_set_uint64(m,"binding",1);xpc_dictionary_set_uint64(m,"package_generation",1);xpc_dictionary_set_uint64(m,"epoch",1);xpc_dictionary_set_data(m,"package",package,sizeof package);
  if(!accepted(&ui,m))return 11;xpc_release(m);
  if(dispatch_semaphore_wait(ui_fd_ready,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC)) || received_ui_fd<0)return 23;
  brain_auth_channel ui_channel,worker_channel;
  if(!brain_channel_init(&ui_channel,received_ui_fd,ids[2],1,2000) || !brain_channel_init(&worker_channel,worker_fd,ids[2],0,2000))return 24;
  uuid_t prompt;uuid_generate_random(prompt);
  if(!brain_submission_prompt(&worker,prompt,0,2000))return 13;
  brain_presence_challenge challenge;uint8_t digest[32];
  if(!brain_submission_challenge(&ui,1,&challenge,2000))return 14;CC_SHA256(challenge.message,(CC_LONG)challenge.length,digest);
  brain_submission_control control={.peer=&worker,.timeout_ms=2000};waiting_worker waiting={.control=&control,.channel=&worker_channel,.prompt=prompt};pthread_t thread;
  if(pthread_create(&thread,NULL,wait_for_approval,&waiting))return 18;usleep(100000);if(atomic_load(&waiting.done))return 19;
  if(!brain_submission_assertion(&ui,digest,2000))return 15;
  if(!brain_submission_send_ready(&ui,prompt,1,2000))return 26;
  const uint8_t secret[]={1,2,3,4};if(!brain_channel_send(&ui_channel,3,prompt,secret,sizeof secret,2000))return 25;
  pthread_join(thread,NULL);if(!waiting.result || waiting.length!=sizeof secret || memcmp(waiting.payload,secret,sizeof secret))return 16;
  int ok=!brain_submission_verify(&control,prompt,1);
  brain_channel_destroy(&ui_channel);brain_channel_destroy(&worker_channel);brain_xpc_close(&supervisor);brain_xpc_close(&worker);brain_xpc_close(&ui);dispatch_release(ui_fd_ready);return ok ? 0 : 11;
}
