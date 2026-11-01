#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include "presence-ui.h"

#ifndef BRAIN_PRESENCE_KEY_TAG
#define BRAIN_PRESENCE_KEY_TAG "org.secondbrain.unconfigured"
#define BRAIN_PRESENCE_UNCONFIGURED 1
#endif
CFDataRef brain_presence_sign(const uint8_t *message, size_t length) {
  if (!message || !length || length>288) return NULL;
#ifdef BRAIN_PRESENCE_UNCONFIGURED
  return NULL;
#endif
  @autoreleasepool {
    LAContext *context=[[LAContext alloc] init];
    context.localizedReason=@"선택한 Garmin 인증을 승인합니다";
    context.localizedFallbackTitle=@""; context.touchIDAuthenticationAllowableReuseDuration=0;
    NSData *tag=[NSData dataWithBytes:BRAIN_PRESENCE_KEY_TAG length:sizeof(BRAIN_PRESENCE_KEY_TAG)-1];
    NSDictionary *query=@{(__bridge id)kSecClass:(__bridge id)kSecClassKey,
                          (__bridge id)kSecAttrApplicationTag:tag,
                          (__bridge id)kSecAttrKeyType:(__bridge id)kSecAttrKeyTypeECSECPrimeRandom,
                          (__bridge id)kSecReturnRef:@YES,
                          (__bridge id)kSecUseAuthenticationContext:context};
    CFTypeRef result=NULL; CFDataRef signature=NULL;
    if (SecItemCopyMatching((__bridge CFDictionaryRef)query,&result)==errSecSuccess && result && CFGetTypeID(result)==SecKeyGetTypeID()) {
      SecKeyRef key=(SecKeyRef)result; CFDictionaryRef attrs=SecKeyCopyAttributes(key);
      CFTypeRef token=attrs ? CFDictionaryGetValue(attrs,kSecAttrTokenID) : NULL;
      if (token && CFEqual(token,kSecAttrTokenIDSecureEnclave)) {
        CFDataRef data=CFDataCreate(NULL,message,(CFIndex)length);
        if (data) { signature=SecKeyCreateSignature(key,kSecKeyAlgorithmECDSASignatureMessageX962SHA256,data,NULL); CFRelease(data); }
      }
      if (attrs) CFRelease(attrs);
    }
    if (result) CFRelease(result); [context invalidate]; [context release]; return signature;
  }
}
