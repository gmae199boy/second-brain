#ifndef BRAIN_SECURE_PROMPT_H
#define BRAIN_SECURE_PROMPT_H
#include "auth-channel.h"
#import "presence-gate.h"
#include "xpc-peer.h"
@class BRAINSubmission;
/* 인증된 broker가 사용자 존재를 증명하고 전용 채널을 승인한 뒤 주 스레드에서만 호출한다. */
int brain_secure_prompt(brain_auth_channel *channel, const uint8_t prompt[16], int is_mfa, int timeout_ms);
/* 입력 고정 후에만 challenge를 요청한다. broker block은 인증된 UI 연결을 사용한다. */
int brain_secure_prompt_start(BRAINSubmission *submission, brain_auth_channel *channel, const uint8_t prompt[16], int is_mfa, unsigned ordinal, int timeout_ms,
  BOOL (^challenge_provider)(uint64_t, brain_presence_challenge *), BOOL (^broker)(const brain_local_presence *), void (^completion)(BOOL));
int brain_secure_prompt_broker(BRAINSubmission *submission, brain_auth_channel *channel, brain_xpc_peer *broker, const uint8_t prompt[16], int is_mfa, unsigned ordinal, int timeout_ms, void (^completion)(BOOL));
#endif
