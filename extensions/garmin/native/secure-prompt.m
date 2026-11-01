#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include "secure-prompt.h"
#import "submission-ui.h"
#include "submission-ipc.h"
#include <string.h>

int brain_secure_prompt_broker(BRAINSubmission *submission,brain_auth_channel *channel,brain_xpc_peer *broker,const uint8_t prompt[16],int is_mfa,unsigned ordinal,int timeout_ms,void (^completion)(BOOL)) {
  if(!broker || !broker->authenticated || !prompt)return 0;
  int control_timeout=timeout_ms<15000?timeout_ms:15000;
  struct {uint8_t bytes[16];} bound_prompt;memcpy(bound_prompt.bytes,prompt,16);__block uint64_t generation=0;
  return brain_secure_prompt_start(submission,channel,prompt,is_mfa,ordinal,timeout_ms,
    ^BOOL(uint64_t value,brain_presence_challenge *challenge){generation=value;return brain_submission_challenge(broker,value,challenge,control_timeout);},
    ^BOOL(const brain_local_presence *receipt){return brain_submission_assertion(broker,receipt->challenge_digest,control_timeout) && brain_submission_send_ready(broker,bound_prompt.bytes,generation,control_timeout);},completion);
}

int brain_secure_prompt_start(BRAINSubmission *submission, brain_auth_channel *channel, const uint8_t prompt[16], int is_mfa, unsigned ordinal, int timeout_ms,
  BOOL (^challenge_provider)(uint64_t, brain_presence_challenge *), BOOL (^broker)(const brain_local_presence *), void (^completion)(BOOL)) {
  if(![NSThread isMainThread] || !submission || !channel || !prompt || (is_mfa!=0 && is_mfa!=1) || (is_mfa ? (ordinal<1 || ordinal>3) : ordinal!=0) || timeout_ms<=0 || timeout_ms>300000 || !challenge_provider || !broker || !completion)return 0;
  if(EnableSecureEventInput()!=noErr)return 0;
  uint8_t secret[4096]={0};NSUInteger used=0;int started=0;
  NSAlert *alert=[[NSAlert alloc] init];alert.messageText=is_mfa?[NSString stringWithFormat:@"Garmin 확인 코드 %u/3을 입력하세요",ordinal]:@"Garmin 계정 비밀번호를 입력하세요";
  NSSecureTextField *field=[[NSSecureTextField alloc] initWithFrame:NSMakeRect(0,0,280,24)];
  alert.accessoryView=field;[alert addButtonWithTitle:@"계속"];[alert addButtonWithTitle:@"취소"];
  __block BOOL expired=NO;dispatch_source_t timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
  if(timer) {
    dispatch_source_set_timer(timer,dispatch_time(DISPATCH_TIME_NOW,(int64_t)timeout_ms*NSEC_PER_MSEC),DISPATCH_TIME_FOREVER,0);
    dispatch_source_set_event_handler(timer,^{expired=YES;[NSApp abortModal];});dispatch_resume(timer);
    NSModalResponse response=[alert runModal];dispatch_source_cancel(timer);dispatch_release(timer);
    if(!expired && response==NSAlertFirstButtonReturn) {
      NSString *value=field.stringValue;NSRange remaining=NSMakeRange(0,0);
      BOOL converted=[value getBytes:secret maxLength:sizeof secret usedLength:&used encoding:NSUTF8StringEncoding options:0 range:NSMakeRange(0,value.length) remainingRange:&remaining];
      field.stringValue=@"";
      if(converted && used && !remaining.length) {
        uint64_t generation=[submission freeze:secret length:used prompt:prompt operation:is_mfa?2:1];
        brain_presence_challenge challenge;
        if(generation && challenge_provider(generation,&challenge)) {
          started=[submission approve:&challenge channel:channel timeout:timeout_ms broker:broker completion:completion];
        }
        if(!started)[submission cancel];
      }
    }
  }
  field.stringValue=@"";[field release];[alert release];DisableSecureEventInput();
  volatile uint8_t *p=secret;for(size_t i=0;i<sizeof secret;i++)p[i]=0;
  if(!started)brain_channel_close(channel);return started;
}

/* AppKit 내부 문자열의 수명과 접근성 차단은 별도 OS 실증이 필요하다. */
int brain_secure_prompt(brain_auth_channel *channel, const uint8_t prompt[16], int is_mfa, int timeout_ms) {
  if (!channel || !prompt || (is_mfa != 0 && is_mfa != 1) || timeout_ms <= 0 || timeout_ms > 300000 || ![NSThread isMainThread]) return 0;
#ifndef BRAIN_NATIVE_FIXTURE
  /* 제출별 생체 callback과 broker 재검증이 연결될 때까지 비밀 입력을 열지 않는다. */
  return 0;
#endif
  if (EnableSecureEventInput() != noErr) return 0;
  uint8_t secret[4096] = {0}; NSUInteger used=0; int ok=0;
  @autoreleasepool {
    NSAlert *alert=[[NSAlert alloc] init];
    alert.messageText=is_mfa ? @"Garmin 확인 코드를 입력하세요" : @"Garmin 비밀번호를 입력하세요";
    NSSecureTextField *field=[[NSSecureTextField alloc] initWithFrame:NSMakeRect(0,0,280,24)];
    alert.accessoryView=field; [alert addButtonWithTitle:@"계속"]; [alert addButtonWithTitle:@"취소"];
    __block BOOL expired=NO;
    dispatch_source_t timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
    if (!timer) { [field release]; [alert release]; DisableSecureEventInput(); brain_channel_close(channel); return 0; }
    dispatch_source_set_timer(timer,dispatch_time(DISPATCH_TIME_NOW,(int64_t)timeout_ms*NSEC_PER_MSEC),DISPATCH_TIME_FOREVER,0);
    dispatch_source_set_event_handler(timer,^{ expired=YES; [NSApp abortModal]; });
    dispatch_resume(timer);
    NSModalResponse response=[alert runModal];
    dispatch_source_cancel(timer); dispatch_release(timer);
    if (!expired && response==NSAlertFirstButtonReturn) {
      NSString *value=field.stringValue;
      NSRange remaining=NSMakeRange(0,0);
      BOOL converted=[value getBytes:secret maxLength:sizeof secret usedLength:&used encoding:NSUTF8StringEncoding options:0 range:NSMakeRange(0,value.length) remainingRange:&remaining];
      field.stringValue=@"";
      if (converted && used && remaining.length==0) ok=brain_channel_send(channel,3,prompt,secret,used,timeout_ms);
    } else field.stringValue=@"";
    [field release]; [alert release];
  }
  volatile uint8_t *p=secret; for (size_t i=0;i<sizeof secret;i++) p[i]=0;
  DisableSecureEventInput();
  if (!ok) brain_channel_close(channel);
  return ok;
}
