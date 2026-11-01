#include <stdio.h>
#include <unistd.h>
#include "../child-bootstrap.h"
#include "fixture-common.h"
int main(int argc, char **argv) {
  uint8_t host[20]; if (argc != 2 || !fixture_hash(argv[1],host)) return 2;
  if (!brain_child_bootstrap(host,3000)) return 3;
  return write(1,"entered",7)==7 ? 0 : 4;
}
