#ifndef BRAIN_SUPERVISOR_AUTHORITY_H
#define BRAIN_SUPERVISOR_AUTHORITY_H
#include <stdint.h>
#include <sys/types.h>
typedef struct pg_conn PGconn;
/* root가 고정한 registry·자격과 OS peer 및 DB에 기록된 동일 인스턴스만 허용한다. */
int brain_supervisor_authority(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]);
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_supervisor_authority_fixture(int fd,uid_t uid,pid_t pid,const uint8_t hash[20],int registry_fd,int payload_fd,PGconn *connection,uid_t owner);
#ifdef BRAIN_FIXTURE_SUPERVISOR_AUTHORITY
int brain_supervisor_authority_fixture_fd(int fd,uid_t uid,pid_t pid,const uint8_t hash[20]);
#endif
#endif
#endif
