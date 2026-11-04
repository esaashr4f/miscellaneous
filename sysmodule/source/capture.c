#include "capture.h"
#include "log.h"

Result captureScreenJpeg(ViLayerStack stack, void *buf, u64 *out_size) {
    Result rc = capsscInitialize();
    if (R_FAILED(rc)) {
        logLine("capture: capsscInitialize failed 0x%x", rc);
        return rc;
    }
    *out_size = 0;
    /* 1 s timeout: the call waits for the next composed frame. */
    rc = capsscCaptureJpegScreenShot(out_size, buf, CAPTURE_JPEG_BUFFER_SIZE, stack, 1000000000LL);
    capsscExit();
    return rc;
}

Result captureLastAlbumScreenshot(void *buf, size_t buf_size, u64 *out_size, CapsAlbumFileId *out_id) {
    Result rc = capsaInitialize();
    if (R_FAILED(rc)) {
        logLine("capture: capsaInitialize failed 0x%x", rc);
        return rc;
    }
    /* This call returns the id of the newest screenshot taken with the Capture
     * button (plus its thumbnail, which we write into buf and then discard). */
    CapsAlbumFileId id = {0};
    u64 thumb_size = 0;
    rc = capsaGetLastOverlayScreenShotThumbnail(&id, &thumb_size, buf, buf_size);
    if (R_SUCCEEDED(rc) && id.application_id == 0 && id.datetime.year == 0)
        rc = MAKERESULT(Module_Libnx, LibnxError_NotFound); /* no screenshot yet */
    if (R_SUCCEEDED(rc)) {
        *out_id = id;
        rc = capsaLoadAlbumFile(&id, out_size, buf, buf_size);
    }
    capsaExit();
    return rc;
}
