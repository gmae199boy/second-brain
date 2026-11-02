#ifndef BRAIN_QUEUE_HOST_H
#define BRAIN_QUEUE_HOST_H
#include "queue-launcher.h"
/* control은 고정 supervisor peer만, 두 디렉터리 FD는 root 봉인 경로만 허용한다. */
int brain_queue_host_open(brain_queue_session *session,int control,int registry_fd,int payload_fd);
#endif
