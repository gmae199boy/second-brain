#include "gui-client.h"
#include <string.h>
static int field(xpc_object_t m,const char *key,xpc_type_t type){xpc_object_t v=xpc_dictionary_get_value(m,key);return v && xpc_get_type(v)==type;}
static xpc_object_t call(brain_gui_client *c,xpc_object_t message) {
  if(!c || !c->peer || !c->peer->authenticated || c->unknown)return NULL;
  xpc_object_t r=brain_submission_call(c->peer,message,c->timeout_ms);if(!r)c->unknown=1;return r;
}
int brain_gui_client_start(brain_gui_client *c,brain_presence_scope *out) {
  if(!c || !out || c->started || c->unknown)return 0;xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;
  xpc_dictionary_set_string(m,"op","start");xpc_object_t r=call(c,m);xpc_release(m);
  const char *uuids[]={"session","instance","boot"},*numbers[]={"asid","start_sec","start_usec","policy"};int ok=r && xpc_dictionary_get_count(r)==8 && field(r,"pid",XPC_TYPE_INT64);
  for(size_t i=0;ok && i<3;i++)ok=field(r,uuids[i],XPC_TYPE_UUID);
  for(size_t i=0;ok && i<4;i++)ok=field(r,numbers[i],XPC_TYPE_UINT64);
  int64_t pid=ok?xpc_dictionary_get_int64(r,"pid"):0;
  if(ok && pid>0 && pid<=INT32_MAX){brain_presence_scope s={0};s.gui_pid=(uint64_t)pid;s.gui_asid=xpc_dictionary_get_uint64(r,"asid");
    s.gui_start_sec=xpc_dictionary_get_uint64(r,"start_sec");s.gui_start_usec=xpc_dictionary_get_uint64(r,"start_usec");s.policy_generation=xpc_dictionary_get_uint64(r,"policy");
    memcpy(s.gui_session,xpc_dictionary_get_uuid(r,"session"),16);memcpy(s.gui_instance,xpc_dictionary_get_uuid(r,"instance"),16);memcpy(s.gui_boot,xpc_dictionary_get_uuid(r,"boot"),16);
    if(s.gui_asid && s.gui_start_sec && s.policy_generation){c->scope=s;*out=s;c->started=1;}}
  if(r)xpc_release(r);if(!c->started){c->unknown=1;if(c->peer)brain_xpc_close(c->peer);}return c->started;
}
static int operation(brain_gui_client *c,const char *op,const char *fieldname) {
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0);if(!m)return 0;xpc_dictionary_set_string(m,"op",op);
  xpc_dictionary_set_int64(m,"pid",(int64_t)c->scope.gui_pid);xpc_dictionary_set_uuid(m,"instance",c->scope.gui_instance);
  xpc_object_t r=call(c,m);xpc_release(m);int ok=r && xpc_dictionary_get_count(r)==1 && field(r,fieldname,XPC_TYPE_BOOL) && xpc_dictionary_get_bool(r,fieldname);
  if(r)xpc_release(r);if(!ok)c->unknown=1;return ok;
}
int brain_gui_client_resume(brain_gui_client *c,const brain_presence_scope *s) {
  if(!c || !s || !c->started || c->resumed || c->unknown || memcmp(s,&c->scope,sizeof *s))return 0;
  if(!operation(c,"resume","accepted"))return 0;c->resumed=1;return 1;
}
int brain_gui_client_cancel(brain_gui_client *c) {
  if(!c || !c->started || c->unknown)return 0;int ok=operation(c,"cancel","ended");if(ok)c->started=0;return ok;
}
