#include "../host-client.h"
#include "fixture-common.h"
#include <string.h>
#include <unistd.h>
#include <signal.h>
int main(int argc,char **argv) {
  if(argc!=3)return 2;uint8_t hash[20],package[32];if(!fixture_hash(argv[2],hash))return 3;memset(package,1,sizeof package);
  brain_host_client c;if(!brain_host_connect(&c,argv[1],geteuid(),hash))return 4;
  uuid_t work,attempt;uuid_generate_random(work);uuid_generate_random(attempt);
  if(!brain_host_start(&c,work,attempt,1,1,1,package))return 5;
  int group=-1;if(brain_host_inspect(&c,&group)!=1 || group!=1 || brain_host_signal(&c,99) || !brain_host_signal(&c,SIGTERM) || !brain_host_recorded(&c))return 7;
  int status=-1,state=0;for(int i=0;i<200 && state==0;i++){usleep(10000);state=brain_host_observe(&c,&status);}
  brain_host_close(&c);
#ifdef BRAIN_WRONG_PID_FIXTURE
  return state==-1 ? 0 : 6;
#else
  return state==1 && status==0 ? 0 : 6;
#endif
}
