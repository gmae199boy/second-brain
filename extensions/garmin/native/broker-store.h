#ifndef BRAIN_BROKER_STORE_H
#define BRAIN_BROKER_STORE_H
#include "session.h"
typedef struct pg_conn PGconn;
typedef struct {PGconn *connection;brain_auth_binding binding;char target[1025];int unusable;} brain_broker_pg_store;
/* 연결과 broker role 자격은 보호된 배치가 제공한다. */
int brain_broker_pg_init(brain_broker_pg_store *store,PGconn *connection,const brain_auth_binding *binding,const char *target);
int brain_broker_pg_guard(void *context);
#endif
