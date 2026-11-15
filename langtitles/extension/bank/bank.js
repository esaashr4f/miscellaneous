// Word bank: saved words and characters, known characters, Anki export and backups.
(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  let items = [];
  let known = { ja: '', zh: '' };
  let tab = 'word';

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer = null;
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
  }

  function fmtTime(t) {
    const s = Math.max(0, Math.floor(t || 0));
    const m = Math.floor(s / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  async function load() {
    items = await SG.cache.getAll('bank');
    known = Object.assign({ ja: '', zh: '' }, (await browser.storage.local.get('known')).known);
    const langs = [...new Set(items.map((x) => x.lang))].filter(Boolean);
    const sel = $('lang');
    const cur = sel.value;
    sel.textContent = '';
    sel.append(new Option('All languages', ''));
    for (const l of langs) sel.append(new Option(SG.lang.langName(l), l));
    sel.value = langs.includes(cur) ? cur : '';
    $('nWord').textContent = items.filter((x) => x.kind === 'word').length || '';
    $('nChar').textContent = items.filter((x) => x.kind === 'char').length || '';
    $('nKnown').textContent = Array.from(known.ja + known.zh).length || '';
    render();
  }

  function visible(kind) {
    const q = $('search').value.trim().toLowerCase();
    const lang = $('lang').value;
    let list = items.filter((x) => x.kind === kind && (!lang || x.lang === lang));
    if (q) list = list.filter((x) => JSON.stringify(x).toLowerCase().includes(q));
    const sort = $('sort').value;
    if (sort === 'az') list.sort((a, b) => a.text.localeCompare(b.text, a.lang));
    else if (sort === 'old') list.sort((a, b) => a.savedAt - b.savedAt);
    else list.sort((a, b) => (b.updatedAt || b.savedAt) - (a.updatedAt || a.savedAt));
    return list;
  }

  function rubyEl(segments, fallback) {
    const span = h('span', 'head-word');
    if (!segments) {
      span.textContent = fallback;
      return span;
    }
    for (const seg of segments) {
      if (seg.r && SG.ruby.hanChars(seg.t).length) {
        const r = document.createElement('ruby');
        r.append(document.createTextNode(seg.t), h('rt', '', seg.r));
        span.append(r);
      } else span.append(document.createTextNode(seg.t));
    }
    return span;
  }

  async function remove(item) {
    await browser.runtime.sendMessage({ type: 'bankRemove', key: item.key });
    toast(`Removed ${item.text}`);
    load();
  }

  async function toggleKnown(ch, lang) {
    const set = new Set(Array.from(known[lang] || ''));
    if (set.has(ch)) set.delete(ch);
    else set.add(ch);
    known[lang] = Array.from(set).join('');
    await browser.storage.local.set({ known });
    return set.has(ch);
  }

  function contexts(item, card) {
    if (!item.contexts || !item.contexts.length) return;
    card.append(h('div', 'section', item.contexts.length > 1 ? `Seen in ${item.contexts.length} lines` : 'Seen in'));
    for (const c of item.contexts) {
      const row = h('div', 'ctx');
      const s = h('div', 's', c.sentence);
      s.lang = item.lang;
      row.append(s);
      if (c.translation) row.append(h('div', 't', c.translation));
      const src = h('div', 'src');
      src.append(document.createTextNode([c.show, c.url ? fmtTime(c.time) : ''].filter(Boolean).join(' · ') + ' '));
      if (c.url && /^https?:/.test(c.url)) {
        const a = h('a', '', 'Watch this line');
        a.title = 'Opens the page; the video jumps to this line when it starts playing';
        a.addEventListener('click', () => browser.runtime.sendMessage({ type: 'openAt', url: c.url, time: c.time }));
        src.append(a);
      }
      row.append(src);
      card.append(row);
    }
  }

  function wordCard(item) {
    const w = item.word || {};
    const card = h('div', 'card');
    const head = h('div', 'card-head');
    head.append(rubyEl(w.s === item.text ? w.f : null, item.text));
    if (w.s && w.s !== item.text) head.append(h('span', 'pos', 'seen as ' + w.s + (w.r ? ` (${w.r})` : '')));
    else if (w.r && !(w.f && w.f.some((x) => x.r))) head.append(h('span', 'reading', w.r));
    head.append(h('span', 'lang-tag', SG.lang.langName(item.lang)), h('span', 'spacer'));
    const del = h('button', 'icon-btn', 'Remove');
    del.addEventListener('click', () => remove(item));
    head.append(del);
    card.append(head);
    if (w.m) card.append(h('div', 'meaning', w.m));
    if (w.pos) card.append(h('div', 'pos', w.pos));
    if (Array.isArray(w.p) && w.p.length > 1) {
      const pieces = h('div', 'pieces');
      w.p.forEach((p, i) => {
        if (i) pieces.append(h('span', 'plus', '+'));
        const el = h('span', 'piece');
        el.append(h('b', '', p.t), h('small', '', p.g));
        pieces.append(el);
      });
      card.append(pieces);
    }
    if (w.n) card.append(h('div', 'note', w.n));
    if (Array.isArray(w.g) && w.g.length) {
      const chips = h('div', 'chips');
      for (const f of w.g) {
        const a = h('a', 'chip', f.name || f.k);
        a.href = '../grammar/grammar.html#' + encodeURIComponent(f.k);
        a.title = 'Open the grammar guide (if you have opened it while watching)';
        chips.append(a);
      }
      card.append(chips);
    }
    contexts(item, card);
    return card;
  }

  function charCard(item) {
    const e = item.entry || {};
    const ch = item.text;
    const card = h('div', 'card');
    const head = h('div', 'card-head');
    const c = h('span', 'head-char', ch);
    c.lang = item.lang;
    head.append(c);
    const reads = h('span', 'reading', (e.readings || []).map((r) => r.r).join('  ·  '));
    head.append(reads, h('span', 'lang-tag', SG.lang.langName(item.lang)), h('span', 'spacer'));
    const isKnown = Array.from(known[item.lang] || '').includes(ch);
    const kb = h('button', 'icon-btn' + (isKnown ? ' known-on' : ''), isKnown ? '✓ Known' : 'Mark known');
    kb.addEventListener('click', async () => {
      const now = await toggleKnown(ch, item.lang);
      kb.textContent = now ? '✓ Known' : 'Mark known';
      kb.classList.toggle('known-on', now);
      $('nKnown').textContent = Array.from(known.ja + known.zh).length || '';
    });
    const del = h('button', 'icon-btn', 'Remove');
    del.addEventListener('click', () => remove(item));
    head.append(kb, del);
    card.append(head);
    if (e.meanings && e.meanings.length) card.append(h('div', 'meaning', e.meanings.join('; ')));
    if (e.parts && e.parts.length) {
      const pieces = h('div', 'pieces');
      e.parts.forEach((p, i) => {
        if (i) pieces.append(h('span', 'plus', '+'));
        const el = h('span', 'piece');
        el.append(h('b', '', p.c), h('small', '', p.g));
        pieces.append(el);
      });
      card.append(pieces);
    }
    if (e.build) card.append(h('div', 'note', e.build));
    if (e.readings && e.readings.some((r) => r.use)) {
      card.append(h('div', 'section', 'Readings'));
      for (const r of e.readings) card.append(h('div', 'li', `${r.r} — ${r.use}`));
    }
    if (e.words && e.words.length) {
      card.append(h('div', 'section', 'Words with it'));
      for (const x of e.words) {
        const li = h('div', 'li');
        li.append(h('span', 'w', x.w), h('span', 'reading', ' ' + (x.r || '')), document.createTextNode(' — ' + x.m));
        card.append(li);
      }
    }
    const mine = items.filter((x) => x.kind === 'word' && x.lang === item.lang && (x.text.includes(ch) || (x.word && (x.word.s || '').includes(ch))));
    if (mine.length) {
      card.append(h('div', 'section', 'In your saved words'));
      const chips = h('div', 'chips');
      for (const x of mine.slice(0, 30)) chips.append(h('span', 'chip', x.text));
      card.append(chips);
    }
    if (e.notes && e.notes.length) {
      card.append(h('div', 'section', 'Notes'));
      for (const n of e.notes) card.append(h('div', 'li', n));
    }
    contexts(item, card);
    return card;
  }

  function knownPanel() {
    const wrap = document.createDocumentFragment();
    for (const lang of ['ja', 'zh']) {
      const box = h('div', 'known-box');
      const chars = Array.from(known[lang] || '');
      box.append(h('h2', '', `${lang === 'ja' ? 'Kanji' : 'Chinese characters'} you know (${chars.length})`));
      box.append(h('p', '', lang === 'ja'
        ? 'No furigana is shown over these. Paste any text to add every kanji in it, for example a JLPT or school-grade kanji list.'
        : 'With "No pinyin over characters I know" on (Options), no pinyin is shown over these. Paste any text to add every character in it.'));
      const add = h('div', 'known-add');
      const ta = h('textarea');
      ta.placeholder = lang === 'ja' ? '日本人 大小 上下 …' : '你好 我们 中国 …';
      const btn = h('button', '', 'Add');
      btn.addEventListener('click', async () => {
        const got = SG.ruby.hanChars(ta.value);
        const set = new Set(Array.from(known[lang] || ''));
        let n = 0;
        for (const c of got) if (!set.has(c)) {
          set.add(c);
          n++;
        }
        known[lang] = Array.from(set).join('');
        await browser.storage.local.set({ known });
        ta.value = '';
        toast(n ? `Added ${n} character${n === 1 ? '' : 's'}` : 'No new characters in that text');
        load();
      });
      add.append(ta, btn);
      box.append(add);
      const grid = h('div', 'known-grid');
      grid.lang = lang;
      for (const c of chars) {
        const b = h('button', '', c);
        b.title = 'Click to remove';
        b.addEventListener('click', async () => {
          await toggleKnown(c, lang);
          load();
        });
        grid.append(b);
      }
      box.append(grid);
      wrap.append(box);
    }
    return wrap;
  }

  function render() {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    $('filters').style.display = tab === 'known' ? 'none' : '';
    $('exportAnki').style.display = tab === 'known' ? 'none' : '';
    const main = $('list');
    main.textContent = '';
    if (tab === 'known') {
      main.append(knownPanel());
      return;
    }
    const list = visible(tab);
    if (!list.length) {
      main.append(h('div', 'empty', items.some((x) => x.kind === tab)
        ? 'Nothing matches.'
        : tab === 'word'
          ? 'No saved words yet. While watching, hover a word and click ☆ to save it.'
          : 'No saved characters yet. While watching, hover a word, click one of its characters, then click ☆.'));
      return;
    }
    for (const item of list) main.append(tab === 'word' ? wordCard(item) : charCard(item));
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  $('exportAnki').addEventListener('click', () => {
    const list = visible(tab);
    if (!list.length) {
      toast('Nothing to export');
      return;
    }
    const first = (x) => (x.contexts && x.contexts[0]) || {};
    let tsv;
    if (tab === 'word') {
      tsv = SG.ruby.toAnkiTsv(
        ['Word', 'Furigana', 'Reading', 'Meaning', 'Pieces', 'Sentence', 'Translation', 'Notes', 'Source'],
        list.map((x) => {
          const w = x.word || {};
          return [
            x.text,
            w.s === x.text ? SG.ruby.ankiFurigana(w.f) : x.text,
            w.r || '',
            w.m || '',
            (w.p || []).map((p) => `${p.t} (${p.g})`).join(' + '),
            first(x).sentence || '',
            first(x).translation || '',
            [w.pos, w.n].filter(Boolean).join('<br>'),
            first(x).show || '',
          ];
        }),
        'langtitles',
      );
    } else {
      tsv = SG.ruby.toAnkiTsv(
        ['Character', 'Readings', 'Meanings', 'Parts', 'How it is built', 'Words', 'Example'],
        list.map((x) => {
          const e = x.entry || {};
          return [
            x.text,
            (e.readings || []).map((r) => r.r).join(' · '),
            (e.meanings || []).join('; '),
            (e.parts || []).map((p) => `${p.c} (${p.g})`).join(' + '),
            e.build || '',
            (e.words || []).map((w) => `${w.w} ${w.r} — ${w.m}`).join('<br>'),
            first(x).sentence || '',
          ];
        }),
        'langtitles',
      );
    }
    download(`langtitles-${tab === 'word' ? 'words' : 'characters'}.txt`, tsv, 'text/tab-separated-values;charset=utf-8');
    toast(`Exported ${list.length}. In Anki: File → Import, choose the file.`);
  });

  $('backup').addEventListener('click', () => {
    const data = { app: 'langtitles', version: 1, exportedAt: new Date().toISOString(), items, known };
    download('langtitles-word-bank.json', JSON.stringify(data, null, 1), 'application/json');
  });

  $('restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      toast('That is not a word bank backup');
      return;
    }
    const list = Array.isArray(data.items) ? data.items.filter((x) => x && x.key && x.kind && x.text) : [];
    if (list.length) await browser.runtime.sendMessage({ type: 'bankPut', items: list });
    if (data.known) {
      for (const lang of ['ja', 'zh']) {
        known[lang] = Array.from(new Set(Array.from((known[lang] || '') + (data.known[lang] || '')))).join('');
      }
      await browser.storage.local.set({ known });
    }
    toast(`Restored ${list.length} items`);
    load();
  });

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      render();
    });
  }
  for (const id of ['search', 'lang', 'sort']) $(id).addEventListener('input', render);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
  await load();
})();
