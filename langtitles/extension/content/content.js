// Content script: finds the video, collects subtitle lines from every available source,
// asks the background page to analyze them ahead of the playhead, and draws the overlay.
(function () {
  'use strict';
  if (window.__langtitlesLoaded || !document.documentElement || !(document instanceof HTMLDocument)) return;
  window.__langtitlesLoaded = true;

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
  const deepTexts = new Map(); // cache key -> finished text (word explanations and grammar guides)
  const deepByReq = new Map(); // reqId -> { el, cacheKey, text, guide }
  const deepByKey = new Map(); // cache key -> the same object, while its text is still streaming
  let popFor = null;

  let domEl = null; // caption element being read from the page
  let domText = '';
  let picking = false;
  let lastSrc = '';

  // Subtitle sites
  let tabUrl = '';
  let tabTitle = '';
  let playedFor = 0; // seconds of playback seen on this video, so ads and previews do not trigger a search
  let lastTickTime = null;
  const autoTried = new Set(); // episode keys already searched automatically on this page
  let autoBusy = false;
  const subReqs = new Map(); // reqId -> callback
  let offsetSaveTimer = null;

  // Known characters (furigana / pinyin hidden over them) and a pending jump to a saved line
  const known = { ja: new Set(), zh: new Set() };
  let pendingSeek = null;

  // Known words (dictionary forms, per language), and the line-study helpers
  let knownWords = {}; // lang -> Set
  let lineNew = null; // { key, idx, words } for the line on screen
  let onePlusDone = null; // key of the last line paused for
  let replay = null; // { idx, end, rate, loop }

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
      playedFor = 0;
    }
    readTextTracks();
    findCaptionElement();
  }

  // ------------------------------------------------------------- background

  function connect() {
    if (port) return;
    port = browser.runtime.connect({ name: 'langtitles' });
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
      tabUrl = msg.tabUrl || tabUrl;
      tabTitle = msg.tabTitle || tabTitle;
      if (msg.seekTo != null) pendingSeek = msg.seekTo;
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
    } else if (msg.type === 'askDelta' || msg.type === 'askDone' || msg.type === 'askError') {
      onAsk(msg);
    } else if (['tabInfo', 'subsFound', 'subLoaded', 'charInfo', 'bankSaved', 'bankStatus', 'stroke', 'episodeWords', 'pitch', 'seasonStarted', 'seasonJobs'].includes(msg.type)) {
      const cb = subReqs.get(msg.reqId);
      subReqs.delete(msg.reqId);
      if (cb) cb(msg);
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
      offset: prev ? prev.offset : t.offset || 0,
      updatedAt: Date.now(),
      provider: t.provider || null,
      episode: t.episode || null,
      synced: prev ? prev.synced : false,
      userOffset: prev ? prev.userOffset : Boolean(t.userOffset),
    });
    // A subtitle file from a subtitle site can be lined up as soon as the site's own subtitles arrive.
    if (t.source !== 'remote') for (const r of tracks.values()) if (r.source === 'remote' && !r.synced && !r.userOffset) syncRemote(r, false);
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
    // The site's own subtitles are timed to its video, so they beat a downloaded file in the same language.
    let score = t.source === 'dom' ? 1 : t.source === 'remote' ? 80 : 100;
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
        showToast('That file has no subtitles Langtitles can read (.srt, .vtt, .ass, .ttml).');
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
    const root = h('langtitles-root');
    if (typeof matchMedia === 'function' && matchMedia('(hover: none)').matches) root.classList.add('sg-touch');
    root.setAttribute('translate', 'no');
    const sub = h('div', 'sg-sub');
    const line = h('div', 'sg-line');
    const tr = h('div', 'sg-tr');
    sub.append(line, tr);
    const pop = h('div', 'sg-pop');
    const toggle = h('button', 'sg-toggle');
    const fox = h('img', 'sg-fox');
    fox.src = browser.runtime.getURL('icons/icon.svg');
    fox.alt = '';
    toggle.append(fox);
    toggle.title = 'Langtitles panel (G)';
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
    const title = h('span', 'sg-panel-title', 'Langtitles');
    const status = h('span', 'sg-panel-status');
    const close = h('button', 'sg-btn sg-close', '×');
    close.title = 'Close panel';
    close.addEventListener('click', () => setPanel(false));
    const readBtn = h('button', 'sg-btn', 'Readings');
    readBtn.title = 'Show or hide furigana / pinyin (R)';
    readBtn.addEventListener('click', () => toggleReadings());
    const bankBtn = h('button', 'sg-btn', 'Word bank');
    bankBtn.title = 'Your saved words and characters';
    bankBtn.addEventListener('click', () => post({ type: 'openBank' }));
    head.append(title, status, readBtn, bankBtn, close);

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
      t.userOffset = true;
      offset.textContent = (t.offset >= 0 ? '+' : '') + t.offset.toFixed(2) + 's';
      rememberOffset(t);
      shownKey = null;
      tick();
    };
    early.title += ' (Shift: 2 s)';
    late.title += ' (Shift: 2 s)';
    early.addEventListener('click', (e) => nudge(e.shiftKey ? -2 : -0.25));
    late.addEventListener('click', (e) => nudge(e.shiftKey ? 2 : 0.25));
    const findBtn = h('button', 'sg-btn', 'Find subtitles');
    findBtn.title = 'Search OpenSubtitles, SubDL and Jimaku for this episode';
    findBtn.addEventListener('click', () => openFind());
    const wordsBtn = h('button', 'sg-btn', 'Episode words');
    wordsBtn.title = "The episode's words you don't know yet, most frequent first";
    wordsBtn.addEventListener('click', () => openEpisodeWords());
    tools.append(select, findBtn, wordsBtn, fileBtn, pickBtn, early, offset, late, file);

    const hint = h('div', 'sg-hint');
    const guide = h('div', 'sg-pguide');
    const guideHead = h('div', 'sg-pguide-head');
    const guideTitle = h('span', 'sg-pguide-title');
    const guideLib = h('button', 'sg-btn', 'Library');
    guideLib.title = 'All the guides you have collected';
    guideLib.addEventListener('click', () => post({ type: 'openLibrary', k: guide.dataset.k || '' }));
    const guideBack = h('button', 'sg-btn', 'Back');
    guideBack.addEventListener('click', () => guide.classList.remove('sg-show'));
    guideHead.append(guideTitle, guideLib, guideBack);
    const guideBody = h('div', 'sg-pguide-body');
    guide.append(guideHead, guideBody);
    const detail = h('div', 'sg-detail');
    const listTitle = h('div', 'sg-section', 'Transcript');
    const list = h('div', 'sg-list');
    const find = h('div', 'sg-pguide sg-find');
    const findHead = h('div', 'sg-pguide-head');
    const findBack = h('button', 'sg-btn', 'Back');
    findBack.addEventListener('click', () => find.classList.remove('sg-show'));
    findHead.append(h('span', 'sg-pguide-title', 'Find subtitles'), findBack);
    const findBody = h('div', 'sg-pguide-body');
    find.append(findHead, findBody);
    const words = h('div', 'sg-pguide sg-find');
    const wordsHead = h('div', 'sg-pguide-head');
    const wordsBack = h('button', 'sg-btn', 'Back');
    wordsBack.addEventListener('click', () => words.classList.remove('sg-show'));
    wordsHead.append(h('span', 'sg-pguide-title', 'Episode words'), wordsBack);
    const wordsBody = h('div', 'sg-pguide-body');
    words.append(wordsHead, wordsBody);
    el.append(head, tools, hint, find, words, guide, detail, listTitle, list);
    return { el, status, select, offset, hint, find, findBody, words, wordsBody, guide, guideTitle, guideBody, detail, list, rows: new Map() };
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
    document.documentElement.classList.toggle('langtitles-hide-native', hide);
    if (domEl) domEl.classList.toggle('langtitles-native-caption', hide);
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
      const kind = { net: '', texttrack: '', dom: ' (read from page)', file: ' (file)', remote: ' (downloaded)' }[t.source] || '';
      const opt = new Option(`${langName(t.lang)} · ${t.label}${kind} · ${t.cues.length} lines`, t.id);
      opt.selected = t.id === activeId;
      select.append(opt);
    }
    const native = langCode(settings.nativeLang);
    let text = '';
    if (!settings.hasKey) text = 'Add your Anthropic API key in the Langtitles options to get breakdowns.';
    else if (!tracks.size) text = 'Turn on subtitles in the player. Langtitles picks them up as the site loads them. If nothing appears, use “Pick on page” or “Load file”.';
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
    const cov = coverage.get(t.id);
    ui.panel.status.textContent = `${ready}/${t.cues.length} lines ready${inflight ? ' · working' : ''}${cov ? ` · ${cov.pct}% known` : ''}`;
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
    const tok = h('span', 'sg-tok sg-role-' + (w.role || 'other') + (isNewWord(w, ctx.lang) ? ' sg-new' : ''));
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

    tok.append(buildSurface(w, ctx.lang, multi && parts.map((p) => p.t).join('') === w.s ? parts : null), h('span', 'sg-bar'));
    tok.append(h('span', 'sg-role', firstOfPhrase ? ROLE_LABELS[w.role] || '' : ''));

    tok.addEventListener('mouseenter', () => onTokenEnter(tok, w, index, ctx));
    tok.addEventListener('click', () => onTokenEnter(tok, w, index, ctx));
    return tok;
  }

  function readingsOn(lang) {
    if (lang === 'ja') return Boolean(settings.furigana);
    if (lang === 'zh') return Boolean(settings.pinyin);
    if (lang === 'ko') return Boolean(settings.hanja);
    return false;
  }

  function knownFor(lang) {
    if (lang === 'ja') return known.ja;
    if (lang === 'zh') return settings.hideKnownPinyin ? known.zh : null;
    return null;
  }

  // The word itself, with each piece coloured to match its gloss and furigana or pinyin
  // as ruby text over the characters that need it.
  function buildSurface(w, lang, parts) {
    const surf = h('span', 'sg-surf');
    const pieceAt = [];
    if (parts) parts.forEach((p, i) => { for (let k = 0; k < p.t.length; k++) pieceAt.push(i); });
    const text = (str, from) => {
      if (!parts) return document.createTextNode(str);
      const frag = document.createDocumentFragment();
      let pos = from;
      let cur = null;
      for (const ch of Array.from(str)) {
        const piece = pieceAt[pos] == null ? 0 : pieceAt[pos];
        if (!cur || cur.dataset.piece !== String(piece)) {
          cur = h('span', 'sg-seg sg-c' + (piece % 5));
          cur.dataset.piece = String(piece);
          frag.append(cur);
        }
        cur.textContent += ch;
        pos += ch.length;
      }
      return frag;
    };
    const segs = readingsOn(lang) ? SG.ruby.segmentsFor(w, lang) : null;
    if (!segs) {
      surf.append(text(w.s, 0));
      return surf;
    }
    const knownSet = knownFor(lang);
    let pos = 0;
    for (const seg of segs) {
      if (SG.ruby.showReading(seg, knownSet)) {
        const ruby = h('ruby', 'sg-ruby');
        const rt = h('rt', lang === 'zh' && settings.toneColors ? 'sg-tone' + SG.ruby.toneOf(seg.r) : lang === 'ko' ? 'sg-hanja' : '', seg.r);
        ruby.append(text(seg.t, pos), rt);
        surf.append(ruby);
      } else {
        surf.append(text(seg.t, pos));
      }
      pos += seg.t.length;
    }
    return surf;
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
      const t = active();
      const ctx = { key, sentence: cue.text, translation: a.tr, lang: langCode(a.lang), time: cue.start + (t ? t.offset : 0) };
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
    studyChecks(t, now);
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
      const a = analyses.get(key);
      lineNew = a ? { key, idx, words: newWordsIn(a) } : null;
    }
  }

  // ------------------------------------------------------------------ hover

  function cancelLeave() {
    clearTimeout(leaveTimer);
  }

  function scheduleLeave() {
    clearTimeout(leaveTimer);
    if (touchMode) return;
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
    pop.classList.remove('sg-wide');
    if (touchMode) {
      const close = h('button', 'sg-pop-close', '×');
      close.title = 'Close and keep watching';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        hidePop();
        if (autoPaused && video && video.paused) {
          const pr = video.play();
          if (pr && pr.catch) pr.catch(() => {});
        }
        autoPaused = false;
      });
      pop.append(close);
    }

    const head = h('div', 'sg-pop-head');
    head.append(h('span', 'sg-pop-word', w.s));
    if (w.r && !sameText(w.r, w.s)) head.append(h('span', 'sg-pop-read', w.r));
    head.append(speakButton(w.s, ctx.lang), knownWordButton(w, ctx.lang), starButton('word', ctx.lang, w.d || w.s, () => wordItem(w, ctx)));
    pop.append(head);
    const meta = [w.pos, w.d && !sameText(w.d, w.s) ? 'dictionary form: ' + w.d : ''].filter(Boolean).join(' · ');
    if (meta) pop.append(h('div', 'sg-pop-meta', meta));
    if (ctx.lang === 'ja' && settings.pitchAccent) pop.append(pitchBlock(w));
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
    if (Array.isArray(w.b) && w.b.length > 1) {
      const chain = h('div', 'sg-build');
      w.b.forEach((step, i) => {
        if (i) chain.append(h('span', 'sg-build-arrow', '→'));
        const one = h('span', 'sg-build-step');
        const form = h('span', 'sg-build-t', step.t);
        form.lang = ctx.lang;
        one.append(form, h('span', 'sg-build-m', step.m));
        chain.append(one);
      });
      pop.append(chain);
    }
    if (w.n) pop.append(h('div', 'sg-pop-note', w.n));

    const forms = formsOf(w);
    const deep = h('div', 'sg-pop-deep');
    // Guides: one for the word itself (what it means, how it's built, where it fits and
    // where it doesn't), and one for each grammar form it carries.
    const wordForm = wordGuideForm(w, ctx.lang);
    const guides = (isTrivial(w) && forms.length ? [] : [{ f: wordForm, word: true }]).concat(forms.map((f) => ({ f, word: false })));
    const firstGuide = forms.length ? guides.find((g) => !g.word) : guides[0];
    if (guides.length) {
      const row = h('div', 'sg-pop-forms');
      row.append(h('span', 'sg-pop-forms-label', 'Guides'));
      for (const g of guides) {
        const chip = h('button', 'sg-form' + (g.word ? ' sg-form-word' : '') + (g === firstGuide ? ' sg-on' : ''), g.word ? '📖 ' + (w.d || w.s) : g.f.name || g.f.k);
        chip.title = g.word ? 'Everything about this word: meanings, how it is built, where it fits and where it does not' : 'Full guide to this grammar form';
        chip.dataset.k = g.f.k;
        chip.addEventListener('click', () => {
          clearTimeout(deepTimer);
          for (const c of pop.querySelectorAll('.sg-form, .sg-char')) c.classList.toggle('sg-on', c === chip);
          pop.classList.add('sg-wide');
          if (g.word) showWordGuide(deep, w, ctx);
          else showGuide(deep, g.f, ctx, w);
          placePop(tok);
        });
        row.append(chip);
      }
      const lib = h('button', 'sg-btn sg-lib', 'Library');
      lib.title = 'All the guides you have collected';
      lib.addEventListener('click', () => {
        const on = row.querySelector('.sg-form.sg-on');
        post({ type: 'openLibrary', k: on ? on.dataset.k : '' });
      });
      row.append(lib);
      pop.append(row);
    }
    if (Array.isArray(w.x) && w.x.length) {
      const row = h('div', 'sg-pop-x');
      row.append(h('span', 'sg-pop-forms-label', 'Also in'));
      for (const x of w.x) {
        const item = h('span', 'sg-x');
        const word = h('span', 'sg-x-w', x.w);
        word.lang = x.lang;
        item.append(h('span', 'sg-x-lang', { ja: 'Japanese', zh: 'Chinese', ko: 'Korean' }[x.lang] || x.lang), word);
        if (x.r) item.append(h('span', 'sg-x-r', x.r));
        if (x.note) item.append(h('span', 'sg-x-note', x.note));
        row.append(item);
      }
      pop.append(row);
    }
    const chars = ctx.lang === 'ja' || ctx.lang === 'zh' ? SG.ruby.hanChars(w.s) : [];
    if (chars.length) {
      const row = h('div', 'sg-pop-forms sg-pop-chars');
      row.append(h('span', 'sg-pop-forms-label', ctx.lang === 'ja' ? 'Kanji' : 'Characters'));
      for (const ch of chars) {
        const chip = h('button', 'sg-char' + (known[ctx.lang].has(ch) ? ' sg-known' : ''), ch);
        chip.title = known[ctx.lang].has(ch) ? 'Known · open its entry' : 'Open its entry';
        chip.addEventListener('click', () => {
          clearTimeout(deepTimer);
          for (const c of pop.querySelectorAll('.sg-form, .sg-char')) c.classList.toggle('sg-on', c === chip);
          pop.classList.add('sg-wide');
          showCharEntry(deep, ch, ctx, w);
          placePop(tok);
        });
        row.append(chip);
      }
      pop.append(row);
    }
    pop.append(deep);

    const ask = () => {
      if (!firstGuide) return;
      pop.classList.add('sg-wide');
      if (firstGuide.word) showWordGuide(deep, w, ctx);
      else showGuide(deep, firstGuide.f, ctx, w);
      placePop(tok);
    };
    const ready = firstGuide && deepTexts.has(firstGuide.word ? guideCacheKey(wordForm) : guideCacheKey(firstGuide.f));
    if (ready) {
      ask();
    } else if (settings.hasKey && settings.autoDeep && firstGuide) {
      deepTimer = setTimeout(ask, 650);
    } else if (settings.hasKey && firstGuide) {
      const more = h('button', 'sg-btn', firstGuide.word ? 'Word guide' : 'Full guide to ' + (firstGuide.f.name || firstGuide.f.k));
      more.addEventListener('click', () => {
        more.remove();
        ask();
      });
      pop.append(more);
    }

    pop.classList.add('sg-show');
    placePop(tok);
  }

  // Centre the popup above the word, kept inside the video.
  function placePop(tok) {
    const pop = ui.pop;
    if (!tok.isConnected) return;
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

  function formsOf(w) {
    const seen = new Set();
    return (Array.isArray(w.g) ? w.g : []).filter((f) => f && f.k && !seen.has(f.k) && seen.add(f.k));
  }

  function guideCacheKey(form) {
    return 'guide|' + form.k;
  }

  function paintDeep(target) {
    if (target.guide) SG.renderGuide(target.el, target.text);
    else target.el.textContent = target.text;
  }

  // Shows cached text at once, attaches to a request already streaming, or starts a new one.
  function startDeep(el, cacheKey, guide, payload) {
    el.classList.add('sg-show');
    el.classList.toggle('sg-guide', guide);
    if (deepTexts.has(cacheKey)) {
      el.classList.remove('sg-loading');
      paintDeep({ el, text: deepTexts.get(cacheKey), guide });
      return;
    }
    const running = deepByKey.get(cacheKey);
    if (running) {
      running.el = el;
      if (running.text) paintDeep(running);
      else {
        el.textContent = guide ? 'Writing a guide to this form…' : 'Explaining…';
        el.classList.add('sg-loading');
      }
      return;
    }
    const reqId = ++deepReq;
    const target = { el, cacheKey, text: '', guide };
    deepByReq.set(reqId, target);
    deepByKey.set(cacheKey, target);
    el.textContent = guide ? `Writing a guide to ${payload.kind === 'wordguide' ? 'this word' : 'this form'}… (saved once written, so it opens instantly next time)` : 'Explaining…';
    el.classList.add('sg-loading');
    post(Object.assign({ type: 'deep', reqId }, payload));
  }

  function wordGuideForm(w, lang) {
    const d = w.d || w.s;
    return { k: `word.${lang || 'und'}.${d}`, name: d + (w.r && w.d === w.s ? ` (${w.r})` : '') };
  }

  function showWordGuide(el, w, ctx) {
    const form = wordGuideForm(w, ctx.lang);
    startDeep(el, guideCacheKey(form), true, {
      kind: 'wordguide', form, lang: ctx.lang, sentence: ctx.sentence, word: w.s, dict: w.d, reading: w.r, pos: w.pos, meaning: w.m,
    });
  }

  function showGuide(el, form, ctx, w) {
    startDeep(el, guideCacheKey(form), true, {
      kind: 'guide', form: { k: form.k, name: form.name }, lang: ctx.lang, sentence: ctx.sentence, word: w.s,
    });
  }

  function onDeep(msg) {
    const target = deepByReq.get(msg.reqId);
    if (!target) return;
    target.el.classList.remove('sg-loading');
    if (msg.type === 'deepDelta') {
      target.text += msg.delta;
      paintDeep(target);
      return;
    }
    deepByReq.delete(msg.reqId);
    deepByKey.delete(target.cacheKey);
    if (msg.type === 'deepDone') {
      deepTexts.set(target.cacheKey, msg.text);
      target.text = msg.text;
      paintDeep(target);
    } else {
      target.el.textContent = msg.message;
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
    const lineTools = h('div', 'sg-d-tools');
    const lang = langCode(a.lang);
    const say = h('button', 'sg-btn', '🔊 Hear the line');
    say.addEventListener('click', () => speakText(cue.text, lang));
    const allKnown = h('button', 'sg-btn', 'Mark every word known');
    allKnown.title = 'Marks each word in this line as known (particles and names are never highlighted anyway)';
    allKnown.addEventListener('click', async () => {
      const words = (a.w || []).filter((w) => !isTrivial(w)).map((w) => w.d || w.s);
      await setWordsKnown(lang, words, true);
      showToast(`Marked ${words.length} word${words.length === 1 ? '' : 's'} known.`);
    });
    const lineStar = starButton('line', lang, cue.text, async () => ({
      kind: 'line', lang, text: cue.text,
      line: { tr: a.tr, lit: a.lit, notes: a.notes || [], w: (a.w || []).map((w) => ({ s: w.s, r: w.r, f: SG.ruby.segmentsFor(w, lang), d: w.d, m: w.m, pos: w.pos })) },
      context: await lineContext({ sentence: cue.text, translation: a.tr, lang, time: cue.start + (active() ? active().offset : 0) }),
    }));
    lineStar.title = 'Save this line as a review card';
    const saveLbl = h('span', 'sg-d-save');
    saveLbl.append(lineStar, document.createTextNode(' Save line'));
    lineTools.append(say, allKnown, saveLbl);
    box.append(lineTools);
    box.append(askBox(cue, a));
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
    const forms = [];
    const seen = new Set();
    for (const w of words) {
      for (const f of formsOf(w)) {
        if (!seen.has(f.k)) {
          seen.add(f.k);
          forms.push({ f, w });
        }
      }
    }
    if (forms.length) {
      box.append(h('div', 'sg-section', 'Grammar in this line'));
      const row = h('div', 'sg-d-forms');
      const ctx = { key: shownKey, sentence: cue.text, translation: a.tr, lang: a.lang };
      for (const { f, w } of forms) {
        const chip = h('button', 'sg-form', f.name || f.k);
        if (deepTexts.has(guideCacheKey(f))) chip.classList.add('sg-saved');
        chip.title = 'Open the full guide to this form';
        chip.addEventListener('click', () => openPanelGuide(f, ctx, w));
        row.append(chip);
      }
      box.append(row);
    }
    if (words.length) {
      box.append(h('div', 'sg-section', 'Words'));
      for (const w of words) {
        const row = h('div', 'sg-word');
        const head = h('div', 'sg-word-head');
        head.append(h('span', 'sg-word-s', w.s));
        if (w.r && !sameText(w.r, w.s)) head.append(h('span', 'sg-word-r', w.r));
        head.append(h('span', 'sg-word-m', w.m || ''));
        const wctx = { sentence: cue.text, translation: a.tr, lang: langCode(a.lang), time: cue.start + (active() ? active().offset : 0) };
        const gb = h('button', 'sg-say', '📖');
        gb.title = 'Word guide';
        gb.addEventListener('click', () => openPanelGuide(wordGuideForm(w, wctx.lang), wctx, w, true));
        head.append(gb, starButton('word', langCode(a.lang), w.d || w.s, () => wordItem(w, wctx)));
        row.append(head);
        const parts = Array.isArray(w.p) ? w.p : [];
        if (parts.length > 1) row.append(h('div', 'sg-word-p', parts.map((p) => `${p.t} ${p.g}`).join('  +  ')));
        if (w.n) row.append(h('div', 'sg-word-n', w.n));
        box.append(row);
      }
    }
  }

  function openPanelGuide(form, ctx, w, isWord) {
    const p = ui.panel;
    p.find.classList.remove('sg-show');
    p.words.classList.remove('sg-show');
    p.guide.dataset.k = form.k;
    p.guideTitle.textContent = isWord ? '📖 ' + (form.name || form.k) : form.name || form.k;
    p.guide.classList.add('sg-show');
    p.guideBody.scrollTop = 0;
    if (isWord) showWordGuide(p.guideBody, w, ctx);
    else showGuide(p.guideBody, form, ctx, w);
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
    else if (key === 's') replayLine(false);
    else if (key === 'l') replayLine(true);
    else if (key === 'g') setPanel(!settings.panelOpen);
    else if (key === 'r') toggleReadings();
    else if (key === 'h') {
      overlayHidden = !overlayHidden;
      applySettings();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function selectorFor(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const classes = Array.from(el.classList).filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !c.startsWith('langtitles')).slice(0, 3);
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

  // ------------------------------------------------- readings and word bank

  function loadKnown(value) {
    const v = value || {};
    known.ja = new Set(Array.from(v.ja || ''));
    known.zh = new Set(Array.from(v.zh || ''));
  }

  function refreshLine() {
    shownKey = null;
    tick();
  }

  function loadKnownWords(value) {
    knownWords = {};
    for (const [lang, list] of Object.entries(value || {})) knownWords[lang] = new Set(list);
  }

  browser.storage.local.get(['known', 'knownWords']).then((r) => {
    loadKnown(r.known);
    loadKnownWords(r.knownWords);
    refreshLine();
  }, () => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.known) loadKnown(changes.known.newValue);
    if (changes.knownWords) loadKnownWords(changes.knownWords.newValue);
    if (changes.known || changes.knownWords) refreshLine();
  });

  // ------------------------------------------------------- new and known words

  const NEW_THRESHOLD = 20;

  function isTrivial(w) {
    return /particle|punctuation|interjection|auxiliary|proper noun|name|助詞|symbol|onomatopoeia/i.test(w.pos || '') || ['connector', 'interjection', 'address'].includes(w.role) && /particle|conjunction/i.test(w.pos || '');
  }

  function wordKnown(w, lang) {
    const set = knownWords[lang];
    return Boolean(set && (set.has(w.d || w.s) || set.has(w.s)));
  }

  // Highlighting starts once enough words are marked known in the language, so that a
  // highlighted word means something.
  function highlighting(lang) {
    return settings.highlightNew && knownWords[lang] && knownWords[lang].size >= NEW_THRESHOLD;
  }

  function isNewWord(w, lang) {
    return highlighting(lang) && !isTrivial(w) && !wordKnown(w, lang);
  }

  function newWordsIn(a) {
    const lang = langCode(a.lang);
    if (!highlighting(lang)) return [];
    const seen = new Set();
    return (a.w || []).filter((w) => isNewWord(w, lang) && !seen.has(w.d || w.s) && seen.add(w.d || w.s));
  }

  async function setWordsKnown(lang, words, on) {
    const r = await browser.storage.local.get('knownWords');
    const all = Object.assign({}, r.knownWords);
    const set = new Set(all[lang] || []);
    for (const w of words) {
      if (on) set.add(w);
      else set.delete(w);
    }
    all[lang] = Array.from(set);
    await browser.storage.local.set({ knownWords: all });
    return set;
  }

  function knownWordButton(w, lang) {
    const b = h('button', 'sg-kw');
    const paint = () => {
      const on = wordKnown(w, lang);
      b.textContent = on ? '✓ Known' : 'Known?';
      b.classList.toggle('sg-on', on);
      b.title = on ? 'You know this word · click to undo' : 'Mark this word as one you know (it stops being highlighted as new)';
    };
    paint();
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const on = !wordKnown(w, lang);
      const set = await setWordsKnown(lang, [w.d || w.s], on);
      knownWords[lang] = set;
      paint();
      const n = set.size;
      if (on && n === NEW_THRESHOLD && settings.highlightNew) showToast(`${n} words known: words you don't know yet are now underlined.`);
    });
    return b;
  }

  // ------------------------------------------------------- replay and pausing

  function replayLine(loop) {
    const t = active();
    if (!t || !video) return;
    const now = video.currentTime - t.offset;
    let idx = findCue(t.cues, now);
    if (idx === -1) {
      idx = t.cues.findIndex((c) => c.start > now) - 1;
      if (idx < 0) idx = Math.max(0, t.cues.length - 1);
    }
    if (loop && replay && replay.loop) {
      stopReplay();
      showToast('Loop off (L).');
      return;
    }
    const cue = t.cues[idx];
    if (!replay) replay = { rate: video.playbackRate };
    replay.idx = idx;
    replay.end = cue.end;
    replay.start = cue.start;
    replay.loop = loop;
    if (settings.slowReplay) video.playbackRate = settings.slowRate || 0.75;
    video.currentTime = cue.start + t.offset + 0.01;
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
    if (loop) showToast(`Looping this line${settings.slowReplay ? ' slowed down' : ''}. Press L to stop.`);
  }

  function stopReplay() {
    if (!replay) return;
    if (video) video.playbackRate = replay.rate || 1;
    replay = null;
  }

  // Runs every tick: ends or repeats a replay, and pauses after a line with exactly one new word.
  function studyChecks(t, now) {
    if (replay) {
      if (now >= replay.end - 0.02 && now < replay.end + 1.5) {
        if (replay.loop) {
          video.currentTime = replay.start + t.offset + 0.01;
        } else {
          stopReplay();
        }
      } else if (now < replay.start - 1 || now > replay.end + 1.5) {
        stopReplay(); // the viewer jumped elsewhere
      }
    }
    if (!settings.pauseOnePlus || !lineNew || video.paused || replay || popFor) return;
    const cue = t.cues[lineNew.idx];
    if (!cue || lineNew.words.length !== 1 || onePlusDone === lineNew.key) return;
    if (now >= cue.end - 0.25 && now < cue.end + 0.6) {
      onePlusDone = lineNew.key;
      video.pause();
      // Stay on this line even if the check ran a moment after it ended.
      if (now > cue.end - 0.08) video.currentTime = cue.end - 0.08 + t.offset;
      autoPaused = false;
      const w = lineNew.words[0];
      showToast(`One new word: ${w.s}${w.m ? ' (' + w.m + ')' : ''}. Hover it, or press Space to go on.`);
    }
  }

  // --------------------------------------------------------- pronunciation

  async function speakText(text, lang) {
    const ok = await SG.speech.speak(text, lang);
    if (!ok) showToast(SG.speech.missingVoiceHelp(lang));
  }

  function speakButton(text, lang) {
    const b = h('button', 'sg-say', '🔊');
    b.title = 'Hear it';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText(text, lang);
    });
    return b;
  }

  // ------------------------------------------------------------ stroke order

  let strokeCssAdded = false;

  function strokeBlock(ch, lang) {
    const wrap = h('div', 'sg-strokes');
    if (!strokeCssAdded && ui) {
      const st = document.createElement('style');
      st.textContent = SG.strokes.CSS;
      ui.root.append(st);
      strokeCssAdded = true;
    }
    wrap.append(h('div', 'sg-g-h', 'Stroke order'));
    const row = h('div', 'sg-strokes-row');
    const pic = h('div', 'sg-strokes-pic', '…');
    const side = h('div', 'sg-strokes-side');
    row.append(pic, side);
    wrap.append(row);
    request({ type: 'stroke', ch, lang }).then((res) => {
      if (!res.data) {
        pic.textContent = 'No stroke order data for this character.';
        return;
      }
      let data;
      try {
        data = res.data.kind === 'kvg' ? SG.strokes.parseKanjiVG(res.data.text) : SG.strokes.parseHanziWriter(res.data.text);
      } catch (e) {
        pic.textContent = 'Stroke order data could not be read.';
        return;
      }
      const draw = () => SG.strokes.render(pic, data, { size: 120 });
      draw();
      const again = h('button', 'sg-btn', 'Replay');
      again.addEventListener('click', draw);
      side.append(h('div', 'sg-strokes-n', `${data.strokes.length} strokes`));
      const lg = SG.strokes.legend(data);
      if (lg.length) {
        const list = h('div', 'sg-strokes-legend');
        for (const c of lg) {
          const item = h('div', 'sg-strokes-comp');
          const sw = h('span', 'sg-strokes-sw', c.element);
          sw.style.color = c.color;
          item.append(sw, h('span', '', [c.original ? `from ${c.original}` : '', c.role].filter(Boolean).join(' · ')));
          list.append(item);
        }
        side.append(list);
      }
      side.append(again, h('div', 'sg-strokes-src', data.kind === 'kvg' ? 'KanjiVG, CC BY-SA 3.0' : 'Make Me a Hanzi'));
    });
    return wrap;
  }

  // ------------------------------------------------------------ episode words

  async function openEpisodeWords() {
    const p = ui.panel;
    p.find.classList.remove('sg-show');
    p.guide.classList.remove('sg-show');
    p.words.classList.add('sg-show');
    const body = p.wordsBody;
    body.textContent = '';
    const t = active();
    if (!t) {
      body.append(h('div', 'sg-g-p', 'No subtitles yet.'));
      return;
    }
    if (t.source === 'dom') {
      body.append(h('div', 'sg-g-p', "Subtitles read off the page only arrive line by line, so there's no full episode to list yet. Find subtitles for the episode first (Find subtitles)."));
      return;
    }
    const lang = t.lang;
    body.append(h('div', 'sg-find-status', `Making a list from all ${t.cues.length} lines… (once per episode)`));
    const sig = SG.subtitles.lineKey(t.cues.map((c) => c.text).join('\n'), String(t.cues.length));
    const res = await request({ type: 'episodeWords', lines: t.cues.map((c) => c.text), sig });
    body.textContent = '';
    if (res.error) {
      body.append(h('div', 'sg-g-p', res.error));
      return;
    }
    const all = res.words || [];
    const cov = computeCoverage(all, lang);
    coverage.set(t.id, cov);
    renderStatus();
    const head = h('div', 'sg-cov');
    head.append(h('div', 'sg-cov-n', cov.pct + '%'), h('div', 'sg-cov-t', `of the words in this episode are ones you know (counting each time a word is used). ${cov.pct >= 90 ? 'Comfortable.' : cov.pct >= 75 ? 'A good level to learn from.' : 'Challenging: studying the words below first will help.'}`));
    body.append(head);
    const status = h('div', 'sg-find-status');
    const hideKnown = h('label', 'sg-f-check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = true;
    hideKnown.append(box, document.createTextNode(" Hide words I know"));
    const list = h('div', 'sg-results');
    body.append(status, hideKnown, list);
    const draw = () => {
      list.textContent = '';
      const shown = all.filter((x) => !(box.checked && knownWords[lang] && knownWords[lang].has(x.d)));
      status.textContent = `${shown.length} of ${all.length} words${box.checked ? " you haven't marked known" : ''}, most frequent first.`;
      for (const x of shown) {
        const row = h('div', 'sg-wl');
        const top = h('div', 'sg-wl-top');
        const word = h('span', 'sg-wl-w', x.d);
        word.lang = lang;
        top.append(word, h('span', 'sg-wl-r', x.r || ''), h('span', 'sg-wl-n', '×' + x.count));
        const fake = { s: x.d, d: x.d, r: x.r, m: x.m, pos: x.pos };
        const line = t.cues[x.line];
        const ctx = { sentence: line ? line.text : '', translation: '', lang, time: line ? line.start + t.offset : 0 };
        const kn = knownWordButton(fake, lang);
        kn.addEventListener('click', () => setTimeout(draw, 50));
        const gb = h('button', 'sg-say', '📖');
        gb.title = 'Word guide';
        gb.addEventListener('click', () => openPanelGuide(wordGuideForm(fake, lang), ctx, fake, true));
        top.append(speakButton(x.d, lang), gb, kn, starButton('word', lang, x.d, () => wordItem(fake, ctx)));
        row.append(top, h('div', 'sg-wl-m', [x.m, x.pos].filter(Boolean).join(' · ')));
        if (line) {
          const ex = h('button', 'sg-wl-ex', line.text);
          ex.title = 'Jump to this line';
          ex.addEventListener('click', () => {
            video.currentTime = line.start + t.offset + 0.01;
          });
          row.append(ex);
        }
        list.append(row);
      }
    };
    box.addEventListener('change', draw);
    draw();
  }

  async function toggleKnown(ch, lang) {
    const r = await browser.storage.local.get('known');
    const v = Object.assign({ ja: '', zh: '' }, r.known);
    const set = new Set(Array.from(v[lang] || ''));
    if (set.has(ch)) set.delete(ch);
    else set.add(ch);
    v[lang] = Array.from(set).join('');
    await browser.storage.local.set({ known: v });
    return set.has(ch);
  }

  function toggleReadings() {
    const t = active();
    const lang = t ? t.lang : '';
    let patch = null;
    const which = { ja: ['furigana', 'Furigana'], zh: ['pinyin', 'Pinyin'], ko: ['hanja', 'Hanja'] }[lang];
    if (!which) {
      showToast('Readings are shown over Japanese kanji (furigana), Chinese characters (pinyin) and Sino-Korean words (hanja).');
      return;
    }
    patch = { [which[0]]: !settings[which[0]] };
    Object.assign(settings, patch);
    post({ type: 'saveSettings', patch });
    showToast(`${which[1]} ${settings[which[0]] ? 'on' : 'off'} (R).`);
    refreshLine();
  }

  async function lineContext(ctx) {
    let show = '';
    try {
      show = SG.episode.describe(await currentEpisode());
    } catch (e) {
      /* the line is still worth saving without the show's name */
    }
    return {
      sentence: ctx.sentence, translation: ctx.translation || '', show, url: tabUrl || location.href,
      time: Math.max(0, Math.round((ctx.time || 0) * 10) / 10), savedAt: Date.now(),
    };
  }

  async function wordItem(w, ctx) {
    return {
      kind: 'word', lang: ctx.lang, text: w.d || w.s,
      word: { s: w.s, r: w.r, f: SG.ruby.segmentsFor(w, ctx.lang), d: w.d, pos: w.pos, m: w.m, p: w.p, n: w.n, g: formsOf(w) },
      context: await lineContext(ctx),
    };
  }

  // A star that saves (or removes) a word or character, showing whether it is already saved.
  function starButton(kind, lang, text, makeItem) {
    const key = [kind, lang, text].join('|');
    const b = h('button', 'sg-star', '☆');
    b.title = 'Save to your word bank';
    request({ type: 'bankStatus', keys: [key] }).then((res) => {
      if (res.status && res.status[key]) {
        b.textContent = '★';
        b.classList.add('sg-saved');
        b.title = 'Saved · click to remove';
      }
    });
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (b.classList.contains('sg-saved')) {
        await request({ type: 'bankRemove', key });
        b.textContent = '☆';
        b.classList.remove('sg-saved');
        b.title = 'Save to your word bank';
        return;
      }
      const res = await request({ type: 'bankSave', item: await makeItem() });
      if (res.error) {
        showToast(res.error);
        return;
      }
      b.textContent = '★';
      b.classList.add('sg-saved');
      b.title = 'Saved · click to remove';
    });
    return b;
  }

  function renderCharEntry(el, ch, ctx, w, e) {
    el.classList.remove('sg-loading', 'sg-guide');
    el.textContent = '';
    const lang = ctx.lang;
    const box = h('div', 'sg-ce');
    const head = h('div', 'sg-ce-head');
    head.append(h('span', 'sg-ce-char', ch));
    const reads = h('div', 'sg-ce-reads');
    for (const r of e.readings || []) {
      const one = h('span', 'sg-ce-read sg-ce-' + r.kind, r.r);
      one.title = r.use || '';
      reads.append(one);
    }
    head.append(reads);
    const known1 = h('button', 'sg-btn sg-ce-known' + (known[lang].has(ch) ? ' sg-on' : ''), known[lang].has(ch) ? '✓ Known' : 'Mark known');
    known1.title = lang === 'ja' ? 'Known kanji get no furigana' : 'Known characters get no pinyin (if that option is on)';
    known1.addEventListener('click', async () => {
      const now = await toggleKnown(ch, lang);
      known1.textContent = now ? '✓ Known' : 'Mark known';
      known1.classList.toggle('sg-on', now);
    });
    head.append(known1, starButton('char', lang, ch, async () => ({ kind: 'char', lang, text: ch, entry: e, context: await lineContext(ctx), from: w.s })));
    box.append(head);
    if (e.meanings && e.meanings.length) box.append(h('div', 'sg-ce-mean', e.meanings.join('; ')));
    if (e.here) box.append(h('div', 'sg-ce-here', e.here));
    box.append(strokeBlock(ch, lang));
    if (e.parts && e.parts.length) {
      box.append(h('div', 'sg-g-h', 'Built from'));
      const parts = h('div', 'sg-ce-parts');
      e.parts.forEach((p, i) => {
        if (i) parts.append(h('span', 'sg-plus', '+'));
        const part = h('span', 'sg-ce-part');
        part.append(h('span', 'sg-ce-pc sg-c' + (i % 5), p.c), h('span', 'sg-ce-pg', p.g));
        parts.append(part);
      });
      box.append(parts);
      if (e.build) box.append(h('div', 'sg-g-p', e.build));
    }
    if (e.readings && e.readings.some((r) => r.use)) {
      box.append(h('div', 'sg-g-h', 'Readings'));
      for (const r of e.readings) box.append(h('div', 'sg-g-li', `${r.r} — ${r.use}`));
    }
    if (e.words && e.words.length) {
      box.append(h('div', 'sg-g-h', 'Words with it'));
      for (const x of e.words) {
        const row = h('div', 'sg-g-li');
        row.append(h('span', 'sg-g-ex', x.w), h('span', 'sg-ce-wr', ' ' + (x.r || '')), h('span', 'sg-g-ext', ' — ' + x.m));
        box.append(row);
      }
    }
    if (e.notes && e.notes.length) {
      box.append(h('div', 'sg-g-h', 'Notes'));
      for (const n of e.notes) box.append(h('div', 'sg-g-li', n));
    }
    el.append(box);
  }

  const charCache = new Map();

  async function showCharEntry(el, ch, ctx, w) {
    el.classList.add('sg-show');
    const k = ctx.lang + '|' + ch;
    if (charCache.has(k)) {
      renderCharEntry(el, ch, ctx, w, charCache.get(k));
      return;
    }
    el.classList.remove('sg-guide');
    el.classList.add('sg-loading');
    el.textContent = `Writing an entry for ${ch}… (saved once written)`;
    const res = await request({ type: 'charInfo', ch, lang: ctx.lang, word: w.s, reading: w.r, sentence: ctx.sentence });
    if (res.error) {
      el.classList.remove('sg-loading');
      el.textContent = res.error;
      return;
    }
    charCache.set(k, res.entry);
    if (el.isConnected) renderCharEntry(el, ch, ctx, w, res.entry);
  }

  function seekIfPending() {
    if (pendingSeek == null || !video || video.readyState < 1) return;
    if (Number.isFinite(video.duration) && video.duration < pendingSeek) return;
    video.currentTime = Math.max(0, pendingSeek - 1.5);
    pendingSeek = null;
    post({ type: 'seekDone' });
  }

  // ------------------------------------------------------------ pitch accent

  const pitchCache = new Map();

  function pitchBlock(w) {
    const box = h('div', 'sg-pitch');
    const key = (w.d || w.s) + '|' + (w.r || '');
    const draw = (res) => {
      if (!res) return;
      const reading = w.s !== w.d && w.d ? '' : w.r;
      const kana = res.r || reading;
      box.append(h('span', 'sg-pitch-l', w.d && w.d !== w.s ? `Pitch (${w.d})` : 'Pitch'));
      res.a.slice(0, 2).forEach((acc) => box.append(SG.pitch.render(kana, acc)));
    };
    if (pitchCache.has(key)) draw(pitchCache.get(key));
    else {
      request({ type: 'pitch', items: [{ d: w.d, r: w.r, s: w.s }] }).then((res) => {
        const r = res.results && res.results[0];
        pitchCache.set(key, r || null);
        draw(r);
      });
    }
    return box;
  }

  // ------------------------------------------------------- ask about a line

  const askThreads = new Map(); // line key -> [{ q, a }]
  const askTargets = new Map(); // reqId -> { el, text, turn }

  function askBox(cue, a) {
    const key = shownKey;
    const wrap = h('div', 'sg-ask');
    wrap.append(h('div', 'sg-section', 'Ask about this line'));
    const thread = h('div', 'sg-ask-thread');
    const turns = askThreads.get(key) || [];
    const addTurn = (turn) => {
      const q = h('div', 'sg-ask-q', turn.q);
      const ans = h('div', 'sg-ask-a', turn.a || '…');
      thread.append(q, ans);
      return ans;
    };
    turns.forEach(addTurn);
    const form = h('div', 'sg-ask-form');
    const input = h('textarea', 'sg-in sg-ask-in');
    input.rows = 2;
    input.placeholder = 'Why は and not が here? Could I say this to my boss?';
    const go = h('button', 'sg-btn sg-go', 'Ask');
    const send = () => {
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      const t = active();
      const idx = shownIndex;
      const turn = { q: question, a: '' };
      const list = askThreads.get(key) || [];
      const history = list.filter((x) => x.a).map((x) => ({ q: x.q, a: x.a }));
      list.push(turn);
      askThreads.set(key, list);
      const ansEl = addTurn(turn);
      ansEl.classList.add('sg-loading');
      const reqId = 'q' + ++reqSeq;
      askTargets.set(reqId, { el: ansEl, text: '', turn });
      post({
        type: 'ask', reqId, question, history,
        sentence: cue.text, translation: a.tr,
        words: (a.w || []).map((w) => `${w.s} = ${w.m}`).join('; '),
        before: t ? t.cues.slice(Math.max(0, idx - 3), idx).map((c) => c.text) : [],
        after: t ? t.cues.slice(idx + 1, idx + 3).map((c) => c.text) : [],
        show: tabTitle || '',
      });
    };
    go.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    form.append(input, go);
    wrap.append(thread, form);
    return wrap;
  }

  function onAsk(msg) {
    const t = askTargets.get(msg.reqId);
    if (!t) return;
    t.el.classList.remove('sg-loading');
    if (msg.type === 'askDelta') {
      t.text += msg.delta;
      t.el.textContent = t.text;
    } else if (msg.type === 'askDone') {
      t.turn.a = msg.text;
      t.el.textContent = msg.text;
      askTargets.delete(msg.reqId);
    } else {
      t.el.textContent = msg.message;
      askTargets.delete(msg.reqId);
    }
  }

  // ---------------------------------------------- how much of the episode you know

  const coverage = new Map(); // track id -> { pct, known, total }

  function computeCoverage(words, lang) {
    let total = 0;
    let knownN = 0;
    for (const x of words) {
      total += x.count || 1;
      if (knownWords[lang] && knownWords[lang].has(x.d)) knownN += x.count || 1;
    }
    return { pct: total ? Math.round((knownN / total) * 100) : 0, total, known: knownN };
  }

  // --------------------------------------------------------- time watched

  let watchedSecs = 0;
  let watchedLast = null;

  function trackWatching() {
    const t = active();
    if (!video || video.paused || !t) {
      watchedLast = null;
      return;
    }
    const now = video.currentTime;
    if (watchedLast != null && now > watchedLast && now - watchedLast < 3) watchedSecs += now - watchedLast;
    watchedLast = now;
    if (watchedSecs >= 60) {
      post({ type: 'watched', lang: t.lang, minutes: Math.floor(watchedSecs / 60) });
      watchedSecs %= 60;
    }
  }

  // --------------------------------------------------------- subtitle sites

  function request(msg) {
    return new Promise((resolve) => {
      const reqId = 's' + ++reqSeq;
      subReqs.set(reqId, resolve);
      if (!post(Object.assign({ reqId }, msg))) {
        subReqs.delete(reqId);
        resolve({ error: 'Langtitles lost its connection; reload the page.' });
      }
    });
  }

  async function currentEpisode() {
    const res = await request({ type: 'tabInfo' });
    if (res.info) {
      tabUrl = res.info.url || tabUrl;
      tabTitle = res.info.title || tabTitle;
    }
    const sources = [{ url: location.href, title: document.title }];
    if (document.referrer) sources.push({ url: document.referrer, title: '' });
    if (tabUrl && tabUrl !== location.href) sources.push({ url: tabUrl, title: tabTitle });
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) sources.push({ url: '', title: og.content });
    return SG.episode.detect(sources);
  }

  function wantedLangs() {
    const native = langCode(settings.nativeLang);
    const list = (settings.learning || []).map(langCode).filter((l) => l && l !== 'und' && l !== native);
    return list.length ? list : ['ja'];
  }

  function hasLearningTrack() {
    const langs = wantedLangs();
    for (const t of tracks.values()) if (t.source !== 'dom' && langs.includes(t.lang) && t.cues.length >= 5) return true;
    return false;
  }

  function sourceName(id) {
    return { opensubtitles: 'OpenSubtitles', subdl: 'SubDL', jimaku: 'Jimaku' }[id] || id;
  }

  // Lines a downloaded file up against the site's own subtitles, if there are any.
  function syncRemote(t, announce) {
    let ref = null;
    for (const r of tracks.values()) {
      if (r === t || r.source === 'remote' || r.source === 'file' || r.cues.length < 15) continue;
      if (!ref || r.cues.length > ref.cues.length) ref = r;
    }
    if (!ref) {
      if (announce) showToast('No other subtitles on this page to line the file up with. If the timing is off, use − / + in the panel (Shift for 2 s steps).');
      return false;
    }
    const res = SG.sync.align(ref.cues.map((c) => ({ start: c.start + ref.offset })), t.cues);
    if (!res.ok) {
      if (announce) showToast(`Could not line the file up with the ${langName(ref.lang)} subtitles. If the timing is off, use − / + in the panel.`);
      return false;
    }
    if (res.scale !== 1) {
      t.cues = t.cues.map((c) => ({ start: c.start * res.scale, end: c.end * res.scale, text: c.text }));
    }
    t.offset = res.offset;
    t.synced = true;
    rememberOffset(t, res.scale);
    shownKey = null;
    if (t.id === activeId) {
      renderTranscript();
      renderTrackList();
    }
    if (announce !== false) {
      const shift = Math.abs(res.offset) < 0.05 ? 'already in time' : `shifted ${res.offset > 0 ? '+' : ''}${res.offset.toFixed(2)} s`;
      showToast(`Timing matched to the site's ${langName(ref.lang)} subtitles (${shift}${res.scale !== 1 ? ', frame rate corrected' : ''}).`);
    }
    return true;
  }

  function rememberOffset(t, scale) {
    if (t.source !== 'remote' || !t.episode) return;
    clearTimeout(offsetSaveTimer);
    offsetSaveTimer = setTimeout(() => {
      post({ type: 'saveSubOffset', episode: t.episode, lang: t.lang, offset: t.offset, scale: scale || 1 });
    }, 800);
  }

  function useLoaded(loaded, ep, how) {
    const track = Object.assign({}, loaded.track, { episode: ep });
    if (loaded.reused && loaded.offset != null) {
      track.offset = loaded.offset;
      track.userOffset = true;
    }
    tracks.delete(track.id);
    addTrack(track);
    const t = tracks.get(track.id);
    if (!t) return;
    if (how === 'manual') {
      manualPick = t.id;
      activeId = null;
      chooseActive();
    }
    const synced = t.userOffset ? false : syncRemote(t, false);
    const parts = [`${how === 'auto' ? 'Loaded' : 'Using'} ${langName(t.lang)} subtitles from ${sourceName(t.provider)}`];
    if (synced) parts.push(`timing matched to the site (${t.offset >= 0 ? '+' : ''}${t.offset.toFixed(2)} s)`);
    else if (loaded.reused && t.userOffset) parts.push('with the timing you set last time');
    let msg = parts.join(', ') + '.';
    if (how === 'auto') msg += ' Wrong file? Press G → Find subtitles.';
    if (loaded.note) msg += ' ' + loaded.note + '.';
    showToast(msg);
  }

  // When the site has no subtitles in a language being learned, fetch them from a subtitle site.
  async function maybeAutoFind() {
    if (autoBusy || !settings.autoFind || !enabled() || !settings.hasKey || !(settings.subProviders || []).length) return;
    if (!video || video.paused || playedFor < 6 || hasLearningTrack()) return;
    autoBusy = true;
    try {
      const ep = await currentEpisode();
      if (!SG.episode.confident(ep)) return;
      const langs = wantedLangs();
      const key = SG.episode.key(ep, langs.join(','));
      if (autoTried.has(key)) return;
      autoTried.add(key);
      const res = await request({ type: 'autoSubs', episode: ep, langs });
      if (hasLearningTrack()) return; // the site's own subtitles turned up meanwhile
      if (res.loaded && res.loaded.track) useLoaded(res.loaded, ep, 'auto');
      else if (res.loaded && res.loaded.searched) {
        const why = res.loaded.errors && res.loaded.errors.length ? ' (' + res.loaded.errors[0] + ')' : '';
        showToast(`No ${langs.map(langName).join(' / ')} subtitles found for ${SG.episode.describe(ep)}${why}. Press G → Find subtitles to search by hand.`);
      }
    } finally {
      autoBusy = false;
    }
  }

  function field(label, input) {
    const wrap = h('label', 'sg-f');
    wrap.append(h('span', 'sg-f-label', label), input);
    return wrap;
  }

  async function openFind() {
    const p = ui.panel;
    p.guide.classList.remove('sg-show');
    p.words.classList.remove('sg-show');
    p.find.classList.add('sg-show');
    const body = p.findBody;
    body.textContent = '';
    if (!(settings.subProviders || []).length) {
      body.append(h('div', 'sg-g-p', 'No subtitle sites are set up yet. Open the Langtitles options and add a free OpenSubtitles, SubDL or Jimaku key under “Subtitle sites”.'));
      return;
    }
    const ep = await currentEpisode();
    const form = h('div', 'sg-form-grid');
    const title = h('input', 'sg-in');
    title.value = ep.title || '';
    title.placeholder = 'Show or movie name';
    const type = h('select', 'sg-in');
    type.append(new Option('TV episode', 'tv'), new Option('Movie', 'movie'));
    type.value = ep.type || (ep.episode != null ? 'tv' : 'tv');
    const id = h('input', 'sg-in');
    id.value = ep.tmdbId || ep.imdbId || '';
    id.placeholder = 'TMDB or IMDb id (optional)';
    const season = h('input', 'sg-in sg-num');
    season.type = 'number';
    season.min = '0';
    season.value = ep.season == null ? (ep.type === 'movie' ? '' : '1') : ep.season;
    const episode = h('input', 'sg-in sg-num');
    episode.type = 'number';
    episode.min = '0';
    episode.value = ep.episode == null ? '' : ep.episode;
    const lang = h('select', 'sg-in');
    const langs = wantedLangs();
    for (const code of langs) lang.append(new Option(langName(code), code));
    for (const code of ['ja', 'ko', 'zh', 'th', 'vi', 'id', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'en']) {
      if (!langs.includes(code)) lang.append(new Option(langName(code), code));
    }
    const go = h('button', 'sg-btn sg-go', 'Search');
    form.append(field('Title', title), field('Type', type), field('ID', id), field('Season', season), field('Episode', episode), field('Language', lang));
    const status = h('div', 'sg-find-status');
    status.textContent = SG.episode.confident(ep) ? `Detected ${SG.episode.describe(ep)}.` : 'Check the title, season and episode, then search.';
    const results = h('div', 'sg-results');
    body.append(form, go, status, results);
    const toggleSeason = () => {
      const tv = type.value === 'tv';
      season.parentNode.style.display = tv ? '' : 'none';
      episode.parentNode.style.display = tv ? '' : 'none';
    };
    type.addEventListener('change', toggleSeason);
    toggleSeason();

    const run = async () => {
      const raw = id.value.trim();
      const query = {
        type: type.value,
        title: title.value.trim(),
        tmdbId: /^\d+$/.test(raw) ? raw : null,
        imdbId: /^tt\d+$/i.test(raw) ? raw.toLowerCase() : null,
        season: type.value === 'tv' && season.value !== '' ? Number(season.value) : null,
        episode: type.value === 'tv' && episode.value !== '' ? Number(episode.value) : null,
        year: ep.year,
      };
      if (!query.title && !query.tmdbId && !query.imdbId) {
        status.textContent = 'Enter a title or an id.';
        return;
      }
      const wanted = [lang.value];
      status.textContent = 'Searching…';
      results.textContent = '';
      go.disabled = true;
      const res = await request({ type: 'findSubs', episode: query, langs: wanted });
      go.disabled = false;
      if (res.error) {
        status.textContent = res.error;
        return;
      }
      const found = res.found;
      const notes = Object.entries(found.report).map(([pid, r]) => {
        if (r.ok) return `${sourceName(pid)}: ${r.count}`;
        return r.message.startsWith(sourceName(pid)) ? r.message : `${sourceName(pid)}: ${r.message}`;
      });
      status.textContent = (found.results.length ? `${found.results.length} found, best first. ` : 'Nothing found. Try the English title, or check the season and episode. ') + notes.join(' · ');
      for (const r of found.results) {
        const row = h('button', 'sg-result');
        const top = h('div', 'sg-result-top');
        top.append(h('span', 'sg-result-src', sourceName(r.provider)), h('span', 'sg-result-lang', langName(r.lang)), h('span', 'sg-result-name', r.name || '(no release name)'));
        const meta = [];
        if (r.title) meta.push(r.title);
        if (r.season != null && r.episode != null) meta.push(`S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`);
        else if (r.episode != null) meta.push('episode ' + r.episode);
        if (r.pack) meta.push('season pack');
        if (r.downloads) meta.push(`${r.downloads.toLocaleString()} downloads`);
        if (r.hi) meta.push('includes sound descriptions');
        if (r.trusted) meta.push('trusted uploader');
        row.append(top, h('div', 'sg-result-meta', meta.join(' · ')));
        row.addEventListener('click', async () => {
          for (const other of results.children) other.classList.remove('sg-on');
          row.classList.add('sg-on', 'sg-loading');
          status.textContent = 'Downloading…';
          const loaded = await request({ type: 'loadSub', result: r, episode: query });
          row.classList.remove('sg-loading');
          if (loaded.error) {
            status.textContent = loaded.error;
            return;
          }
          status.textContent = 'Loaded. Pick another file here if this one is wrong or out of sync.';
          useLoaded(loaded.loaded, query, 'manual');
        });
        results.append(row);
      }
    };
    go.addEventListener('click', run);
    for (const input of [title, id, season, episode]) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') run();
      });
    }
    if (ep.title || ep.tmdbId || ep.imdbId) run();
    body.append(seasonSection(ep, lang));
  }

  // Prepare a whole season ahead through the batch API (half price, ready within a day).
  function seasonSection(ep, langSel) {
    const box = h('div', 'sg-season');
    box.append(h('div', 'sg-section', 'Prepare a whole season'));
    if (!(ep.tmdbId || ep.imdbId) || ep.type !== 'tv') {
      box.append(h('div', 'sg-find-status', 'Available when the episode is detected from the player (a TV show with an id).'));
      return box;
    }
    box.append(h('div', 'sg-find-status', 'Downloads subtitles for each episode and prepares every line at half price through the batch API. Results are usually ready within an hour (at most a day). Each episode uses one subtitle download (OpenSubtitles allows 5 a day, or 20 signed in; SubDL more).'));
    const grid = h('div', 'sg-form-grid');
    const from = h('input', 'sg-in sg-num');
    from.type = 'number';
    from.min = '1';
    from.value = String(ep.episode || 1);
    const to = h('input', 'sg-in sg-num');
    to.type = 'number';
    to.min = '1';
    to.value = String((ep.episode || 1) + 11);
    grid.append(field('From episode', from), field('To episode', to));
    const go = h('button', 'sg-btn sg-go', 'Prepare');
    const jobs = h('div', 'sg-jobs');
    const showJobs = async () => {
      const res = await request({ type: 'seasonJobs' });
      jobs.textContent = '';
      for (const j of (res.jobs || []).slice(0, 4)) {
        const row = h('div', 'sg-job');
        const p = j.progress ? ` · ${j.progress.succeeded || 0} of ${(j.progress.succeeded || 0) + (j.progress.processing || 0) + (j.progress.errored || 0)} requests back` : '';
        row.append(h('div', 'sg-job-t', `${j.show}, episodes ${j.from}–${j.to}`), h('div', 'sg-job-s', `${j.status}${j.lines ? ` · ${j.lines} lines` : ''}${j.ready ? ` · ${j.ready} ready` : ''}${p}`));
        jobs.append(row);
      }
    };
    go.addEventListener('click', async () => {
      const a = Number(from.value);
      const b = Number(to.value);
      if (!(a >= 1 && b >= a && b - a < 40)) {
        showToast('Pick a range of up to 40 episodes.');
        return;
      }
      go.disabled = true;
      showToast('Preparing the season in the background. You can keep watching.');
      const base = { type: 'tv', tmdbId: ep.tmdbId, imdbId: ep.imdbId, title: ep.title };
      request({ type: 'seasonStart', episode: base, season: ep.season == null ? 1 : ep.season, from: a, to: b, langs: [langSel.value] }).then(() => {
        go.disabled = false;
        showJobs();
      });
      setTimeout(showJobs, 1500);
    });
    for (const input of [from, to]) input.addEventListener('keydown', (e) => e.stopPropagation());
    box.append(grid, go, jobs);
    showJobs();
    return box;
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

  // Phones and tablets: no hover, so taps open words and a close button resumes playback.
  const touchMode = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

  scan();
  setInterval(scan, 1500);
  setInterval(() => {
    if (!video) return;
    place();
    tick();
  }, 100);
  setInterval(() => {
    if (!video) return;
    // Count real playback, so a few seconds of an ad or a preview do not start a search.
    const now = video.currentTime;
    if (!video.paused && lastTickTime != null && now > lastTickTime && now - lastTickTime < 3) playedFor += now - lastTickTime;
    lastTickTime = now;
    pump();
    reportState();
    trackWatching();
    seekIfPending();
    maybeAutoFind();
  }, 1000);
})();
