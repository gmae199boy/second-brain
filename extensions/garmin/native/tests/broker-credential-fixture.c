#define BRAIN_CREDENTIAL_FIXTURE 1
#include "../broker-credential.c"
#include <stdio.h>
static void grow(int fd){(void)pwrite(fd,"x",1,4096);}
static void shrink(int fd){(void)ftruncate(fd,4);}
static int prepare(int fd,size_t size) {
  char bytes[4097];memset(bytes,'a',sizeof bytes);return !ftruncate(fd,0) && lseek(fd,0,SEEK_SET)==0 && write(fd,bytes,size)==(ssize_t)size && lseek(fd,0,SEEK_SET)==0;
}
int main(void) {
  char path[]="/tmp/brain-credential-fixture.XXXXXX";int fd=mkstemp(path);if(fd<0)return 1;
  char data[4097];
  if(!prepare(fd,0) || read_credential(fd,data,NULL))return 9;
  if(!prepare(fd,4095) || !read_credential(fd,data,NULL) || strlen(data)!=4095)return 2;
  if(!prepare(fd,4096) || !read_credential(fd,data,NULL) || strlen(data)!=4096)return 3;
  if(!prepare(fd,4097) || read_credential(fd,data,NULL))return 4;
  if(!prepare(fd,4096) || read_credential(fd,data,grow))return 5;
  if(!prepare(fd,4096) || read_credential(fd,data,shrink))return 6;
  if(!prepare(fd,16) || pwrite(fd,"\0",1,4)!=1 || lseek(fd,0,SEEK_SET)!=0 || read_credential(fd,data,NULL))return 10;
  if(open_checked(path,0)>=0)return 11;
  close(fd);unlink(path);wipe(data,sizeof data);
  char address[INET6_ADDRSTRLEN];const char *base="host=127.0.0.1 port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem password=fixture";
  if(!validate_conninfo(base,address) || strcmp(address,"127.0.0.1"))return 7;
  if(validate_conninfo_for_role(base,address,"brain_protected_supervisor"))return 15;
  if(!validate_conninfo_for_role("host=/private/etc/ssl port=5432 dbname=fixture user=brain_protected_supervisor",address,"brain_protected_supervisor"))return 16;
  if(!validate_conninfo("host=/private/etc/ssl port=5432 dbname=fixture user=brain_protected_broker",address) || *address)return 8;
  struct sockaddr_in first={.sin_family=AF_INET},second={.sin_family=AF_INET};
  if(inet_pton(AF_INET,"127.0.0.1",&first.sin_addr)!=1 || inet_pton(AF_INET,"127.0.0.2",&second.sin_addr)!=1)return 12;
  struct addrinfo a={.ai_family=AF_INET,.ai_addrlen=sizeof first,.ai_addr=(struct sockaddr *)&first},b={.ai_family=AF_INET,.ai_addrlen=sizeof second,.ai_addr=(struct sockaddr *)&second};a.ai_next=&b;
  if(unique_address(&a,address))return 13;second.sin_addr=first.sin_addr;if(!unique_address(&a,address) || strcmp(address,"127.0.0.1"))return 14;
  const char *bad[]={
    "host=localhost hostaddr=127.0.0.1 port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem",
    "host=localhost,example port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem",
    "host=localhost port=5432,5433 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=disable sslrootcert=/private/etc/ssl/cert.pem",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/etc/ssl/cert.pem",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem options='-c statement_timeout=0'",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem service=fixture",
    "host=/tmp port=5432 dbname=fixture user=brain_protected_broker",
    "host=localhost port=5432 dbname=fixture user=postgres sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem target_session_attrs=any",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem gssencmode=prefer",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem sslcert=/tmp/attacker",
    "host=localhost port=5432 dbname=fixture user=brain_protected_broker sslmode=verify-full sslrootcert=/private/etc/ssl/cert.pem passfile=/tmp/attacker",
    NULL
  };
  for(size_t i=0;bad[i];i++)if(validate_conninfo(bad[i],address))return (int)(20+i);
  return 0;
}
