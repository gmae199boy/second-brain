#include "worker-host.h"
#include "peer.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <sys/acl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <time.h>
#include <pthread.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int no_acl(int fd) { errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); if (acl) { acl_free(acl); return 0; } return errno == ENOENT; }
static int safe_stat(int fd, int directory) {
  struct stat s; if (fstat(fd, &s) || s.st_uid != 0 || (s.st_mode & 0022) || !no_acl(fd)) return 0;
  return directory ? S_ISDIR(s.st_mode) : S_ISREG(s.st_mode) && s.st_nlink == 1 && (s.st_mode & 0111);
}
/* root 소유 부모만 통과하므로 검증 후 경로 교체는 관리자 권한을 요구한다. */
static int safe_path(const char *path) {
  if (!path || path[0] != '/' || strlen(path) >= 1024 || strstr(path,"//") || path[strlen(path)-1] == '/') return 0;
  char copy[1024]; memcpy(copy,path,strlen(path)+1);
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); if (current < 0 || !safe_stat(current,1)) { if (current >= 0) close(current); return 0; }
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save); if (!part) { close(current); return 0; }
  while (part) {
    if (!strcmp(part,".") || !strcmp(part,"..") || !*part) { close(current); return 0; }
    char *next = strtok_r(NULL,"/",&save);
    int fd = openat(current, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (next ? O_DIRECTORY : 0)); close(current);
    if (fd < 0 || !safe_stat(fd,next != NULL)) { if (fd >= 0) close(fd); return 0; }
    current = fd; part = next;
  }
  close(current); return 1;
}
static int verify_code(const char *path, const uint8_t hash[20]) {
  unsigned nonzero = 0; for (int i=0;i<20;i++) nonzero |= hash[i]; if (!nonzero) return 0;
  char text[51]; memcpy(text,"cdhash H\"",9); static const char h[]="0123456789abcdef";
  for (int i=0;i<20;i++) { text[9+i*2]=h[hash[i]>>4]; text[10+i*2]=h[hash[i]&15]; } text[49]='"'; text[50]=0;
  CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)path,strlen(path),false);
  CFStringRef expression=CFStringCreateWithCString(NULL,text,kCFStringEncodingUTF8);
  SecStaticCodeRef code=NULL; SecRequirementRef requirement=NULL;
  int ok=url && expression && SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)==errSecSuccess
    && SecRequirementCreateWithString(expression,kSecCSDefaultFlags,&requirement)==errSecSuccess
    && SecStaticCodeCheckValidity(code,kSecCSStrictValidate,requirement)==errSecSuccess;
  if(requirement)CFRelease(requirement); if(code)CFRelease(code); if(expression)CFRelease(expression); if(url)CFRelease(url); return ok;
}
static int private_pipe(int fds[2]) {
  if (pipe(fds)) return 0;
  if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) || fcntl(fds[1], F_SETFD, FD_CLOEXEC)) { close(fds[0]); close(fds[1]); return 0; }
  return 1;
}
/* [ASSUMPTION] D1 봉인 설치 경로와 일치해야 한다. fixture에서만 컴파일 경로를 대체한다. */
#if defined(BRAIN_FIXTURE_WORKER_PATH) && !defined(BRAIN_NATIVE_FIXTURE)
#error 합성_경로는_fixture에서만_허용된다
#endif
#if defined(BRAIN_FIXTURE_WORKER_PATH)
#define BRAIN_WORKER_PATH BRAIN_FIXTURE_WORKER_PATH
#elif defined(BRAIN_NATIVE_FIXTURE)
#define BRAIN_WORKER_PATH "/usr/bin/true"
#else
#define BRAIN_WORKER_PATH "/Library/Application Support/SecondBrain/libexec/garmin-worker"
#endif
static int permitted_path(const char *path) {
  if(safe_path(path))return 1;
#if defined(BRAIN_NATIVE_FIXTURE) && defined(BRAIN_FIXTURE_WORKER_PATH)
  /* fixture는 임시 사용자 파일을 쓰며 운영 소유권 검증을 입증하지 않는다. */
  struct stat info;return !lstat(path,&info) && S_ISREG(info.st_mode) && info.st_uid==geteuid() && !(info.st_mode&0022) && (info.st_mode&0111);
#else
  return 0;
#endif
}
static pthread_mutex_t spawn_lock = PTHREAD_MUTEX_INITIALIZER;
static int spawn_worker(const uint8_t hash[20], uid_t worker_uid, int channel_fd, brain_worker *out) {
  const char *fixed_path = BRAIN_WORKER_PATH;
  if (!out) return 0;
  *out = (brain_worker){ .pid = -1, .bootstrap_write = -1, .stdout_read = -1, .stderr_read = -1, .control_fd = -1 };
  if (!hash || !worker_uid || geteuid() != worker_uid || geteuid() == 0 || !permitted_path(fixed_path) || !verify_code(fixed_path,hash)) return 0;
  if(channel_fd>=0) { struct stat channel_stat; if(fstat(channel_fd,&channel_stat) || !S_ISSOCK(channel_stat.st_mode))return 0; }
  /* 같은 host의 모든 spawn은 이 잠금을 공유해야 한다. 다른 spawn 경로는 아직 연결되지 않았다. */
  if (pthread_mutex_lock(&spawn_lock)) return 0;
  int ack[2] = {-1,-1}, outpipe[2] = {-1,-1}, errpipe[2] = {-1,-1}, control[2] = {-1,-1};
  if (!private_pipe(ack) || !private_pipe(outpipe) || !private_pipe(errpipe) || socketpair(AF_UNIX,SOCK_STREAM,0,control)
      || fcntl(control[0],F_SETFD,FD_CLOEXEC) || fcntl(control[1],F_SETFD,FD_CLOEXEC)) goto fail;
  /* dup2 대상과 충돌하지 않도록 원본은 10 이상으로 복제한다. */
  int fds[5] = {fcntl(ack[0],F_DUPFD_CLOEXEC,10),fcntl(outpipe[1],F_DUPFD_CLOEXEC,10),fcntl(errpipe[1],F_DUPFD_CLOEXEC,10),fcntl(control[1],F_DUPFD_CLOEXEC,10),channel_fd>=0?fcntl(channel_fd,F_DUPFD_CLOEXEC,10):-1};
  if (fds[0] < 0 || fds[1] < 0 || fds[2] < 0 || fds[3] < 0 || (channel_fd>=0 && fds[4]<0)) { for(int i=0;i<5;i++) if(fds[i]>=0)close(fds[i]); goto fail; }
  posix_spawn_file_actions_t actions; posix_spawnattr_t attr;
  if (posix_spawn_file_actions_init(&actions)) { for(int i=0;i<5;i++)if(fds[i]>=0)close(fds[i]); goto fail; }
  if (posix_spawnattr_init(&attr)) { posix_spawn_file_actions_destroy(&actions); for(int i=0;i<5;i++)if(fds[i]>=0)close(fds[i]); goto fail; }
  int error = posix_spawn_file_actions_addopen(&actions,0,"/dev/null",O_RDONLY,0) || posix_spawn_file_actions_adddup2(&actions,fds[3],4) || posix_spawn_file_actions_adddup2(&actions,fds[0],3) || posix_spawn_file_actions_adddup2(&actions,fds[1],1)
    || posix_spawn_file_actions_adddup2(&actions,fds[2],2) || posix_spawnattr_setpgroup(&attr,0)
    || posix_spawnattr_setflags(&attr,POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
    || (channel_fd>=0 && posix_spawn_file_actions_adddup2(&actions,fds[4],5));
  char *const argv[] = {(char *)fixed_path,NULL}; char *const env[] = {"PATH=/usr/bin:/bin","LANG=C",NULL}; pid_t pid = -1;
  if (!error) error = posix_spawn(&pid,fixed_path,&actions,&attr,argv,env);
  posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions); for(int i=0;i<5;i++)if(fds[i]>=0)close(fds[i]);
  if (error) goto fail;
  close(ack[0]); close(outpipe[1]); close(errpipe[1]); close(control[1]);
  *out = (brain_worker){ .pid=pid, .bootstrap_write=ack[1], .stdout_read=outpipe[0], .stderr_read=errpipe[0], .control_fd=control[0] }; pthread_mutex_unlock(&spawn_lock); return 1;
fail:
  for(int i=0;i<2;i++) { if(ack[i]>=0)close(ack[i]); if(outpipe[i]>=0)close(outpipe[i]); if(errpipe[i]>=0)close(errpipe[i]); if(control[i]>=0)close(control[i]); }
  pthread_mutex_unlock(&spawn_lock); return 0;
}
int brain_spawn_worker(const uint8_t hash[20], uid_t worker_uid, brain_worker *out) { return spawn_worker(hash,worker_uid,-1,out); }
int brain_spawn_worker_with_channel(const uint8_t hash[20], uid_t worker_uid, int channel_fd, brain_worker *out) {
  if(channel_fd<0)return 0;return spawn_worker(hash,worker_uid,channel_fd,out);
}
static int verify_worker_peer(brain_worker *worker, uid_t worker_uid, const uint8_t hash[20], int timeout_ms) {
  if (!worker || worker->peer_verified || worker->control_fd < 0 || timeout_ms<=0 || timeout_ms>300000) return 0;
  struct timespec now; if (clock_gettime(CLOCK_MONOTONIC,&now)) return 0;
  int64_t deadline=(int64_t)now.tv_sec*1000+now.tv_nsec/1000000+timeout_ms;
  while (!brain_verify_peer(worker->control_fd,worker_uid,worker->pid,hash)) {
    if (clock_gettime(CLOCK_MONOTONIC,&now) || (int64_t)now.tv_sec*1000+now.tv_nsec/1000000>=deadline) return 0;
    /* [ASSUMPTION] exec 후 OS 코드 신원 확정을 10ms 간격으로 재조회한다. */
    usleep(10000);
  }
  if (clock_gettime(CLOCK_MONOTONIC,&now)) return 0;
  int64_t remaining=deadline-((int64_t)now.tv_sec*1000+now.tv_nsec/1000000); if (remaining<=0) return 0;
  uint8_t hello[5]; size_t length=0;
  if (!brain_read_frame(worker->control_fd,hello,sizeof hello,&length,(int)remaining) || length!=5 || memcmp(hello,"hello",5)) return 0;
  worker->peer_verified=1; return 1;
}
int brain_worker_verify_peer(brain_worker *worker, uid_t worker_uid, const uint8_t hash[20], int timeout_ms) {
  int ok=verify_worker_peer(worker,worker_uid,hash,timeout_ms);
  if (!ok && worker) brain_worker_close(worker);
  return ok;
}
int brain_worker_recorded(brain_worker *worker, pid_t actual_pid) {
  if (!worker) return 0;
  if (!worker->peer_verified || worker->identity_recorded || actual_pid != worker->pid) { brain_worker_close(worker); return 0; }
  worker->identity_recorded=1; return 1;
}
int brain_worker_ack(brain_worker *worker) {
  if (!worker) return 0;
  if (!worker->peer_verified || !worker->identity_recorded || worker->bootstrap_write < 0) { brain_worker_close(worker); return 0; } int fd=worker->bootstrap_write; worker->bootstrap_write=-1;
  if (fcntl(fd,F_SETNOSIGPIPE,1)<0) { close(fd); return 0; } char byte=1; ssize_t n; do { n=write(fd,&byte,1); } while(n<0 && errno==EINTR); close(fd); return n==1;
}
void brain_worker_close(brain_worker *worker) {
  if (!worker) return; if(worker->bootstrap_write>=0)close(worker->bootstrap_write); if(worker->stdout_read>=0)close(worker->stdout_read); if(worker->stderr_read>=0)close(worker->stderr_read); if(worker->control_fd>=0)close(worker->control_fd);
  worker->bootstrap_write=worker->stdout_read=worker->stderr_read=worker->control_fd=-1;
}

int brain_worker_reap(brain_worker *worker, int *status) {
  if (!worker || !status || worker->pid <= 0) return -1;
  if (worker->reaped) { *status=worker->wait_status; return 1; }
  int result; pid_t pid; do { pid=waitpid(worker->pid,&result,WNOHANG); } while(pid<0 && errno==EINTR);
  if (pid==0) return 0;
  if (pid!=worker->pid) return -1;
  worker->reaped=1; worker->wait_status=result; *status=result; return 1;
}
int brain_worker_signal(brain_worker *worker, int signal_number) {
  if (!worker || (signal_number!=SIGTERM && signal_number!=SIGKILL)) return 0;
  int status; if (brain_worker_reap(worker,&status)!=0 || getpgid(worker->pid)!=worker->pid) return 0;
  return kill(-worker->pid,signal_number)==0;
}

int brain_worker_group_state(const brain_worker *worker) {
  if (!worker || worker->pid<=0) return -1;
  pid_t ids[4096]; errno=0;
  int bytes=proc_listpids(PROC_PGRP_ONLY,(uint32_t)worker->pid,ids,sizeof ids);
  if (bytes<0 || (bytes==0 && errno!=0) || bytes>=(int)sizeof ids || bytes%(int)sizeof(pid_t)) return -1;
  int count=bytes/(int)sizeof(pid_t);
  for (int i=0;i<count;i++) {
    if (ids[i]<=0) continue;
    struct proc_bsdinfo info; int n=proc_pidinfo(ids[i],PROC_PIDTBSDINFO,0,&info,sizeof info);
    if (n!=(int)sizeof info || info.pbi_pid!=(uint32_t)ids[i] || info.pbi_pgid!=(uint32_t)worker->pid) return -1;
    return 1;
  }
  return count==0 ? 0 : -1;
}
