#ifndef BRAIN_DATA_PEER_H
#define BRAIN_DATA_PEER_H
#include <sys/types.h>
#include <stddef.h>
#include <stdint.h>

/* 신원은 보호된 실행 조립이 공급하며 요청 JSON으로 선택할 수 없다. */
typedef struct {
  int fd;
  uid_t uid;
  pid_t pid;
  uint8_t hash[20];
  int authenticated;
} brain_data_peer;
int brain_data_peer_open(brain_data_peer *peer, int fd, uid_t uid, pid_t pid, const uint8_t hash[20]);
int brain_data_peer_read(brain_data_peer *peer, uint8_t *buffer, size_t capacity, size_t *length, int timeout_ms);
int brain_data_peer_write(brain_data_peer *peer, const uint8_t *buffer, size_t length, int timeout_ms);
void brain_data_peer_close(brain_data_peer *peer);
#endif
