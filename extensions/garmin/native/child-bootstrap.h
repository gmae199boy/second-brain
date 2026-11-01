#ifndef BRAIN_CHILD_BOOTSTRAP_H
#define BRAIN_CHILD_BOOTSTRAP_H
#include <stdint.h>
#include <stddef.h>
/* 자식은 라이브러리 import·I/O 전에 호출한다. hash는 봉인된 설치 정책에서 온다. */
int brain_child_bootstrap(const uint8_t host_hash[20], int timeout_ms);
typedef struct { uint8_t work[16],attempt[16]; uint64_t run; char timezone[129],tokenstore[1025],target_id[37]; int account_target; } brain_child_metadata;
int brain_child_decode_metadata(brain_child_metadata *metadata,const uint8_t *frame,size_t length);
/* ACK 뒤에만 호출한다. 고정 Garmin auth ABI이며 DB 자격이나 입력 비밀을 포함하지 않는다. */
int brain_child_read_metadata(brain_child_metadata *metadata,int timeout_ms);
#endif
