#ifndef BRAIN_SEALED_BUNDLE_H
#define BRAIN_SEALED_BUNDLE_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
/* 보호 registry가 고정 경로와 digest를 공급한다. 일반 요청에서 생성하지 않는다. */
typedef struct { const char *path; uint8_t sha256[32]; } brain_sealed_file;
int brain_sealed_verify_bundle(int root_fd,uid_t owner,const brain_sealed_file *files,size_t count);
#endif
