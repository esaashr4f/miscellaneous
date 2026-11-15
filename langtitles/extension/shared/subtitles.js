// Subtitle file parsers. Loaded by the background page, the content script and the Node tests.
// Every parser returns cues as [{ start, end, text }] with times in seconds.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  // Strip markup and collapse a cue to a single line of text.
  function cleanText(s) {
    return decodeEntities(
      String(s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\{\\[^}]*\}/g, ''),
    )
      .replace(/[​‎‏﻿]/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/[ \t ]+/g, ' ')
      .trim();
  }

  // "01:02:03.456", "02:03,456", "62.5" -> seconds
  function parseClock(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?$/.exec(s.trim());
    if (!m) {
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    }
    const frac = m[4] ? Number('0.' + m[4]) : 0;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }

  const ARROW = /((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})/;

  // WebVTT and SubRip share a block structure, so one parser covers both.
  function parseBlocks(text) {
    const cues = [];
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n');
      const at = lines.findIndex((l) => ARROW.test(l));
      if (at === -1) continue;
      const m = ARROW.exec(lines[at]);
      const start = parseClock(m[1]);
      const end = parseClock(m[2]);
      const body = cleanText(lines.slice(at + 1).join('\n'));
      if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
    }
    return cues;
  }

  function parseASS(text) {
    const cues = [];
    let fields = null;
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (/^Format:/i.test(line) && !fields) {
        const names = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
        if (names.includes('text')) fields = names;
        continue;
      }
      if (!/^Dialogue:/i.test(line)) continue;
      const names = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).split(',');
      const head = parts.slice(0, names.length - 1);
      const body = parts.slice(names.length - 1).join(',');
      const start = parseClock(head[names.indexOf('start')] || '');
      const end = parseClock(head[names.indexOf('end')] || '');
      // Drawing commands ({\p1}...) are vector shapes, not dialogue.
      if (/\{[^}]*\\p[1-9]/.test(body)) continue;
      const clean = cleanText(body.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
      if (clean && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: clean });
    }
    return cues;
  }

  function parseTTML(text) {
    const cues = [];
    const tickRate = Number((/tickRate="(\d+)"/.exec(text) || [])[1]) || 10000000;
    const frameRate = Number((/frameRate="(\d+)"/.exec(text) || [])[1]) || 30;
    const time = (v) => {
      if (v == null) return NaN;
      let m;
      if ((m = /^([\d.]+)t$/.exec(v))) return Number(m[1]) / tickRate;
      if ((m = /^([\d.]+)ms$/.exec(v))) return Number(m[1]) / 1000;
      if ((m = /^([\d.]+)s$/.exec(v))) return Number(m[1]);
      if ((m = /^([\d.]+)m$/.exec(v))) return Number(m[1]) * 60;
      if ((m = /^([\d.]+)h$/.exec(v))) return Number(m[1]) * 3600;
      if ((m = /^([\d.]+)f$/.exec(v))) return Number(m[1]) / frameRate;
      if ((m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(v))) {
        return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / frameRate;
      }
      return parseClock(v);
    };
    const re = /<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/g;
    let m;
    while ((m = re.exec(text))) {
      const attrs = m[1];
      const attr = (name) => (new RegExp('\\b' + name + '="([^"]*)"').exec(attrs) || [])[1];
      const start = time(attr('begin'));
      let end = time(attr('end'));
      if (!Number.isFinite(end) && attr('dur')) end = start + time(attr('dur'));
      const body = cleanText(m[2]);
      if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
    }
    return cues;
  }

  // YouTube "json3" timed text.
  function parseJson3(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return [];
    }
    if (!data || !Array.isArray(data.events)) return [];
    const cues = [];
    for (const ev of data.events) {
      if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
      const body = cleanText(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!body) continue;
      const start = ev.tStartMs / 1000;
      cues.push({ start, end: start + (ev.dDurationMs || 3000) / 1000, text: body });
    }
    return cues;
  }

  function sniffFormat(text) {
    const head = text.slice(0, 4000).replace(/^﻿/, '').trimStart();
    if (/^WEBVTT/.test(head)) return 'vtt';
    if (/^\[Script Info\]/i.test(head) || /^Dialogue:/m.test(head)) return 'ass';
    if (/^<\?xml|^<tt[\s>]/i.test(head) && /<(?:\w+:)?tt[\s>]/.test(head)) return 'ttml';
    if (head[0] === '{' && /"events"\s*:/.test(head)) return 'json3';
    if (ARROW.test(head)) return 'srt';
    return null;
  }

  // Sort, drop empties and exact repeats, and keep cues from running into each other backwards.
  function normalizeCues(cues) {
    const out = [];
    const seen = new Set();
    const sorted = cues
      .filter((c) => c && c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const c of sorted) {
      const sig = c.start.toFixed(2) + '|' + c.text;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const prev = out[out.length - 1];
      // Rolling captions repeat the previous cue's text with a later start; extend instead of repeating.
      if (prev && prev.text === c.text && c.start <= prev.end + 0.05) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      out.push({ start: c.start, end: c.end, text: c.text });
    }
    return out;
  }

  function parseSubtitles(text, hint) {
    if (typeof text !== 'string' || !text) return { format: null, cues: [] };
    const format = sniffFormat(text) || hint || null;
    let cues = [];
    if (format === 'vtt' || format === 'srt') cues = parseBlocks(text);
    else if (format === 'ass') cues = parseASS(text);
    else if (format === 'ttml') cues = parseTTML(text);
    else if (format === 'json3') cues = parseJson3(text);
    return { format, cues: normalizeCues(cues) };
  }

  // Short stable key for a line in its context. The same line after a different
  // previous line can mean something different, so the previous line is part of the key.
  function lineKey(text, prevText) {
    const s = (prevText || '') + '\u0001' + text;
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }

  // Index of the cue that should be on screen at time t, or -1.
  function findCue(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // The latest-starting cue wins; look back a little for one that is still running.
    for (let i = at; i >= 0 && i > at - 4; i--) {
      if (t < cues[i].end) return i;
    }
    return -1;
  }

  SG.subtitles = { parseSubtitles, normalizeCues, sniffFormat, cleanText, parseClock, lineKey, findCue };
})(typeof globalThis !== 'undefined' ? globalThis : this);
