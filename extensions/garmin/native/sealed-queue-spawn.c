#include "sealed-queue-spawn.h"
#include "sealed-files.h"
#include "sealed-signature.h"
#include <sys/spawn.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <signal.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* 요청자는 argv·환경·실행 경로를 지정할 수 없다. registry 자체의 신뢰는 별도 조립에서 보장한다. */
int brain_spawn_sealed_queue(int root_fd,const char *const *parts,size_t count,uid_t owner,
  const uint8_t digest[32],const uint8_t code_hash[20],const brain_sealed_file *files,size_t file_count,int peer_fd,int registry_fd,pid_t *pid) {
  if(!pid || peer_fd<0 || registry_fd<0 || peer_fd==registry_fd || peer_fd==5 || peer_fd==6 || registry_fd==5 || registry_fd==6)return 0;
  *pid=0;if(!brain_sealed_verify_bundle(root_fd,owner,files,file_count))return 0;
  int binary=brain_sealed_open_file(root_fd,parts,count,owner,digest);if(binary<0)return 0;
  if(!brain_sealed_signature(binary,code_hash)){close(binary);return 0;}
  char path[PATH_MAX];struct stat before,after,at_path;
  if(fcntl(binary,F_GETPATH,path)<0 || fstat(binary,&before) || lstat(path,&at_path) || before.st_dev!=at_path.st_dev || before.st_ino!=at_path.st_ino) {close(binary);return 0;}
  posix_spawn_file_actions_t actions;posix_spawnattr_t attr;
  if(posix_spawn_file_actions_init(&actions)){close(binary);return 0;}
  if(posix_spawnattr_init(&attr)){posix_spawn_file_actions_destroy(&actions);close(binary);return 0;}
  int ok=!posix_spawn_file_actions_adddup2(&actions,STDIN_FILENO,STDIN_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,STDOUT_FILENO,STDOUT_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,STDERR_FILENO,STDERR_FILENO)
    && !posix_spawn_file_actions_adddup2(&actions,peer_fd,5)
    && !posix_spawn_file_actions_adddup2(&actions,registry_fd,6)
    && !posix_spawn_file_actions_addchdir(&actions,"/")
    && !posix_spawnattr_setflags(&attr,POSIX_SPAWN_START_SUSPENDED|POSIX_SPAWN_CLOEXEC_DEFAULT);
  char *const argv[]={path,"--sealed-queue-client",NULL};
  char *const env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};
  pid_t child=0;if(ok)ok=posix_spawn(&child,path,&actions,&attr,argv,env)==0;
  posix_spawnattr_destroy(&attr);posix_spawn_file_actions_destroy(&actions);
  if(ok)ok=!fstat(binary,&after) && !lstat(path,&at_path) && before.st_dev==after.st_dev && before.st_ino==after.st_ino
    && before.st_dev==at_path.st_dev && before.st_ino==at_path.st_ino && brain_sealed_verify_bundle(root_fd,owner,files,file_count) && brain_sealed_signature(binary,code_hash);
  close(binary);
  if(!ok) {if(child>0){kill(child,SIGKILL);waitpid(child,NULL,0);}return 0;}
  *pid=child;return 1;
}
