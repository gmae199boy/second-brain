#ifndef BRAIN_AUTH_BROKER_H
#define BRAIN_AUTH_BROKER_H
#include <pthread.h>
#include "session.h"

typedef struct { pthread_mutex_t lock; brain_auth_session session; brain_xpc_peer *ui; brain_xpc_peer *worker; int delivered; int needs_reap; } brain_auth_broker;
/* peer는 보호 서비스가 인증한 뒤 넘긴다. 모든 상태 전이는 이 API로 직렬화한다. */
int brain_broker_init(brain_auth_broker *broker, const brain_auth_binding *binding, brain_xpc_peer *ui, brain_xpc_peer *worker, int ttl_ms);
int brain_broker_worker(brain_auth_broker *broker);
int brain_broker_recorded(brain_auth_broker *broker);
int brain_broker_attach(brain_auth_broker *broker, const brain_auth_binding *selection);
int brain_broker_approve(brain_auth_broker *broker, int trusted_presence);
int brain_broker_prompt(brain_auth_broker *broker, const uint8_t prompt[16], int is_mfa);
int brain_broker_response(brain_auth_broker *broker, const uint8_t prompt[16], uint64_t sequence);
/* spawn 전에 생성한다. worker 쪽은 보호 host의 spawn에서만 상속해야 한다. */
int brain_broker_prepare_channel(int *worker_fd, int *ui_fd, int timeout_ms);
/* 상속과 내구 기록의 실제 연결 전에는 전달하지 않는다. */
int brain_broker_deliver(brain_auth_broker *broker, int timeout_ms);
void brain_broker_cancel(brain_auth_broker *broker);
void brain_broker_destroy(brain_auth_broker *broker);
#endif
