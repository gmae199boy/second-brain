#ifndef BRAIN_SEALED_SIGNATURE_H
#define BRAIN_SEALED_SIGNATURE_H
#include <stdint.h>
/* 열린 고정 파일과 신뢰된 registry의 cdhash를 확인한다. */
int brain_sealed_signature(int fd,const uint8_t hash[20]);
#endif
