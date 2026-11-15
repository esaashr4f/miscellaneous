// Furigana and pinyin placement, known-character handling, and Anki export formatting.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  // CJK ideographs, plus 々 (repeat mark) and ヶ, which behave like kanji in readings.
  const HAN = /[㐀-䶿一-鿿豈-﫿々ヶ]|[\ud840-\ud87f][\udc00-\udfff]/;
  const HAN_G = new RegExp(HAN.source, 'g');

  function isHan(ch) {
    return HAN.test(ch);
  }

  function hanChars(text) {
    return Array.from(new Set(String(text || '').match(HAN_G) || [])).filter((c) => c !== '々' && c !== 'ヶ');
  }

  function kataToHira(s) {
    return String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Split a word into runs of kanji and runs of everything else.
  function runs(s) {
    const out = [];
    for (const ch of Array.from(s)) {
      const han = isHan(ch);
      const last = out[out.length - 1];
      if (last && last.han === han) last.t += ch;
      else out.push({ t: ch, han });
    }
    return out;
  }

  // From a word and its whole hiragana reading, give each kanji run its share of the reading:
  // the kana written in the word must appear in the reading, which pins the kanji readings between.
  function deriveFurigana(s, reading) {
    s = String(s || '');
    const r = kataToHira(reading);
    const parts = runs(s);
    if (!r || !parts.some((p) => p.han)) return [{ t: s, r: '' }];
    const re = new RegExp('^' + parts.map((p) => (p.han ? '(.+?)' : escapeRe(kataToHira(p.t)))).join('') + '$');
    const m = re.exec(r);
    if (!m) return [{ t: s, r: reading }];
    let g = 1;
    return parts.map((p) => ({ t: p.t, r: p.han ? m[g++] : '' }));
  }

  function validSegments(f, s) {
    return Array.isArray(f) && f.length > 0 && f.every((x) => x && typeof x.t === 'string') && f.map((x) => x.t).join('') === s;
  }

  // Ruby segments for a word in a language, or null when the language gets no readings.
  function segmentsFor(w, lang) {
    if (!w || !w.s) return null;
    const s = w.s;
    if (lang === 'ja') {
      if (!hanChars(s).length) return null;
      if (validSegments(w.f, s) && w.f.every((x) => !hanChars(x.t).length || x.r)) {
        return w.f.map((x) => ({ t: x.t, r: hanChars(x.t).length ? kataToHira(x.r) : '' }));
      }
      return w.r ? deriveFurigana(s, w.r) : null;
    }
    if (lang === 'zh') {
      if (!hanChars(s).length) return null;
      if (validSegments(w.f, s) && w.f.some((x) => x.r)) return w.f.map((x) => ({ t: x.t, r: hanChars(x.t).length ? x.r || '' : '' }));
      // "huǒ chē" with one syllable per character can be spread over the characters.
      const chars = Array.from(s);
      const syll = String(w.r || '').trim().split(/\s+/).filter(Boolean);
      if (syll.length && syll.length === chars.filter(isHan).length) {
        let i = 0;
        return chars.map((c) => ({ t: c, r: isHan(c) ? syll[i++] : '' }));
      }
      return w.r ? [{ t: s, r: w.r }] : null;
    }
    return null;
  }

  // A segment's reading is hidden when every kanji in it is one the learner knows.
  function showReading(seg, known) {
    if (!seg.r) return false;
    const chars = hanChars(seg.t);
    if (!chars.length) return false;
    return !known || !chars.every((c) => known.has(c));
  }

  // Anki's furigana syntax: " 食[た]べる". The space marks where the kanji run begins.
  function ankiFurigana(segments) {
    if (!segments) return '';
    let out = '';
    for (const seg of segments) {
      if (seg.r && hanChars(seg.t).length) out += (out ? ' ' : '') + seg.t + '[' + seg.r + ']';
      else out += seg.t;
    }
    return out;
  }

  // Tab-separated text Anki imports directly (File → Import), with header lines it understands.
  function toAnkiTsv(columns, rows, tags) {
    const clean = (v) => String(v == null ? '' : v).replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
    const lines = ['#separator:tab', '#html:true', '#columns:' + columns.join('\t')];
    if (tags) lines.push('#tags column:' + (columns.length + 1));
    for (const row of rows) lines.push(row.map(clean).concat(tags ? [clean(tags)] : []).join('\t'));
    return lines.join('\n') + '\n';
  }

  SG.ruby = { isHan, hanChars, kataToHira, deriveFurigana, segmentsFor, showReading, ankiFurigana, toAnkiTsv };
})(typeof globalThis !== 'undefined' ? globalThis : this);
