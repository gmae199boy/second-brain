#ifndef BRAIN_CHILD_BOOTSTRAP_H
#define BRAIN_CHILD_BOOTSTRAP_H
#include <stdint.h>
/* 자식은 라이브러리 import·I/O 전에 호출한다. hash는 봉인된 설치 정책에서 온다. */
int brain_child_bootstrap(const uint8_t host_hash[20], int timeout_ms);
#endif
