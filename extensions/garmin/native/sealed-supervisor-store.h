#ifndef BRAIN_SEALED_SUPERVISOR_STORE_H
#define BRAIN_SEALED_SUPERVISOR_STORE_H
#include "sealed-supervisor-launch.h"
typedef struct pg_conn PGconn;
typedef struct {PGconn *connection;char token[37];int recorded,confirmed,unusable;} brain_sealed_supervisor_pg_store;
/* 연결은 보호 principal이 소유한다. 현재 호출은 외부 입력의 URL을 받지 않는다. */
int brain_sealed_supervisor_pg_init(brain_sealed_supervisor_pg_store *,PGconn *);
brain_sealed_supervisor_store brain_sealed_supervisor_pg_ops(brain_sealed_supervisor_pg_store *);
int brain_sealed_supervisor_pg_current(brain_sealed_supervisor_pg_store *,pid_t,uid_t,uint64_t,uint64_t,const uint8_t[32],const uint8_t[20]);
/* 반드시 동일 session의 그룹 종료 확인 뒤에만 confirmed=1을 전달한다. */
int brain_sealed_supervisor_pg_release(brain_sealed_supervisor_pg_store *,int confirmed);
#endif
