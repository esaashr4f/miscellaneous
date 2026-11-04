#pragma once
/*
 * WrappedText: a tesla element that word-wraps UTF-8 text to its width and
 * can be scrolled. libtesla has no multi-line text element, and Claude's
 * replies need one, so this is the one bit of custom UI.
 *
 * Wrapping rules: break on spaces; CJK ideographs/kana (no spaces between
 * words) may break between any two characters. Hangul is space-separated, so
 * it wraps like Latin text.
 */
#include <tesla.hpp>
#include <string>
#include <vector>

class WrappedText : public tsl::elm::Element {
public:
    explicit WrappedText(u32 fontSize = 19) : m_fontSize(fontSize) {}

    void setText(const std::string &text) {
        if (text == m_text) return;
        m_text = text;
        m_dirty = true;
        m_scroll = 0;
    }

    /* Scroll by a number of lines (negative = up). */
    void scrollBy(s32 lines) {
        s32 visible = this->getHeight() / lineHeight();
        s32 maxScroll = std::max<s32>(0, (s32)m_lines.size() - visible);
        m_scroll = std::clamp<s32>(m_scroll + lines, 0, maxScroll);
    }

    bool canScroll() const { return m_canScroll; }

    virtual void draw(tsl::gfx::Renderer *renderer) override {
        if (m_dirty || m_wrappedWidth != this->getWidth()) rewrap(renderer);

        renderer->enableScissoring(ELEMENT_BOUNDS(this));
        s32 y = this->getY() + m_fontSize;
        for (size_t i = m_scroll; i < m_lines.size(); i++) {
            if (y - (s32)m_fontSize > this->getY() + this->getHeight()) break;
            renderer->drawString(m_lines[i].c_str(), false, this->getX(), y, m_fontSize,
                                 a(tsl::style::color::ColorText));
            y += lineHeight();
        }
        renderer->disableScissoring();

        s32 visible = this->getHeight() / lineHeight();
        m_canScroll = (s32)m_lines.size() > visible;
        if (m_canScroll) {
            /* Simple scrollbar on the right edge. */
            s32 h = this->getHeight();
            s32 barH = std::max<s32>(20, h * visible / (s32)m_lines.size());
            s32 maxScroll = (s32)m_lines.size() - visible;
            s32 barY = this->getY() + (h - barH) * m_scroll / std::max<s32>(1, maxScroll);
            renderer->drawRect(this->getX() + this->getWidth() - 3, barY, 3, barH, a(0xF888));
        }
    }

    virtual void layout(u16 parentX, u16 parentY, u16 parentWidth, u16 parentHeight) override {}

private:
    s32 lineHeight() const { return (s32)(m_fontSize * 1.3f); }

    static bool isBreakAnywhere(u32 cp) {
        bool hangul = (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3130 && cp <= 0x318F) ||
                      (cp >= 0xAC00 && cp <= 0xD7AF);
        return cp >= 0x2E80 && !hangul;
    }

    s32 measure(tsl::gfx::Renderer *r, const std::string &s) {
        if (s.empty()) return 0;
        return (s32)r->drawString(s.c_str(), false, 0, 0, m_fontSize, tsl::style::color::ColorTransparent).first;
    }

    void pushToken(tsl::gfx::Renderer *r, const std::string &tok, std::string &line, s32 &lineW, s32 maxW) {
        bool isSpace = tok == " ";
        s32 w = measure(r, tok);
        if (lineW + w > maxW && !line.empty()) {
            while (!line.empty() && line.back() == ' ') line.pop_back();
            m_lines.push_back(line);
            line.clear();
            lineW = 0;
            if (isSpace) return; /* don't start a line with a space */
        }
        line += tok;
        lineW += w;
    }

    void rewrap(tsl::gfx::Renderer *r) {
        m_lines.clear();
        m_wrappedWidth = this->getWidth();
        m_dirty = false;
        s32 maxW = this->getWidth() - 8; /* leave room for the scrollbar */

        std::string line, word;
        s32 lineW = 0;
        const u8 *p = reinterpret_cast<const u8 *>(m_text.c_str());
        while (*p) {
            u32 cp;
            ssize_t n = decode_utf8(&cp, p);
            if (n <= 0) break;
            std::string ch(reinterpret_cast<const char *>(p), n);
            p += n;

            if (cp == '\n') {
                pushToken(r, word, line, lineW, maxW);
                word.clear();
                m_lines.push_back(line);
                line.clear();
                lineW = 0;
            } else if (cp == ' ') {
                pushToken(r, word, line, lineW, maxW);
                word.clear();
                pushToken(r, " ", line, lineW, maxW);
            } else if (isBreakAnywhere(cp)) {
                pushToken(r, word, line, lineW, maxW);
                word.clear();
                pushToken(r, ch, line, lineW, maxW);
            } else {
                word += ch;
            }
        }
        pushToken(r, word, line, lineW, maxW);
        if (!line.empty()) m_lines.push_back(line);
        scrollBy(0); /* re-clamp */
    }

    std::string m_text;
    std::vector<std::string> m_lines;
    u32 m_fontSize;
    s32 m_scroll = 0;
    s32 m_wrappedWidth = -1;
    bool m_dirty = true;
    bool m_canScroll = false;
};
