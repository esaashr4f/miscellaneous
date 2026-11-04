#pragma once
#include <switch.h>

/* Milestone spikes M1-M3. Each writes a short human-readable summary into
 * `out` (shown in the overlay) and details into glance.log. */
bool selftestPing(char *out, size_t size);
bool selftestHttps(char *out, size_t size);
bool selftestCapture(char *out, size_t size);
