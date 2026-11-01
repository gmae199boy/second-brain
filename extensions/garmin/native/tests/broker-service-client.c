#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#include "../xpc-peer.h"
#include "fixture-common.h"
static int connect_role(brain_xpc_peer *peer,const char *base,const char *role,const uint8_t hash[20]) {
  char service[256]; if(snprintf(service,sizeof service,"%s.%s",base,role)>=(int)sizeof service)return 0;
  xpc_connection_t c=xpc_connection_create_mach_service(service,NULL,0); if(!c || !brain_xpc_configure_service(peer,c,geteuid(),hash))return 0;
  xpc_connection_set_event_handler(c,^(xpc_object_t event){
    (void)event;
  }); xpc_connection_activate(c);
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(m,"hello",true);
  xpc_object_t r=xpc_connection_send_message_with_reply_sync(c,m); xpc_release(m);
  int ok=brain_xpc_authenticate(peer,r); if(r)xpc_release(r); return ok;
}
static xpc_object_t call(brain_xpc_peer *peer,xpc_object_t message) { return xpc_connection_send_message_with_reply_sync(peer->connection,message); }
static int accepted(brain_xpc_peer *peer,xpc_object_t message) {
  xpc_object_t r=call(peer,message); int ok=r && brain_xpc_verify_message(peer,r) && xpc_dictionary_get_bool(r,"accepted"); if(r)xpc_release(r); return ok;
}
int main(int argc,char **argv) {
  if(argc!=3)return 2; uint8_t hash[20]; if(!fixture_hash(argv[2],hash))return 3;
  brain_xpc_peer supervisor={0},worker={0},ui={0}; if(!connect_role(&supervisor,argv[1],"supervisor",hash))return 4;
  xpc_object_t m=xpc_dictionary_create(NULL,NULL,0); uuid_t ids[4]; uint8_t package[32]; memset(package,1,sizeof package);
  xpc_dictionary_set_string(m,"op","register"); const char *keys[]={"work","attempt","session","lease"};
  for(int i=0;i<4;i++){uuid_generate_random(ids[i]);xpc_dictionary_set_uuid(m,keys[i],ids[i]);}
  xpc_dictionary_set_uint64(m,"run",1);xpc_dictionary_set_uint64(m,"binding",1);xpc_dictionary_set_uint64(m,"package_generation",1);xpc_dictionary_set_uint64(m,"epoch",1);
  xpc_dictionary_set_int64(m,"pid",getpid());xpc_dictionary_set_data(m,"package",package,sizeof package);
  if(!accepted(&supervisor,m))return 5; xpc_release(m);
  if(!connect_role(&worker,argv[1],"worker",hash))return 6;
  m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","attach");if(!accepted(&worker,m))return 7;xpc_release(m);
  m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","recorded");if(!accepted(&supervisor,m))return 8;xpc_release(m);
  if(!connect_role(&ui,argv[1],"ui",hash))return 9;
  m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","select_target");xpc_object_t r=call(&ui,m);xpc_release(m);
  if(!r || !brain_xpc_verify_message(&ui,r) || xpc_dictionary_get_count(r)!=9 || memcmp(xpc_dictionary_get_uuid(r,"work"),ids[0],16))return 10;
  xpc_release(r); m=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(m,"op","selection");
  for(int i=0;i<4;i++)xpc_dictionary_set_uuid(m,keys[i],ids[i]);
  xpc_dictionary_set_uint64(m,"run",1);xpc_dictionary_set_uint64(m,"binding",1);xpc_dictionary_set_uint64(m,"package_generation",1);xpc_dictionary_set_uint64(m,"epoch",1);xpc_dictionary_set_data(m,"package",package,sizeof package);
  r=call(&ui,m);xpc_release(m);
  int ok=r && xpc_get_type(r)==XPC_TYPE_ERROR;if(r)xpc_release(r);
  brain_xpc_close(&supervisor);brain_xpc_close(&worker);brain_xpc_close(&ui);return ok ? 0 : 11;
}
