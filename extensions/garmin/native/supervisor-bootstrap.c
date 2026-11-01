#include "supervisor-bootstrap.h"
#include <string.h>
#include <unistd.h>
static int stopped(const brain_supervisor_bootstrap_ops *ops) {return ops->cancelled(ops->context)!=0;}
int brain_supervisor_start_admitted(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms) {
  if(!host || !broker || !binding || !ops || !ops->target || !ops->admission_current || !ops->cancelled || timeout_ms<=0 || timeout_ms>300000)return 0;
  int fd=-1,spawned=0;
  if(stopped(ops) || !ops->admission_current(ops->context,binding) || stopped(ops))goto fail;
  fd=brain_submission_prepare(broker,timeout_ms);if(fd<0 || stopped(ops))goto fail;
  if(!brain_host_start_auth(host,binding->work,binding->attempt,binding->run_generation,binding->binding_generation,binding->connection_epoch,binding->package,fd))goto fail;
  spawned=1;close(fd);fd=-1;binding->worker_pid=host->pid;memcpy(binding->launch_lease,host->lease,16);
  if(stopped(ops))goto fail;return 1;
fail:
  if(fd>=0)close(fd);if(spawned)brain_host_cancel(host);brain_xpc_close(broker);return 0;
}
int brain_supervisor_authorize_recorded(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms) {
  if(!host || !broker || !binding || !ops || !ops->target || !ops->identity_current || !ops->launch_gui_suspended || !ops->resume_gui || !ops->cancel_gui || !ops->cancelled || timeout_ms<=0 || timeout_ms>300000)return 0;
  int gui_started=0;brain_presence_scope gui={0};
  if(stopped(ops) || !ops->identity_current(ops->context,binding,host->start_sec,host->start_usec) || stopped(ops)
    || !brain_submission_register(broker,binding,ops->target,timeout_ms) || stopped(ops) || !brain_submission_recorded(broker,timeout_ms) || stopped(ops))goto fail;
  gui_started=1;if(!ops->launch_gui_suspended(ops->context,&gui))goto fail;
  if(stopped(ops) || !brain_submission_gui(broker,&gui,timeout_ms) || stopped(ops) || !ops->resume_gui(ops->context,&gui)
    || stopped(ops) || !brain_host_recorded(host) || stopped(ops))goto fail;
  return 1;
fail:
  if(gui_started)ops->cancel_gui(ops->context);brain_host_cancel(host);brain_xpc_close(broker);return 0;
}
int brain_supervisor_bootstrap(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_bootstrap_ops *ops,int timeout_ms) {
  if(!host || !broker || !binding || !ops || !ops->admit || !ops->record_identity || !ops->admission_current || !ops->identity_current || !ops->cancelled)return 0;
  if(stopped(ops) || !ops->admit(ops->context,binding) || stopped(ops)){brain_xpc_close(broker);return 0;}
  if(!brain_supervisor_start_admitted(host,broker,binding,ops,timeout_ms))return 0;
  if(stopped(ops) || !ops->record_identity(ops->context,binding,host->start_sec,host->start_usec) || stopped(ops)) {
    brain_host_cancel(host);brain_xpc_close(broker);return 0;
  }
  return brain_supervisor_authorize_recorded(host,broker,binding,ops,timeout_ms);
}
