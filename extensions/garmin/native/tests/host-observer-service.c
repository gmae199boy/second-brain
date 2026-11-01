#include <dispatch/dispatch.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "../xpc-peer.h"
#include BRAIN_NATIVE_POLICY_HEADER
static void accept(xpc_connection_t c) {
  brain_xpc_peer *p=calloc(1,sizeof *p); if(!p)return;
  if(!brain_xpc_configure_service(p,c,BRAIN_CLIENT_UID,BRAIN_CLIENT_HASH)){free(p);return;}
  xpc_connection_set_event_handler(c,^(xpc_object_t m){
    if(xpc_get_type(m)==XPC_TYPE_ERROR){if(m==XPC_ERROR_CONNECTION_INVALID)free(p);return;}
    if(!p->authenticated){if(!brain_xpc_authenticate(p,m)){brain_xpc_close(p);return;}xpc_object_t r=xpc_dictionary_create_reply(m);xpc_dictionary_set_bool(r,"hello",true);xpc_connection_send_message(c,r);xpc_release(r);return;}
    if(!brain_xpc_verify_message(p,m)){brain_xpc_close(p);return;}
    const char *op=xpc_dictionary_get_string(m,"op"); if(!op){brain_xpc_close(p);return;}
    xpc_object_t r=xpc_dictionary_create_reply(m); if(!r){brain_xpc_close(p);return;}
    if(!strcmp(op,"start")) {
      int a[2],b[2];uuid_t lease;uuid_generate_random(lease);if(pipe(a)||pipe(b)){brain_xpc_close(p);xpc_release(r);return;}
      xpc_dictionary_set_int64(r,"pid",123);xpc_dictionary_set_uint64(r,"start_sec",1);xpc_dictionary_set_uint64(r,"start_usec",1);
      xpc_dictionary_set_uuid(r,"lease",lease);xpc_dictionary_set_fd(r,"stdout",a[0]);xpc_dictionary_set_fd(r,"stderr",b[0]);
      xpc_connection_send_message(c,r);for(int i=0;i<2;i++){close(a[i]);close(b[i]);}
    } else if(!strcmp(op,"inspect")) {
      xpc_dictionary_set_int64(r,"pid",123);xpc_dictionary_set_uint64(r,"start_sec",1);xpc_dictionary_set_uint64(r,"start_usec",1);xpc_dictionary_set_int64(r,"group",1);xpc_connection_send_message(c,r);
    } else if(!strcmp(op,"signal")) {
      xpc_dictionary_set_bool(r,"sent",true);xpc_connection_send_message(c,r);
    } else if(!strcmp(op,"recorded")) {
      xpc_dictionary_set_bool(r,"accepted",true);xpc_connection_send_message(c,r);
      xpc_object_t e=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(e,"op","exit");
#ifdef BRAIN_WRONG_PID_FIXTURE
      xpc_dictionary_set_int64(e,"pid",124);
#else
      xpc_dictionary_set_int64(e,"pid",123);
#endif
      xpc_dictionary_set_int64(e,"wait_status",0);xpc_connection_send_message(c,e);xpc_release(e);
    } else brain_xpc_close(p);
    xpc_release(r);
  });xpc_connection_activate(c);
}
int main(void) {
  xpc_connection_t listener=xpc_connection_create_mach_service(BRAIN_TEST_SERVICE,NULL,XPC_CONNECTION_MACH_SERVICE_LISTENER);brain_xpc_peer policy;
  if(!listener || !brain_xpc_configure_service(&policy,listener,BRAIN_CLIENT_UID,BRAIN_CLIENT_HASH))return 1;
  xpc_connection_set_event_handler(listener,^(xpc_object_t e){if(xpc_get_type(e)==XPC_TYPE_CONNECTION)accept((xpc_connection_t)e);});xpc_connection_activate(listener);dispatch_main();return 0;
}
