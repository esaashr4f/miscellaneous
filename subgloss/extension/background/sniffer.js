// Captures subtitle files as the page's player downloads them.
//
// Firefox lets an extension read a response body while it streams to the page
// (webRequest.filterResponseData). The body is passed through untouched; a copy is parsed here.
// That hands us the whole subtitle file up front, on any site, without knowing its player.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});
  const { parseSubtitles } = SG.subtitles;
  const { detectLang } = SG.lang;

  const MAX_BYTES = 6 * 1024 * 1024;
  const MAX_TRACKS_PER_TAB = 16;
  const SUB_EXT = /\.(vtt|webvtt|srt|ass|ssa|ttml|ttml2|dfxp|sbv)$/i;
  const SUB_TYPE = /text\/vtt|x-subrip|ttml|x-ssa|x-ass|text\/srt/i;
  const SUB_WORD = /subtitle|caption|timedtext|\/subs?\//i;
  const LOOSE_TYPE = /text\/plain|application\/octet-stream|application\/json|text\/xml|application\/xml|^$/i;
  const HLS_TYPE = /mpegurl/i;

  const tabs = new Map(); // tabId -> Map(trackId -> track)
  const ownSegments = new Set(); // HLS subtitle segments this page fetches itself
  const listeners = new Set();

  function header(details, name) {
    const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
    return h ? h.value || '' : '';
  }

  function classify(details) {
    if (details.tabId < 0) return null;
    if (details.statusCode !== 200) return null;
    const length = Number(header(details, 'content-length'));
    if (length > MAX_BYTES) return null;
    let url;
    try {
      url = new URL(details.url);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const type = header(details, 'content-type');
    if (/\.m3u8$/i.test(url.pathname) || HLS_TYPE.test(type)) return 'hls';
    if (SUB_EXT.test(url.pathname) || SUB_TYPE.test(type)) return 'sub';
    if (SUB_WORD.test(url.pathname + url.search) && LOOSE_TYPE.test(type)) return 'sub';
    return null;
  }

  function decode(chunks, contentType) {
    let size = 0;
    for (const c of chunks) size += c.byteLength;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(new Uint8Array(c), at);
      at += c.byteLength;
    }
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else {
      const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
      if (m) encoding = m[1];
    }
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch (e) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  function labelFor(url, lang) {
    let name = '';
    try {
      const u = new URL(url);
      name = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
    } catch (e) {
      name = url;
    }
    if (name.length > 40) name = name.slice(0, 18) + '…' + name.slice(-18);
    return name || lang;
  }

  // HLS serves subtitles as many small files (seg-1.vtt, seg-2.vtt, ...). Give every
  // segment of one playlist the same id so their cues merge into a single track.
  function groupId(url) {
    try {
      const u = new URL(url);
      const file = u.pathname.split('/').pop() || '';
      if (/\d/.test(file) && /\.(vtt|webvtt)$/i.test(file)) {
        const stem = file.replace(/\d+/g, '#');
        return u.origin + u.pathname.slice(0, u.pathname.length - file.length) + stem;
      }
    } catch (e) {
      /* fall through */
    }
    return url;
  }

  function addTrack(tabId, id, url, cues, opts) {
    if (!cues.length) return;
    let tracks = tabs.get(tabId);
    if (!tracks) tabs.set(tabId, (tracks = new Map()));
    let track = tracks.get(id);
    if (track && opts && opts.merge) {
      track.cues = SG.subtitles.normalizeCues(track.cues.concat(cues));
    } else if (track && track.cues.length === cues.length && track.cues[0].text === cues[0].text) {
      return; // the same file fetched again
    } else {
      track = { id, url, source: 'net', cues, addedAt: Date.now() };
      tracks.set(id, track);
    }
    track.lang = (opts && opts.lang) || detectLang(track.cues.slice(0, 60).map((c) => c.text).join('\n'));
    track.label = (opts && opts.label) || labelFor(url, track.lang);
    track.updatedAt = Date.now();
    while (tracks.size > MAX_TRACKS_PER_TAB) tracks.delete(tracks.keys().next().value);
    for (const fn of listeners) fn(tabId, track);
  }

  function handleSubtitle(details, text) {
    const { cues } = parseSubtitles(text);
    if (!cues.length) return;
    const id = groupId(details.url);
    const segmented = id !== details.url;
    // A lone cue from an unsegmented file is almost always a false positive.
    if (!segmented && cues.length < 2) return;
    addTrack(details.tabId, id, details.url, cues, { merge: segmented });
  }

  function attr(line, name) {
    const m = new RegExp(name + '=(?:"([^"]*)"|([^,]*))').exec(line);
    return m ? m[1] || m[2] || '' : '';
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  // Download every segment of an HLS subtitle playlist so the whole episode is known at once.
  async function loadHlsSubtitles(tabId, playlistUrl, text, meta) {
    const uris = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== '#');
    if (!uris.length || !uris.every((u) => /\.(vtt|webvtt)(\?|$)/i.test(u))) return;
    const urls = uris.slice(0, 1500).map((u) => new URL(u, playlistUrl).href);
    const cues = [];
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++];
        try {
          cues.push(...parseSubtitles(await fetchText(url), 'vtt').cues);
          // Only skip the player's own copy of a segment we managed to download ourselves;
          // if our download was refused (some CDNs check the referrer), the player's copy still counts.
          ownSegments.add(url);
        } catch (e) {
          /* a missing segment only loses a few lines */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    addTrack(tabId, 'hls:' + playlistUrl, playlistUrl, SG.subtitles.normalizeCues(cues), meta);
  }

  async function handleHls(details, text) {
    if (!/^#EXTM3U/.test(text.trimStart())) return;
    const lines = text.split(/\r?\n/);
    const media = lines.filter((l) => /^#EXT-X-MEDIA:/.test(l) && /TYPE=SUBTITLES/.test(l));
    if (media.length) {
      // Master playlist: follow each subtitle rendition.
      for (const line of media.slice(0, 12)) {
        const uri = attr(line, 'URI');
        if (!uri) continue;
        const url = new URL(uri, details.url).href;
        const language = attr(line, 'LANGUAGE');
        const name = attr(line, 'NAME');
        const meta = { label: name || language || undefined, lang: language ? SG.lang.langCode(language) : undefined };
        fetchText(url)
          .then((body) => loadHlsSubtitles(details.tabId, url, body, meta))
          .catch(() => {});
      }
      return;
    }
    await loadHlsSubtitles(details.tabId, details.url, text, {});
  }

  function onHeaders(details) {
    const kind = classify(details);
    if (!kind) return;
    if (ownSegments.has(details.url)) return;
    let filter;
    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
      return;
    }
    const type = header(details, 'content-type');
    const chunks = [];
    let size = 0;
    filter.ondata = (event) => {
      filter.write(event.data);
      if (size <= MAX_BYTES) {
        size += event.data.byteLength;
        if (size <= MAX_BYTES) chunks.push(event.data);
      }
    };
    filter.onstop = () => {
      filter.close();
      if (size > MAX_BYTES || !chunks.length) return;
      try {
        const text = decode(chunks, type);
        if (kind === 'hls') handleHls(details, text).catch(() => {});
        else handleSubtitle(details, text);
      } catch (e) {
        console.warn('SubGloss: could not read', details.url, e);
      }
    };
    filter.onerror = () => {
      try {
        filter.disconnect();
      } catch (e) {
        /* already closed */
      }
    };
  }

  function start() {
    browser.webRequest.onHeadersReceived.addListener(
      onHeaders,
      { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest', 'media', 'other', 'object'] },
      ['blocking', 'responseHeaders'],
    );
    // A real page load in the tab means the previous video's subtitles no longer apply.
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId >= 0) tabs.delete(details.tabId);
      },
      { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
    );
    browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
  }

  SG.sniffer = {
    start,
    onTrack: (fn) => listeners.add(fn),
    tracksFor: (tabId) => Array.from((tabs.get(tabId) || new Map()).values()),
    _internals: { classify, groupId, decode },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
