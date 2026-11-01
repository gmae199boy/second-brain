/* 실제 handler를 호출하며 XPC 인증·채널·생체 입력은 이 시험에서만 합성한다. */
#define main brain_auth_ui_program_main
#define brain_xpc_verify_message fixture_verify
#define brain_xpc_receive_fd fixture_receive_fd
#define brain_xpc_close fixture_peer_close
#define brain_channel_init fixture_channel_init
#define brain_channel_close fixture_channel_close
#define brain_secure_prompt_start fixture_prompt_start
#include "../auth-ui.m"
#undef main
#include <sys/socket.h>
#include <CoreFoundation/CoreFoundation.h>
static int saved_fd=-1,prompts,last_mfa,last_ordinal,terminations;
@interface FixtureApp : NSObject
- (void)terminate:(id)sender;
@end
@implementation FixtureApp
- (void)terminate:(id)sender {(void)sender;terminations++;}
@end
int fixture_verify(brain_xpc_peer *peer,xpc_object_t message){return peer && peer->authenticated && message && xpc_get_type(message)==XPC_TYPE_DICTIONARY;}
int fixture_receive_fd(brain_xpc_peer *peer,xpc_object_t message){return fixture_verify(peer,message)?xpc_dictionary_dup_fd(message,"fd"):-1;}
void fixture_peer_close(brain_xpc_peer *peer){if(peer)peer->authenticated=0;}
int fixture_channel_init(brain_auth_channel *channel,int fd,const uint8_t session[16],int ui,int timeout){(void)channel;(void)session;(void)ui;(void)timeout;saved_fd=fd;return fd>=0;}
void fixture_channel_close(brain_auth_channel *channel){(void)channel;if(saved_fd>=0){close(saved_fd);saved_fd=-1;}}
int fixture_prompt_start(BRAINSubmission *s,brain_auth_channel *c,const uint8_t prompt[16],int mfa,unsigned ordinal,int timeout,
  BOOL (^challenge)(uint64_t,brain_presence_challenge *),BOOL (^broker)(const brain_local_presence *),void (^completion)(BOOL)) {
  (void)s;(void)c;(void)prompt;(void)timeout;(void)challenge;(void)broker;(void)completion;
  prompts++;last_mfa=mfa;last_ordinal=(int)ordinal;return 1;
}
static xpc_object_t prompt_event(int mfa,unsigned ordinal) {
  uuid_t id;uuid_generate_random(id);xpc_object_t e=xpc_dictionary_create(NULL,NULL,0);
  xpc_dictionary_set_string(e,"op","prompt");xpc_dictionary_set_uuid(e,"prompt",id);xpc_dictionary_set_bool(e,"mfa",mfa!=0);xpc_dictionary_set_uint64(e,"ordinal",ordinal);return e;
}
static xpc_object_t fd_event(int fd){xpc_object_t e=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_fd(e,"fd",fd);return e;}
static void pump(void){CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.05,false);}
static void reset(brain_xpc_peer *peer){discard_pending();fixture_channel_close(&auth_channel);channel_ready=target_selected=0;peer->authenticated=1;}
int main(void){@autoreleasepool {
  FixtureApp *app=[[FixtureApp alloc] init];dispatch_queue_t queue=dispatch_queue_create("fixture.ui",DISPATCH_QUEUE_SERIAL);
  brain_xpc_peer peer={.authenticated=1};configure_events(&peer,queue,(NSApplication *)app);uuid_t session;uuid_generate_random(session);
  xpc_object_t accepted=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_bool(accepted,"accepted",true);
  int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 1;
  xpc_object_t fd=fd_event(pair[0]),prompt=prompt_event(0,0);close(pair[0]);selection_pending=1;
  process_event(fd);process_event(prompt);xpc_release(fd);xpc_release(prompt);
  if(channel_ready || prompts || pending_events.count!=2)return 2;
  selection_reply(&peer,accepted,session,(NSApplication *)app);pump();
  if(!channel_ready || prompts!=1 || last_mfa || last_ordinal || !peer.authenticated)return 3;
  reset(&peer);close(pair[1]);
  if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 4;fd=fd_event(pair[0]);prompt=prompt_event(1,2);close(pair[0]);selection_pending=1;
  selection_reply(&peer,accepted,session,(NSApplication *)app);process_event(fd);process_event(prompt);xpc_release(fd);xpc_release(prompt);pump();
  if(!channel_ready || prompts!=2 || last_mfa!=1 || last_ordinal!=2)return 5;
  reset(&peer);close(pair[1]);
  if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 6;fd=fd_event(pair[0]);close(pair[0]);selection_pending=1;process_event(fd);xpc_release(fd);
  xpc_object_t denied=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_bool(denied,"accepted",false);
  selection_reply(&peer,denied,session,(NSApplication *)app);xpc_release(denied);pump();char byte;
  if(peer.authenticated || pending_events.count || read(pair[1],&byte,1)!=0 || !terminations)return 7;close(pair[1]);
  reset(&peer);selection_pending=1;prompt=prompt_event(1,1);process_event(prompt);xpc_release(prompt);selection_reply(&peer,accepted,session,(NSApplication *)app);pump();
  if(peer.authenticated || prompts!=2)return 8;
  xpc_release(accepted);discard_pending();[process_event release];process_event=nil;[submission release];submission=nil;dispatch_release(queue);[app release];return 0;
}}
