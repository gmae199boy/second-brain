/* host peer 검증은 별도 fixture에서 다룬다. 이 합성 자식은 ACK 전 출력을 하지 않는다. */
#include "../peer.h"
#include <unistd.h>
int main(void) {
  if(!brain_write_frame(4,(const uint8_t *)"hello",5,2000))return 1;
  unsigned char ack=0;if(read(3,&ack,1)!=1 || ack!=1)return 2;close(3);
  if(write(1,"entered",7)!=7)return 3;usleep(300000);return 0;
}
