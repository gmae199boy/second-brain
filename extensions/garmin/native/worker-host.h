#ifndef BRAIN_WORKER_HOST_H
#define BRAIN_WORKER_HOST_H
#include <stdint.h>
#include <sys/types.h>
#include <stddef.h>

typedef struct { pid_t pid; int bootstrap_write; int stdout_read; int stderr_read; int control_fd; int peer_verified; int identity_recorded; int reaped; int wait_status; int exit_observed; uint64_t start_sec,start_usec; } brain_worker;
typedef struct { pid_t pid; uint64_t start_sec,start_usec; } brain_group_member;
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
/* 종료 관찰은 WNOWAIT로 PID를 고정하며 실제 reap과 별도다. */
int brain_worker_observe_exit(brain_worker *worker,int *status);
/* 종료된 leader는 결과에서 빼되 reap 전 PID를 고정한다. */
int brain_worker_members(brain_worker *worker,brain_group_member *members,size_t capacity,size_t *count);
int brain_worker_signal(brain_worker *worker, int signal_number);
/* 그룹 관찰만 나타낸다. 그룹 밖 후손의 종료 증거는 아니다. */
int brain_worker_group_state(const brain_worker *worker);
void brain_worker_close(brain_worker *worker);
#endif
