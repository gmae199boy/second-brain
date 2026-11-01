#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dispatch/dispatch.h>
#include "../xpc-peer.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  uint8_t hash[20]; if (!fixture_hash(argv[1], hash)) return 3;
  const uint8_t *hash_ptr = hash;
  dispatch_queue_t queue = dispatch_queue_create("fixture.xpc", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  xpc_connection_t listener = xpc_connection_create(NULL, queue);
  __block brain_xpc_peer server = {0}, client = {0}; __block int success = 0;
  brain_xpc_peer listener_policy;
  if (!brain_xpc_configure(&listener_policy, listener, geteuid(), getpid(), hash)) return 4;
  xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
    xpc_connection_t connection = (xpc_connection_t)event;
    if (!brain_xpc_configure(&server, connection, geteuid(), getpid(), hash_ptr)) { dispatch_semaphore_signal(done); return; }
    xpc_connection_set_event_handler(connection, ^(xpc_object_t message) {
      if (!server.authenticated) {
        if (!brain_xpc_authenticate(&server, message)) { dispatch_semaphore_signal(done); return; }
        xpc_object_t reply = xpc_dictionary_create_reply(message);
        if (!reply) { dispatch_semaphore_signal(done); return; }
        xpc_dictionary_set_bool(reply, "hello", true); xpc_connection_send_message(connection, reply); xpc_release(reply);
        return;
      }
      if (xpc_get_type(message) != XPC_TYPE_DICTIONARY || xpc_dictionary_get_count(message) != 1 || !xpc_dictionary_get_bool(message, "ready")) { dispatch_semaphore_signal(done); return; }
      int secret[2]; if (pipe(secret)) { dispatch_semaphore_signal(done); return; }
      if (write(secret[1], "fixture-key", 11) != 11) { close(secret[0]); close(secret[1]); dispatch_semaphore_signal(done); return; }
      close(secret[1]); int sent = brain_xpc_send_fd(&server, secret[0]); int duplicate = brain_xpc_send_fd(&server, secret[0]); close(secret[0]);
      if (!sent || duplicate) dispatch_semaphore_signal(done);
    });
    xpc_connection_activate(connection);
  });
  xpc_connection_activate(listener);
  xpc_endpoint_t endpoint = xpc_endpoint_create(listener);
  xpc_connection_t connection = xpc_connection_create_from_endpoint(endpoint);
  if (!brain_xpc_configure_service(&client, connection, geteuid(), hash)) return 5;
  xpc_connection_set_event_handler(connection, ^(xpc_object_t message) {
    if (xpc_get_type(message) != XPC_TYPE_DICTIONARY || !client.authenticated) { dispatch_semaphore_signal(done); return; }
    int fd = brain_xpc_receive_fd(&client, message); if (fd < 0) { dispatch_semaphore_signal(done); return; }
    char bytes[16] = {0}; ssize_t n = read(fd, bytes, sizeof bytes); close(fd);
    success = n == 11 && memcmp(bytes, "fixture-key", 11) == 0 && brain_xpc_receive_fd(&client, message) == -1;
    memset(bytes, 0, sizeof bytes); dispatch_semaphore_signal(done);
  });
  xpc_connection_activate(connection);
  xpc_object_t hello = xpc_dictionary_create(NULL, NULL, 0); xpc_dictionary_set_bool(hello, "hello", true);
  xpc_connection_send_message_with_reply(connection, hello, queue, ^(xpc_object_t reply) {
    if (!brain_xpc_authenticate(&client, reply) || client.pid != getpid()) { dispatch_semaphore_signal(done); return; }
    xpc_object_t ready = xpc_dictionary_create(NULL, NULL, 0); xpc_dictionary_set_bool(ready, "ready", true);
    xpc_connection_send_message(connection, ready); xpc_release(ready);
  });
  long timeout = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
  brain_xpc_close(&client); brain_xpc_close(&server); brain_xpc_close(&listener_policy);
  xpc_release(hello); xpc_release(connection); xpc_release(endpoint); xpc_release(listener);
  if (timeout || !success) fprintf(stderr, "timeout=%ld success=%d\n", timeout, success);
  return timeout == 0 && success ? 0 : 6;
}
