/* 빌드 시 보호 설치 정책으로 고정된 launcher 신원만 허용한다. 기본값은 닫힘이다. */
#include <node_api.h>
#include "peer.h"
#include <string.h>
#if defined(BRAIN_SUPERVISOR_FIXTURE) && !defined(BRAIN_REGISTRY_FIXTURE)
#error supervisor_fixture_requires_registry_fixture
#endif
#ifdef BRAIN_SUPERVISOR_AUTHORITY
#include <errno.h>
#include <poll.h>
#endif
#include <unistd.h>
#ifndef BRAIN_QUEUE_GATEWAY_UID
#define BRAIN_QUEUE_GATEWAY_UID 0
#endif
#ifndef BRAIN_QUEUE_GATEWAY_HASH
#define BRAIN_QUEUE_GATEWAY_HASH ""
#endif
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int matches(int fd) {
  const char *hex=BRAIN_QUEUE_GATEWAY_HASH;uint8_t hash[20];
  if(strlen(hex)!=40||BRAIN_QUEUE_GATEWAY_UID==0)return 0;
  for(int i=0;i<20;i++){int a=digit(hex[2*i]),b=digit(hex[2*i+1]);if(a<0||b<0)return 0;hash[i]=(uint8_t)((a<<4)|b);}
  return brain_verify_peer(fd,(uid_t)BRAIN_QUEUE_GATEWAY_UID,getppid(),hash);
}
static napi_value bootstrap(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;if(napi_get_boolean(env,matches(5)&&matches(6),&result)!=napi_ok)return NULL;return result;
}
static napi_value peer(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;if(napi_get_boolean(env,matches(5),&result)!=napi_ok)return NULL;return result;
}
#ifdef BRAIN_SUPERVISOR_AUTHORITY
/* 단회 native capability는 검증된 launcher ACK 뒤 같은 프로세스에서만 만든다. */
static int claimed=0,consumed=0;static char capability;
static napi_value claim_supervisor(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;uint8_t ack=0;struct pollfd event={.fd=6,.events=POLLIN};
  if(claimed||!matches(5)||!matches(6)||poll(&event,1,5000)!=1){napi_get_undefined(env,&result);return result;}
  ssize_t n;do{n=read(6,&ack,1);}while(n<0&&errno==EINTR);
  if(n!=1||ack!=1||!matches(5)||!matches(6)){napi_get_undefined(env,&result);return result;}
  close(6);claimed=1;if(napi_create_external(env,&capability,NULL,NULL,&result)!=napi_ok)return NULL;return result;
}
static int config_used=0;
static napi_value read_supervisor_config(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;uint8_t bytes[4096];size_t size=0;
  if(!claimed||config_used||!matches(5)||!matches(7)){napi_get_undefined(env,&result);return result;}
  config_used=1;int ok=brain_read_frame(7,bytes,sizeof bytes,&size,5000)&&size>0&&!memchr(bytes,0,size)&&matches(5)&&matches(7);close(7);
  if(!ok){memset(bytes,0,sizeof bytes);napi_get_undefined(env,&result);return result;}
  napi_status status=napi_create_string_utf8(env,(const char *)bytes,size,&result);volatile uint8_t *wipe=bytes;for(size_t i=0;i<sizeof bytes;i++)wipe[i]=0;
  return status==napi_ok?result:NULL;
}
static napi_value fixture_mode(napi_env env,napi_callback_info info) {
  (void)info;napi_value result;
#ifdef BRAIN_SUPERVISOR_FIXTURE
  int enabled=1;
#else
  int enabled=0;
#endif
  if(napi_get_boolean(env,enabled,&result)!=napi_ok)return NULL;return result;
}
/* 운영 배치의 엔진 격리 증명이 연결될 때까지는 false다. */
static napi_value deployment_ready(napi_env env,napi_callback_info info) {return fixture_mode(env,info);}
static napi_value consume_supervisor(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg,result;void *value=NULL;
  int ok=napi_get_cb_info(env,info,&argc,&arg,NULL,NULL)==napi_ok&&argc==1&&napi_get_value_external(env,arg,&value)==napi_ok&&value==&capability&&claimed&&!consumed&&matches(5);
  if(ok)consumed=1;if(napi_get_boolean(env,ok,&result)!=napi_ok)return NULL;return result;
}
#endif
static napi_value init(napi_env env,napi_value exports) {
  napi_property_descriptor methods[]={{"bootstrap",NULL,bootstrap,NULL,NULL,NULL,napi_default,NULL},{"peer",NULL,peer,NULL,NULL,NULL,napi_default,NULL}
#ifdef BRAIN_SUPERVISOR_AUTHORITY
    ,{"claimSupervisor",NULL,claim_supervisor,NULL,NULL,NULL,napi_default,NULL},{"readSupervisorConfig",NULL,read_supervisor_config,NULL,NULL,NULL,napi_default,NULL},{"consumeSupervisor",NULL,consume_supervisor,NULL,NULL,NULL,napi_default,NULL},{"supervisorFixture",NULL,fixture_mode,NULL,NULL,NULL,napi_default,NULL},{"deploymentReady",NULL,deployment_ready,NULL,NULL,NULL,napi_default,NULL}
#endif
  };
  if(napi_define_properties(env,exports,sizeof methods/sizeof methods[0],methods)!=napi_ok)return NULL;return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
