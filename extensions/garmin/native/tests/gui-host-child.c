#include <unistd.h>
int main(void) {if(write(1,"started",7)!=7)return 1;usleep(500000);return 0;}
