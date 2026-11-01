#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>
#import <xpc/xpc.h>
#include "xpc-peer.h"
#include "secure-prompt.h"
#import "submission-ui.h"
#include "submission-ipc.h"
#include "ui-events.h"
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static brain_auth_channel auth_channel;
static int channel_ready, target_selected, selection_pending;
static brain_ui_events pending_events;
static void (^process_event)(xpc_object_t);
static void discard_pending(void) {
  brain_ui_events_clear(&pending_events);selection_pending=0;
}
static uuid_t target_session;
static BRAINSubmission *submission;

#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_AUTH_MACH_SERVICE "org.secondbrain.auth.unconfigured"
#define BRAIN_BROKER_UID 0
#define BRAIN_UI_UID 0
static const uint8_t BRAIN_BROKER_HASH[20] = {0};
#endif

static void selection_reply(brain_xpc_peer *broker,xpc_object_t reply,const uint8_t session[16],NSApplication *app) {
  if(!brain_xpc_verify_message(broker,reply) || xpc_get_type(reply)!=XPC_TYPE_DICTIONARY || xpc_dictionary_get_count(reply)!=1 || !xpc_dictionary_get_bool(reply,"accepted")) {
    discard_pending();brain_xpc_close(broker);dispatch_async(dispatch_get_main_queue(),^{[app terminate:nil];});return;
  }
  memcpy(target_session,session,16);target_selected=1;selection_pending=0;
  xpc_object_t event;while((event=brain_ui_events_pop(&pending_events))) {
    process_event(event);xpc_release(event);
    if(!broker->authenticated){discard_pending();break;}
  }
}
static void configure_events(brain_xpc_peer *broker,dispatch_queue_t queue,NSApplication *app) {
  process_event=[^(xpc_object_t event) {
      if (xpc_get_type(event)==XPC_TYPE_ERROR) {
        discard_pending();brain_xpc_close(broker);if(channel_ready)brain_channel_close(&auth_channel);
        dispatch_async(dispatch_get_main_queue(),^{[submission cancel];[app terminate:nil];});return;
      }
      if(xpc_get_type(event)!=XPC_TYPE_DICTIONARY) {brain_xpc_close(broker);dispatch_async(dispatch_get_main_queue(),^{[app terminate:nil];});return;}
      if(!target_selected) {
        if(!selection_pending || !brain_xpc_verify_message(broker,event) || !brain_ui_events_push(&pending_events,event)) {discard_pending();brain_xpc_close(broker);dispatch_async(dispatch_get_main_queue(),^{[app terminate:nil];});return;}
        return;
      }
      if(xpc_dictionary_get_value(event,"fd")) {
        int fd=brain_xpc_receive_fd(broker,event);
        if(channel_ready || fd<0 || !brain_channel_init(&auth_channel,fd,target_session,1,15000)) {brain_xpc_close(broker);dispatch_async(dispatch_get_main_queue(),^{[app terminate:nil];});return;}
        channel_ready=1;return;
      }
      xpc_object_t op=xpc_dictionary_get_value(event,"op"),p=xpc_dictionary_get_value(event,"prompt"),m=xpc_dictionary_get_value(event,"mfa"),ordinal=xpc_dictionary_get_value(event,"ordinal");
      if(!channel_ready || !brain_xpc_verify_message(broker,event) || xpc_dictionary_get_count(event)!=4 || !ordinal || xpc_get_type(ordinal)!=XPC_TYPE_UINT64 || !op || xpc_get_type(op)!=XPC_TYPE_STRING
        || strcmp(xpc_string_get_string_ptr(op),"prompt") || !p || xpc_get_type(p)!=XPC_TYPE_UUID || !m || xpc_get_type(m)!=XPC_TYPE_BOOL) {
        brain_xpc_close(broker);if(channel_ready)brain_channel_close(&auth_channel);dispatch_async(dispatch_get_main_queue(),^{[submission cancel];[app terminate:nil];});return;
      }
      struct { uuid_t prompt; int mfa; unsigned ordinal; } selected_prompt;memcpy(selected_prompt.prompt,xpc_uuid_get_bytes(p),16);selected_prompt.mfa=xpc_bool_get_value(m)?1:0;uint64_t ordinal_value=xpc_uint64_get_value(ordinal);selected_prompt.ordinal=(unsigned)ordinal_value;
      if(ordinal_value>3 || (selected_prompt.mfa && (selected_prompt.ordinal<1 || selected_prompt.ordinal>3)) || (!selected_prompt.mfa && selected_prompt.ordinal!=0)) {brain_xpc_close(broker);brain_channel_close(&auth_channel);dispatch_async(dispatch_get_main_queue(),^{[submission cancel];[app terminate:nil];});return;}
      dispatch_async(dispatch_get_main_queue(),^{
        if(!submission)submission=[[BRAINSubmission alloc] init];
        __block uint64_t generation=0;
        BOOL started=brain_secure_prompt_start(submission,&auth_channel,selected_prompt.prompt,selected_prompt.mfa,selected_prompt.ordinal,300000,
          ^BOOL(uint64_t value,brain_presence_challenge *challenge){generation=value;__block BOOL ok=NO;dispatch_sync(queue,^{ok=brain_submission_challenge(broker,value,challenge,15000);});return ok;},
          ^BOOL(const brain_local_presence *receipt){__block BOOL ok=NO;dispatch_sync(queue,^{ok=brain_submission_assertion(broker,receipt->challenge_digest,15000) && brain_submission_send_ready(broker,selected_prompt.prompt,generation,15000);});return ok;},
          ^(BOOL ok){if(!ok){brain_channel_close(&auth_channel);dispatch_async(queue,^{brain_xpc_close(broker);});[app terminate:nil];}});
        if(!started) {
          brain_channel_close(&auth_channel);dispatch_async(queue,^{brain_xpc_close(broker);});[app terminate:nil];
        }
      });
    } copy];
}

static void request_target(brain_xpc_peer *broker, dispatch_queue_t queue, NSApplication *app, unsigned attempts) {
  if (!broker->authenticated) return;
    xpc_object_t request=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_string(request,"op","select_target");
      xpc_connection_send_message_with_reply(broker->connection,request,queue,^(xpc_object_t target) {
        if (!brain_xpc_verify_message(broker,target) || xpc_get_type(target)!=XPC_TYPE_DICTIONARY) {
          brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return;
        }
        if (xpc_dictionary_get_count(target)==1 && xpc_dictionary_get_bool(target,"pending")) {
          /* [ASSUMPTION] 준비 대기는 250ms 간격으로 최대 15초다. */
          if (attempts>=60) { brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return; }
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),queue,^{ request_target(broker,queue,app,attempts+1); }); return;
        }
        if (xpc_dictionary_get_count(target)!=10) {
          brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return;
        }
        const char *uuid_keys[]={"work","attempt","session","lease"};
        const char *integer_keys[]={"run","binding","package_generation","epoch"};
        for (size_t i=0;i<4;i++) {
          xpc_object_t v=xpc_dictionary_get_value(target,uuid_keys[i]);
          xpc_object_t n=xpc_dictionary_get_value(target,integer_keys[i]);
          if (!v || xpc_get_type(v)!=XPC_TYPE_UUID || !n || xpc_get_type(n)!=XPC_TYPE_UINT64 || !xpc_uint64_get_value(n)) {
            brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return;
          }
        }
        size_t package_size=0; const void *package=xpc_dictionary_get_data(target,"package",&package_size);
        xpc_object_t tokenstore_value=xpc_dictionary_get_value(target,"tokenstore");
        const char *tokenstore=tokenstore_value && xpc_get_type(tokenstore_value)==XPC_TYPE_STRING ? xpc_string_get_string_ptr(tokenstore_value) : NULL;
        NSString *tokenstore_label=tokenstore ? [NSString stringWithUTF8String:tokenstore] : nil;
        if (!package || package_size!=32 || !tokenstore_label || !tokenstore_label.length || strlen(tokenstore)>1024) { brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return; }
        __block struct { uuid_t work,attempt,session,lease; uint8_t package[32]; uint64_t run,binding,package_generation,epoch; } selected;
        memcpy(selected.work,xpc_dictionary_get_uuid(target,"work"),16); memcpy(selected.attempt,xpc_dictionary_get_uuid(target,"attempt"),16);
        memcpy(selected.session,xpc_dictionary_get_uuid(target,"session"),16); memcpy(selected.lease,xpc_dictionary_get_uuid(target,"lease"),16);
        memcpy(selected.package,package,32); selected.run=xpc_dictionary_get_uint64(target,"run"); selected.binding=xpc_dictionary_get_uint64(target,"binding");
        selected.package_generation=xpc_dictionary_get_uint64(target,"package_generation"); selected.epoch=xpc_dictionary_get_uint64(target,"epoch");
        dispatch_async(dispatch_get_main_queue(),^{
          char work_text[37],attempt_text[37],package_text[17]; uuid_unparse_lower(selected.work,work_text);uuid_unparse_lower(selected.attempt,attempt_text);
          static const char hex[]="0123456789abcdef";for(size_t i=0;i<8;i++){package_text[2*i]=hex[selected.package[i]>>4];package_text[2*i+1]=hex[selected.package[i]&15];}package_text[16]=0;
          NSAlert *alert=[[NSAlert alloc] init]; alert.messageText=@"Garmin 인증 대상을 확인하세요";
          alert.informativeText=[NSString stringWithFormat:@"대상: Garmin 계정 인증\n토큰 저장 위치 (아직 확인되지 않음): %@\n설치물 %@, 일감 %s, 시도 %s, 실행 세대 %llu",tokenstore_label,[NSString stringWithUTF8String:package_text],work_text,attempt_text,(unsigned long long)selected.run];
          [alert addButtonWithTitle:@"선택"]; [alert addButtonWithTitle:@"취소"];
          NSModalResponse response=[alert runModal];
          if (response==NSAlertFirstButtonReturn) {
            dispatch_async(queue,^{
              if (!broker->authenticated) return;
              xpc_object_t selection=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_string(selection,"op","selection");
              xpc_dictionary_set_uuid(selection,"work",selected.work); xpc_dictionary_set_uuid(selection,"attempt",selected.attempt);
              xpc_dictionary_set_uuid(selection,"session",selected.session); xpc_dictionary_set_uuid(selection,"lease",selected.lease);
              xpc_dictionary_set_uint64(selection,"run",selected.run); xpc_dictionary_set_uint64(selection,"binding",selected.binding);
              xpc_dictionary_set_uint64(selection,"package_generation",selected.package_generation); xpc_dictionary_set_uint64(selection,"epoch",selected.epoch);
              xpc_dictionary_set_data(selection,"package",selected.package,sizeof selected.package);
              selection_pending=1;
              xpc_connection_send_message_with_reply(broker->connection,selection,queue,^(xpc_object_t reply){
                selection_reply(broker,reply,selected.session,app);
              });xpc_release(selection);
            });
          } else { dispatch_async(queue,^{ brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); }); }
        });
      });
    xpc_release(request);

}

/* UI 선택은 요청일 뿐 신뢰된 사람 존재 증거가 아니다. 비밀 입력은 아직 열지 않는다. */
int main(void) {
  @autoreleasepool {
    if (!BRAIN_UI_UID || geteuid()!=BRAIN_UI_UID || !BRAIN_BROKER_UID || geteuid()==0) return 78;
    NSApplication *app=[NSApplication sharedApplication];
    dispatch_queue_t queue=dispatch_queue_create("org.secondbrain.auth-ui",DISPATCH_QUEUE_SERIAL);
    xpc_connection_t connection=xpc_connection_create_mach_service(BRAIN_AUTH_MACH_SERVICE,queue,0);
    if (!connection) return 78;
    __block brain_xpc_peer broker={0};
    if (!brain_xpc_configure_service(&broker,connection,BRAIN_BROKER_UID,BRAIN_BROKER_HASH)) return 78;
    configure_events(&broker,queue,app);
    xpc_connection_set_event_handler(connection,process_event);
    xpc_connection_activate(connection);
    xpc_object_t hello=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(hello,"hello",true);
    xpc_connection_send_message_with_reply(connection,hello,queue,^(xpc_object_t reply) {
      if (!brain_xpc_authenticate(&broker,reply)) { brain_xpc_close(&broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return; }
        request_target(&broker,queue,app,0);
    });
    xpc_release(hello); [app run]; return 0;
  }
}
