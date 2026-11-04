/*
 * glance.ovl - Tesla overlay UI for Glance.
 *
 * This is the M0-M3 "spike" build: a test panel that proves each risky piece
 * on real hardware before the real UI is built on top of it.
 *
 *   M0  the overlay builds, opens and renders (incl. Japanese/Korean glyphs)
 *   M1  it can talk to glance-sys over IPC (Ping)
 *   M2  glance-sys can do HTTPS (Test HTTPS)
 *   M3  glance-sys can capture the screen (Test capture)
 *
 * The overlay stays thin on purpose: overlays get a tiny heap and are frozen
 * when hidden, so every slow or memory-hungry step lives in the sysmodule.
 */
#define TESLA_INIT_IMPL
#include <tesla.hpp>
#include <string>
#include <cstdio>

#include "glance_client.h"
#include "wrapped_text.hpp"

#ifndef GLANCE_VERSION
#define GLANCE_VERSION "dev"
#endif

namespace {

/* Set while the sysmodule is capturing: the root frame then draws nothing so
 * the screenshot shows only the game. (Tesla adds its layer to *every* vi
 * layer stack, including the screenshot ones, so hiding by layer-stack choice
 * alone is not possible.) */
bool g_blank = false;

class GlanceFrame : public tsl::elm::OverlayFrame {
public:
    using OverlayFrame::OverlayFrame;
    virtual void draw(tsl::gfx::Renderer *renderer) override {
        if (g_blank) {
            renderer->clearScreen(); /* fully transparent framebuffer */
            return;
        }
        OverlayFrame::draw(renderer);
    }
};

const char *jobName(u32 job) {
    switch (job) {
        case GlanceJob_Ping:        return "Ping";
        case GlanceJob_TestHttps:   return "HTTPS test";
        case GlanceJob_TestCapture: return "Capture test";
        default:                    return "Job";
    }
}

class MainGui : public tsl::Gui {
public:
    virtual tsl::elm::Element *createUI() override {
        auto *frame = new GlanceFrame("Glance", GLANCE_VERSION " · M0-M3 hardware tests");
        auto *list = new tsl::elm::List();

        list->addItem(new tsl::elm::CategoryHeader("glance-sys"));
        list->addItem(new tsl::elm::CustomDrawer([this](tsl::gfx::Renderer *r, s32 x, s32 y, s32 w, s32 h) {
            r->drawString(m_connText.c_str(), false, x + 4, y + 26, 19,
                          r->a(m_connected ? tsl::style::color::ColorHighlight : tsl::Color(0xF, 0x6, 0x6, 0xF)));
        }), 40);

        addJobItem(list, "M1  Ping sysmodule", GlanceJob_Ping, false);
        addJobItem(list, "M2  Test HTTPS", GlanceJob_TestHttps, false);
        addJobItem(list, "M3  Test screen capture", GlanceJob_TestCapture, true);

        list->addItem(new tsl::elm::CategoryHeader("Result  ( right stick scrolls)"));
        m_text = new WrappedText(18);
        m_text->setText("Pick a test above. Details go to /config/glance/glance.log.");
        list->addItem(m_text, 250);

        /* M0 font check: every line should render with no missing glyphs. */
        list->addItem(new tsl::elm::CategoryHeader("Font check (should be no blanks)"));
        list->addItem(new tsl::elm::CustomDrawer([](tsl::gfx::Renderer *r, s32 x, s32 y, s32 w, s32 h) {
            const auto c = r->a(tsl::style::color::ColorText);
            r->drawString("日本語: 次の駅はどこですか？ カタカナ", false, x + 4, y + 24, 19, c);
            r->drawString("한국어: 다음 역은 어디예요?", false, x + 4, y + 52, 19, c);
            r->drawString("Español: ¿Dónde está la estación? ñ ü", false, x + 4, y + 80, 19, c);
            r->drawString("Français: Ça coûte combien ? œ ë", false, x + 4, y + 108, 19, c);
        }), 125);

        frame->setContent(list);
        return frame;
    }

    virtual void update() override {
        m_frame++;

        if (!glanceIsOpen()) {
            /* Retry once a second: the sysmodule may have just been started
             * from ovl-sysmodules while this overlay was already loaded. */
            if (m_frame % 60 == 1) connect();
            return;
        }

        switch (m_phase) {
            case Phase::Idle:
                break;

            case Phase::BlankBeforeCapture:
                /* Tesla double-buffers, so wait a few frames until the
                 * composited screen really has no overlay pixels left. */
                if (++m_phaseFrames >= 4) startJob(m_pendingJob);
                break;

            case Phase::Running: {
                if (m_frame % 4 != 0) break; /* poll at ~15 Hz, plenty */
                GlanceStatus st;
                Result rc = glanceGetStatus(&st);
                if (R_FAILED(rc)) {
                    showError("Lost connection to glance-sys", rc);
                    break;
                }
                bool capturing = st.state == GlanceState_Running && st.stage == GlanceStage_Capturing;
                /* Safety net: never stay invisible for more than ~5 s. */
                g_blank = capturing && (m_frame - m_jobStartFrame) < 300;

                if (st.state == GlanceState_Running) {
                    char buf[96];
                    const char *stage = st.stage == GlanceStage_Capturing ? "capturing" :
                                        st.stage == GlanceStage_Network   ? "talking to the network" : "working";
                    std::snprintf(buf, sizeof(buf), "%s: %s... %.1f s", jobName(st.job), stage, st.elapsed_ms / 1000.0f);
                    m_text->setText(buf);
                } else if (st.state == GlanceState_Done || st.state == GlanceState_Error) {
                    static char result[GLANCE_RESULT_MAX];
                    glanceGetResult(result, sizeof(result));
                    char head[64];
                    std::snprintf(head, sizeof(head), "[%s, %.1f s]\n", st.state == GlanceState_Done ? "OK" : "ERROR",
                                  st.elapsed_ms / 1000.0f);
                    m_text->setText(std::string(head) + result);
                    g_blank = false;
                    m_phase = Phase::Idle;
                }
                break;
            }
        }
    }

    virtual bool handleInput(u64 keysDown, u64 keysHeld, const HidTouchState &touchPos,
                             HidAnalogStickState joyStickPosLeft, HidAnalogStickState joyStickPosRight) override {
        /* Right stick scrolls the result text (left stick / d-pad move focus). */
        if (m_text && (m_frame % 4 == 0)) {
            if (joyStickPosRight.y > 16000) m_text->scrollBy(-1);
            else if (joyStickPosRight.y < -16000) m_text->scrollBy(1);
        }
        return false;
    }

private:
    enum class Phase { Idle, BlankBeforeCapture, Running };

    void addJobItem(tsl::elm::List *list, const char *label, GlanceJob job, bool captures) {
        auto *item = new tsl::elm::ListItem(label);
        item->setClickListener([this, job, captures](u64 keys) {
            if (!(keys & HidNpadButton_A)) return false;
            if (!glanceIsOpen()) {
                m_text->setText("glance-sys is not running.\nCheck atmosphere/contents/" GLANCE_PROGRAM_ID_STR
                                "/ exists, reboot, then look at /config/glance/glance.log.");
                return true;
            }
            if (m_phase != Phase::Idle) return true;
            if (captures) {
                m_pendingJob = job;
                m_phase = Phase::BlankBeforeCapture;
                m_phaseFrames = 0;
                g_blank = true;
            } else {
                startJob(job);
            }
            return true;
        });
        list->addItem(item);
    }

    void startJob(u32 job) {
        Result rc = glanceStartJob(job, 0);
        if (R_FAILED(rc)) {
            showError(rc == GLANCE_RC_BUSY ? "glance-sys is busy, try again" : "StartJob failed", rc);
            return;
        }
        m_phase = Phase::Running;
        m_jobStartFrame = m_frame;
        m_text->setText(std::string(jobName(job)) + ": starting...");
    }

    void showError(const char *msg, Result rc) {
        char buf[128];
        std::snprintf(buf, sizeof(buf), "%s (0x%X)", msg, rc);
        m_text->setText(buf);
        g_blank = false;
        m_phase = Phase::Idle;
    }

    void connect() {
        Result rc = glanceOpen();
        u32 ver = 0;
        if (R_SUCCEEDED(rc)) rc = glanceGetVersion(&ver);
        m_connected = R_SUCCEEDED(rc);
        char buf[96];
        if (!m_connected) {
            glanceClose();
            std::snprintf(buf, sizeof(buf), "Not running (0x%X)", rc);
        } else if (ver != GLANCE_IPC_VERSION) {
            std::snprintf(buf, sizeof(buf), "Connected, but IPC v%u != v%u: update both", ver, GLANCE_IPC_VERSION);
        } else {
            std::snprintf(buf, sizeof(buf), "Connected (IPC v%u)", ver);
        }
        m_connText = buf;
    }

    WrappedText *m_text = nullptr;
    std::string m_connText = "Connecting...";
    bool m_connected = false;
    Phase m_phase = Phase::Idle;
    u32 m_pendingJob = 0;
    u32 m_phaseFrames = 0;
    u64 m_frame = 0;
    u64 m_jobStartFrame = 0;
};

class GlanceOverlay : public tsl::Overlay {
public:
    /* libtesla already initialised fs, hid, pl, pmdmnt, hid:sys and set:sys. */
    virtual void initServices() override {}
    virtual void exitServices() override { glanceClose(); }

    /* If the overlay is closed mid-capture, never leave it invisible. */
    virtual void onHide() override { g_blank = false; }

    virtual std::unique_ptr<tsl::Gui> loadInitialGui() override { return initially<MainGui>(); }
};

} // namespace

int main(int argc, char **argv) {
    return tsl::loop<GlanceOverlay>(argc, argv);
}
