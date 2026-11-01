#include "../auth-channel.h"
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  uint8_t session[16], prompt[16], kind, payload[4096]; size_t length = 0;
  memset(session, 's', sizeof session); memset(prompt, 'p', sizeof prompt);
  brain_auth_channel channel;
  if (!brain_channel_init(&channel, atoi(argv[1]), session, 0, 2000)) return 2;
  int ok = brain_channel_receive(&channel, prompt, &kind, payload, sizeof payload, &length, 2000)
      && kind == 3 && brain_channel_send(&channel, kind, prompt, payload, length, 2000);
  volatile uint8_t *p = payload; for (size_t i = 0; i < sizeof payload; i++) p[i] = 0;
  brain_channel_close(&channel); brain_channel_destroy(&channel);
  return ok ? 0 : 3;
}
