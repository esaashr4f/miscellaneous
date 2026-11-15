// Stroke order diagrams.
//  Japanese: KanjiVG (Ulrich Apel and contributors, CC BY-SA 3.0), which also records which
//  strokes form which component, and which component is the radical or gives the sound.
//  Chinese: hanzi-writer-data, from Make Me a Hanzi (Arphic Public License).
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = ['#ff9f45', '#5aa7ff', '#4fd18b', '#ff7fb0', '#b08cff', '#ffcc4d'];

  function attr(attrs, name) {
    const m = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"').exec(attrs);
    return m ? m[1] : null;
  }

  // KanjiVG SVG text -> strokes in order, stroke numbers, and the top-level components.
  function parseKanjiVG(text) {
    const strokes = [];
    const numbers = [];
    const components = [];
    const stack = []; // open <g> elements: { element, top }
    let rootSeen = false;
    const re = /<(\/?)(g|path|text)\b([^>]*?)(\/?)>([^<]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const [, close, tag, attrs, selfClose, after] = m;
      if (tag === 'g') {
        if (close) {
          stack.pop();
          continue;
        }
        const id = attr(attrs, 'id') || '';
        if (/StrokeNumbers/.test(id)) {
          stack.push({ numbers: true });
          continue;
        }
        const element = attr(attrs, 'kvg:element');
        const g = { element, id };
        // The first kvg:element group is the character itself; its direct element children are its components.
        if (element && !rootSeen && /^kvg:[0-9a-f]+$/.test(id)) {
          rootSeen = true;
          g.isRoot = true;
        } else if (element && stack.length && stack[stack.length - 1].isRoot) {
          g.component = components.length;
          components.push({
            element,
            original: attr(attrs, 'kvg:original'),
            position: attr(attrs, 'kvg:position'),
            radical: Boolean(attr(attrs, 'kvg:radical')),
            phonetic: Boolean(attr(attrs, 'kvg:phon')),
            strokes: [],
          });
        }
        if (!selfClose) stack.push(g);
      } else if (tag === 'path' && !close) {
        const d = attr(attrs, 'd');
        if (!d) continue;
        let comp = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].component != null) {
            comp = stack[i].component;
            break;
          }
        }
        if (comp >= 0) components[comp].strokes.push(strokes.length);
        strokes.push({ d, component: comp });
      } else if (tag === 'text' && !close) {
        const t = /matrix\(1 0 0 1 ([\d.]+) ([\d.]+)\)/.exec(attrs);
        if (t) numbers.push({ x: Number(t[1]), y: Number(t[2]), n: (after || '').trim() });
      }
    }
    return { kind: 'kvg', size: 109, strokes, numbers, components };
  }

  function parseHanziWriter(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    const strokes = (data.strokes || []).map((d) => ({ d, component: -1 }));
    // Make Me a Hanzi uses a 1024 box with y pointing up; flip to screen coordinates for numbers.
    const numbers = (data.medians || []).map((med, i) => ({ x: med[0][0], y: 900 - med[0][1], n: String(i + 1) }));
    return { kind: 'hw', size: 1024, strokes, numbers, components: [] };
  }

  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Draws the character stroke by stroke. Each component (Japanese) gets its own colour.
  function render(container, data, opts) {
    const o = Object.assign({ size: 140, speed: 1, numbers: true, colors: true }, opts);
    container.textContent = '';
    const svg = el('svg', { viewBox: `0 0 ${data.size} ${data.size}`, width: o.size, height: o.size, class: 'stroke-svg' });
    const unit = data.size / 109;
    // A faint cross guide, like practice paper.
    svg.append(el('path', { d: `M${data.size / 2} 0V${data.size}M0 ${data.size / 2}H${data.size}`, stroke: 'currentColor', 'stroke-opacity': '0.12', 'stroke-width': unit, 'stroke-dasharray': `${3 * unit} ${3 * unit}`, fill: 'none' }));
    const flip = data.kind === 'hw' ? { transform: 'translate(0,900) scale(1,-1)' } : {};
    const ghost = el('g', flip);
    const draw = el('g', flip);
    svg.append(ghost, draw);
    const per = 0.45 / o.speed;
    data.strokes.forEach((s, i) => {
      const color = o.colors && s.component >= 0 ? COLORS[s.component % COLORS.length] : 'currentColor';
      const delay = (i * (per + 0.08)).toFixed(2) + 's';
      if (data.kind === 'kvg') {
        ghost.append(el('path', { d: s.d, fill: 'none', stroke: 'currentColor', 'stroke-opacity': '0.15', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        const p = el('path', { d: s.d, fill: 'none', stroke: color, 'stroke-width': '3.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: '1', 'stroke-dasharray': '1', 'stroke-dashoffset': '1' });
        p.style.animation = `lt-stroke ${per}s ease-in-out ${delay} forwards`;
        draw.append(p);
      } else {
        ghost.append(el('path', { d: s.d, fill: 'currentColor', 'fill-opacity': '0.13' }));
        const p = el('path', { d: s.d, fill: color, opacity: '0' });
        p.style.animation = `lt-fill ${per}s ease-out ${delay} forwards`;
        draw.append(p);
      }
    });
    if (o.numbers) {
      const nums = el('g', { 'font-size': String(8 * unit), fill: 'currentColor', 'fill-opacity': '0.7', 'font-family': 'system-ui, sans-serif' });
      for (const n of data.numbers) {
        const t = el('text', { x: n.x, y: n.y });
        t.textContent = n.n;
        nums.append(t);
      }
      svg.append(nums);
    }
    container.append(svg);
    return svg;
  }

  // CSS the animation needs, for pages and the overlay alike.
  const CSS = '@keyframes lt-stroke{to{stroke-dashoffset:0}}@keyframes lt-fill{to{opacity:1}}';

  function legend(data) {
    return data.components.map((c, i) => ({
      element: c.element,
      original: c.original && c.original !== c.element ? c.original : '',
      role: [c.radical ? 'radical' : '', c.phonetic ? 'gives the sound' : '', c.position || ''].filter(Boolean).join(', '),
      color: COLORS[i % COLORS.length],
      strokes: c.strokes.length,
    }));
  }

  function kanjiVGUrl(ch) {
    return 'https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg@master/kanji/' + ch.codePointAt(0).toString(16).padStart(5, '0') + '.svg';
  }

  function hanziWriterUrl(ch) {
    return 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/' + encodeURIComponent(ch) + '.json';
  }

  SG.strokes = { parseKanjiVG, parseHanziWriter, render, legend, CSS, kanjiVGUrl, hanziWriterUrl, COLORS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
