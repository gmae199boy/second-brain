#include "../child-bootstrap.h"
#include "../submission-ipc.h"
#include "fixture-code-hash.h"
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#ifdef BRAIN_FIXTURE_MULTI_SESSION
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#endif
static int fail(int stage){dprintf(2,"fixture-worker-stage=%d\n",stage);return stage;}
int main(void) {
  uint8_t host[20],broker_hash[20],session[16],prompt[16]={1};
  if(!fixture_code_hash(FIXTURE_HOST_PATH,host) || !brain_child_bootstrap(host,10000) || !fixture_code_hash(FIXTURE_BROKER_PATH,broker_hash))return fail(1);
#ifdef BRAIN_FIXTURE_MULTI_SESSION
  char marker[1024],release[1024];snprintf(marker,sizeof marker,"%s/worker-%ld",BRAIN_FIXTURE_BARRIER,(long)getpid());snprintf(release,sizeof release,"%s/release",BRAIN_FIXTURE_BARRIER);
  int marker_fd=open(marker,O_WRONLY|O_CREAT|O_EXCL,0600);if(marker_fd<0)return fail(14);close(marker_fd);
  int released=0;for(int i=0;i<300;i++){if(!access(release,F_OK)){released=1;break;}usleep(100000);}if(!released)return fail(15);
#endif
#ifdef BRAIN_FIXTURE_ABI
  static const char marker[]="fixture-worker-after-ack\n";(void)write(2,marker,sizeof marker-1);
  brain_child_metadata metadata;if(!brain_child_read_metadata(&metadata,2000) || metadata.run!=1 || strcmp(metadata.timezone,"UTC"))return fail(12);
  if(metadata.work[15]==0x51) {if(strcmp(metadata.tokenstore,"fixture"))return fail(12);}
  else if(metadata.work[15]==0x52) {if(!metadata.account_target || strcmp(metadata.tokenstore,"fixture2") || strcmp(metadata.target_id,"00000000-0000-4000-8000-000000000002"))return fail(12);}
  else return fail(12);
  if(brain_child_read_metadata(&metadata,100))return fail(13);
#endif
  brain_xpc_peer broker;if(!brain_submission_connect(&broker,FIXTURE_BROKER_WORKER,geteuid(),broker_hash,10000) || !brain_submission_worker_attach(&broker,session,10000))return fail(2);
  brain_auth_channel channel;if(!brain_channel_init(&channel,5,session,0,10000))return fail(3);
  int ready=0;for(int i=0;i<150 && !ready;i++){int state=brain_submission_ready(&broker,1000);if(state<0)return fail(4);ready=state;if(!ready)usleep(100000);}if(!ready)return fail(5);
  brain_submission_control control={.peer=&broker,.timeout_ms=10000};
  for(uint64_t generation=1;generation<=4;generation++) {
    prompt[0]=(uint8_t)generation;
    int allowed=brain_submission_prompt(&broker,prompt,(generation>1 || FIXTURE_CASE==3)?1:0,5000);
    if(FIXTURE_CASE==3 && allowed){(void)write(1,"bad",3);return 0;}
    if(!allowed)return fail(6);
    uint8_t value[32];size_t length=0;
    if(!brain_submission_receive(&control,&channel,prompt,generation,value,sizeof value,&length,10000) || length!=4 || value[0]!=1 || value[1]!=2 || value[2]!=3 || value[3]!=4)return fail(7);
    volatile uint8_t *v=value;for(size_t i=0;i<sizeof value;i++)v[i]=0;
  }
  if(FIXTURE_CASE==5){prompt[0]=5;if(!brain_submission_prompt(&broker,prompt,1,5000))return fail(9);(void)write(1,"bad",3);return 0;}
#ifdef BRAIN_FIXTURE_CORE_DESCENDANT
  pid_t descendant=fork();if(descendant<0)return fail(16);if(descendant==0){sleep(30);_exit(0);}
#endif
#ifdef BRAIN_FIXTURE_SIGNAL
  static const char progress[]="{\"abi\":1,\"type\":\"progress\"}\n";
  if(write(1,progress,sizeof progress-1)!=(ssize_t)(sizeof progress-1))return fail(10);
#ifdef BRAIN_FIXTURE_HOST_CRASH
  sleep(3);return fail(11);
#else
  sleep(30);return fail(11);
#endif
#endif
#ifdef BRAIN_FIXTURE_ABI
  static const char output[]="{\"abi\":1,\"type\":\"result\"}\n";
  if(write(1,output,sizeof output-1)!=(ssize_t)(sizeof output-1))return fail(8);
#else
  if(write(1,"ok",2)!=2)return fail(8);
#endif
  brain_channel_destroy(&channel);brain_xpc_close(&broker);return 0;
}
