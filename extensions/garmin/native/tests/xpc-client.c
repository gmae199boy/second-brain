#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <dispatch/dispatch.h>
#include "../xpc-peer.h"
#include "fixture-common.h"
#ifndef FIXTURE_VARIANT
#define FIXTURE_VARIANT 0
#endif
int main(int argc, char **argv) {
  volatile int variant = FIXTURE_VARIANT; if (variant < 0) return 8;
  if (argc != 3) return 2;
  uint8_t hash[20]; if (!fixture_hash(argv[2], hash)) return 3;
  dispatch_queue_t queue = dispatch_queue_create("fixture.client", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  xpc_connection_t connection = xpc_connection_create_mach_service(argv[1], queue, 0);
  __block brain_xpc_peer peer = {0}; __block int result = 0;
  if (!brain_xpc_configure_service(&peer, connection, geteuid(), hash)) return 4;
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_ERROR) { dispatch_semaphore_signal(done); return; }
    int fd=brain_xpc_receive_fd(&peer,event); if (fd<0) { dispatch_semaphore_signal(done); return; }
    uint8_t value[32]; ssize_t n=read(fd,value,sizeof value); close(fd);
    unsigned any=0; for(size_t i=0;i<sizeof value;i++)any|=value[i]; memset(value,0,sizeof value);
    if (n==(ssize_t)sizeof value && any && peer.pid>0 && peer.pid!=getpid()) { result=1; printf("%d\n",peer.pid); fflush(stdout); }
    dispatch_semaphore_signal(done);
  });
  xpc_connection_activate(connection);
  xpc_object_t hello = xpc_dictionary_create(NULL, NULL, 0); xpc_dictionary_set_bool(hello, "hello", true);
  xpc_connection_send_message_with_reply(connection, hello, queue, ^(xpc_object_t reply) {
    if (!brain_xpc_authenticate(&peer,reply) || peer.pid<=0 || peer.pid==getpid()) { dispatch_semaphore_signal(done); return; }
    xpc_object_t ready=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(ready,"ready",true);
    xpc_connection_send_message(connection,ready); xpc_release(ready);
  });
  long timeout = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
  brain_xpc_close(&peer); xpc_release(hello); xpc_release(connection);
  return timeout == 0 && result ? 0 : 5;
}
