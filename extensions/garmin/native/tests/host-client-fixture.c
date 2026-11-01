#include "../host-client.h"
#include "fixture-common.h"
#include <string.h>
#include <unistd.h>
int main(int argc,char **argv) {
  if(argc!=3)return 2; uint8_t hash[20],package[32]; if(!fixture_hash(argv[2],hash))return 3;memset(package,1,sizeof package);
  brain_host_client host; if(!brain_host_connect(&host,argv[1],geteuid(),hash))return 4;
  uuid_t work,attempt;uuid_generate_random(work);uuid_generate_random(attempt);
  if(brain_host_start(&host,work,attempt,1,1,1,package))return 5;
  return host.stdout_fd==-1 && host.stderr_fd==-1 && !host.started ? 0 : 6;
}
