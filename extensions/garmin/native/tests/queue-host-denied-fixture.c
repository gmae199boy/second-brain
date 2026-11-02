#include "../queue-host.h"
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
/* 신원이 빌드에 고정되지 않은 운영 기본값은 제어 입력을 읽지 않고 닫힌다. */
int main(void) {
  int input[2];if(pipe(input))return 1;brain_queue_session session;
  if(brain_queue_host_open(&session,input[0],-1,-1))return 2;
  errno=0;if(fcntl(input[0],F_GETFD)!=-1||errno!=EBADF)return 3;
  close(input[1]);return 0;
}
