#pragma once
#include <switch.h>

/*
 * Minimal single-threaded CMIF server built directly on libnx's HIPC helpers.
 *
 * WHY hand-rolled: the "proper" way is Atmosphère's libstratosphere (C++), which
 * is large and pulls in a lot of machinery. Our service has four tiny commands,
 * so ~200 lines of C over the raw kernel calls is easier to read and debug.
 * sys-clk uses the same approach.
 */

typedef struct {
    u32 cmd_id;
    const void *in_data;   /* raw input bytes after the CMIF header */
    size_t in_size;
    void *out_buf;         /* first type-B (HipcMapAlias Out) buffer, or NULL */
    size_t out_buf_size;
} IpcRequest;

/* Handler: fill out_data (<= 0x100 bytes) and *out_size, return a Result. */
typedef Result (*IpcHandler)(const IpcRequest *req, void *out_data, size_t *out_size);

Result ipcServerInit(const char *name, s32 max_sessions);
/* Blocks forever servicing requests. */
void ipcServerLoop(IpcHandler handler);
void ipcServerExit(void);
