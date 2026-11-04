/*
 * glance_ipc.h - the contract between glance-sys (sysmodule) and glance.ovl (overlay).
 *
 * Shared by both subprojects so the command IDs and struct layouts can never drift.
 * Plain C, no libnx includes beyond basic types, so it compiles in C and C++.
 *
 * WHY this shape: every command returns immediately. Long work (capture, HTTPS)
 * runs on a worker thread inside the sysmodule, and the overlay polls GetStatus
 * once per frame. That keeps the overlay responsive (a blocking IPC call would
 * freeze its render loop) and means closing the overlay mid-request is harmless.
 */
#pragma once
#include <switch/types.h>

#define GLANCE_SERVICE_NAME "glance"
#define GLANCE_IPC_VERSION  1

/* Program ID of the sysmodule. Must match sysmodule/glance-sys.json and the
 * atmosphere/contents/<id>/ folder name. 0x42... is outside Nintendo's ranges. */
#define GLANCE_PROGRAM_ID     0x4200000000474C43ULL
#define GLANCE_PROGRAM_ID_STR "4200000000474C43"

/* Max bytes GetResult can return (UTF-8, NUL-terminated). */
#define GLANCE_RESULT_MAX 0x2000

typedef enum {
    GlanceCmd_GetVersion = 0, /* out: u32 version                                     */
    GlanceCmd_StartJob   = 1, /* in: GlanceJobRequest. Fails with Busy if a job runs.  */
    GlanceCmd_GetStatus  = 2, /* out: GlanceStatus                                    */
    GlanceCmd_GetResult  = 3, /* out buffer (type-B / HipcMapAlias): UTF-8 text        */
} GlanceCmd;

typedef enum {
    GlanceJob_Ping        = 0, /* M1: writes a log line, returns "pong" + uptime      */
    GlanceJob_TestHttps   = 1, /* M2: HTTPS GET to [debug] test_url, report status     */
    GlanceJob_TestCapture = 2, /* M3: capture via caps:sc (+ album fallback), save JPEGs */
} GlanceJob;

typedef enum {
    GlanceState_Idle    = 0,
    GlanceState_Running = 1,
    GlanceState_Done    = 2, /* result text holds the answer                        */
    GlanceState_Error   = 3, /* result text holds a user-facing error message       */
} GlanceState;

/* Coarse progress, so the overlay can show "Capturing..." vs "Thinking...". */
typedef enum {
    GlanceStage_None      = 0,
    GlanceStage_Capturing = 1, /* overlay must stay blank while this is set           */
    GlanceStage_Network   = 2,
    GlanceStage_Parsing   = 3,
} GlanceStage;

typedef struct {
    u32 job;   /* GlanceJob */
    u32 arg;   /* job-specific (preset id later) */
} GlanceJobRequest;

typedef struct {
    u32 state;      /* GlanceState */
    u32 stage;      /* GlanceStage */
    u32 job;        /* job that produced the current state */
    u32 seq;        /* increments every time a job starts; lets the overlay detect stale results */
    u32 result_len; /* bytes of result text available (excluding NUL) */
    u32 elapsed_ms; /* job run time so far / total */
} GlanceStatus;

/* Result codes returned by the service. Module 416 is unused by Nintendo/libnx. */
#define GLANCE_RESULT_MODULE 416
#define GLANCE_RC(desc) (((desc) & 0x1FFF) << 9 | (GLANCE_RESULT_MODULE & 0x1FF))
#define GLANCE_RC_BUSY        GLANCE_RC(1)
#define GLANCE_RC_BAD_JOB     GLANCE_RC(2)
#define GLANCE_RC_BAD_COMMAND GLANCE_RC(3)
#define GLANCE_RC_BAD_ARGS    GLANCE_RC(4)
