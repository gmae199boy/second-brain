#ifndef BRAIN_SUBMISSION_IPC_H
#define BRAIN_SUBMISSION_IPC_H
#include "presence.h"
#include "xpc-peer.h"
#include "auth-channel.h"
/* 인증된 peer 전용 유한 대기 요청. 반환된 reply는 호출자가 release한다. */
xpc_object_t brain_submission_call(brain_xpc_peer *peer,xpc_object_t message,int timeout_ms);
int brain_submission_connect(brain_xpc_peer *peer,const char *service,uid_t uid,const uint8_t hash[20],int timeout_ms);
/* 호출자는 역할별 OS peer를 인증하고 연결의 단독 소유권을 유지한다. */
int brain_submission_prompt(brain_xpc_peer *peer, const uint8_t prompt[16], int is_mfa, int timeout_ms);
int brain_submission_worker_attach(brain_xpc_peer *peer,uint8_t session[16],int timeout_ms);
/* 1 준비, 0 대기, -1 오류. */
int brain_submission_ready(brain_xpc_peer *peer,int timeout_ms);
int brain_submission_challenge(brain_xpc_peer *peer, uint64_t generation, brain_presence_challenge *challenge, int timeout_ms);
int brain_submission_assertion(brain_xpc_peer *peer, const uint8_t digest[32], int timeout_ms);
int brain_submission_send_ready(brain_xpc_peer *peer,const uint8_t prompt[16],uint64_t generation,int timeout_ms);
typedef struct { brain_xpc_peer *peer; int timeout_ms; } brain_submission_control;
int brain_submission_verify(void *context, const uint8_t prompt[16], uint64_t generation);
int brain_submission_confirm(void *context, const uint8_t prompt[16], uint64_t generation);
int brain_submission_receive(brain_submission_control *control, brain_auth_channel *channel, const uint8_t prompt[16], uint64_t generation, uint8_t *payload, size_t capacity, size_t *length, int timeout_ms);
/* supervisor는 내구 admission 후 생성하고 실제 프로세스 기록 commit 뒤 recorded를 보낸다. */
int brain_submission_prepare(brain_xpc_peer *supervisor, int timeout_ms);
int brain_submission_register(brain_xpc_peer *supervisor, const brain_auth_binding *binding, const char *target, int timeout_ms);
int brain_submission_gui(brain_xpc_peer *supervisor, const brain_presence_scope *scope, int timeout_ms);
int brain_submission_recorded(brain_xpc_peer *supervisor, int timeout_ms);
/* 성공 응답은 해당 capability 폐기와 broker 소유 socket shutdown 뒤에만 나온다. */
int brain_submission_revoke(brain_xpc_peer *supervisor,const brain_auth_binding *binding,int timeout_ms);
#endif
