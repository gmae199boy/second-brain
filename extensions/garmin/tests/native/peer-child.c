#include <unistd.h>
#include <stdlib.h>
#ifndef LABEL
#define LABEL 1
#endif
int main(int argc,char **argv) { if(argc!=2) return 2; int fd=atoi(argv[1]); char c=(char)LABEL; if(write(fd,&c,1)!=1) return 3; sleep(2); return 0; }
