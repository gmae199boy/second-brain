#ifndef BRAIN_UI_EVENTS_H
#define BRAIN_UI_EVENTS_H
#include <stddef.h>
#include <xpc/xpc.h>

typedef struct { xpc_object_t events[2]; size_t count; } brain_ui_events;
/* 선택 응답과 XPC 이벤트는 서로 다른 전달 경로이므로 두 이벤트만 대기한다. */
static inline int brain_ui_events_push(brain_ui_events *q,xpc_object_t event) {
  if(!q || !event || q->count>=2)return 0;
  q->events[q->count++]=xpc_retain(event);return 1;
}
static inline xpc_object_t brain_ui_events_pop(brain_ui_events *q) {
  if(!q || !q->count)return NULL;
  xpc_object_t event=q->events[0];q->events[0]=q->events[1];q->events[1]=NULL;q->count--;return event;
}
static inline void brain_ui_events_clear(brain_ui_events *q) {
  xpc_object_t event;while((event=brain_ui_events_pop(q)))xpc_release(event);
}
#endif
