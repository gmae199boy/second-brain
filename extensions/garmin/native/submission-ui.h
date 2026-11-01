#import <Foundation/Foundation.h>
#include "presence-gate.h"
#include "auth-channel.h"

/* 승인된 UI 프로세스 안에서만 사용한다. broker 함수는 인증된 제어 연결을 소유한다. */
@interface BRAINSubmission : NSObject
- (uint64_t)freeze:(const uint8_t *)secret length:(size_t)length prompt:(const uint8_t *)prompt operation:(uint8_t)operation;
- (BOOL)approve:(const brain_presence_challenge *)challenge channel:(brain_auth_channel *)channel timeout:(int)timeout
         broker:(BOOL (^)(const brain_local_presence *))broker completion:(void (^)(BOOL))completion;
- (void)cancel;
@end
