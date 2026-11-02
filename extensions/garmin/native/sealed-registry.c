#include "sealed-registry.h"
#include "sealed-files.h"
#include "sealed-signature.h"
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <unistd.h>

/* 고정 형식: header, Node cdhash, 정렬된 sha256/path 행. 입력은 root registry뿐이다. */
#define REGISTRY_LIMIT (1024 * 1024)
#define FILE_LIMIT 4096
static int hex(char c) { if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1; }
static int decode(const char *s, size_t n, uint8_t *out) {
  for(size_t i=0;i<n;i++){int a=hex(s[i*2]),b=hex(s[i*2+1]);if(a<0||b<0)return 0;out[i]=(uint8_t)((a<<4)|b);}return 1;
}
static int verify(int registry_dir,int payload_dir,uid_t owner,uint8_t *node_hash,uint8_t *package_hash,int supervisor) {
  const char *name[]={supervisor?"supervisor.registry":"queue.registry"};
  int fd=openat(registry_dir,name[0],O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  if(fd<0)return 0;
  struct stat st;int ok=0,checked=-1;char *data=NULL;brain_sealed_file *files=NULL;
  if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_size<=0||st.st_size>REGISTRY_LIMIT)goto done;
  size_t len=(size_t)st.st_size;data=malloc(len+1);if(!data)goto done;
  size_t pos=0;while(pos<len){ssize_t n=read(fd,data+pos,len-pos);if(n<0&&errno==EINTR)continue;if(n<=0)goto done;pos+=(size_t)n;}
  data[len]=0;if(memchr(data,0,len)||data[len-1]!='\n')goto done;
  uint8_t digest[32];CC_SHA256(data,(CC_LONG)len,digest);
  checked=brain_sealed_open_file(registry_dir,name,1,owner,digest);
  struct stat verified;if(checked<0||fstat(checked,&verified)||st.st_dev!=verified.st_dev||st.st_ino!=verified.st_ino)goto done;
  const char *header=supervisor?"brain-supervisor-registry-v1\n":"brain-queue-registry-v2\n";size_t h=strlen(header);
  if(len<h+82||memcmp(data,header,h)||data[h+40]!='\n'||data[h+81]!='\n')goto done;
  uint8_t code_hash[20],addon_hash[20];if(!decode(data+h,20,code_hash)||!decode(data+h+41,20,addon_hash))goto done;
  files=calloc(FILE_LIMIT,sizeof(*files));if(!files)goto done;
  size_t count=0;char *line=data+h+82,*end=data+len;int node=-1,cli=-1,addon=-1;
  while(line<end){char *newline=memchr(line,'\n',(size_t)(end-line));if(!newline||newline-line<66||line[64]!=' '||count==FILE_LIMIT)goto done;
    *newline=0;if(!decode(line,32,files[count].sha256))goto done;files[count].path=line+65;
    if(count&&strcmp(files[count-1].path,files[count].path)>=0)goto done;
    if(!strcmp(files[count].path,"bin/node"))node=(int)count;
    if(!strcmp(files[count].path,supervisor?"supervisor/main.js":"cli/bin.js"))cli=(int)count;
    if(!strcmp(files[count].path,supervisor?"supervisor/peer.node":"cli/peer.node"))addon=(int)count;
    count++;line=newline+1;
  }
  if(node<0||cli<0||addon<0||!brain_sealed_verify_bundle(payload_dir,owner,files,count))goto done;
  const char *node_parts[]={"bin","node"};
  int executable=brain_sealed_open_file(payload_dir,node_parts,2,owner,files[node].sha256);
  if(executable<0)goto done;
  ok=brain_sealed_signature(executable,code_hash);close(executable);
  if(ok){const char *addon_parts[]={supervisor?"supervisor":"cli","peer.node"};int library=brain_sealed_open_file(payload_dir,addon_parts,2,owner,files[addon].sha256);
    if(library<0)ok=0;else {ok=brain_sealed_signature(library,addon_hash);close(library);}}
  if(ok && node_hash)memcpy(node_hash,code_hash,20);if(ok && package_hash)memcpy(package_hash,digest,32);
done:
  free(files);free(data);if(checked>=0)close(checked);close(fd);return ok;
}
int brain_verify_queue_registry(int registry_dir,int payload_dir){return verify(registry_dir,payload_dir,0,NULL,NULL,0);}
int brain_queue_registry_node_hash(int registry_dir,int payload_dir,uint8_t hash[20]) { return hash && verify(registry_dir,payload_dir,0,hash,NULL,0); }
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_verify_queue_registry_fixture(int registry_dir,int payload_dir,uid_t owner){return verify(registry_dir,payload_dir,owner,NULL,NULL,0);}
int brain_queue_registry_node_hash_fixture(int registry_dir,int payload_dir,uid_t owner,uint8_t hash[20]){return hash && verify(registry_dir,payload_dir,owner,hash,NULL,0);}
#endif

#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
static int same_path(int fd,const char *path) {
  struct stat opened,named;return !fstat(fd,&opened) && !lstat(path,&named) && opened.st_dev==named.st_dev && opened.st_ino==named.st_ino;
}
/* 운영 기준 FD까지 /에서 심볼릭 링크 없이 root 소유 경로를 재개방한다. */
static int trusted_path(int fd,const char *path,uid_t final_owner) {
  if(!path || path[0]!='/' || strlen(path)>=PATH_MAX)return 0;
  char copy[PATH_MAX];strcpy(copy,path);int current=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(current<0)return 0;
  int ok=1;char *save=NULL,*part=strtok_r(copy,"/",&save);
  for(;;) {
    struct stat st;errno=0;acl_t acl=acl_get_fd_np(current,ACL_TYPE_EXTENDED);
    if(acl){acl_free(acl);ok=0;break;}
    if(errno!=ENOENT || fstat(current,&st) || !S_ISDIR(st.st_mode) || st.st_uid!=(part?0:final_owner) || (st.st_mode&0022)){ok=0;break;}
    if(!part)break;
    if(!strcmp(part,".")||!strcmp(part,"..")){ok=0;break;}
    int next=openat(current,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(next<0){ok=0;break;}
    close(current);current=next;part=strtok_r(NULL,"/",&save);
  }
  struct stat original,reopened;
  if(ok)ok=!fstat(fd,&original)&&!fstat(current,&reopened)&&original.st_dev==reopened.st_dev&&original.st_ino==reopened.st_ino;
  close(current);return ok;
}
int brain_sealed_trusted_dir(int fd,uid_t owner) {
  char path[PATH_MAX];return fcntl(fd,F_GETPATH,path)>=0 && trusted_path(fd,path,owner);
}
static int spawn_profile(int registry_dir,int payload_dir,uid_t owner,int peer_fd,int channel_fd,int config_fd,pid_t *pid,int supervisor) {
  if(!pid||peer_fd<0||channel_fd<0||peer_fd==channel_fd||peer_fd==5||peer_fd==6||channel_fd==5||channel_fd==6 || (supervisor&&(config_fd<0||config_fd==peer_fd||config_fd==channel_fd||config_fd==5||config_fd==6||config_fd==7||peer_fd==7||channel_fd==7)))return 0;
  *pid=0;if(!verify(registry_dir,payload_dir,owner,NULL,NULL,supervisor))return 0;
  char root[PATH_MAX],registry_path[PATH_MAX],node[PATH_MAX],cli[PATH_MAX];
  if(fcntl(payload_dir,F_GETPATH,root)<0 || fcntl(registry_dir,F_GETPATH,registry_path)<0)return 0;
  if(owner==0 && (!trusted_path(payload_dir,root,0)||!trusted_path(registry_dir,registry_path,0)))return 0;
  if(snprintf(node,sizeof node,"%s/bin/node",root)>=(int)sizeof node || snprintf(cli,sizeof cli,supervisor?"%s/supervisor/main.js":"%s/cli/bin.js",root)>=(int)sizeof cli || !same_path(payload_dir,root))return 0;
  int bin_dir=openat(payload_dir,"bin",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  int cli_dir=openat(payload_dir,supervisor?"supervisor":"cli",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  int bin_fd=bin_dir<0?-1:openat(bin_dir,"node",O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  int cli_fd=cli_dir<0?-1:openat(cli_dir,supervisor?"main.js":"bin.js",O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  if(bin_dir>=0)close(bin_dir);if(cli_dir>=0)close(cli_dir);
  if(bin_fd<0||cli_fd<0||!same_path(bin_fd,node)||!same_path(cli_fd,cli)) {if(bin_fd>=0)close(bin_fd);if(cli_fd>=0)close(cli_fd);return 0;}
  posix_spawn_file_actions_t actions;posix_spawnattr_t attr;
  if(posix_spawn_file_actions_init(&actions)){close(bin_fd);close(cli_fd);return 0;}
  if(posix_spawnattr_init(&attr)){posix_spawn_file_actions_destroy(&actions);close(bin_fd);close(cli_fd);return 0;}
  int ok=!posix_spawn_file_actions_adddup2(&actions,STDIN_FILENO,STDIN_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,STDOUT_FILENO,STDOUT_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,STDERR_FILENO,STDERR_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,peer_fd,5)
    && !posix_spawn_file_actions_adddup2(&actions,channel_fd,6)
    && (!supervisor || !posix_spawn_file_actions_adddup2(&actions,config_fd,7))
    && !posix_spawn_file_actions_addchdir(&actions,"/")
    && !posix_spawnattr_setpgroup(&attr,0)
    && !posix_spawnattr_setflags(&attr,POSIX_SPAWN_START_SUSPENDED|POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_SETPGROUP);
  char *const argv[]={node,cli,supervisor?"--sealed-supervisor":"--sealed-queue-client",NULL};
  char *const env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};
  pid_t child=0;
#ifdef BRAIN_REGISTRY_FIXTURE
  extern void brain_registry_fixture_before_spawn(void);
  brain_registry_fixture_before_spawn();
#endif
  if(ok)ok=posix_spawn(&child,node,&actions,&attr,argv,env)==0;
  posix_spawnattr_destroy(&attr);posix_spawn_file_actions_destroy(&actions);
  if(ok)ok=same_path(payload_dir,root) && same_path(registry_dir,registry_path) && same_path(bin_fd,node) && same_path(cli_fd,cli) && (owner!=0 || (trusted_path(payload_dir,root,0) && trusted_path(registry_dir,registry_path,0))) && verify(registry_dir,payload_dir,owner,NULL,NULL,supervisor);
  close(bin_fd);close(cli_fd);
  if(!ok){if(child>0){kill(child,SIGKILL);waitpid(child,NULL,0);}return 0;}
  *pid=child;return 1;
}
int brain_spawn_queue_registry(int registry_dir,int payload_dir,int peer_fd,int channel_fd,pid_t *pid){return spawn_profile(registry_dir,payload_dir,0,peer_fd,channel_fd,-1,pid,0);}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_spawn_queue_registry_fixture(int registry_dir,int payload_dir,uid_t owner,int peer_fd,int channel_fd,pid_t *pid){return spawn_profile(registry_dir,payload_dir,owner,peer_fd,channel_fd,-1,pid,0);}
#endif

int brain_supervisor_registry_identity(int reg,int payload,uint8_t node_hash[20],uint8_t package_hash[32]) {return node_hash&&package_hash&&brain_sealed_trusted_dir(reg,0)&&brain_sealed_trusted_dir(payload,0)&&verify(reg,payload,0,node_hash,package_hash,1);}
int brain_spawn_supervisor_registry(int reg,int payload,int peer,int bootstrap,int config,pid_t *pid) {return spawn_profile(reg,payload,0,peer,bootstrap,config,pid,1);}
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_supervisor_registry_identity_fixture(int reg,int payload,uid_t owner,uint8_t node_hash[20],uint8_t package_hash[32]) {return node_hash&&package_hash&&verify(reg,payload,owner,node_hash,package_hash,1);}
int brain_spawn_supervisor_registry_fixture(int reg,int payload,uid_t owner,int peer,int bootstrap,int config,pid_t *pid) {return spawn_profile(reg,payload,owner,peer,bootstrap,config,pid,1);}
#endif
