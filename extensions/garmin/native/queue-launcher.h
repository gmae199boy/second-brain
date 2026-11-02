#ifndef BRAIN_QUEUE_LAUNCHER_H
#define BRAIN_QUEUE_LAUNCHER_H
#include "data-peer.h"
#include <sys/types.h>
/* service 신원과 열린 registry FD는 보호된 조립만 제공한다. 일반 요청으로 공급하지 않는다. */
typedef struct { brain_data_peer node, service; pid_t child; int bootstrap_fd; int supervisor_config_fd; int supervisor_config_open; int relayed; int cleanup_unknown; int supervisor_bound; int supervisor_fd; uid_t supervisor_uid; pid_t supervisor_pid; uint8_t supervisor_hash[20]; } brain_queue_session;
int brain_queue_session_open(brain_queue_session *,int registry_fd,int payload_fd,int service_fd,uid_t service_uid,pid_t service_pid,const uint8_t service_hash[20]);
int brain_queue_session_relay(brain_queue_session *);
/* 1은 그룹 종료 확인, 0은 불명이며 복구 전 새 세션을 허용하지 않는다. */
int brain_queue_session_close(brain_queue_session *);
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_queue_session_open_fixture(brain_queue_session *,int,int,int,uid_t,pid_t,const uint8_t[20],uid_t);
#endif
#endif
