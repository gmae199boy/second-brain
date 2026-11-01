#ifndef BRAIN_FIXTURE_COMMON_H
#define BRAIN_FIXTURE_COMMON_H
#include <stdint.h>
#include <string.h>
static int fixture_hash(const char *text, uint8_t out[20]) {
  if (!text || strlen(text) != 40) return 0;
  for (int i = 0; i < 20; i++) { unsigned v; if (sscanf(text+i*2, "%2x", &v) != 1) return 0; out[i] = (uint8_t)v; }
  return 1;
}
#endif
