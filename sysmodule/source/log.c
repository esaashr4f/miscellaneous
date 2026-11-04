#include "log.h"
#include <stdio.h>
#include <stdarg.h>
#include <time.h>
#include <malloc.h>
#include <sys/stat.h>

static Mutex g_logMutex;

void logInit(void) {
    mutexInit(&g_logMutex);
    mkdir("sdmc:/config", 0777);
    mkdir(GLANCE_DIR, 0777);

    /* Keep the log from growing forever: rotate at 256 KB. */
    struct stat st;
    if (stat(GLANCE_LOG_PATH, &st) == 0 && st.st_size > 256 * 1024) {
        remove(GLANCE_LOG_PATH ".old");
        rename(GLANCE_LOG_PATH, GLANCE_LOG_PATH ".old");
    }
}

void logLine(const char *fmt, ...) {
    mutexLock(&g_logMutex);
    FILE *f = fopen(GLANCE_LOG_PATH, "a");
    if (f) {
        time_t now = time(NULL);
        struct tm tm;
        gmtime_r(&now, &tm);
        u64 ms = armTicksToNs(armGetSystemTick()) / 1000000ULL;
        fprintf(f, "%04d-%02d-%02d %02d:%02d:%02dZ [%8llu] ",
                tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                tm.tm_hour, tm.tm_min, tm.tm_sec, (unsigned long long)ms);
        va_list ap;
        va_start(ap, fmt);
        vfprintf(f, fmt, ap);
        va_end(ap);
        fputc('\n', f);
        fclose(f); /* close every line: a crash must not lose the last message */
    }
    mutexUnlock(&g_logMutex);
}

void logHeap(const char *tag) {
    struct mallinfo mi = mallinfo();
    logLine("heap[%s]: in use %zu KB, arena %zu KB", tag, (size_t)mi.uordblks / 1024, (size_t)mi.arena / 1024);
}
