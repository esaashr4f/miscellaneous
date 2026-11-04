#include "config.h"
#include "log.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

static char *trim(char *s) {
    while (*s && isspace((unsigned char)*s)) s++;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
    return s;
}

/* Strip an inline comment: a ';' or '#' that starts the value or follows
 * whitespace (" ; like this"). A ';' glued to a word ("hint;") is kept, so
 * prompts can still contain semicolons. */
static void stripComment(char *s) {
    for (char *p = s; *p; p++) {
        if ((*p == ';' || *p == '#') && (p == s || isspace((unsigned char)p[-1]))) {
            *p = 0;
            return;
        }
    }
}

#define COPY(dst, src) do { strncpy((dst), (src), sizeof(dst) - 1); (dst)[sizeof(dst) - 1] = 0; } while (0)

static void setDefaults(GlanceConfig *cfg) {
    memset(cfg, 0, sizeof(*cfg));
    cfg->max_tokens = 400;
    COPY(cfg->test_url, "https://api.anthropic.com/v1/models");
    COPY(cfg->target_language, "Spanish");
    COPY(cfg->explain_in, "English");
}

bool configLoad(GlanceConfig *cfg) {
    setDefaults(cfg);
    FILE *f = fopen(GLANCE_CONFIG_PATH, "r");
    if (!f) {
        logLine("config: %s not found, using defaults", GLANCE_CONFIG_PATH);
        return false;
    }

    char line[1024];
    char section[32] = "";
    while (fgets(line, sizeof(line), f)) {
        char *s = trim(line);
        if (*s == 0 || *s == ';' || *s == '#') continue;
        if (*s == '[') {
            char *end = strchr(s, ']');
            if (end) { *end = 0; COPY(section, s + 1); }
            continue;
        }
        char *eq = strchr(s, '=');
        if (!eq) continue;
        *eq = 0;
        char *key = trim(s);
        char *val = eq + 1;
        stripComment(val);
        val = trim(val);

        if (!strcmp(section, "api")) {
            if (!strcmp(key, "key")) COPY(cfg->api_key, val);
            else if (!strcmp(key, "model")) COPY(cfg->model, val);
            else if (!strcmp(key, "max_tokens")) cfg->max_tokens = atoi(val);
            else if (!strcmp(key, "system_prompt")) COPY(cfg->system_prompt, val);
        } else if (!strcmp(section, "learning")) {
            if (!strcmp(key, "target_language")) COPY(cfg->target_language, val);
            else if (!strcmp(key, "explain_in")) COPY(cfg->explain_in, val);
        } else if (!strcmp(section, "presets")) {
            int n = atoi(key);
            if (n >= 1 && n <= GLANCE_MAX_PRESETS) {
                COPY(cfg->presets[n - 1], val);
                if (n > cfg->num_presets) cfg->num_presets = n;
            }
        } else if (!strcmp(section, "debug")) {
            if (!strcmp(key, "test_url")) COPY(cfg->test_url, val);
            else if (!strcmp(key, "ca_file")) COPY(cfg->ca_file, val);
        }
    }
    fclose(f);

    if (cfg->max_tokens <= 0 || cfg->max_tokens > 4096) cfg->max_tokens = 400;
    /* Never log the key itself, only whether it looks plausible. */
    logLine("config: key=%s model=%s max_tokens=%d presets=%d",
            cfg->api_key[0] ? (strncmp(cfg->api_key, "sk-ant-", 7) ? "set(unexpected prefix)" : "set") : "MISSING",
            cfg->model[0] ? cfg->model : "(unset)", cfg->max_tokens, cfg->num_presets);
    return true;
}
