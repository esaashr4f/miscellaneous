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
    } else {
      const w = h('div', 'big', card.text);
      w.lang = card.lang;
      box.append(w);
    }
    const ex = example(card);
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
    if (card.kind === 'char') {
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

  async function markKnown(item) {
    const r = await browser.storage.local.get(['known', 'knownWords']);
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
