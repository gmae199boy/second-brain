#ifndef BRAIN_QUEUE_POLICY_H
#define BRAIN_QUEUE_POLICY_H
#include <stdint.h>
#include <sys/types.h>
/* pin 디렉터리는 root 소유로 고정되어야 한다. */
int brain_queue_client_policy(int fd,uid_t *uid,uint8_t hash[20]);
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_queue_client_policy_fixture(int fd,uid_t owner,uid_t *uid,uint8_t hash[20]);
#endif
#endif
