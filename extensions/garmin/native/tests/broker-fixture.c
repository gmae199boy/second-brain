#include <fcntl.h>
#include <spawn.h>
#include <string.h>
#include <sys/random.h>
#include <sys/wait.h>
#include <unistd.h>
#include <CommonCrypto/CommonDigest.h>
#include "../broker.h"
#include "../peer.h"
extern char **environ;
int brain_xpc_send_fd(brain_xpc_peer *peer, int fd) { (void)peer;(void)fd;return 0; }
void brain_xpc_close(brain_xpc_peer *peer) { if(peer)peer->authenticated=0; }
static int guard(void *context) {(void)context;return 1;}
int main(int argc,char **argv) {
  if(argc!=2)return 1;int worker=-1,ui=-1;if(!brain_broker_prepare_channel(&worker,&ui,2000))return 2;
  int inherited=fcntl(worker,F_DUPFD_CLOEXEC,10);if(inherited<0)return 3;
  posix_spawn_file_actions_t actions;if(posix_spawn_file_actions_init(&actions))return 4;
  if(posix_spawn_file_actions_adddup2(&actions,inherited,5))return 5;
  char *child_argv[]={argv[1],NULL};pid_t pid=-1;
  if(posix_spawn(&pid,argv[1],&actions,NULL,child_argv,environ))return 6;
  posix_spawn_file_actions_destroy(&actions);close(inherited);close(worker);
  uint8_t key[32],secret[32],received[32];size_t n=0;
  if(!brain_read_frame(ui,key,sizeof key,&n,2000) || n!=sizeof key || getentropy(secret,sizeof secret)
    || !brain_write_frame(ui,secret,sizeof secret,2000) || !brain_read_frame(ui,received,sizeof received,&n,2000) || n!=sizeof secret || memcmp(secret,received,n))return 7;
  int status=0;if(waitpid(pid,&status,0)!=pid || !WIFEXITED(status) || WEXITSTATUS(status))return 8;
  volatile uint8_t *p=key;for(size_t i=0;i<sizeof key;i++)p[i]=0;p=secret;for(size_t i=0;i<sizeof secret;i++)p[i]=0;close(ui);
  brain_auth_binding b={.run_generation=1,.binding_generation=1,.package_generation=1,.connection_epoch=1,.worker_uid=501,.ui_uid=502,.worker_pid=10};
  memset(b.session,1,16);memset(b.work,2,16);memset(b.attempt,3,16);memset(b.launch_lease,4,16);memset(b.package,5,32);memset(b.worker_hash,6,20);memset(b.ui_hash,7,20);
  brain_xpc_peer w={.uid=501,.pid=10,.authenticated=1},u={.uid=502,.pid=20,.authenticated=1};memcpy(w.hash,b.worker_hash,20);memcpy(u.hash,b.ui_hash,20);
  brain_auth_broker broker;if(!brain_broker_init(&broker,&b,&u,&w,3000) || !brain_broker_set_guard(&broker,guard,NULL) || !brain_broker_worker(&broker) || !brain_broker_recorded(&broker) || !brain_broker_attach(&broker,&b) || !brain_broker_prompt(&broker,b.session,0))return 9;
  brain_presence_scope scope={.gui_pid=20,.gui_asid=1,.gui_start_sec=1,.policy_generation=1,.response_generation=1};memset(scope.gui_session,8,16);memset(scope.gui_instance,9,16);memset(scope.gui_boot,10,16);
  brain_presence_challenge challenge;uint8_t digest[32],capability[32];
  if(!brain_broker_challenge(&broker,&scope,1000,&challenge))return 11;
  CC_SHA256(challenge.message,(CC_LONG)challenge.length,digest);
  if(!brain_broker_callback(&broker,digest,capability) || !brain_broker_consume(&broker,&scope,b.session,capability))return 12;
  if(brain_broker_consume(&broker,&scope,b.session,capability) || !broker.session.revoked)return 13;
  brain_broker_destroy(&broker);
  w.authenticated=u.authenticated=1;
  if(!brain_broker_init(&broker,&b,&u,&w,3000) || !brain_broker_set_guard(&broker,guard,NULL) || !brain_broker_worker(&broker) || !brain_broker_recorded(&broker) || !brain_broker_attach(&broker,&b) || !brain_broker_prompt(&broker,b.session,0) || !brain_broker_approve(&broker,1))return 14;
  if(brain_broker_deliver(&broker,-1) || !broker.needs_reap || !broker.session.revoked)return 10;
  brain_broker_destroy(&broker);return 0;
}
