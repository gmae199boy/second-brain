#include "supervisor-native.h"
typedef struct {brain_gui_client *gui;const brain_supervisor_store_ops *store;} context;
static int admit(void *p,const brain_auth_binding *b){context *c=p;return c->store->admit(c->store->context,b);}
static int record(void *p,const brain_auth_binding *b,uint64_t s,uint64_t u){context *c=p;return c->store->record_identity(c->store->context,b,s,u);}
static int admission_current(void *p,const brain_auth_binding *b){context *c=p;return c->store->admission_current(c->store->context,b);}
static int identity_current(void *p,const brain_auth_binding *b,uint64_t s,uint64_t u){context *c=p;return c->store->identity_current(c->store->context,b,s,u);}
static int cancelled(void *p){context *c=p;return c->store->cancelled(c->store->context);}
static int launch(void *p,brain_presence_scope *s){context *c=p;return brain_gui_client_start(c->gui,s);}
static int resume(void *p,const brain_presence_scope *s){context *c=p;return brain_gui_client_resume(c->gui,s);}
static void cancel_gui(void *p){context *c=p;(void)brain_gui_client_cancel(c->gui);}
int brain_supervisor_native_start_admitted(brain_host_client *host,brain_xpc_peer *broker,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms){
  if(!store || !store->target || !store->admission_current || !store->cancelled)return 0;
  context c={NULL,store};brain_supervisor_bootstrap_ops ops={.context=&c,.target=store->target,.admission_current=admission_current,.cancelled=cancelled};
  return brain_supervisor_start_admitted(host,broker,binding,&ops,timeout_ms);
}
int brain_supervisor_native_authorize_recorded(brain_host_client *host,brain_xpc_peer *broker,brain_gui_client *gui,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms){
  if(!gui || !store || !store->target || !store->identity_current || !store->cancelled)return 0;
  context c={gui,store};brain_supervisor_bootstrap_ops ops={.context=&c,.target=store->target,.identity_current=identity_current,.launch_gui_suspended=launch,.resume_gui=resume,.cancel_gui=cancel_gui,.cancelled=cancelled};
  return brain_supervisor_authorize_recorded(host,broker,binding,&ops,timeout_ms);
}
int brain_supervisor_native_bootstrap(brain_host_client *host,brain_xpc_peer *broker,brain_gui_client *gui,brain_auth_binding *binding,const brain_supervisor_store_ops *store,int timeout_ms){
  if(!gui || !store || !store->target || !store->admit || !store->record_identity || !store->admission_current || !store->identity_current || !store->cancelled)return 0;
  context c={gui,store};brain_supervisor_bootstrap_ops ops={.context=&c,.target=store->target,.admit=admit,.record_identity=record,.admission_current=admission_current,.identity_current=identity_current,.launch_gui_suspended=launch,.resume_gui=resume,.cancel_gui=cancel_gui,.cancelled=cancelled};
  return brain_supervisor_bootstrap(host,broker,binding,&ops,timeout_ms);
}
