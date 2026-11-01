#include "../child-bootstrap.h"
#include "../submission-ipc.h"
#include "fixture-code-hash.h"
#include <unistd.h>
int main(void) {
  uint8_t host[20],broker_hash[20],session[16],prompt[16]={1};
  if(!fixture_code_hash(FIXTURE_HOST_PATH,host) || !brain_child_bootstrap(host,10000) || !fixture_code_hash(FIXTURE_BROKER_PATH,broker_hash))return 1;
  brain_xpc_peer broker;if(!brain_submission_connect(&broker,FIXTURE_BROKER_WORKER,geteuid(),broker_hash,10000) || !brain_submission_worker_attach(&broker,session,10000))return 2;
  brain_auth_channel channel;if(!brain_channel_init(&channel,5,session,0,10000))return 3;
  int ready=0;for(int i=0;i<150 && !ready;i++){int state=brain_submission_ready(&broker,1000);if(state<0)return 4;ready=state;if(!ready)usleep(100000);}if(!ready)return 5;
  brain_submission_control control={.peer=&broker,.timeout_ms=10000};
  for(uint64_t generation=1;generation<=4;generation++) {
    prompt[0]=(uint8_t)generation;
    int allowed=brain_submission_prompt(&broker,prompt,(generation>1 || FIXTURE_CASE==3)?1:0,5000);
    if(FIXTURE_CASE==3 && allowed){(void)write(1,"bad",3);return 0;}
    if(!allowed)return 6;
    uint8_t value[32];size_t length=0;
    if(!brain_submission_receive(&control,&channel,prompt,generation,value,sizeof value,&length,10000) || length!=4 || value[0]!=1 || value[1]!=2 || value[2]!=3 || value[3]!=4)return 7;
    volatile uint8_t *v=value;for(size_t i=0;i<sizeof value;i++)v[i]=0;
  }
  if(FIXTURE_CASE==5){prompt[0]=5;if(!brain_submission_prompt(&broker,prompt,1,5000))return 9;(void)write(1,"bad",3);return 0;}
#ifdef BRAIN_FIXTURE_SIGNAL
  static const char progress[]="{\"abi\":1,\"type\":\"progress\"}\n";
  if(write(1,progress,sizeof progress-1)!=(ssize_t)(sizeof progress-1))return 10;
  sleep(30);return 11;
#endif
#ifdef BRAIN_FIXTURE_ABI
  static const char output[]="{\"abi\":1,\"type\":\"result\"}\n";
  if(write(1,output,sizeof output-1)!=(ssize_t)(sizeof output-1))return 8;
#else
  if(write(1,"ok",2)!=2)return 8;
#endif
  brain_channel_destroy(&channel);brain_xpc_close(&broker);return 0;
}
