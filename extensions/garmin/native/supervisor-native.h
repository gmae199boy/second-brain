#ifndef BRAIN_SUPERVISOR_NATIVE_H
#define BRAIN_SUPERVISOR_NATIVE_H
#include "supervisor-bootstrap.h"
#include "gui-client.h"
typedef struct {
  void *context;
  const char *target;
  int (*admit)(void *,const brain_auth_binding *);
  int (*record_identity)(void *,const brain_auth_binding *,uint64_t,uint64_t);
  int (*admission_current)(void *,const brain_auth_binding *);
  int (*identity_current)(void *,const brain_auth_binding *,uint64_t,uint64_t);
  int (*cancelled)(void *);
} brain_supervisor_store_ops;
/* Core 소유 admission과 identity 기록 사이에서 native host를 분리 실행한다. */
int brain_supervisor_native_start_admitted(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms);
int brain_supervisor_native_authorize_recorded(brain_host_client *host,brain_xpc_peer *broker,brain_gui_client *gui,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms);
/* 저장소 callback은 실제 commit 결과를 확인해야 하며 불명이면 실패다. */
int brain_supervisor_native_bootstrap(brain_host_client *host,brain_xpc_peer *broker,brain_gui_client *gui,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms);
#endif
