// Flashcard review of the word bank with spaced repetition.
(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  const settings = await SG.loadSettings();
  let items = [];
  let queue = [];
  let card = null;
  let revealed = false;
  let reviewedNow = 0;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function newLeft() {
    const log = (await browser.storage.local.get('reviewLog')).reviewLog || {};
    const today = SG.srs.dayKey(Date.now());
    return Math.max(0, (settings.newPerDay || 20) - (log.day === today ? log.newDone || 0 : 0));
  }

  async function countNewDone() {
    const r = (await browser.storage.local.get('reviewLog')).reviewLog || {};
    const today = SG.srs.dayKey(Date.now());
    const log = r.day === today ? r : { day: today, newDone: 0 };
    log.newDone += 1;
    await browser.storage.local.set({ reviewLog: log });
  }

  async function build() {
    const which = $('which').value;
    items = (await SG.cache.getAll('bank')).filter((x) => which === 'all' || x.kind === which);
    queue = SG.srs.queue(items, Date.now(), await newLeft());
    next();
  }

  function updateCounts() {
    const now = Date.now();
    const fresh = queue.filter((x) => !x.srs || x.srs.state === 'new').length;
    const learning = queue.filter((x) => x.srs && (x.srs.state === 'learning' || x.srs.state === 'relearning')).length;
    const due = queue.length - fresh - learning;
    const c = $('counts');
    c.textContent = '';
    c.append(h('b', '', String(fresh)), document.createTextNode(' new · '), h('b', '', String(learning)), document.createTextNode(' learning · '), h('b', '', String(due)), document.createTextNode(' to review'));
    void now;
  }

  function rubyWord(item) {
    const w = item.word || {};
    const el = h('div', 'big');
    el.lang = item.lang;
    const segs = w.s === item.text ? w.f : null;
    if (!segs) {
      el.textContent = item.text;
      return el;
    }
    for (const s of segs) {
      if (s.r && SG.ruby.hanChars(s.t).length) {
        const r = document.createElement('ruby');
        r.append(document.createTextNode(s.t), h('rt', '', s.r));
        el.append(r);
      } else el.append(document.createTextNode(s.t));
    }
    return el;
  }

  function example(item) {
    const c = (item.contexts || [])[0];
    if (!c || !c.sentence) return null;
    const box = h('div', 'example');
    box.lang = item.lang;
    const target = item.kind === 'char' ? item.text : (item.word && item.word.s) || item.text;
    const at = c.sentence.indexOf(target);
    if (at >= 0) {
      box.append(document.createTextNode(c.sentence.slice(0, at)), h('mark', '', target), document.createTextNode(c.sentence.slice(at + target.length)));
    } else box.textContent = c.sentence;
    return box;
  }

  async function say(text, lang) {
    const ok = await SG.speech.speak(text, lang);
    if (!ok) alert(SG.speech.missingVoiceHelp(lang));
  }

  function front() {
    const box = $('card');
    box.textContent = '';
    if (card.kind === 'char') {
      const c = h('div', 'big char', card.text);
      c.lang = card.lang;
      box.append(c);
    } else if (card.kind === 'line') {
      const l = h('div', 'line', card.text);
      l.lang = card.lang;
      box.append(l);
    } else if (card.kind === 'grammar') {
      grammarFront(box);
    } else {
      const w = h('div', 'big', card.text);
      w.lang = card.lang;
      box.append(w);
    }
    const ex = card.kind === 'word' || card.kind === 'char' ? example(card) : null;
    if (ex) box.append(ex);
    const controls = $('controls');
    controls.textContent = '';
    const show = h('button', 'show', 'Show answer');
    show.append(h('small', '', 'Space'));
    show.addEventListener('click', reveal);
    controls.append(show);
  }

  function strokeArea(ch, lang, into) {
    const wrap = h('div', 'strokes');
    const pic = h('div', 'pic');
    const legend = h('div', 'legend');
    wrap.append(pic, legend);
    into.append(h('div', 'section', 'Stroke order'), wrap);
    browser.runtime.sendMessage({ type: 'stroke', ch, lang }).then((res) => {
      if (!res || !res.data) {
        pic.textContent = 'No stroke order data.';
        return;
      }
      const data = res.data.kind === 'kvg' ? SG.strokes.parseKanjiVG(res.data.text) : SG.strokes.parseHanziWriter(res.data.text);
      SG.strokes.render(pic, data, { size: 150 });
      legend.append(h('div', '', `${data.strokes.length} strokes`));
      for (const c of SG.strokes.legend(data)) {
        const row = h('div');
        const sw = h('span', 'sw', c.element);
        sw.style.color = c.color;
        row.append(sw, document.createTextNode([c.original ? `from ${c.original}` : '', c.role].filter(Boolean).join(' · ')));
        legend.append(row);
      }
      const again = h('button', 'say', 'Replay');
      again.addEventListener('click', () => SG.strokes.render(pic, data, { size: 150 }));
      legend.append(again);
    });
  }

  function reveal() {
    if (revealed || !card) return;
    revealed = true;
    const box = $('card');
    box.textContent = '';
    const ans = h('div');
    if (card.kind === 'line') {
      const L = card.line || {};
      const l = h('div', 'line', card.text);
      l.lang = card.lang;
      box.append(l);
      ans.className = 'answer';
      ans.append(h('div', 'meaning', L.tr || ''));
      if (L.lit) ans.append(h('div', 'tr', L.lit));
      const sayBtn = h('button', 'say', '🔊 Hear it');
      sayBtn.addEventListener('click', () => say(card.text, card.lang));
      const center = h('div', '');
      center.style.textAlign = 'center';
      center.append(sayBtn);
      ans.append(center);
      if (Array.isArray(L.w) && L.w.length) {
        const words = h('div', 'words');
        for (const w of L.w) {
          const one = h('span');
          one.append(h('b', '', w.s), document.createTextNode(w.r ? ` ${w.r} ` : ' '), h('span', 'm', w.m || ''));
          words.append(one);
        }
        ans.append(words);
      }
      for (const n of L.notes || []) ans.append(h('div', 'note', n));
    } else if (card.kind === 'grammar') {
      grammarBack(box, ans);
    } else if (card.kind === 'char') {
      const e = card.entry || {};
      const c = h('div', 'big char', card.text);
      c.lang = card.lang;
      box.append(c);
      ans.className = 'answer';
      ans.append(h('div', 'reading', (e.readings || []).map((r) => r.r).join('  ·  ')));
      ans.append(h('div', 'meaning', (e.meanings || []).join('; ')));
      if (e.parts && e.parts.length) {
        const pieces = h('div', 'pieces');
        e.parts.forEach((p, i) => {
          if (i) pieces.append(h('span', 'note', '+'));
          const el = h('span', 'piece');
          el.append(h('b', '', p.c), h('small', '', p.g));
          pieces.append(el);
        });
        ans.append(pieces);
      }
      if (e.build) ans.append(h('div', 'note', e.build));
      strokeArea(card.text, card.lang, ans);
      if (e.words && e.words.length) {
        ans.append(h('div', 'section', 'Words with it'));
        for (const x of e.words.slice(0, 6)) ans.append(h('div', 'li', `${x.w}  ${x.r || ''} — ${x.m}`));
      }
    } else {
      const w = card.word || {};
      box.append(rubyWord(card));
      ans.className = 'answer';
      if (w.r && !(w.s === card.text && w.f && w.f.some((x) => x.r))) ans.append(h('div', 'reading', w.r));
      ans.append(h('div', 'meaning', w.m || ''));
      if (card.lang === 'ja' && settings.pitchAccent) {
        const pitch = h('div', 'pitch');
        ans.append(pitch);
        browser.runtime.sendMessage({ type: 'pitch', items: [{ d: w.d || card.text, r: w.r, s: w.s }] }).then((res) => {
          const r = res && res.results && res.results[0];
          if (r) r.a.slice(0, 2).forEach((acc) => pitch.append(SG.pitch.render(r.r, acc)));
        });
      }
      const sayBtn = h('button', 'say', '🔊 Hear it');
      sayBtn.addEventListener('click', () => say(w.s || card.text, card.lang));
      const center = h('div', '');
      center.style.textAlign = 'center';
      center.append(sayBtn);
      ans.append(center);
      if (Array.isArray(w.p) && w.p.length > 1) {
        const pieces = h('div', 'pieces');
        w.p.forEach((p, i) => {
          if (i) pieces.append(h('span', 'note', '+'));
          const el = h('span', 'piece');
          el.append(h('b', '', p.t), h('small', '', p.g));
          pieces.append(el);
        });
        ans.append(pieces);
      }
      const ex = example(card);
      if (ex) ans.append(ex);
      const ctx = (card.contexts || [])[0];
      if (ctx && ctx.translation) ans.append(h('div', 'tr', ctx.translation));
      if (w.pos) ans.append(h('div', 'pos', w.pos));
      if (w.n) ans.append(h('div', 'note', w.n));
    }
    box.append(ans);
    const controls = $('controls');
    controls.textContent = '';
    const labels = SG.srs.preview(card.srs, Date.now());
    ['Again', 'Hard', 'Good', 'Easy'].forEach((name, i) => {
      const b = h('button', 'g' + (i + 1), name);
      b.append(h('small', '', `${labels[i]} · ${i + 1}`));
      b.addEventListener('click', () => grade(i + 1));
      controls.append(b);
    });
  }

  // Grammar cards: a new fill-in-the-blank sentence from Claude each time.
  let cloze = null;

  async function grammarFront(box) {
    box.append(h('div', 'hint', `Grammar: ${card.name || card.text}`));
    const q = h('div', 'cloze', 'Making a question…');
    q.lang = card.lang;
    box.append(q);
    const forCard = card;
    cloze = null;
    const ctx = (card.contexts || [])[0];
    const res = await browser.runtime.sendMessage({
      type: 'grammarCloze', k: card.text, name: card.name, lang: card.lang, example: ctx ? ctx.sentence : '', avoid: card.recent || [],
    });
    if (card !== forCard) return;
    if (!res || res.error || !res.q) {
      q.textContent = (res && res.error) || 'Could not make a question. Grade from memory of the guide, or skip with Good.';
      return;
    }
    cloze = res.q;
    q.textContent = '';
    const parts = cloze.sentence.split('＿＿');
    parts.forEach((part, i) => {
      if (i) q.append(h('span', 'blank', '\u00a0'));
      q.append(document.createTextNode(part));
    });
    box.append(h('div', 'hint', cloze.hint));
  }

  function grammarBack(box, ans) {
    box.append(h('div', 'hint', `Grammar: ${card.name || card.text}`));
    if (!cloze) {
      box.append(h('div', 'tr', 'No question this time.'));
    } else {
      const q = h('div', 'cloze');
      q.lang = card.lang;
      const parts = cloze.sentence.split('＿＿');
      parts.forEach((part, i) => {
        if (i) q.append(h('mark', '', cloze.answer));
        q.append(document.createTextNode(part));
      });
      box.append(q);
      ans.className = 'answer';
      ans.append(h('div', 'tr', cloze.translation));
      if (cloze.contrast) ans.append(h('div', 'meaning', `Not ${card.name || card.text} here: ${cloze.answer}`));
      ans.append(h('div', 'note', cloze.why));
      const full = parts.join(cloze.answer);
      card.recent = [full].concat(card.recent || []).slice(0, 8);
      const sayBtn = h('button', 'say', '🔊 Hear it');
      sayBtn.addEventListener('click', () => say(full, card.lang));
      const center = h('div', '');
      center.style.textAlign = 'center';
      center.append(sayBtn);
      ans.append(center);
    }
    const link = h('a', 'guide-link', 'Open the guide');
    link.href = '../grammar/grammar.html#' + encodeURIComponent(card.text);
    link.target = '_blank';
    const c2 = h('div', '');
    c2.style.textAlign = 'center';
    c2.append(link);
    ans.append(c2);
  }

  async function markKnown(item) {
    const r = await browser.storage.local.get(['known', 'knownWords']);
    if (item.kind === 'line' || item.kind === 'grammar') return;
    if (item.kind === 'char') {
      const known = Object.assign({ ja: '', zh: '' }, r.known);
      if (!known[item.lang].includes(item.text)) known[item.lang] += item.text;
      await browser.storage.local.set({ known });
    } else {
      const kw = Object.assign({}, r.knownWords);
      const set = new Set(kw[item.lang] || []);
      set.add(item.text);
      if (item.word && item.word.s) set.add(item.word.s);
      kw[item.lang] = Array.from(set);
      await browser.storage.local.set({ knownWords: kw });
    }
  }

  async function grade(g) {
    if (!card || !revealed) return;
    const now = Date.now();
    const wasNew = !card.srs || card.srs.state === 'new';
    const wasMature = SG.srs.isMature(card.srs);
    card.srs = SG.srs.schedule(card.srs, g, now);
    await browser.runtime.sendMessage({ type: 'bankPut', items: [card] });
    browser.runtime.sendMessage({ type: 'reviewed' });
    if (wasNew) await countNewDone();
    if (!wasMature && SG.srs.isMature(card.srs) && settings.autoKnownFromReview) await markKnown(card);
    reviewedNow += 1;
    queue.shift();
    // Cards still being learned come back this session, after a few others.
    if (card.srs.due - now < 20 * 60 * 1000) queue.splice(Math.min(queue.length, 3), 0, card);
    next();
  }

  function next() {
    revealed = false;
    updateCounts();
    card = queue[0] || null;
    if (card) {
      front();
      return;
    }
    const box = $('card');
    box.textContent = '';
    const done = h('div', 'done');
    const upcoming = items.filter((x) => x.srs && x.srs.state !== 'new').map((x) => x.srs.due).sort((a, b) => a - b)[0];
    done.append(h('h2', '', items.length ? 'All done for now' : 'Nothing to review yet'));
    done.append(h('p', '', items.length
      ? `${reviewedNow} reviewed this session.${upcoming ? ' Next card is due ' + new Date(upcoming).toLocaleString() + '.' : ''}`
      : 'Save words and characters while watching (☆ in the hover popup) and they show up here.'));
    box.append(done);
    $('controls').textContent = '';
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal();
      else grade(3);
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key));
  });
  $('which').addEventListener('change', build);
  await build();
})();
