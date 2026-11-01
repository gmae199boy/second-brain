#include "sealed-bundle.h"
#include "sealed-files.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <unistd.h>

/* [ASSUMPTION] 고정 bundle은 최대 4096개 파일과 경로 깊이 64개로 제한한다. */
#define MAX_FILES 4096
#define MAX_DEPTH 64
static int clean_acl(int fd) {errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);if(acl){acl_free(acl);return 0;}return errno==ENOENT;}
static int valid_dir(int fd,uid_t owner) {struct stat st;return !fstat(fd,&st) && S_ISDIR(st.st_mode) && st.st_uid==owner && !(st.st_mode&0022) && clean_acl(fd);}
static int name_ok(const char *s) {return s && *s && strcmp(s,".") && strcmp(s,"..") && !strchr(s,'/');}
static int inspect_tree(int fd,uid_t owner,const brain_sealed_file *files,size_t count,const char *prefix,size_t depth) {
  if(depth>MAX_DEPTH || !valid_dir(fd,owner))return 0;
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(copy<0)return 0;DIR *dir=fdopendir(copy);if(!dir){close(copy);return 0;}
  int ok=1;struct dirent *entry;
  for(;;) {
    errno=0;entry=readdir(dir);if(!entry){if(errno)ok=0;break;}
    if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
    if(!name_ok(entry->d_name)){ok=0;break;}
    size_t a=strlen(prefix),b=strlen(entry->d_name);if(a+b+2>PATH_MAX){ok=0;break;}
    char path[PATH_MAX];if(a){memcpy(path,prefix,a);path[a++]='/';}memcpy(path+a,entry->d_name,b+1);
    int exact=0,subtree=0;size_t n=strlen(path);
    for(size_t i=0;i<count;i++) {if(!strcmp(files[i].path,path))exact=1;else if(!strncmp(files[i].path,path,n) && files[i].path[n]=='/')subtree=1;}
    struct stat st;if(fstatat(fd,entry->d_name,&st,AT_SYMLINK_NOFOLLOW)){ok=0;break;}
    if(S_ISDIR(st.st_mode) && subtree && !exact) {
      int child=openat(fd,entry->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      if(child<0){ok=0;break;}ok=inspect_tree(child,owner,files,count,path,depth+1);close(child);if(!ok)break;
    } else if(!S_ISREG(st.st_mode) || !exact || subtree) {ok=0;break;}
  }
  closedir(dir);return ok;
}
int brain_sealed_verify_bundle(int root_fd,uid_t owner,const brain_sealed_file *files,size_t count) {
  if(root_fd<0 || !files || !count || count>MAX_FILES)return 0;
  for(size_t i=0;i<count;i++) {
    if(!files[i].path || !*files[i].path || strlen(files[i].path)>=PATH_MAX)return 0;
    for(size_t j=0;j<i;j++)if(!strcmp(files[i].path,files[j].path))return 0;
    char path[PATH_MAX];strcpy(path,files[i].path);const char *parts[MAX_DEPTH];size_t n=0;char *cursor=path;
    for(;;) {if(n==MAX_DEPTH)return 0;parts[n++]=cursor;char *slash=strchr(cursor,'/');if(!slash)break;*slash=0;cursor=slash+1;}
    int fd=brain_sealed_open_file(root_fd,parts,n,owner,files[i].sha256);if(fd<0)return 0;close(fd);
  }
  return inspect_tree(root_fd,owner,files,count,"",0);
}
