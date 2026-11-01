#ifndef BRAIN_SEALED_QUEUE_SPAWN_H
#define BRAIN_SEALED_QUEUE_SPAWN_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include "sealed-bundle.h"
/* 신뢰된 registry 전용. 자식은 중지 상태로 반환된다. 호출자는 인증 전 bootstrap만 실행하고 OS peer ACK 전 일반 요청을 차단한다. */
int brain_spawn_sealed_queue(int root_fd, const char *const *components, size_t count, uid_t owner,
  const uint8_t digest[32], const uint8_t code_hash[20], const brain_sealed_file *files, size_t file_count, int peer_fd, int registry_fd, pid_t *pid);
#endif
