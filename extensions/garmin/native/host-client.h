#ifndef BRAIN_HOST_CLIENT_H
#define BRAIN_HOST_CLIENT_H
#include "xpc-peer.h"
#include <uuid/uuid.h>

typedef struct brain_host_observer brain_host_observer;
typedef struct {
  brain_xpc_peer service;
  xpc_connection_t connection;
  brain_host_observer *observer;
  uuid_t work,attempt,lease;
  uint64_t run,binding,epoch,start_sec,start_usec;
  pid_t pid;
  int stdout_fd,stderr_fd,started,recorded;
} brain_host_client;
/* 설치 정책을 받는 부품이다. supervisor adapter 전에는 운영에 연결하지 않는다. */
/* 이름, UID, 해시는 보호된 설치 정책에서 제공한다. */
int brain_host_connect(brain_host_client *client,const char *service,uid_t uid,const uint8_t hash[20]);
int brain_host_start(brain_host_client *client,const uuid_t work,const uuid_t attempt,uint64_t run,uint64_t binding,uint64_t epoch,const uint8_t package[32]);
/* 호출자는 성공적인 내구성 기록 후에만 호출한다. */
int brain_host_recorded(brain_host_client *client);
/* 1은 신원·그룹 확인, -1은 불명이다. */
int brain_host_inspect(brain_host_client *client,int *group);
int brain_host_signal(brain_host_client *client,int signal_number);
/* 0은 진행 중, 1은 검증된 종료, -1은 관찰 불명이다. */
int brain_host_observe(brain_host_client *client,int *wait_status);
void brain_host_cancel(brain_host_client *client);
void brain_host_close(brain_host_client *client);
#endif
