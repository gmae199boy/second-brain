#include "../ui-events.h"
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>

static xpc_object_t event(const char *kind) {
  xpc_object_t value=xpc_dictionary_create(NULL,NULL,0);
  if(value)xpc_dictionary_set_string(value,"kind",kind);
  return value;
}
int main(void) {
  brain_ui_events queue={0};xpc_object_t fd=event("fd"),prompt=event("prompt"),extra=event("extra");
  if(!fd || !prompt || !extra)return 1;
  /* FD와 prompt가 selection ACK보다 먼저 도착해도 순서를 보존한다. */
  if(!brain_ui_events_push(&queue,fd) || !brain_ui_events_push(&queue,prompt) || brain_ui_events_push(&queue,extra))return 2;
  xpc_object_t a=brain_ui_events_pop(&queue),b=brain_ui_events_pop(&queue);
  if(!a || !b || strcmp(xpc_dictionary_get_string(a,"kind"),"fd") || strcmp(xpc_dictionary_get_string(b,"kind"),"prompt") || brain_ui_events_pop(&queue))return 3;
  xpc_release(a);xpc_release(b);
  /* 취소 또는 오류에는 보류된 FD를 놓고 새 선택으로 넘기지 않는다. */
  int sockets[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,sockets))return 4;
  xpc_object_t descriptor=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_fd(descriptor,"fd",sockets[0]);
  if(!brain_ui_events_push(&queue,descriptor))return 5;xpc_release(descriptor);close(sockets[0]);
  brain_ui_events_clear(&queue);if(brain_ui_events_pop(&queue))return 6;
  char byte;if(read(sockets[1],&byte,1)!=0)return 7;close(sockets[1]);
  /* ACK 이후 이벤트는 이 큐를 거치지 않는다. */
  xpc_release(fd);xpc_release(prompt);xpc_release(extra);return 0;
}
