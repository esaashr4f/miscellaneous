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
      send(port, { type: 'init', settings: SG.publicSettings(settings), tracks: sniffer.tracksFor(tabId), tabHost });
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
