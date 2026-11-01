#include "broker-credential.h"
#include <sys/acl.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
extern PGconn *PQconnectdbParams(const char *const *,const char *const *,int);
typedef struct {char *keyword,*envvar,*compiled,*val,*label,*dispchar;int dispsize;} PQconninfoOption;
extern PQconninfoOption *PQconninfoParse(const char *,char **);
extern void PQconninfoFree(PQconninfoOption *);
extern void PQfreemem(void *);
extern int PQstatus(const PGconn *);
extern void PQfinish(PGconn *);
extern char **environ;
static void wipe(void *p,size_t n){volatile unsigned char *v=p;while(n--)*v++=0;}
static int no_acl(int fd){errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);if(acl){acl_free(acl);return 0;}return errno==ENOENT;}
/* kind 0: broker 자격, 1: root 소유 인증서, 2: root 소유 디렉터리. */
static int open_checked(const char *path,int kind) {
  if(!path || path[0]!='/' || strlen(path)>=1024 || strstr(path,"//") || path[strlen(path)-1]=='/')return -1;
  char copy[1024];memcpy(copy,path,strlen(path)+1);int current=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(current<0)return -1;
  char *save=NULL,*part=strtok_r(copy+1,"/",&save);if(!part){close(current);return -1;}
  while(part){if(!strcmp(part,".") || !strcmp(part,"..")){close(current);return -1;}
    struct stat parent;if(fstat(current,&parent) || !S_ISDIR(parent.st_mode) || parent.st_uid!=0 || (parent.st_mode&0022) || !no_acl(current)){close(current);return -1;}
    char *next=strtok_r(NULL,"/",&save);int fd=openat(current,part,O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC|((next || kind==2)?O_DIRECTORY:0));close(current);if(fd<0)return -1;
    if(!next){struct stat s;int ok=!fstat(fd,&s) && no_acl(fd);
      if(kind==0)ok=ok && S_ISREG(s.st_mode) && s.st_uid==geteuid() && s.st_nlink==1 && (s.st_mode&07777)==0600;
      else if(kind==1)ok=ok && S_ISREG(s.st_mode) && s.st_uid==0 && s.st_nlink==1 && !(s.st_mode&0022);
      else ok=ok && S_ISDIR(s.st_mode) && s.st_uid==0 && !(s.st_mode&0022);
      if(!ok){close(fd);return -1;}return fd;}
    current=fd;part=next;
  }
  close(current);return -1;
}
/* hook은 합성 경계 시험용이며 실제 호출은 항상 NULL이다. */
static int read_credential(int fd,char data[4097],void (*hook)(int)) {
  struct stat before,after;if(fstat(fd,&before) || !S_ISREG(before.st_mode) || before.st_size<=0 || before.st_size>4096)return 0;
  if(hook)hook(fd);size_t used=0;
  while(used<4097){ssize_t n=read(fd,data+used,4097-used);if(n<0 && errno==EINTR)continue;if(n<0)return 0;if(!n)break;used+=(size_t)n;}
  if(!used || used>4096 || fstat(fd,&after) || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || before.st_size!=after.st_size
    || before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec
    || before.st_ctimespec.tv_sec!=after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec!=after.st_ctimespec.tv_nsec || memchr(data,0,used))return 0;
  if(data[used-1]=='\n')used--;if(!used)return 0;data[used]=0;return 1;
}
static int one_endpoint(const char *text) {
  if(!text || !*text)return 0;for(const unsigned char *p=(const unsigned char *)text;*p;p++)if(*p<=32 || *p==127 || *p==',')return 0;return 1;
}
static int port_number(const char *text) {
  if(!text || !*text)return 0;unsigned value=0;for(const unsigned char *p=(const unsigned char *)text;*p;p++){if(*p<'0' || *p>'9')return 0;value=value*10+(unsigned)(*p-'0');if(value>65535)return 0;}return value>0;
}
static int unique_address(const struct addrinfo *results,char address[INET6_ADDRSTRLEN]) {
  int ok=1,seen=0;address[0]=0;
  for(const struct addrinfo *r=results;r;r=r->ai_next){const void *bytes=NULL;char current[INET6_ADDRSTRLEN];
    if(r->ai_family==AF_INET && r->ai_addrlen>=sizeof(struct sockaddr_in))bytes=&((const struct sockaddr_in *)r->ai_addr)->sin_addr;
    else if(r->ai_family==AF_INET6 && r->ai_addrlen>=sizeof(struct sockaddr_in6)){
      const struct sockaddr_in6 *a=(const struct sockaddr_in6 *)r->ai_addr;if(a->sin6_scope_id){ok=0;break;}bytes=&a->sin6_addr;
    } else continue;
    if(!inet_ntop(r->ai_family,bytes,current,sizeof current)){ok=0;break;}
    if(seen && strcmp(address,current)){ok=0;break;}if(!seen){memcpy(address,current,strlen(current)+1);seen=1;}
  }
  if(!ok || !seen){address[0]=0;return 0;}return 1;
}
static int resolve_one(const char *host,const char *port,char address[INET6_ADDRSTRLEN]) {
  struct addrinfo hints={0},*results=NULL;hints.ai_socktype=SOCK_STREAM;hints.ai_family=AF_UNSPEC;hints.ai_flags=AI_NUMERICSERV;
  if(getaddrinfo(host,port,&hints,&results))return 0;int ok=unique_address(results,address);freeaddrinfo(results);return ok;
}
static int validate_conninfo_for_role(const char *data,char address[INET6_ADDRSTRLEN],const char *role) {
  if(!address)return 0;address[0]=0;
  char *error=NULL;PQconninfoOption *options=PQconninfoParse(data,&error);int ok=options!=NULL;
  const char *host=NULL,*port=NULL,*database=NULL,*user=NULL,*sslmode=NULL,*rootcert=NULL;
  for(PQconninfoOption *o=options;o && o->keyword;o++)if(o->val && *o->val){
    if(!strcmp(o->keyword,"host"))host=o->val;else if(!strcmp(o->keyword,"port"))port=o->val;
    else if(!strcmp(o->keyword,"dbname"))database=o->val;else if(!strcmp(o->keyword,"user"))user=o->val;
    else if(!strcmp(o->keyword,"sslmode"))sslmode=o->val;else if(!strcmp(o->keyword,"sslrootcert"))rootcert=o->val;
    else if(strcmp(o->keyword,"password"))ok=0;
  }
  if(!one_endpoint(host) || !port_number(port) || !database || !*database || !user || !role || strcmp(user,role))ok=0;
  if(ok && host[0]=='/'){
    int directory=open_checked(host,2);if(directory<0)ok=0;else close(directory);
    if(sslmode && strcmp(sslmode,"verify-full"))ok=0;
    if(rootcert){int certificate=open_checked(rootcert,1);if(certificate<0)ok=0;else close(certificate);}
  }
  else if(ok){if(!sslmode || strcmp(sslmode,"verify-full") || !rootcert)ok=0;else {int certificate=open_checked(rootcert,1);if(certificate<0)ok=0;else close(certificate);}
    if(ok && !resolve_one(host,port,address))ok=0;}
  if(options){for(PQconninfoOption *o=options;o->keyword;o++)if(o->val)wipe(o->val,strlen(o->val));PQconninfoFree(options);}
  if(error){wipe(error,strlen(error));PQfreemem(error);}return ok;
}
#ifdef BRAIN_CREDENTIAL_FIXTURE
static int validate_conninfo(const char *data,char address[INET6_ADDRSTRLEN]) {
  return validate_conninfo_for_role(data,address,"brain_protected_broker");
}
#endif
static PGconn *connect_protected(const char *path,const char *role,const char *application) {
  if(geteuid()==0)return NULL;int fd=open_checked(path,0);if(fd<0)return NULL;
  char data[4097]={0};int ok=read_credential(fd,data,NULL);close(fd);
  /* libpq 환경과 사용자 service/passfile 탐색은 보호 설정을 덮을 수 없다. */
  for(;;){const char *entry=NULL;for(char **p=environ;p && *p;p++)if((*p)[0]=='P' && (*p)[1]=='G' && strchr(*p,'=')){entry=*p;break;}
    if(!entry)break;const char *equals=strchr(entry,'=');size_t length=(size_t)(equals-entry);char name[256];
    if(!length || length>=sizeof name){ok=0;break;}memcpy(name,entry,length);name[length]=0;if(unsetenv(name)){ok=0;break;}}
  int empty_dir=open_checked("/private/var/empty",2);if(empty_dir<0)ok=0;else {
    struct stat absent;errno=0;if(fstatat(empty_dir,"brain-no-crl",&absent,AT_SYMLINK_NOFOLLOW)==0 || errno!=ENOENT)ok=0;close(empty_dir);
  }
  char address[INET6_ADDRSTRLEN]={0};if(ok)ok=validate_conninfo_for_role(data,address,role);
  const char *keys[]={"dbname","connect_timeout","application_name","passfile","gssencmode","sslcertmode","sslcrl","sslcrldir","hostaddr",NULL};
  const char *values[]={data,"2",application,"/dev/null","disable","disable","/private/var/empty/brain-no-crl","/private/var/empty",address[0]?address:NULL,NULL};
  PGconn *connection=ok?PQconnectdbParams(keys,values,1):NULL;wipe(data,sizeof data);
  if(!connection || PQstatus(connection)!=0){if(connection)PQfinish(connection);return NULL;}return connection;
}

PGconn *brain_broker_connect_protected(const char *path) {
  return connect_protected(path,"brain_protected_broker","brain-protected-broker");
}
PGconn *brain_supervisor_connect_protected(const char *path) {
  return connect_protected(path,"brain_protected_supervisor","brain-protected-supervisor");
}
