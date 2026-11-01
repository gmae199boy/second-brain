/* host peer 검증은 별도 fixture에서 다룬다. 이 합성 자식은 ACK 전 출력을 하지 않는다. */
#include "../peer.h"
#include <string.h>
#include <unistd.h>
int main(void) {
  if(!brain_write_frame(4,(const uint8_t *)"hello",5,2000))return 1;
  unsigned char ack=0;if(read(3,&ack,1)!=1 || ack!=1)return 2;close(3);
#ifdef BRAIN_FIXTURE_METADATA_CASE
  uint8_t metadata[1235];size_t length=0;
  if(!brain_read_frame(4,metadata,sizeof metadata,&length,2000) || length!=63 || metadata[0]!=1 || memcmp(metadata+47,"UTCfixturegarmin",16))return 6;
#endif
  char marker=0;if(read(5,&marker,1)!=1 || marker!='x')return 4;close(5);
#ifdef BRAIN_FIXTURE_DESCENDANT
  pid_t child=fork();if(child<0)return 5;if(child==0){sleep(5);_exit(0);}
#endif
  if(write(1,"entered",7)!=7)return 3;usleep(300000);return 0;
}
