#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>
#import <xpc/xpc.h>
#include "xpc-peer.h"
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#ifdef BRAIN_NATIVE_POLICY_HEADER
#include BRAIN_NATIVE_POLICY_HEADER
#else
#define BRAIN_AUTH_MACH_SERVICE "org.secondbrain.auth.unconfigured"
#define BRAIN_BROKER_UID 0
#define BRAIN_UI_UID 0
static const uint8_t BRAIN_BROKER_HASH[20] = {0};
#endif

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
        if (xpc_dictionary_get_count(target)!=9) {
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
        if (!package || package_size!=32) { brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return; }
        __block struct { uuid_t work,attempt,session,lease; uint8_t package[32]; uint64_t run,binding,package_generation,epoch; } selected;
        memcpy(selected.work,xpc_dictionary_get_uuid(target,"work"),16); memcpy(selected.attempt,xpc_dictionary_get_uuid(target,"attempt"),16);
        memcpy(selected.session,xpc_dictionary_get_uuid(target,"session"),16); memcpy(selected.lease,xpc_dictionary_get_uuid(target,"lease"),16);
        memcpy(selected.package,package,32); selected.run=xpc_dictionary_get_uint64(target,"run"); selected.binding=xpc_dictionary_get_uint64(target,"binding");
        selected.package_generation=xpc_dictionary_get_uint64(target,"package_generation"); selected.epoch=xpc_dictionary_get_uint64(target,"epoch");
        dispatch_async(dispatch_get_main_queue(),^{
          char work_text[37],attempt_text[37],package_text[17]; uuid_unparse_lower(selected.work,work_text);uuid_unparse_lower(selected.attempt,attempt_text);
          static const char hex[]="0123456789abcdef";for(size_t i=0;i<8;i++){package_text[2*i]=hex[selected.package[i]>>4];package_text[2*i+1]=hex[selected.package[i]&15];}package_text[16]=0;
          NSAlert *alert=[[NSAlert alloc] init]; alert.messageText=@"Garmin 인증 대상을 확인하세요";
          alert.informativeText=[NSString stringWithFormat:@"Garmin 보호 설치물 %@, 일감 %s, 시도 %s, 실행 세대 %llu",[NSString stringWithUTF8String:package_text],work_text,attempt_text,(unsigned long long)selected.run];
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
              xpc_connection_send_message(broker->connection,selection); xpc_release(selection);
              /* 승인 세탁·접근성 자동화가 미검증이므로 이 빌드는 비밀 입력을 시작하지 않는다. */
              brain_xpc_close(broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; });
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
    xpc_connection_set_event_handler(connection,^(xpc_object_t event) {
      if (xpc_get_type(event)==XPC_TYPE_ERROR) { brain_xpc_close(&broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); }
    });
    xpc_connection_activate(connection);
    xpc_object_t hello=xpc_dictionary_create(NULL,NULL,0); xpc_dictionary_set_bool(hello,"hello",true);
    xpc_connection_send_message_with_reply(connection,hello,queue,^(xpc_object_t reply) {
      if (!brain_xpc_authenticate(&broker,reply)) { brain_xpc_close(&broker); dispatch_async(dispatch_get_main_queue(),^{ [app terminate:nil]; }); return; }
        request_target(&broker,queue,app,0);
    });
    xpc_release(hello); [app run]; return 0;
  }
}
