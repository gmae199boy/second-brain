#include "queue-host.h"
#include "peer.h"
#include <arpa/inet.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#ifdef BRAIN_REGISTRY_FIXTURE
#include <stdio.h>
#define DIAG(x) fprintf(stderr,"host: %s\n",x)
#else
#define DIAG(x) ((void)0)
#endif
#ifndef BRAIN_QUEUE_SUPERVISOR_UID
#define BRAIN_QUEUE_SUPERVISOR_UID 0
#endif
#ifndef BRAIN_QUEUE_SUPERVISOR_HASH
#define BRAIN_QUEUE_SUPERVISOR_HASH ""
#endif
static int nibble(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;}
static int identity(uint8_t hash[20]) {
  const char *s=BRAIN_QUEUE_SUPERVISOR_HASH;if(BRAIN_QUEUE_SUPERVISOR_UID==0||strlen(s)!=40)return 0;
  for(int i=0;i<20;i++){int a=nibble(s[2*i]),b=nibble(s[2*i+1]);if(a<0||b<0)return 0;hash[i]=(uint8_t)((a<<4)|b);}return 1;
}
int brain_queue_host_open(brain_queue_session *session,int control,int reg,int payload) {
  uint8_t supervisor[20],record[28];size_t length=0;brain_peer_session peer={.fd=-1};
  if(!session || !identity(supervisor)){DIAG("identity");if(control>=0)close(control);return 0;}
  pid_t parent=getppid();uid_t supervisor_uid=(uid_t)BRAIN_QUEUE_SUPERVISOR_UID;
  if(!brain_peer_open(&peer,control,supervisor_uid,parent,supervisor)){DIAG("peer");return 0;}
  if(!brain_read_frame(peer.fd,record,sizeof record,&length,5000)||length!=sizeof record
      ||!brain_verify_peer(peer.fd,supervisor_uid,parent,supervisor)){DIAG("record");brain_peer_close(&peer);return 0;}
  uint32_t uid_wire,pid_wire;memcpy(&uid_wire,record,4);memcpy(&pid_wire,record+4,4);
  uint32_t uid=ntohl(uid_wire),pid=ntohl(pid_wire);
  if(!uid || !pid || pid>INT32_MAX){DIAG("values");brain_peer_close(&peer);return 0;}
  int service=brain_peer_receive_fd(&peer,5000);
  if(service<0 || !brain_verify_peer(peer.fd,supervisor_uid,parent,supervisor)) {DIAG("service fd");if(service>=0)close(service);brain_peer_close(&peer);return 0;}
#ifdef BRAIN_REGISTRY_FIXTURE
  int ok=brain_queue_session_open_fixture(session,reg,payload,service,(uid_t)uid,(pid_t)pid,record+8,geteuid());
#else
  int ok=brain_queue_session_open(session,reg,payload,service,(uid_t)uid,(pid_t)pid,record+8);
#endif
  if(!ok){DIAG("launcher");brain_peer_close(&peer);return 0;}
  if(!brain_verify_peer(peer.fd,supervisor_uid,parent,supervisor)){brain_queue_session_close(session);brain_peer_close(&peer);return 0;}
  session->supervisor_bound=1;session->supervisor_fd=peer.fd;session->supervisor_uid=supervisor_uid;session->supervisor_pid=parent;memcpy(session->supervisor_hash,supervisor,20);peer.fd=-1;
  brain_peer_close(&peer);return 1;
}
