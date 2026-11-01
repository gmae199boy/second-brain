#include "auth-channel.h"
#include "peer.h"
#include <CommonCrypto/CommonHMAC.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

#define HEADER_SIZE 42
#define MAX_PAYLOAD 4096
#define TAG_SIZE 32
static void wipe(void *p,size_t n) { volatile uint8_t *v=p; while(n--)*v++=0; }
static void finish_locked(brain_auth_channel *c) { if(c->fd>=0) { int fd=c->fd; c->fd=-1; close(fd); wipe(c->key,sizeof c->key); } }
static int pin(brain_auth_channel *c) { if(pthread_mutex_lock(&c->state_lock))return -1; int fd=-1; if(!c->closed){c->active++;fd=c->fd;} pthread_mutex_unlock(&c->state_lock); return fd; }
static void unpin(brain_auth_channel *c) { pthread_mutex_lock(&c->state_lock); c->active--; if(c->closed && !c->active)finish_locked(c); pthread_mutex_unlock(&c->state_lock); }
static int closed(brain_auth_channel *c) { pthread_mutex_lock(&c->state_lock); int result=c->closed; pthread_mutex_unlock(&c->state_lock); return result; }
void brain_channel_close(brain_auth_channel *c) {
  if(!c)return; pthread_mutex_lock(&c->state_lock);
  if(!c->closed){c->closed=1; if(c->fd>=0)shutdown(c->fd,SHUT_RDWR); if(!c->active)finish_locked(c);}
  pthread_mutex_unlock(&c->state_lock);
}
int brain_channel_destroy(brain_auth_channel *c) {
  if(!c)return 0; brain_channel_close(c); pthread_mutex_lock(&c->state_lock);
  if(c->active){pthread_mutex_unlock(&c->state_lock);return 0;}
  pthread_mutex_unlock(&c->state_lock); pthread_mutex_destroy(&c->state_lock); pthread_mutex_destroy(&c->send_lock); pthread_mutex_destroy(&c->receive_lock); return 1;
}
int brain_channel_init(brain_auth_channel *c, int fd, const uint8_t session[16], int ui, int timeout_ms) {
  if(!c || fd<0 || !session || (ui!=0 && ui!=1)) { if(fd>=0)close(fd); return 0; }
  memset(c,0,sizeof *c); c->fd=fd; c->ui=ui; memcpy(c->session,session,16);
  if(pthread_mutex_init(&c->state_lock,NULL)){close(fd);return 0;}
  if(pthread_mutex_init(&c->send_lock,NULL)){pthread_mutex_destroy(&c->state_lock);close(fd);return 0;}
  if(pthread_mutex_init(&c->receive_lock,NULL)){pthread_mutex_destroy(&c->send_lock);pthread_mutex_destroy(&c->state_lock);close(fd);return 0;}
  struct stat info; size_t length=0;
  if(fstat(fd,&info) || !S_ISSOCK(info.st_mode) || fcntl(fd,F_SETFD,FD_CLOEXEC)<0
     || !brain_read_frame(fd,c->key,sizeof c->key,&length,timeout_ms) || length!=sizeof c->key) { brain_channel_close(c); brain_channel_destroy(c); return 0; }
  return 1;
}
static void tag(const uint8_t key[32], const char *direction, const uint8_t *body, size_t length, uint8_t output[32]) {
  CCHmacContext context; CCHmacInit(&context,kCCHmacAlgSHA256,key,32); CCHmacUpdate(&context,direction,strlen(direction)); CCHmacUpdate(&context,body,length); CCHmacFinal(&context,output); wipe(&context,sizeof context);
}
static void put64(uint8_t *p,uint64_t value) { for(int i=7;i>=0;i--){p[i]=(uint8_t)value;value>>=8;} }
static uint64_t get64(const uint8_t *p) { uint64_t value=0; for(int i=0;i<8;i++)value=(value<<8)|p[i]; return value; }
int brain_channel_send(brain_auth_channel *c, uint8_t kind, const uint8_t prompt[16], const uint8_t *payload, size_t length, int timeout_ms) {
  if(!c || pthread_mutex_lock(&c->send_lock))return 0; int fd=pin(c),ok=0; uint8_t frame[HEADER_SIZE+MAX_PAYLOAD+TAG_SIZE];
  if(fd<0 || !prompt || (length && !payload) || length>MAX_PAYLOAD || kind<1 || kind>5 || c->send_sequence>=64) goto done;
  frame[0]=1; put64(frame+1,++c->send_sequence); memcpy(frame+9,c->session,16); memcpy(frame+25,prompt,16); frame[41]=kind;
  if(length)memcpy(frame+HEADER_SIZE,payload,length); tag(c->key,c->ui?"ui":"worker",frame,HEADER_SIZE+length,frame+HEADER_SIZE+length);
  ok=brain_write_frame(fd,frame,HEADER_SIZE+length+TAG_SIZE,timeout_ms) && !closed(c);
done:
  wipe(frame,sizeof frame); if(!ok)brain_channel_close(c); if(fd>=0)unpin(c); pthread_mutex_unlock(&c->send_lock); return ok;
}
int brain_channel_receive(brain_auth_channel *c, const uint8_t prompt[16], uint8_t *kind, uint8_t *payload, size_t capacity, size_t *length, int timeout_ms) {
  if(!c || pthread_mutex_lock(&c->receive_lock))return 0; int fd=pin(c),ok=0; uint8_t frame[HEADER_SIZE+MAX_PAYLOAD+TAG_SIZE],expected[32]; size_t n=0;
  if(fd<0 || !prompt || !kind || !payload || !length || !brain_read_frame(fd,frame,sizeof frame,&n,timeout_ms) || n<HEADER_SIZE+TAG_SIZE) goto done;
  size_t body=n-TAG_SIZE, payload_length=body-HEADER_SIZE; uint64_t sequence=get64(frame+1); uint8_t type=frame[41];
  tag(c->key,c->ui?"worker":"ui",frame,body,expected); volatile uint8_t diff=0; for(size_t i=0;i<TAG_SIZE;i++)diff|=expected[i]^frame[body+i];
  if(diff || frame[0]!=1 || sequence!=c->receive_sequence+1 || sequence>64 || memcmp(frame+9,c->session,16)
    || memcmp(frame+25,prompt,16) || type<1 || type>5 || payload_length>capacity || closed(c)) goto done;
  if(type==3){ for(size_t i=0;i<c->seen_count;i++)if(!memcmp(c->seen[i],prompt,16))goto done; if(c->seen_count>=64)goto done; memcpy(c->seen[c->seen_count++],prompt,16); }
  pthread_mutex_lock(&c->state_lock);
  if(!c->closed) { c->receive_sequence=sequence; *kind=type; *length=payload_length; memcpy(payload,frame+HEADER_SIZE,payload_length); ok=1; }
  pthread_mutex_unlock(&c->state_lock);
done:
  wipe(frame,sizeof frame); wipe(expected,sizeof expected); if(!ok)brain_channel_close(c); if(fd>=0)unpin(c); pthread_mutex_unlock(&c->receive_lock); return ok;
}
