#import <Foundation/Foundation.h>
#include "presence.h"
typedef struct { uint8_t challenge_digest[32]; uint64_t generation; } brain_local_presence;
/* UI 내부 callback에서만 유효하다. 이 값은 broker가 독립 검증할 OS 증명이 아니다. */
@interface BRAINPresenceGate : NSObject
- (BOOL)begin:(const brain_presence_challenge *)challenge operation:(uint8_t)operation completion:(void (^)(const brain_local_presence *))completion;
- (void)cancel;
@end
