#ifndef BRAIN_PRESENCE_H
#define BRAIN_PRESENCE_H
#include <Security/Security.h>
#include "session.h"
typedef struct { uint8_t message[288]; size_t length; int64_t deadline_ms; int consumed; } brain_presence_challenge;
/* 서명 검증만 한다. 공개키의 보호·생체 인증 정책을 증명하지 않는다. */
int brain_presence_issue(brain_presence_challenge *challenge, const brain_auth_binding *binding, uint8_t operation, const uint8_t prompt[16], int ttl_ms);
int brain_presence_verify(brain_presence_challenge *challenge, SecKeyRef pinned_key, const uint8_t *signature, size_t length);
#endif
