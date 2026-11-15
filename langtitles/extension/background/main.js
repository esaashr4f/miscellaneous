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

  // ---- word bank and character entries -----------------------------------

  const pendingSeeks = new Map(); // tabId -> { time, until }

  function charKey(ch, lang) {
    return [prompt.CHAR_VERSION, settings.nativeLang, lang, ch].join('|');
  }

  const charsInflight = new Map();

  async function charInfo(req) {
    await ready;
    const key = charKey(req.ch, req.lang);
    const hit = (await cache.getMany('chars', [key])).get(key);
    if (hit) return hit.entry;
    if (!charsInflight.has(key)) {
      const p = claude.charEntry(settings, req).then((entry) => {
        cache.putMany('chars', [[key, { entry, savedAt: Date.now() }]]).catch(() => {});
        return entry;
      });
      charsInflight.set(key, p);
      p.finally(() => charsInflight.delete(key)).catch(() => {});
    }
    return charsInflight.get(key);
  }

  function bankKey(kind, lang, text) {
    return [kind, lang, text].join('|');
  }

  // Save a word or character; saving it again from another line adds that line as another example.
  async function bankSave(item) {
    const key = bankKey(item.kind, item.lang, item.text);
    const prev = (await cache.getMany('bank', [key])).get(key);
    const entry = Object.assign({}, prev || {}, item, { key, savedAt: prev ? prev.savedAt : Date.now(), updatedAt: Date.now() });
    const contexts = (prev && prev.contexts) || [];
    if (item.context && item.context.sentence) {
      const dup = contexts.findIndex((c) => c.sentence === item.context.sentence);
      if (dup >= 0) contexts.splice(dup, 1);
      contexts.unshift(item.context);
    }
    entry.contexts = contexts.slice(0, 12);
    delete entry.context;
    await cache.putMany('bank', [[key, entry]]);
    return entry;
  }

  async function bankStatus(keys) {
    const found = await cache.getMany('bank', keys);
    const out = {};
    for (const k of keys) out[k] = found.has(k);
    return out;
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

  function seekFor(tabId) {
    const s = pendingSeeks.get(tabId);
    if (!s || s.until < Date.now()) return null;
    return s.time;
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
    if (port.name !== 'langtitles' || !port.sender || !port.sender.tab) return;
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
        seekTo: seekFor(tabId),
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
      } else if (msg.type === 'charInfo') {
        charInfo(msg).then(
          (entry) => send(port, { type: 'charInfo', reqId: msg.reqId, entry }),
          (err) => send(port, { type: 'charInfo', reqId: msg.reqId, error: err.message }),
        );
      } else if (msg.type === 'bankSave') {
        bankSave(msg.item).then(
          (entry) => send(port, { type: 'bankSaved', reqId: msg.reqId, entry }),
          (err) => send(port, { type: 'bankSaved', reqId: msg.reqId, error: String(err && err.message) }),
        );
      } else if (msg.type === 'bankRemove') {
        cache.remove('bank', msg.key).then(() => send(port, { type: 'bankSaved', reqId: msg.reqId, removed: true }));
      } else if (msg.type === 'bankStatus') {
        bankStatus(msg.keys).then((status) => send(port, { type: 'bankStatus', reqId: msg.reqId, status }));
      } else if (msg.type === 'seekDone') {
        pendingSeeks.delete(tabId);
      } else if (msg.type === 'openBank') {
        browser.tabs.create({ url: browser.runtime.getURL('bank/bank.html'), index: port.sender.tab.index + 1 });
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
    // The word bank page changes saved items through here, so this page's copy stays current.
    if (msg.type === 'bankRemove' && msg.key) return cache.remove('bank', msg.key).then(() => ({ ok: true }));
    if (msg.type === 'bankPut' && Array.isArray(msg.items)) {
      return cache.putMany('bank', msg.items.filter((x) => x && x.key).map((x) => [x.key, x])).then(() => ({ ok: true, count: msg.items.length }));
    }
    if (msg.type === 'charInfo' && msg.ch) return charInfo(msg).then((entry) => ({ entry }), (err) => ({ error: err.message }));
    if (msg.type === 'openAt' && msg.url) {
      // Open a saved line's page; the player there jumps to the line once it loads.
      return browser.tabs.create({ url: msg.url }).then((tab) => {
        pendingSeeks.set(tab.id, { time: Math.max(0, Number(msg.time) || 0), until: Date.now() + 120000 });
        return { ok: true };
      });
    }
    if (msg.type === 'resetUsage') return browser.storage.local.remove('usage').then(() => ({ ok: true }));
    return undefined;
  });

  sniffer.start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
