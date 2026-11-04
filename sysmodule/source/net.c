#include "net.h"
#include "log.h"
#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Transfer memory = sb_efficiency * (tcp_tx_max + tcp_rx_max + udp_tx + udp_rx)
 * = 1 * (256K + 256K + 9K + 41K) ~= 564 KB, allocated from our heap. */
static const SocketInitConfig kSocketConfig = {
    .tcp_tx_buf_size     = 0x8000,
    .tcp_rx_buf_size     = 0x10000,
    .tcp_tx_buf_max_size = 0x40000,
    .tcp_rx_buf_max_size = 0x40000,
    .udp_tx_buf_size     = 0x2400,
    .udp_rx_buf_size     = 0xA500,
    .sb_efficiency       = 1,
    .num_bsd_sessions    = 2,
    .bsd_service_type    = BsdServiceType_Auto,
};

static bool g_nifm, g_socket, g_curl;

NetStatus netBegin(void) {
    Result rc = nifmInitialize(NifmServiceType_User);
    if (R_FAILED(rc)) {
        logLine("net: nifmInitialize failed 0x%x", rc);
        return NetStatus_InitFailed;
    }
    g_nifm = true;

    NifmInternetConnectionType type = 0;
    u32 strength = 0;
    NifmInternetConnectionStatus status = 0;
    rc = nifmGetInternetConnectionStatus(&type, &strength, &status);
    logLine("net: nifm status rc=0x%x type=%d strength=%u status=%d", rc, type, strength, status);
    /* rc fails when there is no network at all (Wi-Fi off / not associated).
     * A status below Connected can just mean the console's own connection test
     * was blocked by DNS-MITM, so we still try in that case and let curl decide. */
    if (R_FAILED(rc)) {
        netEnd();
        return NetStatus_Offline;
    }

    rc = socketInitialize(&kSocketConfig);
    if (R_FAILED(rc)) {
        logLine("net: socketInitialize failed 0x%x", rc);
        netEnd();
        return NetStatus_InitFailed;
    }
    g_socket = true;

    CURLcode cc = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (cc != CURLE_OK) {
        logLine("net: curl_global_init failed %d", cc);
        netEnd();
        return NetStatus_InitFailed;
    }
    g_curl = true;
    return NetStatus_Ok;
}

void netEnd(void) {
    if (g_curl) curl_global_cleanup();
    if (g_socket) socketExit();
    if (g_nifm) nifmExit();
    g_curl = g_socket = g_nifm = false;
}

typedef struct {
    char *buf;
    size_t len, cap, max;
} Sink;

static size_t onData(char *ptr, size_t size, size_t nmemb, void *user) {
    Sink *s = user;
    size_t n = size * nmemb;
    if (s->len + n + 1 > s->max) return 0; /* abort: response too large */
    if (s->len + n + 1 > s->cap) {
        size_t cap = s->cap ? s->cap : 4096;
        while (cap < s->len + n + 1) cap *= 2;
        if (cap > s->max) cap = s->max;
        char *nb = realloc(s->buf, cap);
        if (!nb) return 0;
        s->buf = nb;
        s->cap = cap;
    }
    memcpy(s->buf + s->len, ptr, n);
    s->len += n;
    s->buf[s->len] = 0;
    return n;
}

bool httpRequest(const char *url, const char *const *headers, const void *body, size_t body_len,
                 const char *ca_file, size_t max_response, long timeout_s, HttpResponse *out) {
    memset(out, 0, sizeof(*out));
    CURL *c = curl_easy_init();
    if (!c) {
        snprintf(out->error, sizeof(out->error), "curl_easy_init failed");
        return false;
    }

    struct curl_slist *hl = NULL;
    for (const char *const *h = headers; h && *h; h++) hl = curl_slist_append(hl, *h);

    Sink sink = { .max = max_response };
    char errbuf[CURL_ERROR_SIZE] = "";

    curl_easy_setopt(c, CURLOPT_URL, url);
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, hl);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, onData);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &sink);
    curl_easy_setopt(c, CURLOPT_ERRORBUFFER, errbuf);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "glance-switch/0.1");
    curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, timeout_s);
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 2L);
    if (ca_file && *ca_file) curl_easy_setopt(c, CURLOPT_CAINFO, ca_file);
    if (body) {
        curl_easy_setopt(c, CURLOPT_POST, 1L);
        curl_easy_setopt(c, CURLOPT_POSTFIELDS, body);
        curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)body_len);
    }

    u64 t0 = armGetSystemTick();
    CURLcode cc = curl_easy_perform(c);
    out->elapsed_ms = armTicksToNs(armGetSystemTick() - t0) / 1000000ULL;
    out->curl_code = cc;
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &out->http_status);
    if (cc != CURLE_OK)
        snprintf(out->error, sizeof(out->error), "%s%s%s", curl_easy_strerror(cc),
                 errbuf[0] ? ": " : "", errbuf);

    out->body = sink.buf;
    out->body_len = sink.len;

    curl_slist_free_all(hl);
    curl_easy_cleanup(c);
    logLine("http: %s -> curl=%d http=%ld %u ms, %zu bytes%s%s", url, cc, out->http_status,
            out->elapsed_ms, out->body_len, out->error[0] ? " err=" : "", out->error);
    return cc == CURLE_OK;
}
