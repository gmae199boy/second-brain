#include <arpa/inet.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../peer.h"
int main(void) {
  int fds[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds)) return 1;
  pid_t child = fork(); if (child < 0) return 2;
  if (!child) {
    close(fds[0]); uint32_t size = htonl(3); const uint8_t *p = (const uint8_t *)&size;
    for (int i = 0; i < 4; i++) { if (write(fds[1], p+i, 1) != 1) _exit(3); usleep(1000); }
    if (write(fds[1], "abc", 3) != 3) _exit(4);
    size = htonl(16385); if (write(fds[1], &size, sizeof size) != sizeof size) _exit(5);
    close(fds[1]); _exit(0);
  }
  close(fds[1]); uint8_t data[32]; size_t n = 0;
  if (!brain_read_frame(fds[0], data, sizeof data, &n, 3000) || n != 3 || memcmp(data, "abc", 3)) return 6;
  if (brain_read_frame(fds[0], data, sizeof data, &n, 3000)) return 7;
  close(fds[0]); int status; waitpid(child, &status, 0); if (!WIFEXITED(status) || WEXITSTATUS(status)) return 8;
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds)) return 9;
  if (brain_read_frame(fds[0], data, sizeof data, &n, 25)) return 10;
  close(fds[1]); if (brain_write_frame(fds[0], (const uint8_t *)"x", 1, 100)) return 11;
  close(fds[0]); return 0;
}
