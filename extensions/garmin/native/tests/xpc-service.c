#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/random.h>
#include <xpc/xpc.h>
#include <dispatch/dispatch.h>
#include "../xpc-peer.h"
#include "fixture-common.h"
static uint8_t client_hash[20];
static void on_connection(xpc_connection_t connection) {
    brain_xpc_peer *peer = calloc(1, sizeof *peer); if (!peer) return;
    if (!brain_xpc_configure_service(peer, connection, geteuid(), client_hash)) { free(peer); return; }
    xpc_connection_set_event_handler(connection, ^(xpc_object_t message) {
      if (xpc_get_type(message) == XPC_TYPE_ERROR) {
        if (message == XPC_ERROR_CONNECTION_INVALID) { brain_xpc_close(peer); free(peer); }
        else brain_xpc_close(peer);
        return;
      }
      if (!peer->authenticated) {
        if (!brain_xpc_authenticate(peer, message)) { brain_xpc_close(peer); return; }
        xpc_object_t reply = xpc_dictionary_create_reply(message); if (!reply) { brain_xpc_close(peer); return; }
        xpc_dictionary_set_bool(reply, "hello", true); xpc_connection_send_message(connection, reply); xpc_release(reply); return;
      }
      if (!brain_xpc_verify_message(peer,message) || xpc_dictionary_get_count(message)!=1 || !xpc_dictionary_get_bool(message,"ready")) { brain_xpc_close(peer); return; }
      int secret[2]; uint8_t value[32];
      if (pipe(secret)) { brain_xpc_close(peer); return; }
      if (getentropy(value,sizeof value) || write(secret[1],value,sizeof value)!=(ssize_t)sizeof value) { close(secret[0]); close(secret[1]); brain_xpc_close(peer); return; }
      memset(value,0,sizeof value); close(secret[1]);
      if (!brain_xpc_send_fd(peer,secret[0])) brain_xpc_close(peer);
      close(secret[0]);
    });
    xpc_connection_activate(connection);
}
int main(int argc, char **argv) {
  if (argc != 3 || !fixture_hash(argv[2], client_hash)) return 2;
  xpc_connection_t listener = xpc_connection_create_mach_service(argv[1], NULL, XPC_CONNECTION_MACH_SERVICE_LISTENER);
  if (!listener) return 3;
  brain_xpc_peer policy;
  if (!brain_xpc_configure_service(&policy, listener, geteuid(), client_hash)) return 4;
  xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_CONNECTION) on_connection((xpc_connection_t)event);
  });
  xpc_connection_activate(listener);
  dispatch_main();
  return 0;
}
