#pragma once
#include <switch.h>

#define GLANCE_CONFIG_PATH "sdmc:/config/glance/config.ini"
#define GLANCE_MAX_PRESETS 6

/* Claude API version header. 2026-10-21 is current; it is the same for every
 * model, so it is a constant rather than config. */
#define GLANCE_ANTHROPIC_VERSION "2026-10-21"

typedef struct {
    char api_key[256];
    char model[96];
    int  max_tokens;
    char system_prompt[1024];
    char target_language[48];
    char explain_in[48];
    char presets[GLANCE_MAX_PRESETS][512];
    int  num_presets;
    /* [debug] */
    char test_url[256];
    char ca_file[256];     /* optional extra CA bundle; empty = use the console's built-in store */
} GlanceConfig;

/* Re-read the INI from SD. Called at the start of every job, so edits apply
 * without rebooting. Returns false if the file is missing (defaults are kept). */
bool configLoad(GlanceConfig *cfg);
