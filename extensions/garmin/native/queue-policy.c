#include "queue-policy.h"
#include "sealed-files.h"
#include "sealed-registry.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static int digit(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int read_policy(int dir,uid_t owner,uid_t *uid,uint8_t hash[20]) {
  if(!uid||!hash)return 0;
#ifndef BRAIN_REGISTRY_FIXTURE
  if(owner!=0||!brain_sealed_trusted_dir(dir,0))return 0;
#endif
  int fd=openat(dir,"queue-client.pin",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if(fd<0)return 0;
  struct stat a,b;char data[128];ssize_t n=read(fd,data,sizeof data);int ok=0,verified=-1;
  if(n<=0||n>=(ssize_t)sizeof data||fstat(fd,&a)||!S_ISREG(a.st_mode))goto done;
  uint8_t digest[32];CC_SHA256(data,(CC_LONG)n,digest);const char *parts[]={"queue-client.pin"};
  verified=brain_sealed_open_file(dir,parts,1,owner,digest);if(verified<0||fstat(verified,&b)||a.st_dev!=b.st_dev||a.st_ino!=b.st_ino)goto done;
  data[n]=0;char *end=NULL;errno=0;unsigned long value=strtoul(data,&end,10);
  if(errno||!value||value>UINT_MAX||end==data||*end!=' '||strlen(end+1)!=41||end[41]!='\n')goto done;
  for(int i=0;i<20;i++){int x=digit(end[1+i*2]),y=digit(end[2+i*2]);if(x<0||y<0)goto done;hash[i]=(uint8_t)((x<<4)|y);}*uid=(uid_t)value;ok=1;
done:if(verified>=0)close(verified);close(fd);return ok;
}
int brain_queue_client_policy(int fd,uid_t *uid,uint8_t hash[20]){return read_policy(fd,0,uid,hash);}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_queue_client_policy_fixture(int fd,uid_t owner,uid_t *uid,uint8_t hash[20]){return read_policy(fd,owner,uid,hash);}
#endif
