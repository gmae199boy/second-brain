#include "../presence.h"
#include <CoreFoundation/CoreFoundation.h>
#include <string.h>
int main(void) {
  int bits=256; CFNumberRef size=CFNumberCreate(NULL,kCFNumberIntType,&bits);
  const void *keys[]={kSecAttrKeyType,kSecAttrKeySizeInBits}; const void *values[]={kSecAttrKeyTypeECSECPrimeRandom,size};
  CFDictionaryRef attrs=CFDictionaryCreate(NULL,keys,values,2,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  SecKeyRef private=SecKeyCreateRandomKey(attrs,NULL), public=private ? SecKeyCopyPublicKey(private) : NULL;
  CFRelease(attrs); CFRelease(size); if(!public)return 1;
  brain_auth_binding binding={0}; memset(&binding,0x42,sizeof binding); binding.worker_uid=501;binding.ui_uid=502;binding.worker_pid=123; brain_presence_challenge c; uint8_t prompt[16];memset(prompt,7,sizeof prompt);
  brain_presence_scope scope={.gui_pid=20,.gui_asid=1,.gui_start_sec=1,.policy_generation=1,.response_generation=1};memset(scope.gui_session,8,16);memset(scope.gui_instance,9,16);memset(scope.gui_boot,10,16);
  if(!brain_presence_issue(&c,&binding,&scope,1,prompt,1000) || c.length>sizeof c.message)return 2;
  /* 끝에서 73바이트 앞부터 GUI session, instance, policy 및 response 세대가 직렬화된다. */
  if(c.length<73 || memcmp(c.message+c.length-73,scope.gui_session,16) || memcmp(c.message+c.length-57,scope.gui_instance,16)
    || c.message[c.length-34]!=1 || c.message[c.length-26]!=1)return 9;
  CFDataRef message=CFDataCreate(NULL,c.message,(CFIndex)c.length);
  CFDataRef signature=SecKeyCreateSignature(private,kSecKeyAlgorithmECDSASignatureMessageX962SHA256,message,NULL);
  if(!signature || !brain_presence_verify(&c,public,CFDataGetBytePtr(signature),(size_t)CFDataGetLength(signature)))return 3;
  if(brain_presence_verify(&c,public,CFDataGetBytePtr(signature),(size_t)CFDataGetLength(signature)))return 4;
  if(!brain_presence_issue(&c,&binding,&scope,1,prompt,1000) || brain_presence_verify(&c,public,CFDataGetBytePtr(signature),(size_t)CFDataGetLength(signature)))return 5;
  if(brain_presence_verify(&c,public,CFDataGetBytePtr(signature),(size_t)CFDataGetLength(signature)))return 6;
  if(!brain_presence_issue(&c,&binding,&scope,1,prompt,1000))return 7;
  CFDataRef next=CFDataCreate(NULL,c.message,(CFIndex)c.length);
  CFDataRef next_sig=SecKeyCreateSignature(private,kSecKeyAlgorithmECDSASignatureMessageX962SHA256,next,NULL);
  c.message[c.length-1]^=1;
  if(!next_sig || brain_presence_verify(&c,public,CFDataGetBytePtr(next_sig),(size_t)CFDataGetLength(next_sig)))return 8;
  scope.response_generation=0;
  if(brain_presence_issue(&c,&binding,&scope,1,prompt,1000) || !c.consumed)return 10;
  CFRelease(next_sig); CFRelease(next);
  CFRelease(signature); CFRelease(message); CFRelease(public); CFRelease(private); return 0;
}
