#include "ipc_server.h"
#include "log.h"
#include "glance_ipc.h"
#include <string.h>

#define MAX_SESSIONS 8
#define MAX_OUT_DATA 0x100

static SmServiceName g_name;
static Handle g_port = INVALID_HANDLE;
static Handle g_sessions[MAX_SESSIONS];
static s32 g_numSessions;
static s32 g_maxSessions;

Result ipcServerInit(const char *name, s32 max_sessions) {
    g_name = smEncodeName(name);
    g_maxSessions = max_sessions > MAX_SESSIONS ? MAX_SESSIONS : max_sessions;
    return smRegisterService(&g_port, g_name, false, g_maxSessions);
}

void ipcServerExit(void) {
    for (s32 i = 0; i < g_numSessions; i++) svcCloseHandle(g_sessions[i]);
    g_numSessions = 0;
    if (g_port != INVALID_HANDLE) {
        svcCloseHandle(g_port);
        smUnregisterService(g_name);
        g_port = INVALID_HANDLE;
    }
}

static void removeSession(s32 i) {
    svcCloseHandle(g_sessions[i]);
    g_sessions[i] = g_sessions[--g_numSessions];
}

/* Write a CMIF reply into TLS. */
static void writeReply(Result rc, const void *data, size_t size) {
    void *base = armGetTls();
    u32 words = (u32)((0x10 + sizeof(CmifOutHeader) + size + 3) / 4); /* 0x10 = alignment slack */
    HipcRequest rep = hipcMakeRequestInline(base, .type = 0, .num_data_words = words);
    CmifOutHeader *hdr = (CmifOutHeader *)cmifGetAlignedDataStart(rep.data_words, base);
    hdr->magic = CMIF_OUT_HEADER_MAGIC;
    hdr->version = 0;
    hdr->result = rc;
    hdr->token = 0;
    if (size) memcpy(hdr + 1, data, size);
}

/* Returns false if the session should be closed. */
static bool processMessage(IpcHandler handler) {
    void *base = armGetTls();
    HipcParsedRequest p = hipcParseRequest(base);

    if (p.meta.type == CmifCommandType_Close)
        return false;

    CmifInHeader *in = (CmifInHeader *)cmifGetAlignedDataStart(p.data.data_words, base);
    size_t raw_words_bytes = p.meta.num_data_words * 4;
    size_t hdr_off = (u8 *)in - (u8 *)p.data.data_words;

    if ((p.meta.type != CmifCommandType_Request && p.meta.type != CmifCommandType_RequestWithContext &&
         p.meta.type != CmifCommandType_Control && p.meta.type != CmifCommandType_ControlWithContext) ||
        raw_words_bytes < hdr_off + sizeof(CmifInHeader) || in->magic != CMIF_IN_HEADER_MAGIC) {
        writeReply(GLANCE_RC_BAD_COMMAND, NULL, 0);
        return true;
    }

    /* Copy everything out of TLS before the reply overwrites it. */
    u8 in_copy[0x100];
    size_t in_size = raw_words_bytes - hdr_off - sizeof(CmifInHeader);
    if (in_size > sizeof(in_copy)) in_size = sizeof(in_copy);
    memcpy(in_copy, in + 1, in_size);
    u32 cmd_id = in->command_id;

    if (p.meta.type == CmifCommandType_Control || p.meta.type == CmifCommandType_ControlWithContext) {
        /* libnx's serviceCreate() sends QueryPointerBufferSize (control cmd 3)
         * on every connect. We don't use pointer buffers: answer 0. */
        if (cmd_id == 3) {
            u16 zero = 0;
            writeReply(0, &zero, sizeof(zero));
        } else {
            writeReply(GLANCE_RC_BAD_COMMAND, NULL, 0);
        }
        return true;
    }

    IpcRequest req = {
        .cmd_id = cmd_id,
        .in_data = in_copy,
        .in_size = in_size,
    };
    if (p.meta.num_recv_buffers > 0) {
        req.out_buf = hipcGetBufferAddress(&p.data.recv_buffers[0]);
        req.out_buf_size = hipcGetBufferSize(&p.data.recv_buffers[0]);
    }

    u8 out[MAX_OUT_DATA];
    size_t out_size = 0;
    Result rc = handler(&req, out, &out_size);
    if (out_size > sizeof(out)) out_size = sizeof(out);
    writeReply(rc, R_SUCCEEDED(rc) ? out : NULL, R_SUCCEEDED(rc) ? out_size : 0);
    return true;
}

void ipcServerLoop(IpcHandler handler) {
    for (;;) {
        Handle handles[1 + MAX_SESSIONS];
        handles[0] = g_port;
        memcpy(&handles[1], g_sessions, g_numSessions * sizeof(Handle));

        s32 idx = -1;
        Result rc = svcWaitSynchronization(&idx, handles, 1 + g_numSessions, UINT64_MAX);
        if (R_FAILED(rc)) {
            logLine("ipc: wait failed 0x%x", rc);
            svcSleepThread(100000000ULL);
            continue;
        }

        if (idx == 0) {
            Handle s;
            if (R_SUCCEEDED(svcAcceptSession(&s, g_port))) {
                if (g_numSessions < g_maxSessions) g_sessions[g_numSessions++] = s;
                else svcCloseHandle(s);
            }
            continue;
        }

        s32 si = idx - 1;
        Handle s = g_sessions[si];
        s32 dummy;
        /* Receive the pending request (handle is already signalled, timeout 0). */
        rc = svcReplyAndReceive(&dummy, &s, 1, INVALID_HANDLE, 0);
        if (R_FAILED(rc)) {
            /* 0xf601 = session closed by the client (e.g. overlay exited). */
            removeSession(si);
            continue;
        }

        if (!processMessage(handler)) {
            removeSession(si);
            continue;
        }

        /* Send the reply. With no handles to wait on this always "times out"
         * (0xea01) after replying; that's the success case. */
        rc = svcReplyAndReceive(&dummy, NULL, 0, s, 0);
        if (R_FAILED(rc) && R_VALUE(rc) != KERNELRESULT(TimedOut))
            removeSession(si);
    }
}
