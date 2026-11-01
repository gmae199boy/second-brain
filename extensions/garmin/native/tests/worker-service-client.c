#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include "../xpc-peer.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  if (argc != 3) return 2; uint8_t hash[20]; if (!fixture_hash(argv[2],hash)) return 3;
  dispatch_queue_t queue=dispatch_queue_create("fixture.worker-client",DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t done=dispatch_semaphore_create(0);
  xpc_connection_t connection=xpc_connection_create_mach_service(argv[1],queue,0);
  __block brain_xpc_peer peer={0}; __block int rejected=0;
  if (!brain_xpc_configure_service(&peer,connection,geteuid(),hash)) return 4;
  xpc_connection_set_event_handler(connection,^(xpc_object_t event) {
    if (xpc_get_type(event)==XPC_TYPE_ERROR) { rejected=1; dispatch_semaphore_signal(done); }
  });
  xpc_connection_activate(connection);
  xpc_object_t hello=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(hello,"hello",true);
  xpc_connection_send_message_with_reply(connection,hello,queue,^(xpc_object_t reply) {
    if (!brain_xpc_authenticate(&peer,reply)) { dispatch_semaphore_signal(done); return; }
    xpc_object_t start=xpc_dictionary_create(NULL,NULL,0); uuid_t work,attempt; uuid_generate_random(work); uuid_generate_random(attempt);
    uint8_t package[32]; memset(package,1,sizeof package);
    xpc_dictionary_set_string(start,"op","start"); xpc_dictionary_set_uuid(start,"work",work); xpc_dictionary_set_uuid(start,"attempt",attempt);
    xpc_dictionary_set_uint64(start,"run",1); xpc_dictionary_set_uint64(start,"binding",1); xpc_dictionary_set_uint64(start,"epoch",1);
    xpc_dictionary_set_data(start,"package",package,sizeof package);
    xpc_connection_send_message_with_reply(connection,start,queue,^(xpc_object_t response) {
      if (xpc_get_type(response)==XPC_TYPE_ERROR) rejected=1;
      dispatch_semaphore_signal(done);
    });
    xpc_release(start);
  });
  long timeout=dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,15*NSEC_PER_SEC));
  brain_xpc_close(&peer); xpc_release(hello); xpc_release(connection);
  return timeout==0 && rejected ? 0 : 5;
}
