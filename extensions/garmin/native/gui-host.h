#ifndef BRAIN_GUI_HOST_H
#define BRAIN_GUI_HOST_H
#include "presence.h"
typedef struct { brain_presence_scope scope; pid_t pid; int reaped, resumed; } brain_gui_process;
/* 봉인된 GUI 사용자 host에서만 호출한다. 설치 policy는 빌드에 고정된다. */
int brain_gui_start(brain_gui_process *process,uid_t uid,const uint8_t hash[20],uint64_t policy_generation);
int brain_gui_resume(brain_gui_process *process);
/* 1은 종료 확인, 0은 미확인이다. */
int brain_gui_cancel(brain_gui_process *process);
#endif
