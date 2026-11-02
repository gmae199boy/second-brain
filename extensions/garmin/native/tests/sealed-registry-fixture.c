#include "../sealed-registry.h"
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>
static const char *swap_path;
static char moved[PATH_MAX];
void brain_registry_fixture_before_spawn(void) {
  if(!swap_path)return;
  if(snprintf(moved,sizeof moved,"%s-moved",swap_path)>=(int)sizeof moved || rename(swap_path,moved) || symlink(moved,swap_path)) _exit(9);
}
int main(int argc,char **argv) {
  if(argc!=4)return 2;
  int registry=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),payload=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(registry<0||payload<0)return 3;
  if(!strcmp(argv[3],"spawn") || !strcmp(argv[3],"swap")) {
    if(!strcmp(argv[3],"swap"))swap_path=argv[2];
    int first=open("/dev/null",O_RDONLY),second=open("/dev/null",O_RDONLY);
    int a=fcntl(first,F_DUPFD_CLOEXEC,10),b=fcntl(second,F_DUPFD_CLOEXEC,10);close(first);close(second);
    pid_t child=0;int ok=a>=0&&b>=0&&brain_spawn_queue_registry_fixture(registry,payload,geteuid(),a,b,&child);
    if(a>=0)close(a);if(b>=0)close(b);
    if(swap_path) {
      int restored=!unlink(swap_path)&&!rename(moved,swap_path);
      close(registry);close(payload);return restored&&!ok&&child==0?0:8;
    }
    if(!ok)return 6;
    int status;if(kill(child,SIGCONT)||waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status))return 7;
    close(registry);close(payload);return 0;
  }
  int accepted=brain_verify_queue_registry_fixture(registry,payload,geteuid());
  int root_accepted=brain_verify_queue_registry(registry,payload);
  close(registry);close(payload);
  if(geteuid()!=0 && root_accepted)return 4;
  return accepted==atoi(argv[3])?0:5;
}
