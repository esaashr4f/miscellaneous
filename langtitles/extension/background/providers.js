// Subtitle sources: OpenSubtitles.com, SubDL and Jimaku, through their official APIs.
// Each turns an episode description into a list of results, and a result into subtitle cues.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const CLIENT = 'Langtitles v0.1';

  class ProviderError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function getJson(url, init, name) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new ProviderError('network', `Could not reach ${name}.`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* some errors are not JSON */
    }
    if (!res.ok) {
      const detail = body && (body.message || body.error || (Array.isArray(body.errors) && body.errors.join(', ')));
      const code = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status === 406 ? 'quota' : 'http';
      throw new ProviderError(code, `${name}: ${detail || 'HTTP ' + res.status}`);
    }
    return body;
  }

  async function getBytes(url, init, name) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new ProviderError('network', `Could not download from ${name}.`);
    }
    if (!res.ok) throw new ProviderError(res.status === 429 ? 'rate_limit' : 'http', `${name}: download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Release names from web rips match streaming sites' timing best.
  function releaseBonus(name) {
    return /\b(web[ .-]?dl|web[ .-]?rip|webrip|web|nf|amzn|dsnp|hulu|cr|crunchyroll|atvp|hmax|max)\b/i.test(name || '') ? 1 : 0;
  }

  // ------------------------------------------------------------ OpenSubtitles

  const OS_BASE = 'https://api.opensubtitles.com/api/v1';
  let osToken = null; // { token, base, user, exp }

  function osLang(code) {
    if (code === 'zh') return ['zh-cn', 'zh-tw'];
    if (code === 'pt') return ['pt-br', 'pt-pt'];
    return [code];
  }

  function osHeaders(settings, withAuth) {
    const h = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Api-Key': settings.osApiKey,
      'User-Agent': CLIENT,
      'X-User-Agent': CLIENT,
    };
    if (withAuth && osToken) h.Authorization = 'Bearer ' + osToken.token;
    return h;
  }

  async function osLogin(settings) {
    if (!settings.osUser || !settings.osPass) return null;
    if (osToken && osToken.user === settings.osUser && osToken.exp > Date.now()) return osToken;
    const body = await getJson(OS_BASE + '/login', {
      method: 'POST',
      headers: osHeaders(settings, false),
      body: JSON.stringify({ username: settings.osUser, password: settings.osPass }),
    }, 'OpenSubtitles');
    osToken = {
      token: body.token,
      base: body.base_url ? 'https://' + body.base_url.replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/api/v1' : OS_BASE,
      user: settings.osUser,
      exp: Date.now() + 23 * 3600 * 1000,
    };
    return osToken;
  }

  async function osSearch(settings, ep, langs) {
    const q = new URLSearchParams();
    const codes = [...new Set(langs.flatMap(osLang))].sort();
    q.set('languages', codes.join(','));
    q.set('ai_translated', 'exclude');
    q.set('machine_translated', 'exclude');
    if (ep.type === 'tv') {
      q.set('type', 'episode');
      if (ep.tmdbId) q.set('parent_tmdb_id', ep.tmdbId);
      else if (ep.imdbId) q.set('parent_imdb_id', String(ep.imdbId).replace(/^tt0*/, ''));
      else q.set('query', ep.title);
      if (ep.season != null) q.set('season_number', ep.season);
      if (ep.episode != null) q.set('episode_number', ep.episode);
    } else {
      if (ep.type === 'movie') q.set('type', 'movie');
      if (ep.tmdbId) q.set('tmdb_id', ep.tmdbId);
      else if (ep.imdbId) q.set('imdb_id', String(ep.imdbId).replace(/^tt0*/, ''));
      else q.set('query', ep.title);
      if (ep.year) q.set('year', ep.year);
    }
    // The API asks for its parameters in alphabetical order.
    const params = new URLSearchParams([...q.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    const body = await getJson(OS_BASE + '/subtitles?' + params, { headers: osHeaders(settings, false) }, 'OpenSubtitles');
    const out = [];
    for (const item of body.data || []) {
      const a = item.attributes || {};
      const file = (a.files || [])[0];
      if (!file) continue;
      const f = a.feature_details || {};
      out.push({
        provider: 'opensubtitles',
        id: String(file.file_id),
        lang: SG.lang.langCode(a.language),
        name: a.release || file.file_name || '',
        title: f.parent_title || f.title || f.movie_name || '',
        season: f.season_number == null ? null : f.season_number,
        episode: f.episode_number == null ? null : f.episode_number,
        downloads: a.download_count || 0,
        hi: Boolean(a.hearing_impaired),
        trusted: Boolean(a.from_trusted),
        pack: false,
      });
    }
    return out;
  }

  async function osDownload(settings, result) {
    let auth = null;
    try {
      auth = await osLogin(settings);
    } catch (e) {
      // A failed login still leaves the anonymous allowance.
      auth = null;
    }
    const base = auth ? auth.base : OS_BASE;
    const body = await getJson(base + '/download', {
      method: 'POST',
      headers: osHeaders(settings, Boolean(auth)),
      body: JSON.stringify({ file_id: Number(result.id) }),
    }, 'OpenSubtitles');
    if (!body.link) throw new ProviderError('quota', 'OpenSubtitles: ' + (body.message || 'no download link (daily limit reached?)'));
    const bytes = await getBytes(body.link, {}, 'OpenSubtitles');
    return { bytes, note: body.remaining != null ? `${body.remaining} OpenSubtitles downloads left today` : '' };
  }

  // ---------------------------------------------------------------- SubDL

  const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
  const SUBDL_DL = 'https://dl.subdl.com';

  function subdlLang(code) {
    if (code === 'zh') return ['ZH', 'ZH_BG'];
    if (code === 'pt') return ['PT', 'BR_PT'];
    return [code.toUpperCase()];
  }

  function fromSubdlLang(v) {
    const s = String(v || '');
    if (/^ZH/i.test(s) || /chinese/i.test(s)) return 'zh';
    if (/^BR_PT$/i.test(s) || /portug/i.test(s)) return 'pt';
    return SG.lang.langCode(s.length <= 3 ? s.toLowerCase() : s);
  }

  async function subdlSearch(settings, ep, langs) {
    const q = new URLSearchParams();
    q.set('api_key', settings.subdlKey);
    if (ep.tmdbId) q.set('tmdb_id', ep.tmdbId);
    else if (ep.imdbId) q.set('imdb_id', ep.imdbId);
    else q.set('film_name', ep.title);
    if (ep.type) q.set('type', ep.type);
    if (ep.type === 'tv') {
      if (ep.season != null) q.set('season_number', ep.season);
      if (ep.episode != null) q.set('episode_number', ep.episode);
    }
    if (ep.year && ep.type === 'movie') q.set('year', ep.year);
    q.set('languages', [...new Set(langs.flatMap(subdlLang))].join(','));
    q.set('subs_per_page', '30');
    q.set('unpack', '1');
    q.set('client', 'custom_integration');
    const body = await getJson(SUBDL_API + '?' + q, { headers: { Accept: 'application/json' } }, 'SubDL');
    if (body && body.status === false) {
      // "No subtitles found" comes back as an error with status false.
      if (/not found|no subtitle/i.test(body.error || '')) return [];
      throw new ProviderError('http', 'SubDL: ' + (body.error || 'search failed'));
    }
    const title = (body.results && body.results[0] && body.results[0].name) || '';
    const out = [];
    for (const s of body.subtitles || []) {
      if (s.ai_translated) continue;
      const lang = fromSubdlLang(s.language || s.lang);
      // A season pack lists its files; take the one for this episode when it is there.
      const files = Array.isArray(s.unpack_files) ? s.unpack_files : [];
      const match = ep.episode != null ? files.find((f) => Number(f.episode) === Number(ep.episode) && (ep.season == null || f.season == null || Number(f.season) === Number(ep.season))) : null;
      if (s.full_season && ep.episode != null && !match && files.length) continue;
      out.push({
        provider: 'subdl',
        id: match ? match.url : s.url,
        lang,
        name: (match && (match.release_name || match.name)) || s.release_name || s.name || '',
        title,
        season: s.season == null ? null : s.season,
        episode: match ? match.episode : s.full_season ? null : s.episode == null ? null : s.episode,
        downloads: 0,
        hi: Boolean(s.hi),
        trusted: false,
        pack: Boolean(s.full_season) && !match,
      });
    }
    return out;
  }

  async function subdlDownload(settings, result) {
    const url = SUBDL_DL + (result.id.startsWith('/') ? '' : '/') + result.id;
    return { bytes: await getBytes(url, {}, 'SubDL'), note: '' };
  }

  // --------------------------------------------------------------- Jimaku

  const JIMAKU = 'https://jimaku.cc/api';

  function jimakuHeaders(settings) {
    return { Authorization: settings.jimakuKey, Accept: 'application/json', 'User-Agent': CLIENT, 'X-Client-Id': CLIENT };
  }

  async function jimakuSearch(settings, ep, langs, titleHint) {
    if (!langs.includes('ja')) return [];
    const headers = jimakuHeaders(settings);
    let entries = [];
    if (ep.tmdbId && ep.type) {
      for (const anime of ['true', 'false']) {
        entries = await getJson(`${JIMAKU}/entries/search?anime=${anime}&tmdb_id=${ep.type}:${ep.tmdbId}`, { headers }, 'Jimaku');
        if (entries.length) break;
      }
    }
    const title = ep.title || titleHint;
    if (!entries.length && title) {
      entries = await getJson(`${JIMAKU}/entries/search?anime=true&query=${encodeURIComponent(title)}`, { headers }, 'Jimaku');
    }
    const out = [];
    // Jimaku keeps one entry per anime season; with no better signal, check the closest few.
    for (const entry of entries.slice(0, 3)) {
      const q = ep.episode != null && !(entry.flags && entry.flags.movie) ? `?episode=${ep.episode}` : '';
      const files = await getJson(`${JIMAKU}/entries/${entry.id}/files${q}`, { headers }, 'Jimaku');
      for (const f of files) {
        if (!/\.(srt|ass|ssa|vtt|zip)$/i.test(f.name)) continue;
        out.push({
          provider: 'jimaku',
          id: f.url,
          lang: 'ja',
          name: f.name,
          title: entry.japanese_name ? `${entry.english_name || entry.name} (${entry.japanese_name})` : entry.english_name || entry.name,
          season: ep.season,
          episode: ep.episode,
          downloads: 0,
          hi: false,
          trusted: false,
          pack: /\.zip$/i.test(f.name),
        });
      }
    }
    return out;
  }

  async function jimakuDownload(settings, result) {
    return { bytes: await getBytes(result.id, { headers: jimakuHeaders(settings) }, 'Jimaku'), note: '' };
  }

  // -------------------------------------------------------------- together

  const PROVIDERS = {
    opensubtitles: { name: 'OpenSubtitles', ready: (s) => Boolean(s.osApiKey), search: osSearch, download: osDownload },
    subdl: { name: 'SubDL', ready: (s) => Boolean(s.subdlKey), search: subdlSearch, download: subdlDownload },
    jimaku: { name: 'Jimaku', ready: (s) => Boolean(s.jimakuKey), search: jimakuSearch, download: jimakuDownload },
  };

  function configured(settings) {
    return Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].ready(settings));
  }

  // Higher is better: wanted language order first, then an exact episode, then quality signals.
  function rank(result, ep, langs) {
    const li = langs.indexOf(result.lang);
    let score = (li === -1 ? 0 : (langs.length - li) * 1000);
    if (ep.episode != null && result.episode != null && Number(result.episode) === Number(ep.episode)) score += 200;
    if (result.pack) score -= 150;
    if (result.hi) score -= 40; // sound descriptions get in the way of reading
    if (result.trusted) score += 30;
    score += releaseBonus(result.name) * 25;
    score += Math.min(60, Math.log10(1 + result.downloads) * 15);
    if (result.provider === 'jimaku') score += 20; // Japanese-native subtitles, usually from the broadcast
    return score;
  }

  async function search(settings, ep, langs) {
    const ids = configured(settings);
    const report = {};
    let results = [];
    const run = async (id, titleHint) => {
      try {
        const found = await PROVIDERS[id].search(settings, ep, langs, titleHint);
        report[id] = { ok: true, count: found.length };
        results = results.concat(found);
      } catch (e) {
        report[id] = { ok: false, message: e.message || String(e) };
      }
    };
    // Jimaku searches by title when it has no id match, so give it the title the others found.
    await Promise.all(ids.filter((id) => id !== 'jimaku').map((id) => run(id)));
    if (ids.includes('jimaku')) await run('jimaku', (results.find((r) => r.title) || {}).title);
    results = results.filter((r) => langs.includes(r.lang));
    results.sort((a, b) => rank(b, ep, langs) - rank(a, ep, langs));
    return { results: results.slice(0, 60), report, providers: ids };
  }

  async function download(settings, result, ep) {
    const p = PROVIDERS[result.provider];
    if (!p) throw new ProviderError('unknown', 'Unknown subtitle source');
    const { bytes, note } = await p.download(settings, result);
    const sub = await SG.files.readSubtitle(bytes, { lang: result.lang, episode: ep && ep.episode, name: result.name });
    return { cues: sub.cues, file: sub.name || result.name, note };
  }

  SG.providers = { search, download, configured, rank, PROVIDERS, ProviderError, _internals: { osLang, subdlLang, fromSubdlLang } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
