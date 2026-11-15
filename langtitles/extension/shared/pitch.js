// Japanese pitch accent: splitting kana into morae, the high/low pattern for an accent
// number, and drawing it. Accent data: Kanjium (CC BY-SA 4.0), loaded by the background page.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const SMALL = /[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ]/;

  function morae(kana) {
    const out = [];
    for (const ch of Array.from(String(kana || ''))) {
      if (SMALL.test(ch) && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  // H/L for each mora, plus the pitch of a following particle.
  //  0 heiban: low then high, and a particle stays high.
  //  1 atamadaka: high then low.
  //  n nakadaka / odaka: low, high up to mora n, then low (odaka when n is the last mora: the particle drops).
  function pattern(count, accent) {
    const marks = [];
    for (let i = 1; i <= count; i++) {
      if (accent === 1) marks.push(i === 1 ? 'H' : 'L');
      else if (i === 1) marks.push('L');
      else marks.push(accent === 0 || i <= accent ? 'H' : 'L');
    }
    const particle = accent === 0 ? 'H' : 'L';
    return { marks, particle, drop: accent > 0 ? accent - 1 : -1 };
  }

  function name(count, accent) {
    if (accent === 0) return 'heiban (flat)';
    if (accent === 1) return 'atamadaka (high start)';
    if (accent === count) return 'odaka (drops after the word)';
    return 'nakadaka (drops inside the word)';
  }

  // Draws kana with a line over high morae, a rise and a drop, and the accent number.
  function render(kana, accent, doc) {
    const d = doc || document;
    const ms = morae(kana);
    const p = pattern(ms.length, accent);
    const wrap = d.createElement('span');
    wrap.className = 'pa';
    wrap.title = `Pitch accent [${accent}]: ${name(ms.length, accent)}`;
    ms.forEach((m, i) => {
      const s = d.createElement('span');
      let cls = 'pa-m ' + (p.marks[i] === 'H' ? 'pa-h' : 'pa-l');
      if (p.marks[i] === 'H' && i > 0 && p.marks[i - 1] === 'L') cls += ' pa-up';
      if (i === p.drop) cls += ' pa-down';
      s.className = cls;
      s.textContent = m;
      wrap.append(s);
    });
    // The following particle: shows whether the word ends high (heiban) or drops (odaka).
    const part = d.createElement('span');
    part.className = 'pa-m pa-part ' + (p.particle === 'H' ? 'pa-h' : 'pa-l') + (p.particle === 'H' && p.marks[ms.length - 1] === 'L' ? ' pa-up' : '');
    part.textContent = '○';
    wrap.append(part);
    const n = d.createElement('span');
    n.className = 'pa-n';
    n.textContent = accent;
    wrap.append(n);
    return wrap;
  }

  // Kanjium's accents.txt: "word<TAB>reading<TAB>accents". Accents can carry part-of-speech
  // notes like "(名)0"; the numbers are what matter here.
  function parseKanjium(text) {
    const map = new Map();
    for (const line of String(text).split('\n')) {
      const cols = line.split('\t');
      if (cols.length < 3) continue;
      const accents = (cols[2].match(/\d+/g) || []).map(Number);
      if (!accents.length) continue;
      const word = cols[0];
      const reading = cols[1] || cols[0];
      if (!map.has(word)) map.set(word, []);
      map.get(word).push({ r: reading, a: accents });
      // Kana-only words are also looked up by their reading.
      if (reading !== word && !map.has(reading) && /^[぀-ヿ]+$/.test(word)) map.set(reading, map.get(word));
    }
    return map;
  }

  function toHira(s) {
    return String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  // The entry for a word, using the reading to choose between homographs (母: はは, not かか).
  function lookup(map, word, reading) {
    const list = map.get(word) || map.get(toHira(word));
    if (!list) return null;
    if (reading) {
      const hit = list.find((e) => toHira(e.r) === toHira(reading));
      if (hit) return hit;
    }
    return list.length === 1 ? list[0] : null;
  }

  SG.pitch = { morae, pattern, name, render, parseKanjium, lookup };
})(typeof globalThis !== 'undefined' ? globalThis : this);
