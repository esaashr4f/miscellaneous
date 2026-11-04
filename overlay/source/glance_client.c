#include "glance_client.h"
#include <string.h>

static Service g_srv;
static bool g_open;

/* Atmosphère's sm extension "HasService" (cmd 65100). We need it because a
 * plain smGetService() on a name nobody registered doesn't fail: sm *defers*
 * the request until someone registers it, which would freeze the overlay
 * forever if glance-sys is not installed. */
static Result smAtmosphereHasService(bool *out, SmServiceName name) {
    u8 tmp = 0;
    Result rc;
    if (hosversionAtLeast(12, 0, 0))
        rc = tipcDispatchInOut(smGetServiceSessionTipc(), 65100, name, tmp);
    else
        rc = serviceDispatchInOut(smGetServiceSession(), 65100, name, tmp);
    if (R_SUCCEEDED(rc)) *out = tmp != 0;
    return rc;
}

bool glanceIsRunning(void) {
    bool has = false;
    return R_SUCCEEDED(smAtmosphereHasService(&has, smEncodeName(GLANCE_SERVICE_NAME))) && has;
}

Result glanceOpen(void) {
    if (g_open) return 0;
    if (!glanceIsRunning()) return MAKERESULT(Module_Libnx, LibnxError_NotFound);
    Result rc = smGetService(&g_srv, GLANCE_SERVICE_NAME);
    g_open = R_SUCCEEDED(rc);
    return rc;
}

void glanceClose(void) {
    if (g_open) serviceClose(&g_srv);
    g_open = false;
}

bool glanceIsOpen(void) { return g_open; }

Result glanceGetVersion(u32 *out) {
    return serviceDispatchOut(&g_srv, GlanceCmd_GetVersion, *out);
}

Result glanceStartJob(u32 job, u32 arg) {
    const GlanceJobRequest req = { job, arg };
    return serviceDispatchIn(&g_srv, GlanceCmd_StartJob, req);
}

Result glanceGetStatus(GlanceStatus *out) {
    return serviceDispatchOut(&g_srv, GlanceCmd_GetStatus, *out);
}

Result glanceGetResult(char *buf, size_t size) {
    u32 n = 0;
    if (size) buf[0] = 0;
    Result rc = serviceDispatchOut(&g_srv, GlanceCmd_GetResult, n,
        .buffer_attrs = { SfBufferAttr_HipcMapAlias | SfBufferAttr_Out },
        .buffers = { { buf, size } },
    );
    if (size) buf[size - 1] = 0;
    return rc;
}
