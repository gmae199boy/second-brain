#include <xpc/xpc.h>
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
 if(argc!=2) return 2;
 dispatch_queue_t q=dispatch_queue_create("fixture",DISPATCH_QUEUE_SERIAL);
 dispatch_semaphore_t done=dispatch_semaphore_create(0);
 xpc_connection_t listener=xpc_connection_create(NULL,q);
 int l=xpc_connection_set_peer_code_signing_requirement(listener,argv[1]);
 xpc_connection_set_event_handler(listener,^(xpc_object_t event){
  if(xpc_get_type(event)!=XPC_TYPE_CONNECTION) return;
  xpc_connection_t peer=(xpc_connection_t)event;
  xpc_connection_set_event_handler(peer,^(xpc_object_t message){
   if(xpc_get_type(message)!=XPC_TYPE_DICTIONARY) return;
   xpc_object_t reply=xpc_dictionary_create_reply(message);
   if(reply) { xpc_dictionary_set_bool(reply,"ok",true); xpc_connection_send_message(peer,reply); xpc_release(reply); }
  });
  xpc_connection_activate(peer);
 });
 xpc_connection_activate(listener);
 xpc_endpoint_t endpoint=xpc_endpoint_create(listener);
 xpc_connection_t client=xpc_connection_create_from_endpoint(endpoint);
 int c=xpc_connection_set_peer_code_signing_requirement(client,argv[1]);
 xpc_connection_set_event_handler(client,^(xpc_object_t event){ (void)event; });
 xpc_connection_activate(client);
 xpc_object_t msg=xpc_dictionary_create(NULL,NULL,0);
 xpc_connection_send_message_with_reply(client,msg,q,^(xpc_object_t reply){
  char *desc=xpc_copy_description(reply); printf("description=%s\n",desc); free(desc);
  printf("reply_is_dictionary=%d ok=%d\n",xpc_get_type(reply)==XPC_TYPE_DICTIONARY,xpc_get_type(reply)==XPC_TYPE_DICTIONARY && xpc_dictionary_get_bool(reply,"ok")); fflush(stdout); dispatch_semaphore_signal(done);
 });
 long timeout=dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC));
 printf("listener_requirement=%d client_requirement=%d timeout=%ld\n",l,c,timeout);
 xpc_release(msg); xpc_connection_cancel(client); xpc_connection_cancel(listener); xpc_release(client); xpc_release(endpoint); xpc_release(listener); return timeout?1:0;
}
