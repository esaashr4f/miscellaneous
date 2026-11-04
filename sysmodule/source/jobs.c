#include "jobs.h"
#include "log.h"
#include "selftest.h"
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

static Thread g_thread;
static Mutex g_mutex;
static CondVar g_cond;
static bool g_pending;
static GlanceJobRequest g_req;
static GlanceStatus g_status;
static char g_result[GLANCE_RESULT_MAX];
static u64 g_startTick;

static void finish(GlanceState state, const char *text) {
    mutexLock(&g_mutex);
    strncpy(g_result, text, sizeof(g_result) - 1);
    g_result[sizeof(g_result) - 1] = 0;
    g_status.result_len = strlen(g_result);
    g_status.state = state;
    g_status.stage = GlanceStage_None;
    g_status.elapsed_ms = armTicksToNs(armGetSystemTick() - g_startTick) / 1000000ULL;
    mutexUnlock(&g_mutex);
    logLine("job %u finished: state=%u in %u ms", g_status.job, state, g_status.elapsed_ms);
}

void jobSetStage(GlanceStage stage) {
    mutexLock(&g_mutex);
    g_status.stage = stage;
    mutexUnlock(&g_mutex);
}

static void workerMain(void *arg) {
    (void)arg;
    static char text[GLANCE_RESULT_MAX];
    for (;;) {
        mutexLock(&g_mutex);
        while (!g_pending) condvarWait(&g_cond, &g_mutex);
        g_pending = false;
        GlanceJobRequest req = g_req;
        mutexUnlock(&g_mutex);

        text[0] = 0;
        bool ok = false;
        logLine("job %u (arg %u) started", req.job, req.arg);
        logHeap("job start");
        switch (req.job) {
            case GlanceJob_Ping:        ok = selftestPing(text, sizeof(text)); break;
            case GlanceJob_TestHttps:   ok = selftestHttps(text, sizeof(text)); break;
            case GlanceJob_TestCapture: ok = selftestCapture(text, sizeof(text)); break;
            default: snprintf(text, sizeof(text), "Unknown job %u", req.job); break;
        }
        logHeap("job end");
        finish(ok ? GlanceState_Done : GlanceState_Error, text);
    }
}

Result jobsInit(void) {
    mutexInit(&g_mutex);
    condvarInit(&g_cond);
    /* Priority 0x3B is low (higher number = lower priority) so we never compete
     * with anything important; core 3 is the system core games don't use. */
    Result rc = threadCreate(&g_thread, workerMain, NULL, NULL, 0x10000, 0x3B, 3);
    if (R_SUCCEEDED(rc)) rc = threadStart(&g_thread);
    return rc;
}

void jobsExit(void) {
    /* The worker loops forever; the process exiting tears it down. */
}

Result jobsStart(const GlanceJobRequest *req) {
    if (req->job > GlanceJob_TestCapture) return GLANCE_RC_BAD_JOB;
    mutexLock(&g_mutex);
    if (g_pending || g_status.state == GlanceState_Running) {
        mutexUnlock(&g_mutex);
        return GLANCE_RC_BUSY;
    }
    g_req = *req;
    g_pending = true;
    g_status.state = GlanceState_Running;
    /* Set Capturing *now*, not when the worker wakes: the overlay is blanked
     * while stage == Capturing and must not see a gap between StartJob and the
     * worker picking the job up. */
    g_status.stage = (req->job == GlanceJob_TestCapture) ? GlanceStage_Capturing : GlanceStage_None;
    g_status.job = req->job;
    g_status.seq++;
    g_status.result_len = 0;
    g_status.elapsed_ms = 0;
    g_result[0] = 0;
    g_startTick = armGetSystemTick();
    condvarWakeOne(&g_cond);
    mutexUnlock(&g_mutex);
    return 0;
}

void jobsGetStatus(GlanceStatus *out) {
    mutexLock(&g_mutex);
    *out = g_status;
    if (out->state == GlanceState_Running)
        out->elapsed_ms = armTicksToNs(armGetSystemTick() - g_startTick) / 1000000ULL;
    mutexUnlock(&g_mutex);
}

size_t jobsGetResult(char *out, size_t size) {
    if (!size) return 0;
    mutexLock(&g_mutex);
    size_t n = strnlen(g_result, sizeof(g_result));
    if (n > size - 1) n = size - 1;
    memcpy(out, g_result, n);
    out[n] = 0;
    mutexUnlock(&g_mutex);
    return n + 1;
}
