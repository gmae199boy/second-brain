#ifndef BRAIN_SUPERVISOR_STORE_H
#define BRAIN_SUPERVISOR_STORE_H
#include "supervisor-native.h"
/* PGconn은 보호된 배치가 연결·인증하고 이 객체에 단독 소유권을 제공한다. */
typedef struct pg_conn PGconn;
typedef struct {
  PGconn *connection;
  brain_auth_binding binding;
  char target[1025],zone[129];
  int admitted,unusable;
} brain_supervisor_pg_store;
/* 현재 commit된 holder에서 검증된 대상과 binding 세대를 읽는다. */
int brain_supervisor_pg_admission_context(PGconn *connection,const brain_auth_binding *binding,char target[1025],uint64_t *generation);
int brain_supervisor_pg_init(brain_supervisor_pg_store *store,PGconn *connection,const brain_auth_binding *binding,const char *target,const char *zone);
brain_supervisor_store_ops brain_supervisor_pg_ops(brain_supervisor_pg_store *store);
typedef enum { BRAIN_PROTECTED_CANCEL=1, BRAIN_PROTECTED_HOLD=2, BRAIN_PROTECTED_DISABLE=3 } brain_protected_action;
/* broker ACK를 받은 뒤 같은 DB transaction에서 폐기 증거와 고정 mutation을 기록한다. */
int brain_supervisor_pg_revoke_action(brain_supervisor_pg_store *store,brain_xpc_peer *broker,const brain_auth_binding *binding,brain_protected_action action,int timeout_ms);
#endif
