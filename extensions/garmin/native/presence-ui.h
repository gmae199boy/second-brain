#ifndef BRAIN_PRESENCE_UI_H
#define BRAIN_PRESENCE_UI_H
#include <CoreFoundation/CoreFoundation.h>
#include <stddef.h>
#include <stdint.h>
/* 키는 별도로 보호된 고정 태그로 사전 구성해야 한다. 운영 호출은 아직 연결하지 않는다. */
CFDataRef brain_presence_sign(const uint8_t *message, size_t length);
#endif
