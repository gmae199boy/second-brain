#ifndef BRAIN_SEALED_FILES_H
#define BRAIN_SEALED_FILES_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
/* root FD와 목록·digest는 신뢰된 설치 registry가 제공한다. 반환 FD는 호출자가 닫는다. */
int brain_sealed_open_file(int root_fd, const char *const *components, size_t count, uid_t owner, const uint8_t sha256[32]);
#endif
