#ifndef BRAIN_SUPERVISOR_BOOTSTRAP_H
#define BRAIN_SUPERVISOR_BOOTSTRAP_H
#include "host-client.h"
#include "submission-ipc.h"
/* 성공은 commit 응답을 확인한 경우만 반환한다. 불명·취소는 실패다. */
typedef struct {
  void *context;
  const char *target;
  int (*admit)(void *,const brain_auth_binding *);
  int (*record_identity)(void *,const brain_auth_binding *,uint64_t,uint64_t);
  int (*admission_current)(void *,const brain_auth_binding *);
  int (*identity_current)(void *,const brain_auth_binding *,uint64_t,uint64_t);
  int (*launch_gui_suspended)(void *,brain_presence_scope *);
  int (*resume_gui)(void *,const brain_presence_scope *);
  void (*cancel_gui)(void *);
  int (*cancelled)(void *);
} brain_supervisor_bootstrap_ops;
/* Core가 admission을 commit한 뒤 실행한다. 이 함수는 새 admission을 만들지 않는다. */
int brain_supervisor_start_admitted(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms);
/* Core가 OS identity를 commit한 뒤 재검증하고 GUI와 worker ACK를 진행한다. */
int brain_supervisor_authorize_recorded(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms);
/* 실패 시 admission은 자동 해제하지 않는다. 호출자는 종료 불명을 보존한다. */
int brain_supervisor_bootstrap(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms);
#endif
