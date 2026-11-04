#pragma once
#include <switch.h>
#include "glance_ipc.h"

/*
 * Thin client for the "glance" service. Every call is a few microseconds of
 * IPC; nothing here blocks on the network or capture.
 */
#ifdef __cplusplus
extern "C" {
#endif

/* Returns false (without blocking) if glance-sys isn't running. */
bool   glanceIsRunning(void);
Result glanceOpen(void);
void   glanceClose(void);
bool   glanceIsOpen(void);

Result glanceGetVersion(u32 *out);
Result glanceStartJob(u32 job, u32 arg);
Result glanceGetStatus(GlanceStatus *out);
Result glanceGetResult(char *buf, size_t size);

#ifdef __cplusplus
}
#endif
