#ifndef BRAIN_BROKER_CREDENTIAL_H
#define BRAIN_BROKER_CREDENTIAL_H
#include "broker-store.h"
/* 고정 설치 policy의 broker 소유 자격 파일만 읽는다. 반환 연결은 호출자가 닫는다. */
PGconn *brain_broker_connect_protected(const char *path);
/* supervisor도 독립된 고정 자격 파일과 별도 DB 역할을 사용한다. */
PGconn *brain_supervisor_connect_protected(const char *path);
#endif
