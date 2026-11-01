#include "presence.h"
#include <sys/random.h>
#include <string.h>
#include <time.h>

static int64_t now_ms(void) { struct timespec t; return clock_gettime(CLOCK_MONOTONIC,&t) ? -1 : (int64_t)t.tv_sec*1000+t.tv_nsec/1000000; }
static void append(uint8_t **out, const void *data, size_t n) { memcpy(*out,data,n); *out+=n; }
static void number(uint8_t **out, uint64_t value) { uint8_t bytes[8]; for (int i=7;i>=0;i--) { bytes[i]=(uint8_t)value; value>>=8; } append(out,bytes,sizeof bytes); }
int brain_presence_issue(brain_presence_challenge *c, const brain_auth_binding *b, const brain_presence_scope *scope, uint8_t operation, const uint8_t prompt[16], int ttl_ms) {
  if (!c) return 0;
  memset(c,0,sizeof *c); c->consumed=1;
  if (!b || !scope || !scope->gui_pid || !scope->gui_asid || !scope->gui_start_sec || !scope->policy_generation || !scope->response_generation || !prompt || (operation!=1 && operation!=2) || ttl_ms<=0 || ttl_ms>300000) return 0;
  unsigned gui=0,instance=0,boot=0;for(size_t i=0;i<16;i++){gui|=scope->gui_session[i];instance|=scope->gui_instance[i];boot|=scope->gui_boot[i];}if(!gui || !instance || !boot)return 0;
  unsigned nonzero=0;for(size_t i=0;i<16;i++)nonzero|=prompt[i];if(!nonzero)return 0;
  brain_auth_session validation; if(!brain_auth_init(&validation,b,ttl_ms))return 0;
  int64_t now=now_ms(); if(now<0)return 0;
  uint8_t nonce[32]; if(getentropy(nonce,sizeof nonce))return 0;
  uint8_t *out=c->message; const char domain[]="second-brain-presence-v1";
  _Static_assert(sizeof c->message >= sizeof domain-1+32+4*16+32+7*8+2*20+3*16+6*8+1+16+8, "challenge 크기 부족");
  append(&out,domain,sizeof domain-1); append(&out,nonce,sizeof nonce);
  append(&out,b->session,16); append(&out,b->work,16); append(&out,b->attempt,16); append(&out,b->launch_lease,16); append(&out,b->package,32);
  number(&out,b->run_generation); number(&out,b->binding_generation); number(&out,b->package_generation); number(&out,b->connection_epoch);
  number(&out,b->worker_uid); number(&out,b->ui_uid); number(&out,(uint64_t)b->worker_pid);
  append(&out,b->worker_hash,20); append(&out,b->ui_hash,20); append(&out,scope->gui_boot,16);number(&out,scope->gui_pid);number(&out,scope->gui_asid);number(&out,scope->gui_start_sec);number(&out,scope->gui_start_usec);
  append(&out,scope->gui_session,16); append(&out,scope->gui_instance,16);
  number(&out,scope->policy_generation); number(&out,scope->response_generation);
  append(&out,&operation,1); append(&out,prompt,16); number(&out,(uint64_t)(now+ttl_ms));
  c->length=(size_t)(out-c->message); c->deadline_ms=now+ttl_ms; c->consumed=0; memset(nonce,0,sizeof nonce); return 1;
}
int brain_presence_verify(brain_presence_challenge *c, SecKeyRef key, const uint8_t *signature, size_t length) {
  if(!c || c->consumed)return 0; c->consumed=1;
  int64_t now=now_ms(); if(!key || !signature || !length || length>256 || now<0 || now>=c->deadline_ms)return 0;
  CFDataRef message=CFDataCreate(NULL,c->message,(CFIndex)c->length), sig=CFDataCreate(NULL,signature,(CFIndex)length);
  int ok=message && sig && SecKeyVerifySignature(key,kSecKeyAlgorithmECDSASignatureMessageX962SHA256,message,sig,NULL);
  if(message)CFRelease(message); if(sig)CFRelease(sig); return ok;
}
