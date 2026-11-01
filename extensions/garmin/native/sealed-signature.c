#include "sealed-signature.h"
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
int brain_sealed_signature(int fd,const uint8_t hash[20]) {
  if(fd<0 || !hash)return 0;unsigned nonzero=0;for(int i=0;i<20;i++)nonzero|=hash[i];if(!nonzero)return 0;
  char path[PATH_MAX];struct stat before,at_path,after;
  if(fcntl(fd,F_GETPATH,path)<0 || fstat(fd,&before) || lstat(path,&at_path) || before.st_dev!=at_path.st_dev || before.st_ino!=at_path.st_ino)return 0;
  char requirement[51];memcpy(requirement,"cdhash H\"",9);static const char hex[]="0123456789abcdef";
  for(int i=0;i<20;i++){requirement[9+i*2]=hex[hash[i]>>4];requirement[10+i*2]=hex[hash[i]&15];}requirement[49]='"';requirement[50]=0;
  CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)path,strlen(path),false);
  CFStringRef text=CFStringCreateWithCString(NULL,requirement,kCFStringEncodingUTF8);
  SecStaticCodeRef code=NULL;SecRequirementRef req=NULL;
  int ok=url && text && SecStaticCodeCreateWithPath(url,kSecCSDefaultFlags,&code)==errSecSuccess
    && SecRequirementCreateWithString(text,kSecCSDefaultFlags,&req)==errSecSuccess
    && SecStaticCodeCheckValidity(code,kSecCSStrictValidate,req)==errSecSuccess
    && !fstat(fd,&after) && !lstat(path,&at_path) && before.st_dev==after.st_dev && before.st_ino==after.st_ino
    && before.st_dev==at_path.st_dev && before.st_ino==at_path.st_ino;
  if(req)CFRelease(req);if(code)CFRelease(code);if(text)CFRelease(text);if(url)CFRelease(url);return ok;
}
