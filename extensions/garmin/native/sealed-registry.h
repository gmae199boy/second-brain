#ifndef BRAIN_SEALED_REGISTRY_H
#define BRAIN_SEALED_REGISTRY_H
#include "sealed-bundle.h"
#include <stdint.h>
#include <sys/types.h>

/* registry와 payload는 서로 다른, 이미 고정된 디렉터리 FD다. 운영 소유자는 항상 root다. */
int brain_verify_queue_registry(int registry_dir, int payload_dir);
int brain_sealed_trusted_dir(int fd,uid_t final_owner);
int brain_queue_registry_node_hash(int registry_dir, int payload_dir, uint8_t hash[20]);
/* 합성 시험 전용; 운영 진입점은 소유자를 호출자에게서 받지 않는다. */
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_verify_queue_registry_fixture(int registry_dir, int payload_dir, uid_t owner);
int brain_queue_registry_node_hash_fixture(int registry_dir,int payload_dir,uid_t owner,uint8_t hash[20]);
int brain_spawn_queue_registry_fixture(int registry_dir, int payload_dir, uid_t owner, int peer_fd, int registry_fd, pid_t *pid);
#endif
int brain_supervisor_registry_identity(int reg,int payload,uint8_t node_hash[20],uint8_t package_hash[32]);
int brain_spawn_supervisor_registry(int reg,int payload,int peer,int bootstrap,int config,pid_t *pid);
#ifdef BRAIN_REGISTRY_FIXTURE
int brain_supervisor_registry_identity_fixture(int reg,int payload,uid_t owner,uint8_t node_hash[20],uint8_t package_hash[32]);
int brain_spawn_supervisor_registry_fixture(int reg,int payload,uid_t owner,int peer,int bootstrap,int config,pid_t *pid);
#endif
/* 운영에서는 root registry만 허용한다. 반환 child는 중지 상태다. */
int brain_spawn_queue_registry(int registry_dir, int payload_dir, int peer_fd, int registry_fd, pid_t *pid);
#endif
