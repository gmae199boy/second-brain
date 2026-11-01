#ifndef BRAIN_FIXTURE_CODE_HASH_H
#define BRAIN_FIXTURE_CODE_HASH_H
#include <Security/Security.h>
#include <string.h>
static int fixture_code_hash(const char *path,uint8_t hash[20]) {
  CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)path,strlen(path),false);SecStaticCodeRef code=NULL;CFDictionaryRef info=NULL;
  int ok=url && SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)==errSecSuccess && SecCodeCopySigningInformation(code,kSecCSSigningInformation,&info)==errSecSuccess;
  CFDataRef data=ok?CFDictionaryGetValue(info,kSecCodeInfoUnique):NULL;
  ok=data && CFGetTypeID(data)==CFDataGetTypeID() && CFDataGetLength(data)==20;if(ok)memcpy(hash,CFDataGetBytePtr(data),20);
  if(info)CFRelease(info);if(code)CFRelease(code);if(url)CFRelease(url);return ok;
}
#endif
