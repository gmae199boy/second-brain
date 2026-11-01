#include "gui-host.h"
#include <Security/Security.h>
#include <SystemConfiguration/SystemConfiguration.h>
#include <bsm/audit.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <libproc.h>
#include <fcntl.h>
#include <spawn.h>
#include <signal.h>
#include <uuid/uuid.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#ifndef BRAIN_GUI_UI_PATH
#define BRAIN_GUI_UI_PATH ""
#endif
static int console_uid(uid_t uid) {uid_t current=0;gid_t group=0;CFStringRef name=SCDynamicStoreCopyConsoleUser(NULL,&current,&group);int ok=name && uid && current==uid;if(name)CFRelease(name);return ok;}
static int safe_stat(int fd,int dir) {
  struct stat s;if(fstat(fd,&s) || s.st_uid!=0 || (s.st_mode&0022))return 0;
  errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);if(acl){acl_free(acl);return 0;}if(errno!=ENOENT)return 0;
  return dir?S_ISDIR(s.st_mode):S_ISREG(s.st_mode) && s.st_nlink==1 && (s.st_mode&0111);
}
static int safe_path(const char *path) {
  if(!path || path[0]!='/' || strlen(path)>=1024 || strstr(path,"//") || path[strlen(path)-1]=='/')return 0;
  char text[1024];memcpy(text,path,strlen(path)+1);int current=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(current<0 || !safe_stat(current,1)){if(current>=0)close(current);return 0;}
  char *save=NULL,*part=strtok_r(text+1,"/",&save);if(!part){close(current);return 0;}
  while(part){if(!strcmp(part,".") || !strcmp(part,"..")){close(current);return 0;}char *next=strtok_r(NULL,"/",&save);
    int fd=openat(current,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(next?O_DIRECTORY:0));close(current);
    if(fd<0 || !safe_stat(fd,next!=NULL)){if(fd>=0)close(fd);return 0;}current=fd;part=next;}
  close(current);return 1;
}
static int permitted(const char *path) {
  if(safe_path(path))return 1;
#if defined(BRAIN_NATIVE_FIXTURE) && defined(BRAIN_FIXTURE_GUI_PATH)
  struct stat s;return !lstat(path,&s) && S_ISREG(s.st_mode) && s.st_uid==geteuid() && !(s.st_mode&0022) && (s.st_mode&0111);
#else
  return 0;
#endif
}
static int verify_code(const char *path,const uint8_t hash[20]) {
  unsigned nonzero=0;for(size_t i=0;i<20;i++)nonzero|=hash[i];if(!nonzero)return 0;
  char text[51];memcpy(text,"cdhash H\"",9);static const char hex[]="0123456789abcdef";
  for(size_t i=0;i<20;i++){text[9+i*2]=hex[hash[i]>>4];text[10+i*2]=hex[hash[i]&15];}text[49]='"';text[50]=0;
  CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)path,strlen(path),false);CFStringRef expression=CFStringCreateWithCString(NULL,text,kCFStringEncodingUTF8);
  SecStaticCodeRef code=NULL;SecRequirementRef requirement=NULL;
  int ok=url && expression && SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)==errSecSuccess && SecRequirementCreateWithString(expression,kSecCSDefaultFlags,&requirement)==errSecSuccess && SecStaticCodeCheckValidity(code,kSecCSStrictValidate,requirement)==errSecSuccess;
  if(requirement)CFRelease(requirement);if(code)CFRelease(code);if(expression)CFRelease(expression);if(url)CFRelease(url);return ok;
}
static int same_process(const brain_gui_process *p) {
  if(!p || p->pid<=0 || p->reaped)return 0;struct proc_bsdinfo info;
  return proc_pidinfo(p->pid,PROC_PIDTBSDINFO,0,&info,sizeof info)==(int)sizeof info && info.pbi_pid==(uint32_t)p->pid && info.pbi_pgid==(uint32_t)p->pid && info.pbi_uid==geteuid()
    && info.pbi_start_tvsec==p->scope.gui_start_sec && info.pbi_start_tvusec==p->scope.gui_start_usec;
}
int brain_gui_start(brain_gui_process *p,uid_t uid,const uint8_t hash[20],uint64_t policy) {
  if(!p)return 0;memset(p,0,sizeof *p);p->pid=-1;
#if defined(BRAIN_FIXTURE_GUI_PATH) && !defined(BRAIN_NATIVE_FIXTURE)
#error fixture_path_is_not_a_production_policy
#endif
#ifdef BRAIN_FIXTURE_GUI_PATH
  const char *path=BRAIN_FIXTURE_GUI_PATH;
#else
  const char *path=BRAIN_GUI_UI_PATH;
#endif
  if(!uid || uid!=geteuid() || geteuid()==0 || !hash || !policy || !console_uid(uid) || !permitted(path) || !verify_code(path,hash))return 0;
  auditinfo_addr_t audit;char boot[64];size_t n=sizeof boot;
  if(getaudit_addr(&audit,sizeof audit) || audit.ai_asid<=0 || sysctlbyname("kern.bootsessionuuid",boot,&n,NULL,0) || !n || n>sizeof boot || boot[n-1]!='\0' || uuid_parse(boot,p->scope.gui_boot))return 0;
  uuid_generate_random(p->scope.gui_session);uuid_generate_random(p->scope.gui_instance);p->scope.gui_asid=(uint64_t)audit.ai_asid;p->scope.policy_generation=policy;
  posix_spawnattr_t attr;if(posix_spawnattr_init(&attr))return 0;posix_spawn_file_actions_t actions;
  if(posix_spawn_file_actions_init(&actions)){posix_spawnattr_destroy(&attr);return 0;}
  int error=posix_spawnattr_setpgroup(&attr,0) || posix_spawnattr_setflags(&attr,POSIX_SPAWN_START_SUSPENDED|POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_SETPGROUP)
    || posix_spawn_file_actions_addopen(&actions,0,"/dev/null",O_RDONLY,0)
#ifdef BRAIN_NATIVE_FIXTURE
    || posix_spawn_file_actions_adddup2(&actions,1,1)
#else
    || posix_spawn_file_actions_addopen(&actions,1,"/dev/null",O_WRONLY,0)
#endif
    || posix_spawn_file_actions_addopen(&actions,2,"/dev/null",O_WRONLY,0);
  char *const args[]={(char *)path,NULL};char *const env[]={"PATH=/usr/bin:/bin","LANG=C",NULL};pid_t pid=-1;
  if(!error)error=posix_spawn(&pid,path,&actions,&attr,args,env);posix_spawn_file_actions_destroy(&actions);posix_spawnattr_destroy(&attr);if(error)return 0;
  p->pid=pid;struct proc_bsdinfo info;if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof info)!=(int)sizeof info || info.pbi_pid!=(uint32_t)pid || info.pbi_uid!=uid){kill(pid,SIGKILL);return 0;}
  p->scope.gui_pid=(uint64_t)pid;p->scope.gui_start_sec=info.pbi_start_tvsec;p->scope.gui_start_usec=info.pbi_start_tvusec;
  if(!p->scope.gui_start_sec || info.pbi_pgid!=(uint32_t)pid){kill(-pid,SIGKILL);return 0;}return 1;
}
int brain_gui_resume(brain_gui_process *p) {if(!same_process(p) || p->resumed || !console_uid(geteuid()) || kill(p->pid,SIGCONT))return 0;p->resumed=1;return 1;}
int brain_gui_cancel(brain_gui_process *p) {
  if(!p || p->pid<=0)return 0;
  if(!p->reaped){int status=0;pid_t r=waitpid(p->pid,&status,WNOHANG);if(r==p->pid)p->reaped=1;
    else if(r==0 && same_process(p) && !kill(-p->pid,SIGKILL))for(int i=0;i<100;i++){r=waitpid(p->pid,&status,WNOHANG);if(r==p->pid){p->reaped=1;break;}if(r<0 && errno!=EINTR)break;usleep(10000);}}
  if(!p->reaped)return 0;pid_t ids[4096];errno=0;int bytes=proc_listpids(PROC_PGRP_ONLY,(uint32_t)p->pid,ids,sizeof ids);
  return bytes==0 && errno==0;
}
