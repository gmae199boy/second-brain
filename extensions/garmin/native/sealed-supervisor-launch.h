#ifndef BRAIN_SEALED_SUPERVISOR_LAUNCH_H
#define BRAIN_SEALED_SUPERVISOR_LAUNCH_H
#include "queue-launcher.h"
#include <stdint.h>
#include <sys/types.h>
/* 저장 callback은 2초 내 durable commit을 확인하며 응답 불명은 false다. */
typedef struct {
  void *context;
  int (*record)(void *context,pid_t pid,uid_t uid,uint64_t boot_seconds,uint64_t start_microseconds,const uint8_t package_hash[32],const uint8_t node_hash[20]);
  int (*confirm)(void *context,pid_t pid,uid_t uid,uint64_t boot_seconds,uint64_t start_microseconds,const uint8_t package_hash[32],const uint8_t node_hash[20]);
} brain_sealed_supervisor_store;
/* false는 정상 종료 증거가 아니며 세션의 cleanup_unknown을 보존해야 한다. */
int brain_sealed_supervisor_start(brain_queue_session *,int registry_fd,int payload_fd,const brain_sealed_supervisor_store *);
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_sealed_supervisor_start_fixture(brain_queue_session *,int,int,const brain_sealed_supervisor_store *,uid_t);
#endif
#endif
