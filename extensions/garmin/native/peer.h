#ifndef BRAIN_NATIVE_PEER_H
#define BRAIN_NATIVE_PEER_H
#include <sys/types.h>
#include <stddef.h>
#include <stdint.h>

/* hash와 PID는 보호된 spawn/설치 경계에서 공급한다. 사용자 메시지는 증거가 아니다. */
int brain_verify_peer(int fd, uid_t uid, pid_t pid, const uint8_t hash[20]);
int brain_read_frame(int fd, uint8_t *buffer, size_t capacity, size_t *length, int timeout_ms);
int brain_write_frame(int fd, const uint8_t *buffer, size_t length, int timeout_ms);
typedef struct { int fd; int authenticated; int sent; int received; } brain_peer_session;
int brain_peer_open(brain_peer_session *session, int fd, uid_t uid, pid_t pid, const uint8_t hash[20]);
int brain_peer_send_fd(brain_peer_session *session, int secret_fd, int timeout_ms);
int brain_peer_receive_fd(brain_peer_session *session, int timeout_ms);
void brain_peer_close(brain_peer_session *session);
#endif
