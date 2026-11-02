#include "../queue-policy.h"
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
void brain_registry_fixture_before_spawn(void) {}
int main(int argc,char **argv) {
  if(argc!=3)return 2;int fd=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(fd<0)return 3;
  uid_t uid=0;uint8_t hash[20];int accepted=brain_queue_client_policy_fixture(fd,geteuid(),&uid,hash);
  uid_t privileged=0;uint8_t pinned[20];int root_accepted=brain_queue_client_policy(fd,&privileged,pinned);close(fd);
  if(geteuid()!=0&&root_accepted)return 4;
  return accepted==atoi(argv[2])&&(!accepted||(uid==geteuid()&&hash[0]==0x11))?0:5;
}
