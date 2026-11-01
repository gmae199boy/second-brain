#include "xpc-peer.h"
#include <fcntl.h>
#include <sys/stat.h>
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <string.h>
#include <unistd.h>

static int configure(brain_xpc_peer *peer, xpc_connection_t connection, uid_t uid, pid_t pid, const uint8_t hash[20]) {
  if (!peer || !connection || !hash || uid == 0 || pid < 0) return 0;
  *peer = (brain_xpc_peer){0}; unsigned nonzero = 0;
  for (int i = 0; i < 20; i++) nonzero |= hash[i]; if (!nonzero) return 0;
  char requirement[51]; memcpy(requirement, "cdhash H\"", 9); static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 20; i++) { requirement[9+i*2] = hex[hash[i] >> 4]; requirement[10+i*2] = hex[hash[i] & 15]; }
  requirement[49] = '"'; requirement[50] = 0;
  if (__builtin_available(macOS 12.0, *)) {
    if (xpc_connection_set_peer_code_signing_requirement(connection, requirement) != 0) return 0;
  } else return 0;
  peer->connection = connection; peer->uid = uid; peer->pid = pid; memcpy(peer->hash, hash, 20); peer->configured = 1; return 1;
}
int brain_xpc_configure(brain_xpc_peer *peer, xpc_connection_t connection, uid_t uid, pid_t pid, const uint8_t hash[20]) {
  return pid > 0 && configure(peer, connection, uid, pid, hash);
}
int brain_xpc_configure_service(brain_xpc_peer *peer, xpc_connection_t connection, uid_t uid, const uint8_t hash[20]) {
  return configure(peer, connection, uid, 0, hash);
}
static int verify_message(brain_xpc_peer *peer, xpc_object_t message) {
  if (!peer || !peer->configured || !peer->connection || !message || xpc_get_type(message) != XPC_TYPE_DICTIONARY) return 0;
  pid_t actual = xpc_connection_get_pid(peer->connection);
  if (xpc_connection_get_euid(peer->connection) != peer->uid || actual <= 0 || (peer->pid != 0 && actual != peer->pid)) return 0;
  char requirement[51]; memcpy(requirement, "cdhash H\"", 9); static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 20; i++) { requirement[9+i*2] = hex[peer->hash[i] >> 4]; requirement[10+i*2] = hex[peer->hash[i] & 15]; }
  requirement[49] = '\"'; requirement[50] = 0;
  CFStringRef text = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
  SecRequirementRef req = NULL; SecCodeRef code = NULL;
  int valid = text && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &req) == errSecSuccess
    && SecCodeCreateWithXPCMessage(message, kSecCSDefaultFlags, &code) == errSecSuccess
    && SecCodeCheckValidity(code, kSecCSStrictValidate, req) == errSecSuccess;
  if (code) CFRelease(code); if (req) CFRelease(req); if (text) CFRelease(text);
  if (valid && peer->pid == 0) peer->pid = actual;
  return valid;
}
int brain_xpc_authenticate(brain_xpc_peer *peer, xpc_object_t message) {
  if (!peer || peer->authenticated || !message || xpc_get_type(message) != XPC_TYPE_DICTIONARY
      || xpc_dictionary_get_count(message) != 1) return 0;
  xpc_object_t hello = xpc_dictionary_get_value(message, "hello");
  if (!hello || xpc_get_type(hello) != XPC_TYPE_BOOL || !xpc_bool_get_value(hello) || !verify_message(peer, message)) return 0;
  peer->authenticated = 1; return 1;
}
int brain_xpc_verify_message(brain_xpc_peer *peer, xpc_object_t message) {
  if (!peer || !peer->authenticated || !verify_message(peer,message)) { if (peer) brain_xpc_close(peer); return 0; }
  return 1;
}
int brain_xpc_send_fd(brain_xpc_peer *peer, int fd) {
  if (!peer || !peer->authenticated || peer->sent || fd < 0) return 0;
  peer->sent = 1;
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0); if (!message) return 0;
  xpc_dictionary_set_fd(message, "fd", fd);
  xpc_connection_send_message(peer->connection, message); xpc_release(message); return 1;
}
int brain_xpc_receive_fd(brain_xpc_peer *peer, xpc_object_t message) {
  if (!peer || !peer->authenticated || peer->received || !message || xpc_get_type(message) != XPC_TYPE_DICTIONARY) return -1;
  peer->received = 1;
  xpc_object_t value = xpc_dictionary_get_value(message, "fd");
  if (xpc_dictionary_get_count(message) != 1 || !value || xpc_get_type(value) != XPC_TYPE_FD || !verify_message(peer, message)) { brain_xpc_close(peer); return -1; }
  int fd = xpc_dictionary_dup_fd(message, "fd");
  struct stat info;
  if (fd < 0 || fstat(fd, &info) || (!S_ISSOCK(info.st_mode) && !S_ISFIFO(info.st_mode))
      || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) { if (fd >= 0) close(fd); brain_xpc_close(peer); return -1; }
  return fd;
}
void brain_xpc_close(brain_xpc_peer *peer) {
  if (!peer) return;
  if (peer->connection) xpc_connection_cancel(peer->connection);
  *peer = (brain_xpc_peer){0};
}
