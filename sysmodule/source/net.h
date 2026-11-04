#pragma once
#include <switch.h>
#include <stddef.h>

/*
 * Networking is brought up per job and torn down afterwards.
 *
 * WHY: sockets reserve ~0.5 MB of transfer memory and keep service sessions
 * open. Holding that while idle would waste memory 99.9% of the time and the
 * brief asks for minimal idle cost. Bring-up takes only a few milliseconds.
 *
 * TLS: devkitPro's switch-curl uses the console's own `ssl` system service
 * (curl's "libnx" TLS backend), not mbedTLS. That means no CA bundle is needed
 * (Nintendo's built-in trust store is used), and the TLS state lives in the ssl
 * sysmodule, not in our tiny heap. An extra PEM can still be supplied via
 * [debug] ca_file if a root is ever missing.
 */

typedef enum {
    NetStatus_Ok = 0,
    NetStatus_Offline,     /* nifm says no network */
    NetStatus_InitFailed,  /* socket/curl init failed */
} NetStatus;

NetStatus netBegin(void);
void netEnd(void);

typedef struct {
    long http_status;      /* 0 if the request never got a response */
    int curl_code;         /* CURLcode */
    char error[160];       /* curl error text, if any */
    char *body;            /* malloc'd, NUL-terminated; caller frees with free() */
    size_t body_len;
    u32 elapsed_ms;
} HttpResponse;

/* headers: NULL-terminated array of "Name: value" strings. body may be NULL (GET). */
bool httpRequest(const char *url, const char *const *headers, const void *body, size_t body_len,
                 const char *ca_file, size_t max_response, long timeout_s, HttpResponse *out);
