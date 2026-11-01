#include "sealed-files.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

static int clean_acl(int fd) {
  errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if(acl){acl_free(acl);return 0;}
  return errno==ENOENT;
}
static int valid_dir(int fd,uid_t owner) {
  struct stat st;return !fstat(fd,&st) && S_ISDIR(st.st_mode) && st.st_uid==owner && !(st.st_mode & 0022) && clean_acl(fd);
}
static int component(const char *name) {
  return name && name[0] && strcmp(name,".") && strcmp(name,"..") && !strchr(name,'/');
}
int brain_sealed_open_file(int root_fd,const char *const *parts,size_t count,uid_t owner,const uint8_t expected[32]) {
  /* [ASSUMPTION] 설치 payload 경로의 component 상한은 64개이며 package 구성에서 재평가한다. */
  if(root_fd<0 || !parts || !count || count>64 || !expected)return -1;
  int current=dup(root_fd);if(current<0)return -1;
  if(!valid_dir(current,owner))goto fail;
  for(size_t i=0;i<count;i++) {
    if(!component(parts[i]))goto fail;
    int final=i+1==count;int next=openat(current,parts[i],O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK|(final?0:O_DIRECTORY));
    if(next<0)goto fail;close(current);current=next;
    if(!final && !valid_dir(current,owner))goto fail;
  }
  struct stat before,after;
  if(fstat(current,&before) || !S_ISREG(before.st_mode) || before.st_uid!=owner || before.st_mode&0022 || before.st_nlink!=1 || !clean_acl(current))goto fail;
  CC_SHA256_CTX ctx;if(!CC_SHA256_Init(&ctx))goto fail;uint8_t buffer[16384],digest[CC_SHA256_DIGEST_LENGTH];
  for(;;) {ssize_t n=read(current,buffer,sizeof buffer);if(n<0 && errno==EINTR)continue;if(n<0)goto fail;if(!n)break;if(!CC_SHA256_Update(&ctx,buffer,(CC_LONG)n))goto fail;}
  if(!CC_SHA256_Final(digest,&ctx) || memcmp(digest,expected,sizeof digest) || fstat(current,&after)
    || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || before.st_size!=after.st_size
    || before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec
    || lseek(current,0,SEEK_SET)<0)goto fail;
  return current;
fail:close(current);return -1;
}
