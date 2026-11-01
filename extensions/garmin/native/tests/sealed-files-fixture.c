#include "../sealed-files.h"
#include "../sealed-bundle.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc,char **argv) {
  if(argc!=2 && argc!=3)return 1;
  int root=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(root<0)return 2;
  if(argc==3) {
    uint8_t hash[32];CC_SHA256("sealed",6,hash);const char *file[]={"bundle","cli.js"};
    int refused=brain_sealed_open_file(root,file,2,geteuid(),hash);close(root);
    if(refused>=0){close(refused);return 20;}
    printf("확장 ACL이 있는 payload 거부 통과\n");return 0;
  }
  if(mkdirat(root,"bundle",0700))return 3;
  int dir=openat(root,"bundle",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(dir<0)return 4;
  int fd=openat(dir,"cli.js",O_CREAT|O_EXCL|O_WRONLY,0600);if(fd<0 || write(fd,"sealed",6)!=6)return 5;close(fd);
  uint8_t digest[32];CC_SHA256("sealed",6,digest);const char *path[]={"bundle","cli.js"};
  fd=brain_sealed_open_file(root,path,2,geteuid(),digest);if(fd<0)return 6;
  char bytes[6];if(read(fd,bytes,6)!=6 || memcmp(bytes,"sealed",6))return 7;close(fd);
  fd=openat(dir,"loader.js",O_CREAT|O_EXCL|O_WRONLY,0600);if(fd<0 || write(fd,"loader",6)!=6)return 23;close(fd);
  brain_sealed_file files[2]={{.path="bundle/cli.js"},{.path="bundle/loader.js"}};
  memcpy(files[0].sha256,digest,32);CC_SHA256("loader",6,files[1].sha256);
  if(!brain_sealed_verify_bundle(root,geteuid(),files,2) || !brain_sealed_verify_bundle(root,geteuid(),files,2))return 24;
  fd=openat(dir,"extra.js",O_CREAT|O_EXCL|O_WRONLY,0600);if(fd<0)return 25;close(fd);
  if(brain_sealed_verify_bundle(root,geteuid(),files,2) || unlinkat(dir,"extra.js",0))return 26;
  if(mkdirat(dir,"extra",0700) || brain_sealed_verify_bundle(root,geteuid(),files,2) || unlinkat(dir,"extra",AT_REMOVEDIR))return 27;
  files[1].sha256[0]^=1;if(brain_sealed_verify_bundle(root,geteuid(),files,2))return 28;
  if(unlinkat(dir,"loader.js",0))return 29;
  digest[0]^=1;if(brain_sealed_open_file(root,path,2,geteuid(),digest)>=0)return 8;digest[0]^=1;
  fd=openat(dir,"cli.js",O_WRONLY|O_TRUNC);if(fd<0 || write(fd,"tamper",6)!=6)return 17;close(fd);
  if(brain_sealed_open_file(root,path,2,geteuid(),digest)>=0)return 18;
  fd=openat(dir,"cli.js",O_WRONLY|O_TRUNC);if(fd<0 || write(fd,"sealed",6)!=6)return 19;close(fd);
  if(chmod(argv[1],0777) || brain_sealed_open_file(root,path,2,geteuid(),digest)>=0 || chmod(argv[1],0700))return 9;
  if(fchmod(dir,0777) || brain_sealed_open_file(root,path,2,geteuid(),digest)>=0 || fchmod(dir,0700))return 10;
  if(fchmodat(dir,"cli.js",0666,0) || brain_sealed_open_file(root,path,2,geteuid(),digest)>=0 || fchmodat(dir,"cli.js",0600,0))return 11;
  if(linkat(dir,"cli.js",dir,"hard",0) || brain_sealed_open_file(root,path,2,geteuid(),digest)>=0 || unlinkat(dir,"hard",0))return 12;
  if(symlinkat("cli.js",dir,"link"))return 13;const char *symlink[]={"bundle","link"};
  if(brain_sealed_open_file(root,symlink,2,geteuid(),digest)>=0)return 14;
  if(mkfifoat(dir,"fifo",0600))return 21;const char *fifo[]={"bundle","fifo"};
  if(brain_sealed_open_file(root,fifo,2,geteuid(),digest)>=0)return 22;
  const char *escape[]={"bundle","..","bundle","cli.js"};if(brain_sealed_open_file(root,escape,4,geteuid(),digest)>=0)return 15;
  if(brain_sealed_open_file(root,path,2,geteuid()+1,digest)>=0)return 16;
  close(dir);close(root);printf("보호 파일 소유권·ACL 부재·해시·경로 거부 통과\n");return 0;
}
