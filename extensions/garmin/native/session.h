#ifndef BRAIN_AUTH_SESSION_H
#define BRAIN_AUTH_SESSION_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include "xpc-peer.h"

typedef struct {
  uint8_t session[16], work[16], attempt[16], launch_lease[16], package[32];
  uint64_t run_generation, binding_generation, package_generation, connection_epoch;
  uid_t worker_uid, ui_uid; pid_t worker_pid;
  uint8_t worker_hash[20], ui_hash[20];
} brain_auth_binding;
typedef struct {
  brain_auth_binding binding;
  int64_t deadline_ms;
  uint64_t sequence;
  uint8_t prompt[16], seen_prompts[64][16];
  size_t prompt_count;
  int worker_verified, recorded, attached, approved, prompt_open, mfa_count, revoked;
} brain_auth_session;
int brain_auth_init(brain_auth_session *session, const brain_auth_binding *binding, int ttl_ms);
int brain_auth_worker(brain_auth_session *session, const brain_xpc_peer *peer);
int brain_auth_recorded(brain_auth_session *session);
int brain_auth_attach(brain_auth_session *session, const brain_xpc_peer *peer, const brain_auth_binding *selection);
/* trusted_presence는 OS 검증된 UI 승인 증거만 받는다. XPC payload의 boolean이 아니다. */
int brain_auth_approve(brain_auth_session *session, int trusted_presence);
int brain_auth_prompt(brain_auth_session *session, const uint8_t prompt[16], int is_mfa);
int brain_auth_response(brain_auth_session *session, const uint8_t prompt[16], uint64_t sequence);
int brain_auth_is_active(brain_auth_session *session);
void brain_auth_revoke(brain_auth_session *session);
#endif
