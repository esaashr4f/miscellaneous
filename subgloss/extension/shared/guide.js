// Turns a grammar guide's plain text ("## " headings, "- " list items, "sentence — translation"
// examples) into DOM. Used by the video overlay and the grammar library page.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Example lines: "<sentence> — <translation>". Showing the translation dimmer makes them scannable.
  function line(cls, text) {
    const div = el('div', cls);
    const at = text.indexOf(' — ');
    if (at > 0) {
      div.append(el('span', 'sg-g-ex', text.slice(0, at)), el('span', 'sg-g-ext', ' — ' + text.slice(at + 3)));
    } else {
      div.textContent = text;
    }
    return div;
  }

  // Renders into `target`, replacing what was there. Works on partial (streaming) text too.
  function renderGuide(target, text) {
    const frag = document.createDocumentFragment();
    for (const raw of String(text || '').split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      if (/^#{1,4}\s/.test(t)) frag.append(el('div', 'sg-g-h', t.replace(/^#{1,4}\s+/, '')));
      else if (/^[-•*]\s/.test(t)) frag.append(line('sg-g-li', t.replace(/^[-•*]\s+/, '')));
      else frag.append(line('sg-g-p', t));
    }
    target.textContent = '';
    target.append(frag);
  }

  SG.renderGuide = renderGuide;
})(typeof globalThis !== 'undefined' ? globalThis : this);
