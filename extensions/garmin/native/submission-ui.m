#import "submission-ui.h"
#include <string.h>

@interface BRAINSubmission () {
  BRAINPresenceGate *_gate;
  uint8_t _secret[4096], _prompt[16];
  size_t _length;
  uint8_t _operation;
  uint64_t _generation;
  BOOL _pending, _exhausted;
}
@end
@implementation BRAINSubmission
- (id)init { if((self=[super init]))_gate=[[BRAINPresenceGate alloc] init];return self; }
- (uint64_t)freeze:(const uint8_t *)secret length:(size_t)length prompt:(const uint8_t *)prompt operation:(uint8_t)operation {
  if(![NSThread isMainThread])return 0;
  [self cancel];
  if(_exhausted || !secret || !length || length>sizeof _secret || !prompt || (operation!=1 && operation!=2))return 0;
  unsigned nonzero=0;for(size_t i=0;i<16;i++)nonzero|=prompt[i];if(!nonzero)return 0;
  memcpy(_secret,secret,length);memcpy(_prompt,prompt,16);_length=length;_operation=operation;
  if(++_generation==0){_exhausted=YES;[self cancel];return 0;}return _generation;
}
- (BOOL)approve:(const brain_presence_challenge *)challenge channel:(brain_auth_channel *)channel timeout:(int)timeout
         broker:(BOOL (^)(const brain_local_presence *))broker completion:(void (^)(BOOL))completion {
  if(![NSThread isMainThread])return NO;
  if(_pending || !_length || !challenge || !channel || !broker || !completion || timeout<=0 || timeout>300000){[self cancel];if(channel)brain_channel_close(channel);return NO;}
  /* challenge 꼬리에는 response generation, operation, prompt, deadline이 고정 순서로 있다. */
  if(challenge->length<73 || challenge->length>sizeof challenge->message){[self cancel];brain_channel_close(channel);return NO;}
  size_t n=challenge->length;uint64_t response=0;for(size_t i=n-33;i<n-25;i++)response=(response<<8)|challenge->message[i];
  if(response!=_generation || challenge->message[n-25]!=_operation || memcmp(challenge->message+n-24,_prompt,16)){[self cancel];brain_channel_close(channel);return NO;}
  _pending=YES;uint64_t generation=_generation;
  BOOL started=[_gate begin:challenge operation:_operation completion:^(const brain_local_presence *receipt) {
    if(!_pending || _generation!=generation)return;
    BOOL ok=NO;
    if(_pending && _generation==generation && receipt && broker(receipt) && _pending && _generation==generation)
      ok=brain_channel_send(channel,3,_prompt,_secret,_length,timeout);
    [self cancel];completion(ok);
  }];
  if(!started){_pending=NO;[self cancel];brain_channel_close(channel);}return started;
}
- (void)cancel {
  if(![NSThread isMainThread])return;
  _pending=NO;[_gate cancel];volatile uint8_t *p=_secret;for(size_t i=0;i<sizeof _secret;i++)p[i]=0;
  memset(_prompt,0,sizeof _prompt);_length=0;_operation=0;
}
- (void)dealloc { [self cancel];[_gate release];[super dealloc]; }
@end
