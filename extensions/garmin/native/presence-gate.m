#import <AppKit/AppKit.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <SystemConfiguration/SystemConfiguration.h>
#include "presence-gate.h"
#include <time.h>
#include <CommonCrypto/CommonDigest.h>
#include <string.h>
#include <unistd.h>

@interface BRAINPresenceGate () {
  LAContext *_context;
  void (^_completion)(const brain_local_presence *);
  uint8_t _digest[32];
  uint64_t _generation;
  int64_t _deadline;
  BOOL _pending;
}
- (void)interrupted:(NSNotification *)notification;
- (void)finish:(BOOL)approved generation:(uint64_t)generation;
@end

static int64_t now_ms(void) { struct timespec t;return clock_gettime(CLOCK_MONOTONIC,&t)?-1:(int64_t)t.tv_sec*1000+t.tv_nsec/1000000; }
static BOOL current_console_user(void) {
  uid_t uid=0;gid_t gid=0;CFStringRef name=SCDynamicStoreCopyConsoleUser(NULL,&uid,&gid);
  BOOL ok=name && uid!=0 && uid==getuid() && uid==geteuid();if(name)CFRelease(name);return ok;
}
@implementation BRAINPresenceGate
- (BOOL)begin:(const brain_presence_challenge *)challenge operation:(uint8_t)operation completion:(void (^)(const brain_local_presence *))completion {
  if(![NSThread isMainThread] || _pending || !challenge || challenge->consumed || !completion || (operation!=1 && operation!=2) || !current_console_user())return NO;
  if(challenge->length<25 || challenge->length>sizeof challenge->message || challenge->message[challenge->length-25]!=operation)return NO;
  uint64_t encoded_deadline=0;for(size_t i=challenge->length-8;i<challenge->length;i++)encoded_deadline=(encoded_deadline<<8)|challenge->message[i];
  int64_t now=now_ms();if(now<0 || challenge->deadline_ms<=now || challenge->deadline_ms-now>300000 || encoded_deadline!=(uint64_t)challenge->deadline_ms)return NO;
  LAContext *context=[[LAContext alloc] init];context.touchIDAuthenticationAllowableReuseDuration=0;context.localizedFallbackTitle=@"";
  NSError *error=nil;
  if(![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error]){[context invalidate];[context release];return NO;}
  _context=context;_completion=[completion copy];_deadline=challenge->deadline_ms;_pending=YES;CC_SHA256(challenge->message,(CC_LONG)challenge->length,_digest);uint64_t generation=++_generation;
  NSNotificationCenter *workspace=[[NSWorkspace sharedWorkspace] notificationCenter];
  [workspace addObserver:self selector:@selector(interrupted:) name:NSWorkspaceWillSleepNotification object:nil];
  [workspace addObserver:self selector:@selector(interrupted:) name:NSWorkspaceSessionDidResignActiveNotification object:nil];
  [[NSDistributedNotificationCenter defaultCenter] addObserver:self selector:@selector(interrupted:) name:@"com.apple.screenIsLocked" object:nil];
  int64_t delay=challenge->deadline_ms-now;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,delay*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self finish:NO generation:generation];});
  NSString *reason=operation==1?@"선택한 Garmin 비밀번호 제출을 승인합니다":@"선택한 Garmin 확인 코드 제출을 승인합니다";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics localizedReason:reason reply:^(BOOL success,NSError *failure){
    dispatch_async(dispatch_get_main_queue(),^{ [self finish:success && failure==nil generation:generation]; });
  }];
  return YES;
}
- (void)interrupted:(NSNotification *)notification { (void)notification;if([NSThread isMainThread])[self cancel];else dispatch_async(dispatch_get_main_queue(),^{[self cancel];}); }
- (void)cancel { if([NSThread isMainThread])[self finish:NO generation:_generation]; }
- (void)finish:(BOOL)approved generation:(uint64_t)generation {
  if(!_pending || generation!=_generation)return;
  int64_t now=now_ms();approved=approved && now>=0 && now<_deadline && current_console_user();
  brain_local_presence receipt={.generation=generation};memcpy(receipt.challenge_digest,_digest,sizeof _digest);memset(_digest,0,sizeof _digest);
  _pending=NO;_generation++;
  [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:self];[[NSDistributedNotificationCenter defaultCenter] removeObserver:self];
  [_context invalidate];[_context release];_context=nil;
  void (^completion)(const brain_local_presence *)=[_completion autorelease];_completion=nil;if(completion)completion(approved?&receipt:NULL);
  memset(&receipt,0,sizeof receipt);
}
- (void)dealloc { [self cancel];[super dealloc]; }
@end
