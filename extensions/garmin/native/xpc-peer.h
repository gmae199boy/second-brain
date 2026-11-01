#ifndef BRAIN_XPC_PEER_H
#define BRAIN_XPC_PEER_H
#include <stdint.h>
#include <sys/types.h>
#include <xpc/xpc.h>

typedef struct { xpc_connection_t connection; uid_t uid; pid_t pid; uint8_t hash[20]; int configured; int authenticated; int sent; int received; } brain_xpc_peer;
/* 활성화 전에 호출한다. hash·uid·pid는 보호된 spawn/설치 경계가 공급한다. */
int brain_xpc_configure(brain_xpc_peer *peer, xpc_connection_t connection, uid_t uid, pid_t pid, const uint8_t hash[20]);
/* launchd 서비스는 최초 실제 수신 메시지 검증 후 OS PID를 고정한다. */
int brain_xpc_configure_service(brain_xpc_peer *peer, xpc_connection_t connection, uid_t uid, const uint8_t hash[20]);
int brain_xpc_authenticate(brain_xpc_peer *peer, xpc_object_t message);
int brain_xpc_verify_message(brain_xpc_peer *peer, xpc_object_t message);
int brain_xpc_send_fd(brain_xpc_peer *peer, int fd);
int brain_xpc_receive_fd(brain_xpc_peer *peer, xpc_object_t message);
void brain_xpc_close(brain_xpc_peer *peer);
#endif
