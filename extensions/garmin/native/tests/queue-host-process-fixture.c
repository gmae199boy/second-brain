#include "../queue-host.h"
#include <stdint.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
void brain_registry_fixture_before_spawn(void) {}
int main(void) {
  uint8_t hello=1;if(write(5,&hello,1)!=1)return 2;
  brain_queue_session session;if(!brain_queue_host_open(&session,5,6,7))return 3;
  int ok=brain_queue_session_relay(&session),status=0;
  /* 합성 fixture만 leader를 기다린다. 운영의 그룹 종료 확인을 대체하지 않는다. */
  if(ok){ok=waitpid(session.child,&status,0)==session.child&&WIFEXITED(status)&&WEXITSTATUS(status)==0;session.child=0;}
  if(!ok)fprintf(stderr,"host fixture relay/child failed status=%d\n",status);brain_queue_session_close(&session);return ok?0:4;
}
