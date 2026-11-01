#ifndef BRAIN_WORKER_HOST_H
#define BRAIN_WORKER_HOST_H
#include <stdint.h>
#include <sys/types.h>

typedef struct { pid_t pid; int bootstrap_write; int stdout_read; int stderr_read; int control_fd; int peer_verified; int identity_recorded; int reaped; int wait_status; } brain_worker;
/* policy는 보호 서비스의 봉인 코드에서만 온다. IPC 요청의 path/hash/uid를 전달하지 않는다. */
int brain_spawn_worker(const uint8_t hash[20], uid_t worker_uid, brain_worker *out);
/* 호출자는 broker가 공급한 socket의 신원·소유권을 먼저 검증한다. 자식에는 FD 5로 상속한다. */
int brain_spawn_worker_with_channel(const uint8_t hash[20], uid_t worker_uid, int channel_fd, brain_worker *out);
/* 저장 완료 표시는 인증된 supervisor 연결에서만 호출한다. */
int brain_worker_verify_peer(brain_worker *worker, uid_t worker_uid, const uint8_t hash[20], int timeout_ms);
int brain_worker_recorded(brain_worker *worker, pid_t actual_pid);
int brain_worker_ack(brain_worker *worker);
/* 1=확인된 종료, 0=실행 중, -1=불명. 그룹 전체 종료 증거는 별도다. */
int brain_worker_reap(brain_worker *worker, int *status);
int brain_worker_signal(brain_worker *worker, int signal_number);
/* 그룹 관찰만 나타낸다. 그룹 밖 후손의 종료 증거는 아니다. */
int brain_worker_group_state(const brain_worker *worker);
void brain_worker_close(brain_worker *worker);
#endif
