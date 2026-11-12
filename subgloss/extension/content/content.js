// Content script: finds the video, collects subtitle lines from every available source,
// asks the background page to analyze them ahead of the playhead, and draws the overlay.
(function () {
  'use strict';
  if (window.__subglossLoaded || !document.documentElement || !(document instanceof HTMLDocument)) return;
  window.__subglossLoaded = true;

  const SG = globalThis.SG;
  const { parseSubtitles, lineKey, findCue } = SG.subtitles;
  const { detectLang, langName, langCode } = SG.lang;

  // Caption containers of common web players, used when no subtitle file could be captured.
  const CAPTION_SELECTORS = [
    '.jw-captions', '.jw-text-track-display', '.vjs-text-track-display', '.plyr__captions',
    '.shaka-text-container', '.player-timedtext', '.ytp-caption-window-container',
    '.atvwebplayersdk-captions-text', '.vds-captions', 'media-captions', '.art-subtitle',
    '.bmpui-ui-subtitle-overlay', '.dplayer-subtitle', '.mejs__captions-text', '.fp-captions',
    '.theoplayer-texttracks', '.dss-subtitle-renderer-wrapper', '[class*="subtitle-text"]',
    '[class*="SubtitleText"]', '[class*="caption-text"]', '[class*="captionText"]',
  ];

  const ROLE_LABELS = {
    subject: 'subject', topic: 'topic', object: 'object', indirect_object: 'to/for', predicate: 'predicate',
    complement: 'complement', modifier: 'modifier', adverbial: 'adverbial', time: 'time', place: 'place',
    connector: 'connector', address: 'address', interjection: 'interjection', quote: 'quote', other: '',
  };

  let settings = Object.assign({}, SG.DEFAULTS, { hasKey: false });
  let tabHost = location.hostname;
  let port = null;
  let video = null;
  let ui = null;

  const tracks = new Map(); // id -> { id, label, lang, source, cues, keys, offset, updatedAt }
  let activeId = null;
  let manualPick = null;
  let analyzeNative = false; // user explicitly picked a track in their own language

  const analyses = new Map(); // line key -> analysis
  const requested = new Set(); // keys currently being analyzed
  const failures = new Map(); // key -> { count, at }
  let inflight = 0;
  let pauseUntil = 0;
  let lastError = null;
  let reqSeq = 0;
  const pendingReqs = new Map(); // reqId -> keys

  let shownKey = null; // what the subtitle box currently shows
  let shownAnalyzed = false;
  let shownIndex = -1;
  let overlayHidden = false;

  let autoPaused = false;
  let hoverTimer = null;
  let leaveTimer = null;
  let deepTimer = null;
  let deepReq = 0;
  const deepTexts = new Map();
  let popFor = null;

  let domEl = null; // caption element being read from the page
  let domText = '';
  let picking = false;
  let lastSrc = '';

  // ---------------------------------------------------------------- helpers

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function enabled() {
    return Boolean(settings.enabled) && !(settings.disabledHosts || []).includes(tabHost);
  }

  function active() {
    return activeId ? tracks.get(activeId) || null : null;
  }

  function fmtTime(t) {
    const s = Math.max(0, Math.floor(t));
    const m = Math.floor(s / 60);
    const hh = Math.floor(m / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return hh ? `${hh}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function isEditable(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  // ------------------------------------------------------------------ video

  function allVideos(rootNode, out, depth) {
    for (const v of rootNode.querySelectorAll('video')) out.push(v);
    if (depth > 3) return out;
    for (const el of rootNode.querySelectorAll('*')) {
      if (el.shadowRoot) allVideos(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  function bestVideo() {
    let best = null;
    let bestArea = 0;
    const list = document.querySelector('video') ? Array.from(document.querySelectorAll('video')) : allVideos(document, [], 0);
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width < 200 || r.height < 110) continue;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function scan() {
    const v = bestVideo();
    if (v !== video) {
      video = v;
      if (video) {
        connect();
        buildUI();
        video.addEventListener('play', () => {
          if (!popFor) autoPaused = false;
        });
        video.addEventListener('seeking', () => pump());
      }
    }
    if (!video) return;
    const src = video.currentSrc || video.src || '';
    if (src !== lastSrc) {
      // A new video in the same page: subtitles captured well before it belong to the old one.
      if (lastSrc) {
        const cutoff = Date.now() - 15000;
        for (const [id, t] of tracks) if (t.source !== 'file' && t.updatedAt < cutoff) tracks.delete(id);
        manualPick = null;
        chooseActive();
      }
      lastSrc = src;
    }
    readTextTracks();
    findCaptionElement();
  }

  // ------------------------------------------------------------- background

  function connect() {
    if (port) return;
    port = browser.runtime.connect({ name: 'subgloss' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
    });
  }

  function post(msg) {
    if (!port) connect();
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      port = null;
      return false;
    }
  }

  function onMessage(msg) {
    if (msg.type === 'init') {
      settings = Object.assign({}, SG.DEFAULTS, msg.settings);
      if (msg.tabHost) tabHost = msg.tabHost;
      for (const t of msg.tracks || []) addTrack(t);
      applySettings();
    } else if (msg.type === 'settings') {
      settings = Object.assign({}, SG.DEFAULTS, msg.settings);
      applySettings();
    } else if (msg.type === 'track') {
      addTrack(msg.track);
    } else if (msg.type === 'analyzed') {
      onAnalyzed(msg);
    } else if (msg.type === 'deepDelta' || msg.type === 'deepDone' || msg.type === 'deepError') {
      onDeep(msg);
    }
  }

  // ----------------------------------------------------------------- tracks

  function signature(cues) {
    return cues.length ? cues.length + '|' + cues[0].text + '|' + cues[cues.length - 1].text : '';
  }

  function addTrack(t) {
    if (!t || !t.cues || !t.cues.length) return;
    const prev = tracks.get(t.id);
    // The same subtitles can arrive twice (network capture and the <track> element); keep one.
    if (!prev) {
      const sig = signature(t.cues);
      for (const other of tracks.values()) {
        if (other.id !== t.id && other.source !== 'dom' && signature(other.cues) === sig) return;
      }
    }
    const keys = t.cues.map((c, i) => lineKey(c.text, i ? t.cues[i - 1].text : ''));
    tracks.set(t.id, {
      id: t.id,
      label: t.label || t.id,
      lang: t.lang || detectLang(t.cues.slice(0, 60).map((c) => c.text).join('\n')),
      source: t.source || 'net',
      cues: t.cues,
      keys,
      offset: prev ? prev.offset : 0,
      updatedAt: Date.now(),
    });
    chooseActive();
    if (ui) renderTrackList();
    if (t.id === activeId) {
      renderTranscript();
      pump();
    }
  }

  function trackScore(t) {
    if (t.source === 'file') return 10000;
    const native = langCode(settings.nativeLang);
    if (t.lang === native) return -1;
    let score = t.source === 'dom' ? 1 : 100;
    if (settings.hostLang && settings.hostLang[tabHost] === t.lang) score += 500;
    const idx = (settings.learning || []).indexOf(t.lang);
    if (idx >= 0) score += 300 - idx * 10;
    if (t.source === 'texttrack' && t.showing) score += 40;
    return score + t.updatedAt / 1e13;
  }

  function chooseActive() {
    let next = null;
    if (manualPick && tracks.has(manualPick)) next = manualPick;
    else {
      let best = 0;
      for (const t of tracks.values()) {
        const s = trackScore(t);
        if (s > best) {
          best = s;
          next = t.id;
        }
      }
    }
    if (next !== activeId) {
      activeId = next;
      analyzeNative = Boolean(manualPick);
      shownKey = null;
      shownIndex = -1;
      if (ui) {
        renderTrackList();
        renderTranscript();
        applyHideNative();
      }
      pump();
    }
  }

  function readTextTracks() {
    if (!video || !video.textTracks) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i];
      if (tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;
      const list = tt.cues;
      if (!list || !list.length) continue;
      const id = 'tt:' + i + ':' + (tt.language || '') + ':' + (tt.label || '');
      const existing = tracks.get(id);
      if (existing && existing.cues.length === list.length) {
        existing.showing = tt.mode === 'showing';
        continue;
      }
      const cues = [];
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        const text = SG.subtitles.cleanText(c.text || '');
        if (text) cues.push({ start: c.startTime, end: c.endTime, text });
      }
      const norm = SG.subtitles.normalizeCues(cues);
      if (!norm.length) continue;
      addTrack({
        id,
        label: tt.label || langName(tt.language) || 'Text track ' + (i + 1),
        lang: tt.language ? langCode(tt.language) : undefined,
        source: 'texttrack',
        cues: norm,
      });
      const added = tracks.get(id);
      if (added) added.showing = tt.mode === 'showing';
    }
  }

  // Reading captions straight off the page: the fallback when no file was captured.
  function findCaptionElement() {
    if (domEl && domEl.isConnected) return;
    domEl = null;
    const saved = settings.hostSelectors && settings.hostSelectors[location.hostname];
    for (const sel of (saved ? [saved] : []).concat(CAPTION_SELECTORS)) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (el && (!ui || !ui.root.contains(el))) {
        domEl = el;
        return;
      }
    }
  }

  function readDomCaption() {
    if (!domEl || !video) return;
    const text = SG.subtitles.cleanText(domEl.innerText || domEl.textContent || '');
    if (text === domText) return;
    domText = text;
    let t = tracks.get('dom');
    const now = video.currentTime;
    if (t && t.cues.length) {
      const last = t.cues[t.cues.length - 1];
      if (last.end > now) last.end = Math.max(last.start + 0.05, now);
    }
    if (!text) return;
    if (!t) {
      t = { id: 'dom', label: 'On-screen captions', lang: detectLang(text), source: 'dom', cues: [], keys: [], offset: 0, updatedAt: Date.now() };
      tracks.set('dom', t);
    }
    // Rewinding replays lines we already have; only record new ones.
    const at = findCue(t.cues, now);
    if (at !== -1 && t.cues[at].text === text) return;
    const prev = t.cues.length ? t.cues[t.cues.length - 1].text : '';
    const cue = { start: now, end: now + 8, text };
    let i = t.cues.length;
    while (i > 0 && t.cues[i - 1].start > now) i--;
    t.cues.splice(i, 0, cue);
    t.keys.splice(i, 0, lineKey(text, prev));
    t.updatedAt = Date.now();
    if (t.cues.length === 3) t.lang = detectLang(t.cues.map((c) => c.text).join('\n'));
    chooseActive();
    if (activeId === 'dom') {
      renderTranscript();
      pump();
    }
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const { cues } = parseSubtitles(String(reader.result));
      if (!cues.length) {
        showToast('That file has no subtitles SubGloss can read (.srt, .vtt, .ass, .ttml).');
        return;
      }
      const id = 'file:' + file.name;
      addTrack({ id, label: file.name, source: 'file', cues });
      manualPick = id;
      chooseActive();
    };
    reader.readAsText(file);
  }

  // --------------------------------------------------------------- analysis

  function shouldAnalyze(t) {
    if (!t || !enabled() || !settings.hasKey) return false;
    if (t.lang === langCode(settings.nativeLang) && !analyzeNative && t.source !== 'file') return false;
    return true;
  }

  function pump() {
    const t = active();
    if (!video || !shouldAnalyze(t) || Date.now() < pauseUntil) return;
    const now = video.currentTime - t.offset;
    const horizon = settings.lookaheadMin > 0 ? now + settings.lookaheadMin * 60 : Infinity;
    // First line that has not finished yet.
    let from = 0;
    let lo = 0;
    let hi = t.cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.cues[mid].end < now) {
        from = mid + 1;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const limit = Math.max(1, settings.concurrency || 1);
    while (inflight < limit) {
      const lines = [];
      const seen = new Set();
      let first = -1;
      // Keep the first batch small so the line on screen is ready as fast as possible.
      const urgent = from < t.cues.length && !analyses.has(t.keys[from]) && !requested.has(t.keys[from]);
      const size = urgent ? Math.min(3, settings.chunkSize) : settings.chunkSize;
      for (let i = from; i < t.cues.length && t.cues[i].start <= horizon && lines.length < size; i++) {
        const key = t.keys[i];
        if (analyses.has(key) || requested.has(key) || seen.has(key)) continue;
        const f = failures.get(key);
        if (f && (f.count >= 2 || Date.now() - f.at < 30000)) continue;
        if (first === -1) first = i;
        seen.add(key);
        lines.push({ key, text: t.cues[i].text });
      }
      if (!lines.length) break;
      const context = t.cues.slice(Math.max(0, first - 3), first).map((c) => c.text);
      const reqId = ++reqSeq;
      if (!post({ type: 'analyze', reqId, lang: t.lang, context, lines })) break;
      for (const l of lines) requested.add(l.key);
      pendingReqs.set(reqId, lines.map((l) => l.key));
      inflight++;
    }
    renderStatus();
  }

  function onAnalyzed(msg) {
    const keys = pendingReqs.get(msg.reqId);
    if (!keys) return;
    pendingReqs.delete(msg.reqId);
    inflight = Math.max(0, inflight - 1);
    for (const key of keys) {
      requested.delete(key);
      const a = msg.results && msg.results[key];
      if (a) {
        analyses.set(key, a);
        failures.delete(key);
        updateTranscriptRow(key);
      } else {
        const f = failures.get(key) || { count: 0, at: 0 };
        failures.set(key, { count: f.count + 1, at: Date.now() });
      }
    }
    if (msg.error) {
      lastError = msg.error;
      const slow = ['auth', 'no_key', 'model', 'bad_request'].includes(msg.error.code);
      pauseUntil = Date.now() + (slow ? 60000 : 15000);
      showToast(msg.error.message);
    } else {
      lastError = null;
    }
    // A language guess from a few DOM lines can be wrong; trust the model once it has seen them.
    const t = active();
    if (t && t.lang === 'und') {
      const first = keys.map((k) => analyses.get(k)).find((a) => a && a.lang);
      if (first) {
        t.lang = langCode(first.lang);
        renderTrackList();
      }
    }
    tick();
    pump();
  }

  // --------------------------------------------------------------------- UI

  function buildUI() {
    if (ui) return;
    const root = h('subgloss-root');
    root.setAttribute('translate', 'no');
    const sub = h('div', 'sg-sub');
    const line = h('div', 'sg-line');
    const tr = h('div', 'sg-tr');
    sub.append(line, tr);
    const pop = h('div', 'sg-pop');
    const toggle = h('button', 'sg-toggle', '字');
    toggle.title = 'SubGloss panel (G)';
    const toast = h('div', 'sg-toast');
    const panel = buildPanel();
    root.append(sub, pop, toggle, toast, panel.el);
    ui = { root, sub, line, tr, pop, toggle, toast, panel };

    const stop = (e) => e.stopPropagation();
    for (const el of [sub, pop, toggle, panel.el]) {
      for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu']) {
        el.addEventListener(type, stop);
      }
    }
    toggle.addEventListener('click', () => setPanel(!settings.panelOpen));
    sub.addEventListener('mouseenter', cancelLeave);
    sub.addEventListener('mouseleave', scheduleLeave);
    pop.addEventListener('mouseenter', cancelLeave);
    pop.addEventListener('mouseleave', scheduleLeave);

    document.addEventListener('fullscreenchange', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onPickClick, true);

    place();
    applySettings();
  }

  function buildPanel() {
    const el = h('div', 'sg-panel');
    const head = h('div', 'sg-panel-head');
    const title = h('span', 'sg-panel-title', 'SubGloss');
    const status = h('span', 'sg-panel-status');
    const close = h('button', 'sg-btn sg-close', '×');
    close.title = 'Close panel';
    close.addEventListener('click', () => setPanel(false));
    head.append(title, status, close);

    const tools = h('div', 'sg-panel-tools');
    const select = h('select', 'sg-select');
    select.title = 'Subtitle track';
    select.addEventListener('change', () => {
      manualPick = select.value || null;
      const t = tracks.get(manualPick);
      if (t && t.lang && t.lang !== 'und') {
        const hostLang = Object.assign({}, settings.hostLang, { [tabHost]: t.lang });
        post({ type: 'saveSettings', patch: { hostLang } });
      }
      activeId = null;
      chooseActive();
    });
    const file = h('input');
    file.type = 'file';
    file.accept = '.srt,.vtt,.ass,.ssa,.ttml,.dfxp,.xml,.txt';
    file.style.display = 'none';
    file.addEventListener('change', () => file.files[0] && loadFile(file.files[0]));
    const fileBtn = h('button', 'sg-btn', 'Load file');
    fileBtn.title = 'Use a subtitle file from your computer';
    fileBtn.addEventListener('click', () => file.click());
    const pickBtn = h('button', 'sg-btn', 'Pick on page');
    pickBtn.title = 'Click the subtitles on the video to read them from the page';
    pickBtn.addEventListener('click', () => {
      picking = true;
      showToast('Click the subtitle text on the video. Press Escape to cancel.');
    });
    const early = h('button', 'sg-btn', '−');
    early.title = 'Subtitles earlier by 0.25 s';
    const late = h('button', 'sg-btn', '+');
    late.title = 'Subtitles later by 0.25 s';
    const offset = h('span', 'sg-offset', '0.00s');
    const nudge = (d) => {
      const t = active();
      if (!t) return;
      t.offset = Math.round((t.offset + d) * 100) / 100;
      offset.textContent = (t.offset >= 0 ? '+' : '') + t.offset.toFixed(2) + 's';
      shownKey = null;
      tick();
    };
    early.addEventListener('click', () => nudge(-0.25));
    late.addEventListener('click', () => nudge(0.25));
    tools.append(select, fileBtn, pickBtn, early, offset, late, file);

    const hint = h('div', 'sg-hint');
    const detail = h('div', 'sg-detail');
    const listTitle = h('div', 'sg-section', 'Transcript');
    const list = h('div', 'sg-list');
    el.append(head, tools, hint, detail, listTitle, list);
    return { el, status, select, offset, hint, detail, list, rows: new Map() };
  }

  // Keep the overlay glued to the video, including in fullscreen.
  function place() {
    if (!ui || !video) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs !== video && fs.contains(video) ? fs : document.documentElement;
    if (ui.root.parentNode !== parent) parent.appendChild(ui.root);
    const r = video.getBoundingClientRect();
    const visible = r.width >= 200 && r.height >= 110 && video.isConnected;
    const s = ui.root.style;
    s.display = visible && enabled() ? 'block' : 'none';
    if (!visible) return;
    s.left = r.left + 'px';
    s.top = r.top + 'px';
    s.width = r.width + 'px';
    s.height = r.height + 'px';
    const size = Math.max(13, Math.min(34, r.height / 27)) * (settings.fontScale || 1);
    s.fontSize = size.toFixed(1) + 'px';
  }

  function applySettings() {
    if (!ui) return;
    const c = ui.root.classList;
    c.toggle('sg-panel-open', Boolean(settings.panelOpen));
    c.toggle('sg-no-parts', !settings.showParts);
    c.toggle('sg-no-mean', !settings.showMeaning);
    c.toggle('sg-no-read', !settings.showReading);
    c.toggle('sg-no-roles', !settings.showRoles);
    c.toggle('sg-no-tr', !settings.showTranslation);
    c.toggle('sg-hidden', overlayHidden);
    place();
    applyHideNative();
    renderTrackList();
    shownKey = null;
    tick();
    pump();
  }

  function applyHideNative() {
    const hide = Boolean(active()) && enabled() && settings.hideNative && !overlayHidden;
    document.documentElement.classList.toggle('subgloss-hide-native', hide);
    if (domEl) domEl.classList.toggle('subgloss-native-caption', hide);
  }

  function setPanel(open) {
    settings.panelOpen = open;
    post({ type: 'saveSettings', patch: { panelOpen: open } });
    ui.root.classList.toggle('sg-panel-open', open);
    if (open) {
      renderTranscript();
      shownKey = null;
      tick();
    }
  }

  let toastTimer = null;
  function showToast(text) {
    if (!ui) return;
    ui.toast.textContent = text;
    ui.toast.classList.add('sg-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('sg-show'), 6000);
  }

  let toggleTimer = null;
  function onMouseMove(e) {
    if (!ui || !video) return;
    const r = video.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    ui.toggle.classList.add('sg-show');
    clearTimeout(toggleTimer);
    toggleTimer = setTimeout(() => ui.toggle.classList.remove('sg-show'), 2500);
  }

  function renderTrackList() {
    if (!ui) return;
    const { select, hint } = ui.panel;
    select.textContent = '';
    if (!tracks.size) select.append(new Option('No subtitles found yet', ''));
    for (const t of tracks.values()) {
      const kind = { net: '', texttrack: '', dom: ' (read from page)', file: ' (file)' }[t.source] || '';
      const opt = new Option(`${langName(t.lang)} · ${t.label}${kind} · ${t.cues.length} lines`, t.id);
      opt.selected = t.id === activeId;
      select.append(opt);
    }
    const native = langCode(settings.nativeLang);
    let text = '';
    if (!settings.hasKey) text = 'Add your Anthropic API key in the SubGloss options to get breakdowns.';
    else if (!tracks.size) text = 'Turn on subtitles in the player. SubGloss picks them up as the site loads them. If nothing appears, use “Pick on page” or “Load file”.';
    else if (!activeId) text = `The subtitles found are in ${langName(native)}. Choose a subtitle track in the language you are learning in the site’s player, or pick one above to analyze it anyway.`;
    hint.textContent = text;
    hint.style.display = text ? 'block' : 'none';
    const t = active();
    if (t) ui.panel.offset.textContent = (t.offset >= 0 ? '+' : '') + t.offset.toFixed(2) + 's';
  }

  function renderStatus() {
    if (!ui) return;
    const t = active();
    if (!t) {
      ui.panel.status.textContent = '';
      return;
    }
    let ready = 0;
    for (const k of t.keys) if (analyses.has(k)) ready++;
    ui.panel.status.textContent = `${ready}/${t.cues.length} lines ready${inflight ? ' · working' : ''}`;
  }

  // ------------------------------------------------------------ subtitle box

  // Lay the model's words back onto the original line so punctuation and spacing survive.
  function alignWords(text, words) {
    const out = [];
    let pos = 0;
    const lower = text.toLowerCase();
    for (const w of words) {
      if (!w || !w.s) continue;
      let at = text.indexOf(w.s, pos);
      if (at === -1) at = lower.indexOf(w.s.toLowerCase(), pos);
      if (at === -1) {
        out.push({ word: w });
        continue;
      }
      if (at > pos) out.push({ gap: text.slice(pos, at) });
      out.push({ word: w });
      pos = at + w.s.length;
    }
    if (pos < text.length) out.push({ gap: text.slice(pos) });
    return out;
  }

  function sameText(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  function buildToken(w, index, firstOfPhrase, ctx) {
    const tok = h('span', 'sg-tok sg-role-' + (w.role || 'other'));
    const parts = Array.isArray(w.p) && w.p.length ? w.p : [{ t: w.s, g: w.m }];
    const multi = parts.length > 1;

    tok.append(h('span', 'sg-mean', w.m || ''));

    const partsEl = h('span', 'sg-parts');
    if (multi || !sameText(parts[0].g, w.m)) {
      parts.forEach((p, i) => {
        if (i) partsEl.append(h('span', 'sg-plus', '+'));
        partsEl.append(h('span', multi ? 'sg-part sg-c' + (i % 5) : 'sg-part', p.g || ''));
      });
    }
    tok.append(partsEl);

    tok.append(h('span', 'sg-read', w.r && !sameText(w.r, w.s) ? w.r : ''));

    const surf = h('span', 'sg-surf');
    if (multi && parts.map((p) => p.t).join('') === w.s) {
      parts.forEach((p, i) => surf.append(h('span', 'sg-seg sg-c' + (i % 5), p.t)));
    } else {
      surf.textContent = w.s;
    }
    tok.append(surf, h('span', 'sg-bar'));
    tok.append(h('span', 'sg-role', firstOfPhrase ? ROLE_LABELS[w.role] || '' : ''));

    tok.addEventListener('mouseenter', () => onTokenEnter(tok, w, index, ctx));
    tok.addEventListener('click', () => onTokenEnter(tok, w, index, ctx));
    return tok;
  }

  function buildGap(text) {
    const trimmed = text.trim();
    const gap = h('span', trimmed ? 'sg-gap' : 'sg-gap sg-space');
    gap.append(h('span', 'sg-surf', trimmed || ' '), h('span', 'sg-bar'), h('span', 'sg-role', ''));
    return gap;
  }

  function renderLine(cue, key) {
    const a = analyses.get(key);
    const { line, tr, sub } = ui;
    hidePop();
    line.textContent = '';
    line.classList.toggle('sg-plain', !a || !a.w || !a.w.length);
    if (a && a.w && a.w.length) {
      line.lang = a.lang || '';
      let lastPhrase = null;
      const ctx = { key, sentence: cue.text, translation: a.tr };
      let index = 0;
      for (const item of alignWords(cue.text, a.w)) {
        if (item.gap != null) {
          line.append(buildGap(item.gap));
          continue;
        }
        const w = item.word;
        line.append(buildToken(w, index++, w.c !== lastPhrase, ctx));
        lastPhrase = w.c;
      }
      tr.textContent = a.tr || '';
    } else {
      line.removeAttribute('lang');
      line.append(h('span', 'sg-raw', cue.text));
      if (requested.has(key)) line.append(h('span', 'sg-dots', '···'));
      tr.textContent = '';
    }
    tr.style.display = tr.textContent ? '' : 'none';
    sub.classList.add('sg-show');
    renderDetail(cue, a);
  }

  function clearLine() {
    if (!ui) return;
    ui.sub.classList.remove('sg-show');
    hidePop();
  }

  // The main loop: decide which line is on screen and draw it when that changes.
  function tick() {
    if (!ui || !video) return;
    readDomCaption();
    const t = active();
    if (!t || !enabled() || overlayHidden) {
      if (shownKey !== null) clearLine();
      shownKey = null;
      shownIndex = -1;
      return;
    }
    const now = video.currentTime - t.offset;
    let idx = findCue(t.cues, now);
    // Captions read from the page disappear when the page clears them, not at a guessed end time.
    if (t.source === 'dom' && !domText && !video.paused) idx = -1;
    if (idx === -1) {
      // Stay on the line while the viewer is studying it.
      if (popFor || (autoPaused && video.paused)) return;
      if (shownKey !== null) clearLine();
      shownKey = null;
      shownIndex = -1;
      highlightRow(-1);
      return;
    }
    const key = t.keys[idx];
    const analyzed = analyses.has(key);
    if (key !== shownKey || analyzed !== shownAnalyzed || idx !== shownIndex) {
      // Do not rebuild the line under the pointer just because the analysis state did not change.
      shownKey = key;
      shownAnalyzed = analyzed;
      shownIndex = idx;
      renderLine(t.cues[idx], key);
      highlightRow(idx);
    }
  }

  // ------------------------------------------------------------------ hover

  function cancelLeave() {
    clearTimeout(leaveTimer);
  }

  function scheduleLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      hidePop();
      if (autoPaused && settings.resumeOnLeave && video && video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
      autoPaused = false;
    }, 280);
  }

  function hidePop() {
    if (!ui) return;
    clearTimeout(deepTimer);
    clearTimeout(hoverTimer);
    deepReq++;
    popFor = null;
    ui.pop.classList.remove('sg-show');
    const cur = ui.line.querySelector('.sg-on');
    if (cur) cur.classList.remove('sg-on');
  }

  function onTokenEnter(tok, w, index, ctx) {
    cancelLeave();
    if (popFor === tok) return;
    if (settings.hoverPause && video && !video.paused) {
      video.pause();
      autoPaused = true;
    }
    hidePop();
    popFor = tok;
    tok.classList.add('sg-on');
    const pop = ui.pop;
    pop.textContent = '';

    const head = h('div', 'sg-pop-head');
    head.append(h('span', 'sg-pop-word', w.s));
    if (w.r && !sameText(w.r, w.s)) head.append(h('span', 'sg-pop-read', w.r));
    pop.append(head);
    const meta = [w.pos, w.d && !sameText(w.d, w.s) ? 'dictionary form: ' + w.d : ''].filter(Boolean).join(' · ');
    if (meta) pop.append(h('div', 'sg-pop-meta', meta));
    pop.append(h('div', 'sg-pop-mean', w.m || ''));

    const parts = Array.isArray(w.p) ? w.p : [];
    if (parts.length > 1 || (parts.length === 1 && !sameText(parts[0].g, w.m))) {
      const table = h('div', 'sg-pop-parts');
      parts.forEach((p, i) => {
        const row = h('div', 'sg-pop-row');
        row.append(h('span', 'sg-pop-t sg-c' + (i % 5), p.t), h('span', 'sg-pop-g', p.g));
        table.append(row);
      });
      pop.append(table);
    }
    if (w.n) pop.append(h('div', 'sg-pop-note', w.n));

    const deep = h('div', 'sg-pop-deep');
    pop.append(deep);
    const deepKey = ctx.key + '|' + index;
    const ask = () => requestDeep(deep, deepKey, w, index, ctx);
    if (deepTexts.has(deepKey)) {
      deep.textContent = deepTexts.get(deepKey);
      deep.classList.add('sg-show');
    } else if (settings.hasKey && settings.autoDeep) {
      deepTimer = setTimeout(ask, 650);
    } else if (settings.hasKey) {
      const more = h('button', 'sg-btn', 'Explain more');
      more.addEventListener('click', () => {
        more.remove();
        ask();
      });
      pop.append(more);
    }

    pop.classList.add('sg-show');
    // Centre the popup above the word, kept inside the video.
    const rr = ui.root.getBoundingClientRect();
    const tr = tok.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const reserved = settings.panelOpen ? ui.panel.el.offsetWidth : 0;
    let left = tr.left - rr.left + tr.width / 2 - pw / 2;
    left = Math.max(6, Math.min(left, rr.width - reserved - pw - 6));
    pop.style.left = left + 'px';
    pop.style.bottom = rr.bottom - tr.top + 6 + 'px';
    pop.style.maxHeight = Math.max(120, tr.top - rr.top - 14) + 'px';
  }

  let deepTarget = null;
  function requestDeep(el, deepKey, w, index, ctx) {
    const reqId = ++deepReq;
    deepTarget = { reqId, el, deepKey, text: '' };
    el.textContent = 'Explaining…';
    el.classList.add('sg-show', 'sg-loading');
    post({
      type: 'deep', reqId, key: ctx.key, wordIndex: index, sentence: ctx.sentence, translation: ctx.translation,
      word: { s: w.s, r: w.r, d: w.d, pos: w.pos, m: w.m, p: w.p, n: w.n },
    });
  }

  function onDeep(msg) {
    const d = deepTarget;
    if (msg.type === 'deepDone' && d && msg.reqId === d.reqId) deepTexts.set(d.deepKey, msg.text);
    // The popup may have moved on to another word while this was streaming.
    if (!d || msg.reqId !== d.reqId || msg.reqId !== deepReq) return;
    d.el.classList.remove('sg-loading');
    if (msg.type === 'deepDelta') {
      d.text += msg.delta;
      d.el.textContent = d.text;
    } else if (msg.type === 'deepDone') {
      d.el.textContent = msg.text;
    } else {
      d.el.textContent = msg.message;
    }
  }

  // ------------------------------------------------------------------ panel

  function renderDetail(cue, a) {
    if (!ui || !settings.panelOpen) return;
    const box = ui.panel.detail;
    box.textContent = '';
    const orig = h('div', 'sg-d-orig', cue.text);
    if (a && a.lang) orig.lang = a.lang;
    box.append(orig);
    if (!a) {
      box.append(h('div', 'sg-d-wait', settings.hasKey ? 'Analyzing this line…' : 'No API key set.'));
      return;
    }
    if (a.tr) box.append(h('div', 'sg-d-tr', a.tr));
    if (a.lit) {
      box.append(h('div', 'sg-section', 'Word for word'), h('div', 'sg-d-lit', a.lit));
    }
    const words = a.w || [];
    if (words.length) {
      box.append(h('div', 'sg-section', 'Structure'));
      const chips = h('div', 'sg-chips');
      let cur = null;
      let chip = null;
      for (const w of words) {
        if (w.c !== cur || !chip) {
          cur = w.c;
          chip = h('span', 'sg-chip sg-role-' + (w.role || 'other'));
          chip.append(h('span', 'sg-chip-role', ROLE_LABELS[w.role] || 'other'), h('span', 'sg-chip-text', ''));
          chips.append(chip);
        }
        chip.lastChild.textContent += w.s;
      }
      box.append(chips);
      if (a.pat) box.append(h('div', 'sg-d-pat', a.pat));
    }
    if (a.notes && a.notes.length) {
      box.append(h('div', 'sg-section', 'Notes'));
      for (const n of a.notes) box.append(h('div', 'sg-d-note', n));
    }
    if (words.length) {
      box.append(h('div', 'sg-section', 'Words'));
      for (const w of words) {
        const row = h('div', 'sg-word');
        const head = h('div', 'sg-word-head');
        head.append(h('span', 'sg-word-s', w.s));
        if (w.r && !sameText(w.r, w.s)) head.append(h('span', 'sg-word-r', w.r));
        head.append(h('span', 'sg-word-m', w.m || ''));
        row.append(head);
        const parts = Array.isArray(w.p) ? w.p : [];
        if (parts.length > 1) row.append(h('div', 'sg-word-p', parts.map((p) => `${p.t} ${p.g}`).join('  +  ')));
        if (w.n) row.append(h('div', 'sg-word-n', w.n));
        box.append(row);
      }
    }
  }

  function renderTranscript() {
    if (!ui || !settings.panelOpen) return;
    const { list, rows } = ui.panel;
    list.textContent = '';
    rows.clear();
    const t = active();
    if (!t) return;
    const frag = document.createDocumentFragment();
    t.cues.forEach((cue, i) => {
      const row = h('div', 'sg-row');
      row.append(h('span', 'sg-row-time', fmtTime(cue.start + t.offset)));
      const body = h('span', 'sg-row-body');
      body.append(h('span', 'sg-row-text', cue.text));
      const a = analyses.get(t.keys[i]);
      body.append(h('span', 'sg-row-tr', a ? a.tr : ''));
      row.append(body);
      row.addEventListener('click', () => {
        video.currentTime = cue.start + t.offset + 0.01;
      });
      const key = t.keys[i];
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(row);
      row.dataset.i = String(i);
      frag.append(row);
    });
    list.append(frag);
    highlightRow(shownIndex);
    renderStatus();
  }

  function updateTranscriptRow(key) {
    if (!ui) return;
    const a = analyses.get(key);
    for (const row of ui.panel.rows.get(key) || []) {
      row.querySelector('.sg-row-tr').textContent = a ? a.tr : '';
    }
  }

  let litRow = null;
  function highlightRow(idx) {
    if (!ui || !settings.panelOpen) return;
    if (litRow) litRow.classList.remove('sg-current');
    litRow = idx >= 0 ? ui.panel.list.children[idx] || null : null;
    if (!litRow) return;
    litRow.classList.add('sg-current');
    const list = ui.panel.list;
    if (!list.matches(':hover')) list.scrollTop = litRow.offsetTop - list.offsetTop - list.clientHeight / 3;
  }

  // ------------------------------------------------- keyboard and picker

  function seekToCue(delta) {
    const t = active();
    if (!t || !video) return;
    const now = video.currentTime - t.offset;
    let idx = findCue(t.cues, now);
    if (idx === -1) {
      idx = t.cues.findIndex((c) => c.start > now);
      if (idx === -1) idx = t.cues.length;
      if (delta > 0) idx -= 1;
    }
    const target = t.cues[Math.max(0, Math.min(t.cues.length - 1, idx + delta))];
    if (target) video.currentTime = target.start + t.offset + 0.01;
  }

  function onKey(e) {
    if (picking && e.key === 'Escape') {
      picking = false;
      return;
    }
    if (!ui || !video || !enabled() || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
    if (!active() && e.key.toLowerCase() !== 'g') return;
    const key = e.key.toLowerCase();
    if (key === 'a') seekToCue(-1);
    else if (key === 'd') seekToCue(1);
    else if (key === 's') seekToCue(0);
    else if (key === 'g') setPanel(!settings.panelOpen);
    else if (key === 'h') {
      overlayHidden = !overlayHidden;
      applySettings();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function selectorFor(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const classes = Array.from(el.classList).filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !c.startsWith('subgloss')).slice(0, 3);
    return classes.length ? el.tagName.toLowerCase() + '.' + classes.join('.') : '';
  }

  function onPickClick(e) {
    if (!picking) return;
    if (ui && ui.root.contains(e.target)) return;
    picking = false;
    e.preventDefault();
    e.stopPropagation();
    const hits = document.elementsFromPoint(e.clientX, e.clientY);
    const el = hits.find((x) => {
      if (x === video || (ui && ui.root.contains(x))) return false;
      const text = (x.innerText || '').trim();
      return text.length > 0 && text.length < 400;
    });
    if (!el) {
      showToast('No text found there. Make sure a subtitle is on screen, then try again.');
      return;
    }
    domEl = el;
    domText = '';
    const sel = selectorFor(el);
    if (sel) {
      const hostSelectors = Object.assign({}, settings.hostSelectors, { [location.hostname]: sel });
      post({ type: 'saveSettings', patch: { hostSelectors } });
    }
    tracks.delete('dom');
    readDomCaption();
    manualPick = 'dom';
    activeId = null;
    chooseActive();
    showToast('Reading subtitles from the page.');
  }

  // ------------------------------------------------------------------ start

  function reportState() {
    if (!port || !video) return;
    const t = active();
    let ready = 0;
    if (t) for (const k of t.keys) if (analyses.has(k)) ready++;
    post({
      type: 'state',
      state: {
        frame: location.hostname,
        track: t ? { label: t.label, lang: t.lang, source: t.source, lines: t.cues.length, ready } : null,
        tracks: tracks.size,
        error: lastError,
      },
    });
  }

  scan();
  setInterval(scan, 1500);
  setInterval(() => {
    if (!video) return;
    place();
    tick();
  }, 100);
  setInterval(() => {
    if (!video) return;
    pump();
    reportState();
  }, 1000);
})();
