#include "../peer.h"
#include <stdint.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  uint8_t key[32],value[32];size_t n=0;
  if(!brain_read_frame(5,key,sizeof key,&n,2000) || n!=sizeof key || !brain_read_frame(5,value,sizeof value,&n,2000) || n!=sizeof value)return 1;
  int ok=brain_write_frame(5,value,n,2000);volatile uint8_t *p=key;for(size_t i=0;i<sizeof key;i++)p[i]=0;
  p=value;for(size_t i=0;i<sizeof value;i++)p[i]=0;close(5);return ok?0:2;
}
