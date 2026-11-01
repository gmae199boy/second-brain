#include "../supervisor-bootstrap.h"
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
static int step,fail_at,acked,cancelled_host,cancelled_gui,closed_broker;
static int next(void){step++;return step!=fail_at;}
int brain_submission_prepare(brain_xpc_peer *p,int t){(void)p;(void)t;return next()?open("/dev/null",O_RDONLY):-1;}
int brain_host_start_auth(brain_host_client *h,const uuid_t w,const uuid_t a,uint64_t r,uint64_t b,uint64_t e,const uint8_t p[32],int fd){(void)w;(void)a;(void)r;(void)b;(void)e;(void)p;(void)fd;if(!next())return 0;h->pid=20;h->start_sec=2;h->start_usec=3;memset(h->lease,1,16);return 1;}
int brain_submission_register(brain_xpc_peer *p,const brain_auth_binding *b,const char *target,int t){(void)p;(void)b;(void)target;(void)t;return next();}
int brain_submission_recorded(brain_xpc_peer *p,int t){(void)p;(void)t;return next();}
int brain_submission_gui(brain_xpc_peer *p,const brain_presence_scope *s,int t){(void)p;(void)s;(void)t;return next();}
int brain_host_recorded(brain_host_client *h){(void)h;if(!next())return 0;acked++;return 1;}
void brain_host_cancel(brain_host_client *h){(void)h;cancelled_host++;}
void brain_xpc_close(brain_xpc_peer *p){(void)p;closed_broker++;}
static int admit(void *c,const brain_auth_binding *b){(void)c;(void)b;return next();}
static int current(void *c,const brain_auth_binding *b){(void)c;(void)b;return next();}
static int current_identity(void *c,const brain_auth_binding *b,uint64_t s,uint64_t u){(void)c;return b->worker_pid==20 && s==2 && u==3 && next();}
static int record(void *c,const brain_auth_binding *b,uint64_t s,uint64_t u){(void)c;return b->worker_pid==20 && s==2 && u==3 && next();}
static int launch(void *c,brain_presence_scope *s){(void)c;(void)s;return next();}
static int resume(void *c,const brain_presence_scope *s){(void)c;(void)s;return next();}
static void cancel_gui(void *c){(void)c;cancelled_gui++;}
static int cancelled(void *c){(void)c;return 0;}
int main(void){
  brain_supervisor_bootstrap_ops ops={.target="fixture",.admit=admit,.record_identity=record,.admission_current=current,.identity_current=current_identity,.launch_gui_suspended=launch,.resume_gui=resume,.cancel_gui=cancel_gui,.cancelled=cancelled};
  for(fail_at=0;fail_at<=12;fail_at++){
    step=acked=cancelled_host=cancelled_gui=closed_broker=0;brain_host_client host={0};brain_xpc_peer broker={0};brain_auth_binding b={0};
    int result=brain_supervisor_bootstrap(&host,&broker,&b,&ops,1000);
    if(!fail_at){if(!result || step!=12 || acked!=1 || cancelled_host || cancelled_gui || closed_broker)return 1;}
    else {if(result || acked || !closed_broker || (fail_at>4 && !cancelled_host) || (fail_at>=9 && !cancelled_gui))return 2;}
  }
  return 0;
}
