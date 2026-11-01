#ifndef BRAIN_GUI_CLIENT_H
#define BRAIN_GUI_CLIENT_H
#include "submission-ipc.h"
typedef struct { brain_xpc_peer *peer;brain_presence_scope scope;int timeout_ms,started,resumed,unknown; } brain_gui_client;
/* peer는 OS 코드 신원과 연결 인스턴스를 인증한 supervisor 소유 연결이다. */
int brain_gui_client_start(brain_gui_client *client,brain_presence_scope *scope);
int brain_gui_client_resume(brain_gui_client *client,const brain_presence_scope *scope);
int brain_gui_client_cancel(brain_gui_client *client);
#endif
