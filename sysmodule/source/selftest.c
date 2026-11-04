#include "selftest.h"
#include "jobs.h"
#include "config.h"
#include "log.h"
#include "net.h"
#include "capture.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <malloc.h>
#include <curl/curl.h>

static GlanceConfig g_cfg; /* ~4 KB; static so it doesn't eat the worker stack */

/* ---------------------------------------------------------------- M1 ---- */

bool selftestPing(char *out, size_t size) {
    u64 uptime_s = armTicksToNs(armGetSystemTick()) / 1000000000ULL;
    struct mallinfo mi = mallinfo();
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    logLine("ping");
    snprintf(out, size,
             "pong from glance-sys (IPC v%d)\n"
             "Console uptime: %llu s\n"
             "Heap in use: %zu KB\n"
             "System clock (UTC): %04d-%02d-%02d %02d:%02d",
             GLANCE_IPC_VERSION, (unsigned long long)uptime_s, (size_t)mi.uordblks / 1024,
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min);
    return true;
}

/* ---------------------------------------------------------------- M2 ---- */

bool selftestHttps(char *out, size_t size) {
    configLoad(&g_cfg);
    jobSetStage(GlanceStage_Network);

    /* TLS certificate validation needs a sane clock. A console that was never
     * synced (common on offline emuMMC) can sit at 2000-01-01 or similar. */
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    logLine("https: system clock %04d-%02d-%02d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);

    NetStatus ns = netBegin();
    if (ns == NetStatus_Offline) {
        snprintf(out, size, "No connection.\nTurn on Wi-Fi / check the network and try again.");
        return false;
    }
    if (ns != NetStatus_Ok) {
        snprintf(out, size, "Network init failed. See glance.log.");
        return false;
    }
    logHeap("net up");

    char key_hdr[300] = "";
    const char *headers[4] = { "anthropic-version: " GLANCE_ANTHROPIC_VERSION, NULL, NULL, NULL };
    if (g_cfg.api_key[0]) {
        snprintf(key_hdr, sizeof(key_hdr), "x-api-key: %s", g_cfg.api_key);
        headers[1] = key_hdr;
    }

    HttpResponse r;
    bool ok = httpRequest(g_cfg.test_url, headers, NULL, 0, g_cfg.ca_file, 64 * 1024, 20, &r);
    logHeap("after request");
    memset(key_hdr, 0, sizeof(key_hdr));

    if (r.body) {
        char snippet[201];
        snprintf(snippet, sizeof(snippet), "%s", r.body);
        logLine("https: body starts: %s", snippet);
    }

    if (!ok) {
        const char *hint = "";
        if (r.curl_code == CURLE_COULDNT_RESOLVE_HOST) hint = "\nDNS failed: is the host blocked in your DNS-MITM hosts file?";
        else if (r.curl_code == CURLE_OPERATION_TIMEDOUT) hint = "\nTimed out.";
        else if (r.curl_code == CURLE_SSL_CACERT || r.curl_code == CURLE_PEER_FAILED_VERIFICATION ||
                 r.curl_code == CURLE_SSL_CONNECT_ERROR)
            hint = "\nTLS failed: check the console clock, or set [debug] ca_file.";
        snprintf(out, size, "HTTPS FAILED (curl %d)\n%s%s", r.curl_code, r.error, hint);
    } else {
        const char *meaning =
            r.http_status == 200 ? "TLS works and the API key is valid." :
            r.http_status == 401 ? (g_cfg.api_key[0] ? "TLS works, but the API key was rejected."
                                                     : "TLS works (401 expected: no key in config.ini).") :
            "TLS works.";
        snprintf(out, size, "HTTPS OK: HTTP %ld in %u ms\n%s\n%s", r.http_status, r.elapsed_ms, g_cfg.test_url, meaning);
    }
    free(r.body);
    netEnd();
    logHeap("net down");
    return ok;
}

/* ---------------------------------------------------------------- M3 ---- */

static bool saveFile(const char *path, const void *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) return false;
    bool ok = fwrite(data, 1, len, f) == len;
    fclose(f);
    return ok;
}

bool selftestCapture(char *out, size_t size) {
    jobSetStage(GlanceStage_Capturing);
    void *buf = memalign(0x1000, CAPTURE_JPEG_BUFFER_SIZE);
    if (!buf) {
        snprintf(out, size, "Out of memory allocating capture buffer.");
        return false;
    }
    logHeap("capture buffer");

    /* Try the stacks that could plausibly contain just the game. The overlay
     * blanks itself while we capture, so even stacks that include the Tesla
     * layer should come out clean. Compare the saved JPEGs on a PC. */
    static const struct { ViLayerStack stack; const char *name; } kStacks[] = {
        { ViLayerStack_Default,             "default" },
        { ViLayerStack_Screenshot,          "screenshot" },
        { ViLayerStack_ApplicationForDebug, "appdebug" },
    };

    int pos = snprintf(out, size, "Capture test (files in /config/glance/):\n");
    bool any_ok = false;
    for (size_t i = 0; i < sizeof(kStacks) / sizeof(kStacks[0]); i++) {
        u64 jpeg_size = 0;
        u64 t0 = armGetSystemTick();
        Result rc = captureScreenJpeg(kStacks[i].stack, buf, &jpeg_size);
        u32 ms = armTicksToNs(armGetSystemTick() - t0) / 1000000ULL;
        logLine("capture: stack %s rc=0x%x size=%llu %u ms", kStacks[i].name, rc,
                (unsigned long long)jpeg_size, ms);
        if (R_SUCCEEDED(rc) && jpeg_size > 0) {
            char path[96];
            snprintf(path, sizeof(path), GLANCE_DIR "/capture_%s.jpg", kStacks[i].name);
            saveFile(path, buf, jpeg_size);
            any_ok = true;
            pos += snprintf(out + pos, size - pos, "%s: OK %llu KB, %u ms\n", kStacks[i].name,
                            (unsigned long long)(jpeg_size / 1024), ms);
        } else {
            pos += snprintf(out + pos, size - pos, "%s: FAILED 0x%x\n", kStacks[i].name, rc);
        }
        if (pos >= (int)size) pos = size - 1;
    }
    /* Capture is over: the overlay may draw again while we read the album. */
    jobSetStage(GlanceStage_None);

    u64 album_size = 0;
    CapsAlbumFileId id;
    Result rc = captureLastAlbumScreenshot(buf, CAPTURE_JPEG_BUFFER_SIZE, &album_size, &id);
    logLine("capture: album fallback rc=0x%x size=%llu", rc, (unsigned long long)album_size);
    if (R_SUCCEEDED(rc) && album_size > 0) {
        saveFile(GLANCE_DIR "/capture_album.jpg", buf, album_size);
        snprintf(out + pos, size - pos, "album (last Capture-button shot): OK %llu KB\n  %04u-%02u-%02u %02u:%02u",
                 (unsigned long long)(album_size / 1024), id.datetime.year, id.datetime.month,
                 id.datetime.day, id.datetime.hour, id.datetime.minute);
    } else {
        snprintf(out + pos, size - pos, "album: none/failed 0x%x (press Capture first)", rc);
    }

    free(buf);
    return any_ok || R_SUCCEEDED(rc);
}
