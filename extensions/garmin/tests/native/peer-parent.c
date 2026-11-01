#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <bsm/libbsm.h>
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc,char **argv) {
 if(argc!=3) return 1; int s[2]; if(socketpair(AF_UNIX,SOCK_STREAM,0,s)) return 2;
 pid_t child=fork(); if(child<0) return 3;
 if(!child) { close(s[0]); char fd[32]; snprintf(fd,sizeof fd,"%d",s[1]); execl(argv[1],argv[1],fd,(char*)0); _exit(4); }
 close(s[1]); char c; if(read(s[0],&c,1)!=1) return 5;
 audit_token_t t; socklen_t n=sizeof t; if(getsockopt(s[0],SOL_LOCAL,LOCAL_PEERTOKEN,&t,&n)) return 6;
 CFDataRef d=CFDataCreate(NULL,(UInt8*)&t,sizeof t); const void *keys[]={kSecGuestAttributeAudit}; const void *vals[]={d};
 CFDictionaryRef attrs=CFDictionaryCreate(NULL,keys,vals,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
 SecCodeRef code=NULL; OSStatus lookup=SecCodeCopyGuestWithAttributes(NULL,attrs,kSecCSDefaultFlags,&code);
 CFStringRef text=CFStringCreateWithCString(NULL,argv[2],kCFStringEncodingUTF8); SecRequirementRef req=NULL;
 OSStatus parse=SecRequirementCreateWithString(text,kSecCSDefaultFlags,&req); OSStatus verdict=(lookup||parse)?-1:SecCodeCheckValidity(code,kSecCSDefaultFlags,req);
 printf("peer_pid=%d child_pid=%d lookup=%d requirement=%d verdict=%d\n",audit_token_to_pid(t),child,(int)lookup,(int)parse,(int)verdict);
 if(code) CFRelease(code); if(req) CFRelease(req); CFRelease(text); CFRelease(attrs); CFRelease(d); close(s[0]); waitpid(child,NULL,0); return 0;
}
