#pragma once
#include <switch.h>
#include "glance_ipc.h"

/*
 * One background worker thread that runs one job at a time.
 *
 * WHY a single worker: the IPC thread must never block (otherwise the overlay's
 * GetStatus poll would stall its UI). And one-at-a-time keeps peak memory
 * predictable: we never hold two screenshots or two TLS sessions at once.
 */
Result jobsInit(void);
void jobsExit(void);

Result jobsStart(const GlanceJobRequest *req);
void jobsGetStatus(GlanceStatus *out);
/* Copies the result text (NUL-terminated, truncated to size). Returns bytes copied. */
size_t jobsGetResult(char *out, size_t size);

/* Called by job implementations. */
void jobSetStage(GlanceStage stage);
