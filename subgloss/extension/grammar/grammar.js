// Grammar library: every guide SubGloss has written, readable and searchable after watching.
(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  let guides = [];
  let lang = '';
  let current = '';

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function load() {
    guides = (await SG.cache.getAll('guides')).sort((a, b) => b.savedAt - a.savedAt);
    $('count').textContent = guides.length === 1 ? '1 form' : `${guides.length} forms`;
    const langs = [...new Set(guides.map((g) => SG.lang.langCode(g.lang || (g.k || '').split('.')[0])))];
    const box = $('langs');
    box.textContent = '';
    if (langs.length > 1) {
      for (const code of [''].concat(langs)) {
        const b = h('button', code === lang ? 'on' : '', code ? SG.lang.langName(code) : 'All');
        b.addEventListener('click', () => {
          lang = code;
          load();
        });
        box.append(b);
      }
    }
    renderList();
    const wanted = decodeURIComponent(location.hash.slice(1));
    const pick = guides.find((g) => g.k === wanted) || guides.find((g) => g.k === current) || guides[0];
    if (pick) show(pick);
  }

  function matches(g, q) {
    if (lang && SG.lang.langCode(g.lang || g.k.split('.')[0]) !== lang) return false;
    if (!q) return true;
    return [g.name, g.k, g.text, g.sentence].join('\n').toLowerCase().includes(q);
  }

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const nav = $('list');
    nav.textContent = '';
    for (const g of guides.filter((x) => matches(x, q))) {
      const a = h('a', g.k === current ? 'on' : '');
      a.href = '#' + encodeURIComponent(g.k);
      a.append(document.createTextNode(g.name || g.k), h('small', '', SG.lang.langName(g.lang || g.k.split('.')[0])));
      a.addEventListener('click', (e) => {
        e.preventDefault();
        history.replaceState(null, '', a.href);
        show(g);
      });
      nav.append(a);
    }
  }

  function show(g) {
    current = g.k;
    for (const a of $('list').children) a.classList.toggle('on', a.getAttribute('href') === '#' + encodeURIComponent(g.k));
    const view = $('view');
    view.textContent = '';
    const head = h('div', 'head');
    head.append(h('h2', '', g.name || g.k));
    const meta = h('div', 'meta');
    meta.append(document.createTextNode(SG.lang.langName(g.lang || g.k.split('.')[0]) + ' · first met in '));
    const q = h('q', '', g.sentence || '');
    if (g.lang) q.lang = g.lang;
    meta.append(q, document.createTextNode(' · ' + new Date(g.savedAt).toLocaleDateString()));
    head.append(meta);
    const tools = h('div', 'tools');
    const del = h('button', '', 'Delete this guide');
    del.title = 'The next time you meet this form, SubGloss writes a fresh guide';
    del.addEventListener('click', async () => {
      await SG.cache.remove('guides', g.key);
      current = '';
      history.replaceState(null, '', location.pathname);
      load();
    });
    tools.append(del);
    const body = h('div', 'guide');
    if (g.lang) body.lang = g.lang;
    SG.renderGuide(body, g.text);
    view.append(head, tools, body);
    window.scrollTo(0, 0);
  }

  $('search').addEventListener('input', renderList);
  // Guides written while this tab is open show up when you come back to it.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
  window.addEventListener('hashchange', () => {
    const g = guides.find((x) => x.k === decodeURIComponent(location.hash.slice(1)));
    if (g) show(g);
  });
  await load();
})();
