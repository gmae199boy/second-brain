#include "session.h"
#include <string.h>
#include <time.h>

static int64_t now_ms(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1; return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int nonzero(const uint8_t *p, size_t n) { unsigned v = 0; for (size_t i = 0; i < n; i++) v |= p[i]; return v != 0; }
static int same(const brain_auth_binding *a, const brain_auth_binding *b) {
  return !memcmp(a->session,b->session,16) && !memcmp(a->work,b->work,16) && !memcmp(a->attempt,b->attempt,16)
    && !memcmp(a->launch_lease,b->launch_lease,16) && !memcmp(a->package,b->package,32)
    && a->run_generation == b->run_generation && a->binding_generation == b->binding_generation
    && a->package_generation == b->package_generation && a->connection_epoch == b->connection_epoch
    && a->worker_uid == b->worker_uid && a->ui_uid == b->ui_uid && a->worker_pid == b->worker_pid
    && !memcmp(a->worker_hash,b->worker_hash,20) && !memcmp(a->ui_hash,b->ui_hash,20);
}
void brain_auth_revoke(brain_auth_session *s) { if (s) { s->revoked = 1; s->approved = 0; s->prompt_open = 0; memset(s->prompt, 0, sizeof s->prompt); } }
static int active(brain_auth_session *s) {
  int64_t now = now_ms(); if (!s || s->revoked || now < 0 || now >= s->deadline_ms) { brain_auth_revoke(s); return 0; } return 1;
}
int brain_auth_is_active(brain_auth_session *s) { return active(s); }
int brain_auth_init(brain_auth_session *s, const brain_auth_binding *b, int ttl_ms) {
  /* [ASSUMPTION] 전체 세션 상한 5분은 D4 실제 UI 검증 때 재평가한다. */
  if (!s) return 0;
  memset(s, 0, sizeof *s); s->revoked = 1;
  if (!b || ttl_ms <= 0 || ttl_ms > 300000 || !b->run_generation || !b->binding_generation || !b->package_generation || !b->connection_epoch || !b->worker_uid || !b->ui_uid
#if !defined(BRAIN_NATIVE_FIXTURE) || !defined(BRAIN_SAME_UID_FIXTURE)
    || b->worker_uid == b->ui_uid
#endif
    || b->worker_pid <= 0 || !nonzero(b->session,16) || !nonzero(b->work,16) || !nonzero(b->attempt,16)
    || !nonzero(b->launch_lease,16) || !nonzero(b->package,32) || !nonzero(b->worker_hash,20) || !nonzero(b->ui_hash,20)) return 0;
  int64_t now = now_ms(); if (now < 0) return 0;
  *s = (brain_auth_session){ .binding = *b, .deadline_ms = now + ttl_ms }; return 1;
}
int brain_auth_worker(brain_auth_session *s, const brain_xpc_peer *peer) {
  if (!active(s) || !peer || !peer->authenticated || s->worker_verified || peer->uid != s->binding.worker_uid
    || peer->pid != s->binding.worker_pid || memcmp(peer->hash,s->binding.worker_hash,20)) { brain_auth_revoke(s); return 0; }
  s->worker_verified = 1; return 1;
}
int brain_auth_recorded(brain_auth_session *s) {
  if (!active(s) || !s->worker_verified || s->recorded) { brain_auth_revoke(s); return 0; }
  s->recorded = 1; return 1;
}
int brain_auth_attach(brain_auth_session *s, const brain_xpc_peer *peer, const brain_auth_binding *selection) {
  if (!active(s) || !s->recorded || s->attached || !peer || !peer->authenticated || peer->uid != s->binding.ui_uid
    || memcmp(peer->hash,s->binding.ui_hash,20) || !selection || !same(&s->binding,selection)) { brain_auth_revoke(s); return 0; }
  s->attached = 1; return 1;
}
int brain_auth_approve_callback(brain_auth_session *s) {
  if (!active(s) || !s->attached || !s->prompt_open || s->approved) { brain_auth_revoke(s); return 0; }
  s->approved = 1; return 1;
}
int brain_auth_approve(brain_auth_session *s, int trusted_presence) {
  if (!active(s) || !s->attached || !s->prompt_open || s->approved || trusted_presence != 1) { brain_auth_revoke(s); return 0; }
#ifndef BRAIN_NATIVE_FIXTURE
  /* 사용자 승인 세탁과 접근성 자동화의 OS 증거가 없어 실제 승인은 닫혀 있다. */
  brain_auth_revoke(s); return 0;
#else
  return brain_auth_approve_callback(s);
#endif
}
int brain_auth_prompt(brain_auth_session *s, const uint8_t prompt[16], int is_mfa) {
  if (!active(s) || !s->attached || s->prompt_open || s->approved || !prompt || !nonzero(prompt,16) || (is_mfa != 0 && is_mfa != 1)
    || s->prompt_count >= 4 || (is_mfa ? (s->sequence == 0 || s->mfa_count >= 3) : s->prompt_count != 0)) { brain_auth_revoke(s); return 0; }
  for (size_t i = 0; i < s->prompt_count; i++) if (!memcmp(s->seen_prompts[i], prompt, 16)) { brain_auth_revoke(s); return 0; }
  if (is_mfa) s->mfa_count++; memcpy(s->seen_prompts[s->prompt_count++],prompt,16); memcpy(s->prompt,prompt,16); s->prompt_open = 1; return 1;
}
int brain_auth_response(brain_auth_session *s, const uint8_t prompt[16], uint64_t sequence) {
  if (!active(s) || !s->approved || !s->prompt_open || !prompt || memcmp(s->prompt,prompt,16)
    || sequence != s->sequence + 1 || sequence > 64) { brain_auth_revoke(s); return 0; }
  s->sequence = sequence; s->prompt_open = 0; s->approved = 0; memset(s->prompt,0,16); return 1;
}
