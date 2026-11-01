#include "broker-store.h"
#include <uuid/uuid.h>
#include <stdio.h>
#include <string.h>
typedef struct pg_result PGresult;
extern int PQstatus(const PGconn *);
extern int PQtransactionStatus(const PGconn *);
extern PGresult *PQexec(PGconn *,const char *);
extern PGresult *PQexecParams(PGconn *,const char *,int,const unsigned int *,const char *const *,const int *,const int *,int);
extern int PQresultStatus(const PGresult *);
extern int PQntuples(const PGresult *);
extern int PQnfields(const PGresult *);
extern char *PQgetvalue(const PGresult *,int,int);
extern void PQclear(PGresult *);
enum { CONNECTION_OK=0, TRANSACTION_IDLE=0, COMMAND_OK=1, TUPLES_OK=2 };
static int command(brain_broker_pg_store *s,const char *query){PGresult *r=PQexec(s->connection,query);int ok=r && PQresultStatus(r)==COMMAND_OK;if(r)PQclear(r);return ok;}
int brain_broker_pg_guard(void *context) {
  brain_broker_pg_store *s=context;if(!s || !s->connection || s->unusable || PQstatus(s->connection)!=CONNECTION_OK || PQtransactionStatus(s->connection)!=TRANSACTION_IDLE)return 0;
  if(!command(s,"begin") || !command(s,"set local statement_timeout='2s'") || !command(s,"set local lock_timeout='2s'")
    || !command(s,"set local transaction_timeout='2s'") || !command(s,"set local idle_in_transaction_session_timeout='2s'")) {
    (void)command(s,"rollback");s->unusable=1;return 0;
  }
  char work[37],token[37],run[32],generation[32];uuid_unparse_lower(s->binding.work,work);uuid_unparse_lower(s->binding.attempt,token);
  snprintf(run,sizeof run,"%llu",(unsigned long long)s->binding.run_generation);snprintf(generation,sizeof generation,"%llu",(unsigned long long)s->binding.binding_generation);
  const char *params[]={work,token,run,s->target,generation};
  PGresult *r=PQexecParams(s->connection,"select (session_user='brain_protected_broker' and garmin.admission_valid($1::uuid,$2::uuid,$3::bigint,$4,$5::bigint))::text",5,NULL,params,NULL,NULL,0);
  int ok=r && PQresultStatus(r)==TUPLES_OK && PQntuples(r)==1 && PQnfields(r)==1 && !strcmp(PQgetvalue(r,0,0),"true");if(r)PQclear(r);
  if(!ok){if(!command(s,"rollback"))s->unusable=1;return 0;}
  if(!command(s,"commit")){s->unusable=1;return 0;}return 1;
}
int brain_broker_pg_init(brain_broker_pg_store *s,PGconn *connection,const brain_auth_binding *binding,const char *target) {
  if(!s)return 0;memset(s,0,sizeof *s);s->unusable=1;
  if(!connection || !binding || !binding->run_generation || !binding->binding_generation || !target || !*target || strlen(target)>=sizeof s->target)return 0;
  s->connection=connection;s->binding=*binding;memcpy(s->target,target,strlen(target)+1);s->unusable=0;
  if(!brain_broker_pg_guard(s)){s->unusable=1;return 0;}return 1;
}
