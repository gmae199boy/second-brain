#include "../host-client.h"
#include "fixture-common.h"
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <signal.h>
#include <errno.h>
int main(int argc,char **argv) {
  if(argc!=3)return 2;uint8_t hash[20],package[32];if(!fixture_hash(argv[2],hash))return 3;memset(package,1,sizeof package);
  brain_host_client c;if(!brain_host_connect(&c,argv[1],geteuid(),hash))return 4;uuid_t work,attempt;uuid_generate_random(work);uuid_generate_random(attempt);
  int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 11;
  if(!brain_host_start_auth(&c,work,attempt,1,1,1,package,pair[0]))return 5;
#ifdef BRAIN_FIXTURE_IDENTITY_CASE
  if(BRAIN_FIXTURE_IDENTITY_CASE==2)c.lease[0]^=1;
  brain_group_member probe[24];size_t probe_count=0;int observed=brain_host_members(&c,probe,24,&probe_count);
  close(pair[0]);close(pair[1]);brain_host_close(&c);return observed<0?0:20;
#endif
  if(write(pair[1],"x",1)!=1)return 12;
  int flags=fcntl(c.stdout_fd,F_GETFL);if(flags<0 || fcntl(c.stdout_fd,F_SETFL,flags|O_NONBLOCK)<0)return 6;
  char output[8];if(read(c.stdout_fd,output,7)>0)return 7;
  int unread=0;if(ioctl(pair[0],FIONREAD,&unread) || unread!=1)return 13;close(pair[0]);
#ifdef BRAIN_FIXTURE_METADATA_CASE
  uint8_t metadata[1236]={1};memcpy(metadata+1,work,16);memcpy(metadata+17,attempt,16);metadata[40]=1;metadata[42]=3;metadata[44]=7;metadata[45]=1;metadata[46]=6;memcpy(metadata+47,"UTCfixturegarmin",16);
  if(BRAIN_FIXTURE_METADATA_CASE==2)metadata[17]^=1;
  if(BRAIN_FIXTURE_METADATA_CASE==4) {
    xpc_object_t message=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(message,"op","metadata");xpc_dictionary_set_uuid(message,"lease",c.lease);xpc_dictionary_set_data(message,"frame",metadata,sizeof metadata);
    xpc_connection_send_message(c.connection,message);xpc_release(message);usleep(200000);
    int accepted=brain_host_metadata(&c,metadata,63);close(pair[1]);brain_host_close(&c);return accepted?19:0;
  }
  if(BRAIN_FIXTURE_METADATA_CASE==5) {
    int accepted=brain_host_recorded(&c);close(pair[1]);brain_host_close(&c);return accepted?15:0;
  }
  int accepted=brain_host_metadata(&c,metadata,63);
  if(BRAIN_FIXTURE_METADATA_CASE==2){close(pair[1]);brain_host_close(&c);return accepted?16:0;}
  if(!accepted)return 17;
  if(BRAIN_FIXTURE_METADATA_CASE==3){accepted=brain_host_metadata(&c,metadata,63);close(pair[1]);brain_host_close(&c);return accepted?18:0;}
#endif
  int group=-1;if(brain_host_inspect(&c,&group)!=1 || group!=1 || !brain_host_recorded(&c))return 8;
  ssize_t n=-1;for(int i=0;i<200 && n<0;i++){usleep(10000);n=read(c.stdout_fd,output,7);}
  if(n!=7 || memcmp(output,"entered",7))return 9;
  int state=0,status=-1;for(int i=0;i<300 && state==0;i++){usleep(10000);state=brain_host_leader_observed(&c,&status);}
#ifdef BRAIN_FIXTURE_DESCENDANT
  int open_group=kill(-c.pid,0)==0;
  errno=0;ssize_t extra=read(c.stdout_fd,output,1);int open_pipe=extra<0 && (errno==EAGAIN || errno==EWOULDBLOCK);
  brain_group_member members[24];size_t count=0;
  int inspected=brain_host_members(&c,members,24,&count);
  int killed=brain_host_signal(&c,SIGKILL);
  if(state!=1 || status!=0 || !open_group || !open_pipe || inspected!=1 || count==0 || !killed)return 14;
#endif
  brain_group_member remaining[24];size_t remaining_count=0;int empty=0;
  for(int i=0;i<300;i++){if(brain_host_members(&c,remaining,24,&remaining_count)!=1)break;if(!remaining_count){empty=1;break;}usleep(10000);}
  if(!empty || !brain_host_reap(&c))return 15;
  state=0;for(int i=0;i<300 && state==0;i++){usleep(10000);state=brain_host_observe(&c,&status);}
  close(pair[1]);brain_host_close(&c);return state==1 && status==0 ? 0 : 10;
}
