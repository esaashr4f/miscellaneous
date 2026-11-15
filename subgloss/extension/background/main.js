// Background page: owns the API key, the analysis queue and the captured subtitle tracks.
(function (root) {
  'use strict';
  const SG = root.SG;
  const { claude, cache, sniffer, prompt } = SG;

  let settings = Object.assign({}, SG.DEFAULTS);
  const ready = SG.loadSettings().then((s) => {
    settings = s;
  });

  const ports = new Map(); // tabId -> Set(port)
  const tabStatus = new Map(); // tabId -> last state reported by the content script
  let lastError = null;

  // ---- concurrency -------------------------------------------------------

  let running = 0;
  const waiting = [];

  function withSlot(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        fn().then(resolve, reject).finally(() => {
          running--;
          const next = waiting.shift();
          if (next) next();
        });
      };
      if (running < Math.max(1, settings.concurrency || 1)) run();
      else waiting.push(run);
    });
  }

  // ---- analysis ----------------------------------------------------------

  const inflight = new Map(); // cache key -> promise of analysis

  function fingerprint() {
    return [prompt.PROMPT_VERSION, settings.model, settings.nativeLang].join('|');
  }

  // Ask Claude for a batch; if the reply was cut off, split the batch and try the halves.
  async function analyzeBatch(texts, context, langHint) {
    try {
      return await withSlot(() => claude.analyzeLines(settings, texts, context, langHint));
    } catch (err) {
      if (err.code === 'truncated' && texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const first = await analyzeBatch(texts.slice(0, mid), context, langHint);
        const second = await analyzeBatch(texts.slice(mid), context.concat(texts.slice(0, mid)).slice(-3), langHint);
        return first.concat(second);
      }
      throw err;
    }
  }

  // lines: [{ key, text }]. Resolves to { results: { key: analysis }, error? }.
  async function analyze(req) {
    await ready;
    const fp = fingerprint();
    const results = {};
    const fullKey = (l) => fp + '|' + l.key;
    const cached = await cache.getMany('lines', req.lines.map(fullKey));
    const pending = [];
    const fresh = [];
    for (const line of req.lines) {
      const k = fullKey(line);
      if (cached.has(k)) results[line.key] = cached.get(k);
      else if (inflight.has(k)) pending.push(inflight.get(k).then((a) => a && (results[line.key] = a)));
      else fresh.push(line);
    }
    let error = null;
    if (fresh.length) {
      const batch = analyzeBatch(fresh.map((l) => l.text), req.context || [], req.lang);
      fresh.forEach((line, i) => {
        const p = batch.then((out) => out[i], () => null);
        inflight.set(fullKey(line), p);
        p.finally(() => inflight.delete(fullKey(line)));
      });
      try {
        const out = await batch;
        const store = [];
        fresh.forEach((line, i) => {
          if (!out[i]) return;
          results[line.key] = out[i];
          store.push([fullKey(line), out[i]]);
        });
        cache.putMany('lines', store).catch(() => {});
        lastError = null;
      } catch (err) {
        error = { code: err.code || 'unknown', message: err.message };
        lastError = Object.assign({ at: Date.now() }, error);
      }
    }
    await Promise.all(pending);
    return { results, error };
  }

  function guideKey(k) {
    return ['guide', prompt.GUIDE_VERSION, settings.nativeLang, k].join('|');
  }

  const guidesInflight = new Map(); // guide key -> Set(port, reqId) waiting for it

  async function explainGuide(req, port) {
    await ready;
    const key = guideKey(req.form.k);
    const hit = (await cache.getMany('guides', [key])).get(key);
    if (hit) {
      port.postMessage({ type: 'deepDone', reqId: req.reqId, text: hit.text });
      return;
    }
    // The same form can be hovered in several places at once; write its guide only once.
    if (guidesInflight.has(key)) {
      guidesInflight.get(key).push({ port, reqId: req.reqId });
      return;
    }
    const waiters = [{ port, reqId: req.reqId }];
    guidesInflight.set(key, waiters);
    const each = (fn) => {
      for (const w of waiters) {
        try {
          fn(w);
        } catch (e) {
          /* that tab went away */
        }
      }
    };
    try {
      const text = await claude.explainForm(settings, req, (delta) => each((w) => w.port.postMessage({ type: 'deepDelta', reqId: w.reqId, delta })));
      const entry = {
        key, k: req.form.k, name: req.form.name || req.form.k, lang: req.lang || '', nativeLang: settings.nativeLang,
        text, sentence: req.sentence || '', word: req.word || '', model: settings.model, savedAt: Date.now(),
      };
      cache.putMany('guides', [[key, entry]]).catch(() => {});
      each((w) => w.port.postMessage({ type: 'deepDone', reqId: w.reqId, text }));
    } catch (err) {
      each((w) => w.port.postMessage({ type: 'deepError', reqId: w.reqId, message: err.message }));
    } finally {
      guidesInflight.delete(key);
    }
  }

  async function explain(req, port) {
    if (req.kind === 'guide' && req.form && req.form.k) return explainGuide(req, port);
    await ready;
    const key = [fingerprint(), 'deep', req.key, req.word && req.word.s, req.wordIndex].join('|');
    const hit = (await cache.getMany('deep', [key])).get(key);
    if (hit) {
      port.postMessage({ type: 'deepDone', reqId: req.reqId, text: hit });
      return;
    }
    try {
      const text = await claude.explainWord(settings, req, (delta) => {
        try {
          port.postMessage({ type: 'deepDelta', reqId: req.reqId, delta });
        } catch (e) {
          /* the tab went away mid-stream */
        }
      });
      cache.putMany('deep', [[key, text]]).catch(() => {});
      port.postMessage({ type: 'deepDone', reqId: req.reqId, text });
    } catch (err) {
      port.postMessage({ type: 'deepError', reqId: req.reqId, message: err.message });
    }
  }

  // ---- subtitle sources ----------------------------------------------------

  const SUB_TTL = 90 * 24 * 3600 * 1000;

  function subKey(result) {
    return result.provider + '|' + result.id;
  }

  function trackFrom(result, sub) {
    const source = SG.providers.PROVIDERS[result.provider].name;
    return {
      id: 'remote:' + subKey(result),
      label: `${source} · ${result.name || sub.file || ''}`.slice(0, 90),
      lang: result.lang,
      source: 'remote',
      provider: result.provider,
      cues: sub.cues,
    };
  }

  // Downloads (or reuses) one result and remembers it as the choice for this episode.
  async function loadSubtitle(result, ep) {
    const key = subKey(result);
    const cached = (await cache.getMany('subs', [key])).get(key);
    let sub = cached && Date.now() - cached.savedAt < SUB_TTL ? cached : null;
    let note = '';
    if (!sub) {
      const got = await SG.providers.download(settings, result, ep);
      sub = { cues: got.cues, file: got.file, savedAt: Date.now() };
      note = got.note;
      cache.putMany('subs', [[key, sub]]).catch(() => {});
    }
    if (ep) {
      const pick = { result, savedAt: Date.now() };
      cache.putMany('picks', [[SG.episode.key(ep, result.lang), pick]]).catch(() => {});
    }
    return { track: trackFrom(result, sub), note };
  }

  // Automatic loading: a file chosen before for this episode, otherwise the best search result.
  async function autoSubtitle(ep, langs) {
    for (const lang of langs) {
      const pick = (await cache.getMany('picks', [SG.episode.key(ep, lang)])).get(SG.episode.key(ep, lang));
      if (pick) {
        try {
          const loaded = await loadSubtitle(pick.result, ep);
          return Object.assign(loaded, { reused: true, offset: pick.offset, alternatives: null });
        } catch (e) {
          /* fall through to a fresh search */
        }
      }
    }
    const found = await SG.providers.search(settings, ep, langs);
    const errors = Object.entries(found.report).filter(([, r]) => !r.ok).map(([, r]) => r.message);
    // Only take a result that is clearly this episode (or this movie).
    const usable = found.results.filter((r) => !r.pack && (ep.type !== 'tv' || r.episode == null || Number(r.episode) === Number(ep.episode)));
    for (const result of usable.slice(0, 3)) {
      try {
        const loaded = await loadSubtitle(result, ep);
        return Object.assign(loaded, { reused: false, alternatives: found.results.length - 1 });
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { track: null, errors, searched: found.providers.length };
  }

  async function tabInfo(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return { url: tab.url || '', title: tab.title || '' };
    } catch (e) {
      return { url: '', title: '' };
    }
  }

  // ---- content script connections ----------------------------------------

  function send(port, msg) {
    try {
      port.postMessage(msg);
    } catch (e) {
      /* disconnected */
    }
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'subgloss' || !port.sender || !port.sender.tab) return;
    const tabId = port.sender.tab.id;
    if (!ports.has(tabId)) ports.set(tabId, new Set());
    ports.get(tabId).add(port);

    ready.then(() => {
      let tabHost = '';
      try {
        tabHost = new URL(port.sender.tab.url || '').hostname;
      } catch (e) {
        /* about:blank and similar */
      }
      send(port, {
        type: 'init', settings: SG.publicSettings(settings), tracks: sniffer.tracksFor(tabId), tabHost,
        tabUrl: port.sender.tab.url || '', tabTitle: port.sender.tab.title || '',
      });
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'analyze') {
        analyze(msg).then((res) => send(port, { type: 'analyzed', reqId: msg.reqId, results: res.results, error: res.error }));
      } else if (msg.type === 'deep') {
        explain(msg, port);
      } else if (msg.type === 'state') {
        tabStatus.set(tabId, Object.assign({ at: Date.now() }, msg.state));
      } else if (msg.type === 'openLibrary') {
        const url = browser.runtime.getURL('grammar/grammar.html') + (msg.k ? '#' + encodeURIComponent(msg.k) : '');
        browser.tabs.create({ url, index: port.sender.tab.index + 1 });
      } else if (msg.type === 'saveSettings') {
        SG.saveSettings(msg.patch);
      } else if (msg.type === 'tabInfo') {
        tabInfo(tabId).then((info) => send(port, { type: 'tabInfo', reqId: msg.reqId, info }));
      } else if (msg.type === 'findSubs') {
        ready
          .then(() => SG.providers.search(settings, msg.episode, msg.langs))
          .then(
            (found) => send(port, { type: 'subsFound', reqId: msg.reqId, found }),
            (err) => send(port, { type: 'subsFound', reqId: msg.reqId, error: err.message }),
          );
      } else if (msg.type === 'loadSub') {
        ready
          .then(() => loadSubtitle(msg.result, msg.episode))
          .then(
            (loaded) => send(port, { type: 'subLoaded', reqId: msg.reqId, loaded }),
            (err) => send(port, { type: 'subLoaded', reqId: msg.reqId, error: err.message }),
          );
      } else if (msg.type === 'autoSubs') {
        ready
          .then(() => autoSubtitle(msg.episode, msg.langs))
          .then(
            (loaded) => send(port, { type: 'subLoaded', reqId: msg.reqId, loaded, auto: true }),
            (err) => send(port, { type: 'subLoaded', reqId: msg.reqId, error: err.message, auto: true }),
          );
      } else if (msg.type === 'saveSubOffset' && msg.episode && msg.lang) {
        const k = SG.episode.key(msg.episode, msg.lang);
        cache.getMany('picks', [k]).then((m) => {
          const pick = m.get(k);
          if (pick) cache.putMany('picks', [[k, Object.assign({}, pick, { offset: msg.offset, scale: msg.scale })]]);
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const set = ports.get(tabId);
      if (set) {
        set.delete(port);
        if (!set.size) ports.delete(tabId);
      }
    });
  });

  sniffer.onTrack((tabId, track) => {
    for (const port of ports.get(tabId) || []) send(port, { type: 'track', track });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabStatus.delete(tabId);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = Object.assign({}, SG.DEFAULTS, changes.settings.newValue || {});
    const pub = SG.publicSettings(settings);
    for (const set of ports.values()) for (const port of set) send(port, { type: 'settings', settings: pub });
  });

  // ---- popup and options page --------------------------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.type === 'status') {
      return ready.then(async () => ({
        hasKey: Boolean(settings.apiKey),
        tracks: sniffer.tracksFor(msg.tabId).map((t) => ({ label: t.label, lang: t.lang, lines: t.cues.length, url: t.url })),
        state: tabStatus.get(msg.tabId) || null,
        lastError,
        usage: (await browser.storage.local.get('usage')).usage || {},
      }));
    }
    if (msg.type === 'testKey') {
      return ready.then(() => claude.testKey(Object.assign({}, settings, msg.settings || {})));
    }
    if (msg.type === 'clearCache') return cache.clear().then(() => ({ ok: true }));
    if (msg.type === 'resetUsage') return browser.storage.local.remove('usage').then(() => ({ ok: true }));
    return undefined;
  });

  sniffer.start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
