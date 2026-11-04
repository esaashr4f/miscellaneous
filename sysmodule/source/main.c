/*
 * glance-sys: background service for the Glance overlay.
 *
 * Boot flow: Atmosphère launches us at boot (boot2.flag) -> we register the
 * "glance" service with sm -> we sleep in svcWaitSynchronization until the
 * overlay connects. Idle cost is one sleeping thread and our static heap.
 */
#include <switch.h>
#include <string.h>
#include "glance_ipc.h"
#include "ipc_server.h"
#include "jobs.h"
#include "log.h"

/* ---- libnx runtime configuration for a sysmodule ---------------------- */

void __libnx_init_time(void);

u32 __nx_applet_type = AppletType_None; /* we are not an applet */
u32 __nx_fs_num_sessions = 1;

/* The whole heap is a static array in .bss. 3 MB covers: 512 KB capture
 * buffer + ~564 KB socket transfer memory + curl + slack. Later milestones
 * add the base64 request body; logHeap() lines in glance.log show real use. */
#define INNER_HEAP_SIZE 0x300000

void __libnx_initheap(void) {
    static u8 inner_heap[INNER_HEAP_SIZE];
    extern void *fake_heap_start;
    extern void *fake_heap_end;
    fake_heap_start = inner_heap;
    fake_heap_end = inner_heap + sizeof(inner_heap);
}

void __appInit(void) {
    Result rc = smInitialize();
    if (R_FAILED(rc)) diagAbortWithResult(rc);

    /* hosversion must be set manually in a sysmodule (no loader to tell us).
     * libnx and curl's TLS backend use it to pick the right IPC variants. */
    rc = setsysInitialize();
    if (R_SUCCEEDED(rc)) {
        SetSysFirmwareVersion fw;
        if (R_SUCCEEDED(setsysGetFirmwareVersion(&fw)))
            hosversionSet(MAKEHOSVERSION(fw.major, fw.minor, fw.micro));
        setsysExit();
    }

    rc = fsInitialize();
    if (R_FAILED(rc)) diagAbortWithResult(rc);
    fsdevMountSdmc();

    /* For log timestamps and the clock sanity check; failure is non-fatal.
     * __libnx_init_time() is what the default __appInit calls to hook the
     * time service into newlib's time()/gettimeofday(). */
    if (R_SUCCEEDED(timeInitialize())) __libnx_init_time();
}

void __appExit(void) {
    timeExit();
    fsdevUnmountAll();
    fsExit();
    smExit();
}

/* ---- IPC command dispatch -------------------------------------------- */

static Result handleCommand(const IpcRequest *req, void *out, size_t *out_size) {
    switch (req->cmd_id) {
        case GlanceCmd_GetVersion: {
            u32 v = GLANCE_IPC_VERSION;
            memcpy(out, &v, sizeof(v));
            *out_size = sizeof(v);
            return 0;
        }
        case GlanceCmd_StartJob: {
            if (req->in_size < sizeof(GlanceJobRequest)) return GLANCE_RC_BAD_ARGS;
            GlanceJobRequest jr;
            memcpy(&jr, req->in_data, sizeof(jr));
            return jobsStart(&jr);
        }
        case GlanceCmd_GetStatus: {
            GlanceStatus st;
            jobsGetStatus(&st);
            memcpy(out, &st, sizeof(st));
            *out_size = sizeof(st);
            return 0;
        }
        case GlanceCmd_GetResult: {
            if (!req->out_buf || req->out_buf_size == 0) return GLANCE_RC_BAD_ARGS;
            u32 n = (u32)jobsGetResult(req->out_buf, req->out_buf_size);
            memcpy(out, &n, sizeof(n));
            *out_size = sizeof(n);
            return 0;
        }
        default:
            return GLANCE_RC_BAD_COMMAND;
    }
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    logInit();
    logLine("glance-sys starting (IPC v%d, fw %u.%u.%u)", GLANCE_IPC_VERSION,
            HOSVER_MAJOR(hosversionGet()), HOSVER_MINOR(hosversionGet()), HOSVER_MICRO(hosversionGet()));
    logHeap("boot");

    Result rc = jobsInit();
    if (R_FAILED(rc)) {
        logLine("jobsInit failed 0x%x", rc);
        return 1;
    }

    rc = ipcServerInit(GLANCE_SERVICE_NAME, 4);
    if (R_FAILED(rc)) {
        logLine("register service '%s' failed 0x%x", GLANCE_SERVICE_NAME, rc);
        return 1;
    }
    logLine("service '%s' registered, waiting for clients", GLANCE_SERVICE_NAME);

    ipcServerLoop(handleCommand); /* never returns */
    ipcServerExit();
    return 0;
}
