#ifndef BRAIN_AUTH_BROKER_H
#define BRAIN_AUTH_BROKER_H
#include <pthread.h>
#include "session.h"
#include "presence.h"

typedef struct { pthread_mutex_t lock; brain_auth_session session; brain_xpc_peer *ui; brain_xpc_peer *worker; int delivered; int needs_reap; brain_presence_challenge challenge; brain_presence_scope scope; uint8_t capability[32], confirmation_prompt[16]; uint64_t confirmation_generation; int capability_ready, awaiting_confirmation, send_issued; int (*guard)(void *); void *guard_context; } brain_auth_broker;
/* peer는 보호 서비스가 인증한 뒤 넘긴다. 모든 상태 전이는 이 API로 직렬화한다. */
int brain_broker_init(brain_auth_broker *broker, const brain_auth_binding *binding, brain_xpc_peer *ui, brain_xpc_peer *worker, int ttl_ms);
int brain_broker_worker(brain_auth_broker *broker);
int brain_broker_recorded(brain_auth_broker *broker);
int brain_broker_attach(brain_auth_broker *broker, const brain_auth_binding *selection);
int brain_broker_set_guard(brain_auth_broker *broker,int (*guard)(void *),void *context);
int brain_broker_approve(brain_auth_broker *broker, int trusted_presence);
int brain_broker_prompt(brain_auth_broker *broker, const uint8_t prompt[16], int is_mfa);
int brain_broker_response(brain_auth_broker *broker, const uint8_t prompt[16], uint64_t sequence);
/* 호출자는 고정된 UI instance와 worker의 OS peer를 검증해야 한다. */
int brain_broker_challenge(brain_auth_broker *broker, const brain_presence_scope *scope, int ttl_ms, brain_presence_challenge *out);
int brain_broker_callback(brain_auth_broker *broker, const uint8_t digest[32], uint8_t capability[32]);
int brain_broker_consume(brain_auth_broker *broker, const brain_presence_scope *scope, const uint8_t prompt[16], const uint8_t capability[32]);
int brain_broker_send_ready(brain_auth_broker *broker,const uint8_t prompt[16],uint64_t generation);
int brain_broker_confirm(brain_auth_broker *broker,const uint8_t prompt[16],uint64_t generation);
/* spawn 전에 생성한다. worker 쪽은 보호 host의 spawn에서만 상속해야 한다. */
int brain_broker_prepare_channel(int *worker_fd, int *ui_fd, int timeout_ms);
/* supervisor 기록과 worker 상속을 확인한 뒤 검증된 UI에만 전달한다. */
int brain_broker_deliver(brain_auth_broker *broker, int ui_fd);
void brain_broker_cancel(brain_auth_broker *broker);
void brain_broker_destroy(brain_auth_broker *broker);
#endif
