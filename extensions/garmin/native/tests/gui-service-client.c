#include "../gui-client.h"
#include "fixture-common.h"
#include <dispatch/dispatch.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
int main(int argc,char **argv) {
  if(argc!=4)return 1;uint8_t hash[20];if(!fixture_hash(argv[2],hash))return 2;
  brain_xpc_peer peer;if(!brain_submission_connect(&peer,argv[1],geteuid(),hash,2000))return 3;
  brain_gui_client client={.peer=&peer,.timeout_ms=2000};brain_presence_scope scope;
  if(!brain_gui_client_start(&client,&scope))return 5;
  struct stat s;if(stat(argv[3],&s) || s.st_size!=0)return 6;
  if(!brain_gui_client_resume(&client,&scope))return 7;
  int found=0;for(int i=0;i<100;i++){usleep(10000);if(!stat(argv[3],&s) && s.st_size==7){found=1;break;}}
  if(!found || !brain_gui_client_cancel(&client))return 8;
  brain_xpc_close(&peer);return 0;
}
