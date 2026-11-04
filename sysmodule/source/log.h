#pragma once
#include <switch.h>

/* Append-only log at sdmc:/config/glance/glance.log.
 * WHY a file: a sysmodule has no console. nxlink only works for apps launched
 * from hbmenu, so the SD log is the one channel that always works. */
#define GLANCE_DIR      "sdmc:/config/glance"
#define GLANCE_LOG_PATH GLANCE_DIR "/glance.log"

void logInit(void);
void logLine(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
/* Log heap usage (mallinfo) with a tag; used to measure the memory budget. */
void logHeap(const char *tag);
