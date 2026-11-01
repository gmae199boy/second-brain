#ifndef BRAIN_AUTH_CHANNEL_H
#define BRAIN_AUTH_CHANNEL_H
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  pthread_mutex_t state_lock, send_lock, receive_lock;
  int fd, closed, active, ui;
  uint8_t key[32], session[16], seen[64][16];
  size_t seen_count;
  uint64_t send_sequence, receive_sequence;
} brain_auth_channel;
/* 인증된 전용 socket FD의 소유권을 받는다. 초기 key도 이 FD에서만 읽는다. */
int brain_channel_init(brain_auth_channel *channel, int fd, const uint8_t session[16], int ui, int timeout_ms);
int brain_channel_send(brain_auth_channel *channel, uint8_t kind, const uint8_t prompt[16], const uint8_t *payload, size_t length, int timeout_ms);
int brain_channel_receive(brain_auth_channel *channel, const uint8_t prompt[16], uint8_t *kind, uint8_t *payload, size_t capacity, size_t *length, int timeout_ms);
void brain_channel_close(brain_auth_channel *channel);
/* 모든 send/receive가 반환된 다음에만 호출한다. */
int brain_channel_destroy(brain_auth_channel *channel);
#endif
