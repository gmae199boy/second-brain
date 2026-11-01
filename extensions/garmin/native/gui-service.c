#include "gui-host.h"
#include "xpc-peer.h"
#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>
#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_GUI_SERVICE "org.secondbrain.gui.unconfigured"
#define BRAIN_GUI_UID 0
#define BRAIN_SUPERVISOR_UID 0
#define BRAIN_PRESENCE_POLICY_GENERATION 0
static const uint8_t BRAIN_GUI_HASH[20]={0},BRAIN_SUPERVISOR_HASH[20]={0};
#endif
#ifndef BRAIN_PRESENCE_POLICY_GENERATION
#define BRAIN_PRESENCE_POLICY_GENERATION 0
#endif
static brain_gui_process process;
static int occupied;
static dispatch_queue_t queue;
static brain_xpc_peer *owner;
static void cleanup(void) {if(occupied && brain_gui_cancel(&process))occupied=0;}
static int field(xpc_object_t m,const char *key,xpc_type_t type){xpc_object_t v=xpc_dictionary_get_value(m,key);return v && xpc_get_type(v)==type;}
static int same(xpc_object_t m) {
  return xpc_dictionary_get_count(m)==3 && field(m,"pid",XPC_TYPE_INT64) && field(m,"instance",XPC_TYPE_UUID)
    && xpc_dictionary_get_int64(m,"pid")==process.pid && !memcmp(xpc_dictionary_get_uuid(m,"instance"),process.scope.gui_instance,16);
}
static void on_connection(xpc_connection_t connection) {
  if(owner){xpc_connection_cancel(connection);return;}
  brain_xpc_peer *peer=calloc(1,sizeof *peer);if(!peer)return;
  xpc_connection_set_target_queue(connection,queue);
  if(!brain_xpc_configure_service(peer,connection,BRAIN_SUPERVISOR_UID,BRAIN_SUPERVISOR_HASH)){free(peer);xpc_connection_cancel(connection);return;}
  owner=peer;
  xpc_connection_set_event_handler(connection,^(xpc_object_t message){
    if(xpc_get_type(message)==XPC_TYPE_ERROR){cleanup();if(message==XPC_ERROR_CONNECTION_INVALID){brain_xpc_close(peer);owner=NULL;free(peer);}return;}
    if(!peer->authenticated){
      if(!brain_xpc_authenticate(peer,message)){cleanup();brain_xpc_close(peer);return;}
      xpc_object_t r=xpc_dictionary_create_reply(message);if(!r){cleanup();brain_xpc_close(peer);return;}
      xpc_dictionary_set_bool(r,"hello",true);xpc_connection_send_message(connection,r);xpc_release(r);return;
    }
    if(!brain_xpc_verify_message(peer,message) || !field(message,"op",XPC_TYPE_STRING)){cleanup();brain_xpc_close(peer);return;}
    const char *op=xpc_dictionary_get_string(message,"op");
    if(!strcmp(op,"start") && !occupied && xpc_dictionary_get_count(message)==1){
      int ok=brain_gui_start(&process,BRAIN_GUI_UID,BRAIN_GUI_HASH,BRAIN_PRESENCE_POLICY_GENERATION);
      occupied=process.pid>0;if(!ok){cleanup();brain_xpc_close(peer);return;}
      xpc_object_t r=xpc_dictionary_create_reply(message);if(!r){cleanup();brain_xpc_close(peer);return;}
      xpc_dictionary_set_int64(r,"pid",process.pid);xpc_dictionary_set_uuid(r,"session",process.scope.gui_session);
      xpc_dictionary_set_uuid(r,"instance",process.scope.gui_instance);xpc_dictionary_set_uuid(r,"boot",process.scope.gui_boot);
      xpc_dictionary_set_uint64(r,"asid",process.scope.gui_asid);xpc_dictionary_set_uint64(r,"start_sec",process.scope.gui_start_sec);
      xpc_dictionary_set_uint64(r,"start_usec",process.scope.gui_start_usec);xpc_dictionary_set_uint64(r,"policy",process.scope.policy_generation);
      xpc_connection_send_message(connection,r);xpc_release(r);return;
    }
    if(!strcmp(op,"resume") && occupied && same(message) && brain_gui_resume(&process)){
      xpc_object_t r=xpc_dictionary_create_reply(message);if(!r){cleanup();brain_xpc_close(peer);return;}xpc_dictionary_set_bool(r,"accepted",true);xpc_connection_send_message(connection,r);xpc_release(r);return;
    }
    if(!strcmp(op,"cancel") && occupied && same(message)){
      int ended=brain_gui_cancel(&process);if(ended)occupied=0;
      xpc_object_t r=xpc_dictionary_create_reply(message);if(!r){cleanup();brain_xpc_close(peer);return;}xpc_dictionary_set_bool(r,"ended",ended);xpc_connection_send_message(connection,r);xpc_release(r);return;
    }
    cleanup();brain_xpc_close(peer);
  });xpc_connection_activate(connection);
}
int main(void) {
  if(!BRAIN_GUI_UID || geteuid()!=BRAIN_GUI_UID || geteuid()==0 || !BRAIN_SUPERVISOR_UID || !BRAIN_PRESENCE_POLICY_GENERATION)return 78;
#ifndef BRAIN_NATIVE_FIXTURE
  if(BRAIN_GUI_UID==BRAIN_SUPERVISOR_UID)return 78;
#endif
  queue=dispatch_queue_create("org.secondbrain.gui.host",DISPATCH_QUEUE_SERIAL);if(!queue)return 78;
  xpc_connection_t listener=xpc_connection_create_mach_service(BRAIN_GUI_SERVICE,queue,XPC_CONNECTION_MACH_SERVICE_LISTENER);brain_xpc_peer policy;
  if(!listener || !brain_xpc_configure_service(&policy,listener,BRAIN_SUPERVISOR_UID,BRAIN_SUPERVISOR_HASH))return 78;
  xpc_connection_set_event_handler(listener,^(xpc_object_t e){if(xpc_get_type(e)==XPC_TYPE_CONNECTION)on_connection((xpc_connection_t)e);});
  xpc_connection_activate(listener);dispatch_main();return 0;
}
