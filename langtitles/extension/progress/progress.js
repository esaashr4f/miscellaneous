// Progress: what you know, how much you watch and review, and how it changes over time.
(async function () {
  'use strict';
  const SG = globalThis.SG;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const DAYS = 30;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function s(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  const store = await browser.storage.local.get(['history', 'knownWords', 'known', 'reviewLog']);
  const history = store.history || {};
  const items = await SG.cache.getAll('bank');
  const settings = await SG.loadSettings();

  // The last 30 days, oldest first.
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ date: d, key: SG.srs.dayKey(d.getTime()) });
  }
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const minutes = days.map((d) => sum((history[d.key] || {}).minutes));
  const reviews = days.map((d) => (history[d.key] || {}).reviews || 0);
  const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // ---- headline numbers
  const kw = store.knownWords || {};
  const kc = store.known || {};
  const knownTotal = Object.values(kw).reduce((a, l) => a + (l || []).length, 0);
  const charsTotal = Object.values(kc).reduce((a, str) => a + Array.from(str || '').length, 0);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const active = minutes[i] > 0 || reviews[i] > 0;
    if (active) streak++;
    else if (i === days.length - 1) continue; // today may not have started yet
    else break;
  }
  const week = (arr) => arr.slice(-7).reduce((a, b) => a + b, 0);
  const log = store.reviewLog || {};
  const newDone = log.day === SG.srs.dayKey(Date.now()) ? log.newDone || 0 : 0;
  const due = SG.srs.counts(items, Date.now(), (settings.newPerDay || 20) - newDone);
  const byKind = (k) => items.filter((x) => x.kind === k).length;
  const tiles = [
    ['Words you know', knownTotal, Object.entries(kw).filter(([, l]) => (l || []).length).map(([l, list]) => `${SG.lang.langName(l)} ${list.length}`).join(' · ') || 'Mark words known while watching'],
    ['Characters you know', charsTotal, [kc.ja ? `kanji ${Array.from(kc.ja).length}` : '', kc.zh ? `hanzi ${Array.from(kc.zh).length}` : ''].filter(Boolean).join(' · ') || 'No furigana over these'],
    ['Day streak', streak, streak ? 'days in a row watching or reviewing' : 'Watch or review today to start one'],
    ['Minutes this week', Math.round(week(minutes)), `${Math.round(minutes.reduce((a, b) => a + b, 0))} in the last 30 days`],
    ['Reviewed this week', week(reviews), due.total ? `${due.total} cards ready now` : 'Nothing due right now'],
    ['Saved for review', items.length, [['word', 'word', 'words'], ['char', 'character', 'characters'], ['line', 'line', 'lines'], ['grammar', 'grammar form', 'grammar forms']].map(([k, one, many]) => `${byKind(k)} ${byKind(k) === 1 ? one : many}`).join(' · ')],
  ];
  for (const [label, value, detail] of tiles) {
    const t = h('div', 'tile');
    t.append(h('div', 'label', label), h('div', 'value', String(value)), h('div', 'detail', detail));
    $('tiles').append(t);
  }

  // ---- charts
  const tip = $('tip');
  function showTip(e, text) {
    tip.textContent = text;
    tip.classList.add('show');
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
    tip.style.left = x + 'px';
    tip.style.top = e.clientY - tip.offsetHeight - 10 + 'px';
  }
  function hideTip() {
    tip.classList.remove('show');
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  // One series per chart, so no legend: the heading names it. A table view sits under each chart.
  function chart(el, values, opts) {
    const W = Math.max(280, Math.round(el.getBoundingClientRect().width) || 880);
    const H = opts.height || 200;
    const m = { l: 36, r: 8, t: 10, b: 24 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const present = values.filter((v) => v != null);
    const max = niceMax(Math.max(...present, 0));
    // Whole-number steps: fifths for 10, 20, 50, 100…, quarters for small counts like 4.
    const ticks = max % 5 === 0 && max >= 10 ? 5 : 4;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label });
    const y = (v) => m.t + ih - (v / max) * ih;
    for (let i = 0; i <= ticks; i++) {
      const v = (max / ticks) * i;
      svg.append(s('line', { class: i ? 'grid' : 'axis', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = s('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
      svg.append(t);
    }
    const step = iw / values.length;
    const every = W < 500 ? 10 : 5;
    days.forEach((d, i) => {
      if (i % every === 0 || i === days.length - 1) {
        const t = s('text', { x: m.l + step * (i + 0.5), y: H - 6, 'text-anchor': 'middle' });
        t.textContent = fmtDay(d.date);
        svg.append(t);
      }
    });
    if (opts.kind === 'line') {
      // Days before the first record are left out rather than drawn as zero.
      const pts = values.map((v, i) => (v == null ? null : [m.l + step * (i + 0.5), y(v)])).filter(Boolean);
      svg.append(s('path', { class: 'area', d: `M${pts[0][0]},${y(0)} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(' ') + ` L${pts[pts.length - 1][0]},${y(0)} Z` }));
      svg.append(s('path', { class: 'line', d: pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ') }));
      const last = pts[pts.length - 1];
      svg.append(s('circle', { class: 'dot', cx: last[0], cy: last[1], r: 4 }));
    } else {
      const bw = Math.max(2, step - 2);
      values.forEach((v, i) => {
        if (v <= 0) return;
        const x = m.l + step * i + 1;
        const top = y(v);
        const r = Math.min(4, bw / 2, y(0) - top);
        svg.append(s('path', { class: 'bar', d: `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z` }));
      });
    }
    // Hover: a full-height target per day, bigger than the mark.
    values.forEach((v, i) => {
      if (v == null) return;
      const x = m.l + step * i;
      const hit = s('rect', { class: 'hit', x, y: m.t, width: step, height: ih });
      const hl = s('line', { class: 'hl', x1: x + step / 2, x2: x + step / 2, y1: m.t, y2: m.t + ih });
      hit.addEventListener('mousemove', (e) => {
        hl.classList.add('on');
        showTip(e, `${fmtDay(days[i].date)}: ${opts.format(v)}`);
      });
      hit.addEventListener('mouseleave', () => {
        hl.classList.remove('on');
        hideTip();
      });
      svg.append(hit, hl);
    });
    el.append(svg);
    const det = h('details');
    det.append(h('summary', '', 'Show as a table'));
    const table = h('table');
    const head = h('tr');
    head.append(h('th', '', 'Day'), h('th', '', opts.label));
    table.append(head);
    values.forEach((v, i) => {
      if (v == null) return;
      const tr = h('tr');
      tr.append(h('td', '', fmtDay(days[i].date)), h('td', '', opts.format(v)));
      table.append(tr);
    });
    det.append(table);
    el.append(det);
  }

  const any = (arr) => arr.some((v) => v > 0);
  if (any(minutes)) chart($('minutes'), minutes, { label: 'Minutes watched', format: (v) => `${Math.round(v)} min` });
  else $('minutes').append(h('div', 'empty', 'Nothing yet: minutes are counted while Langtitles shows subtitles.'));
  if (any(reviews)) chart($('reviews'), reviews, { label: 'Cards reviewed', format: (v) => `${v} cards` });
  else $('reviews').append(h('div', 'empty', 'No reviews yet.'));

  // Words known per language: small multiples, one chart each (no shared colour key to decode).
  const langs = Object.keys(kw).filter((l) => (kw[l] || []).length);
  const knownBox = $('known');
  if (!langs.length) knownBox.append(h('div', 'empty', 'Mark words as known while watching, or learn them in review, and this fills in.'));
  else {
    const grid = h('div', 'small');
    knownBox.append(grid); // on the page first, so each chart can measure its real width
    // Lay out every cell first, then draw, so each chart measures its final width.
    const cells = langs.map((lang) => {
      const series = [];
      let last = null;
      for (const d of days) {
        const snap = (history[d.key] || {}).knownWords;
        if (snap && snap[lang] != null) last = snap[lang];
        series.push(last);
      }
      series[series.length - 1] = (kw[lang] || []).length;
      const cell = h('div', 'chart');
      cell.append(h('h3', '', `${SG.lang.langName(lang)} · ${series[series.length - 1]}`));
      grid.append(cell);
      return { lang, series, cell };
    });
    for (const { lang, series, cell } of cells) {
      chart(cell, series, { kind: 'line', height: 160, label: `${SG.lang.langName(lang)} words known`, format: (v) => `${v} words` });
    }
  }
})();
