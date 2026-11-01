#ifndef BRAIN_SECURE_PROMPT_H
#define BRAIN_SECURE_PROMPT_H
#include "auth-channel.h"
/* 인증된 broker가 사용자 존재를 증명하고 전용 채널을 승인한 뒤 주 스레드에서만 호출한다. */
int brain_secure_prompt(brain_auth_channel *channel, const uint8_t prompt[16], int is_mfa, int timeout_ms);
#endif
