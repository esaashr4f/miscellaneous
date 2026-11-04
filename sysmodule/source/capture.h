#pragma once
#include <switch.h>

/*
 * Screen capture.
 *
 * Primary: caps:sc CaptureJpegScreenShot (fw 9.0.0+, no debug mode needed on
 * 10.0.0+). The system's hardware JPEG encoder produces a 1280x720 JPEG of the
 * chosen layer stack in one call: no raw framebuffer, no encoder in our heap.
 *
 * Fallback: the user presses the Capture button, then we read the newest album
 * screenshot through caps:a (the way sys-screenuploader does).
 */

#define CAPTURE_JPEG_BUFFER_SIZE 0x80000 /* what official software uses */

/* buf must be CAPTURE_JPEG_BUFFER_SIZE bytes, 0x1000-aligned. */
Result captureScreenJpeg(ViLayerStack stack, void *buf, u64 *out_size);

/* Copies the most recent album screenshot JPEG into buf. */
Result captureLastAlbumScreenshot(void *buf, size_t buf_size, u64 *out_size, CapsAlbumFileId *out_id);
