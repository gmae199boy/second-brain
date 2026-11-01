#include "../child-bootstrap.h"
#include <string.h>
int main(void) {
  for(int test=0;test<7;test++) {
    uint8_t frame[1236]={1};frame[1]=1;frame[17]=2;frame[40]=1;frame[42]=3;frame[44]=7;frame[45]=1;frame[46]=6;memcpy(frame+47,"UTCfixturegarmin",16);
    if(test==1)frame[0]=2;if(test==2)frame[44]=8;if(test==3)frame[1]=0;if(test==4)frame[50]=0;if(test==5)frame[47]='!';
    brain_child_metadata metadata;int ok=brain_child_decode_metadata(&metadata,frame,test==6?sizeof frame:63);
    if(test==0) {if(!ok || metadata.run!=1 || strcmp(metadata.timezone,"UTC") || strcmp(metadata.tokenstore,"fixture"))return 1;}
    else if(ok)return 2+test;
    if(brain_child_read_metadata(&metadata,100))return 10;
  }
  return 0;
}
