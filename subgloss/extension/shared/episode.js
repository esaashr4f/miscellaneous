// Works out which movie or episode is playing from page and player addresses and titles.
//
// Many embedded players put the TMDB or IMDb id, season and episode in their own address
// (player.example/tv/1399/1/2, /embed/tv?tmdb=1399&season=1&episode=2), and SubGloss runs
// inside the player frame, so that is the most reliable source. Titles are a fallback.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const TYPE_WORDS = { movie: 'movie', movies: 'movie', film: 'movie', tv: 'tv', series: 'tv', show: 'tv', shows: 'tv', anime: 'tv' };

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  function fromUrl(href) {
    let u;
    try {
      u = new URL(href);
    } catch (e) {
      return null;
    }
    const out = {};
    // /tv/1399/1/2, /embed/movie/tt0133093, /tv/1399-1-2
    const m = /\/(movies?|film|tv|series|shows?|anime)\/(tt\d{5,10}|\d{1,9})(?:[/-](\d{1,3})[/-](\d{1,4}))?(?:[/?#.]|$)/i.exec(u.pathname);
    if (m) {
      out.type = TYPE_WORDS[m[1].toLowerCase()];
      if (m[2].startsWith('tt')) out.imdbId = m[2];
      else out.tmdbId = m[2];
      if (m[3] != null) {
        out.season = num(m[3]);
        out.episode = num(m[4]);
      }
    }
    const q = u.searchParams;
    const get = (...names) => {
      for (const n of names) {
        const v = q.get(n);
        if (v != null && v !== '' && v !== 'undefined' && v !== 'null') return v;
      }
      return null;
    };
    const type = get('type', 'media_type', 'mediaType', 'kind');
    if (type && TYPE_WORDS[type.toLowerCase()]) out.type = TYPE_WORDS[type.toLowerCase()];
    const imdb = get('imdb', 'imdb_id', 'imdbId');
    if (imdb && /^tt\d{5,10}$/.test(imdb)) out.imdbId = imdb;
    const tmdb = get('tmdb', 'tmdb_id', 'tmdbId', out.type ? 'id' : '_');
    if (tmdb && /^\d{1,9}$/.test(tmdb)) out.tmdbId = tmdb;
    else if (tmdb && /^tt\d{5,10}$/.test(tmdb)) out.imdbId = tmdb;
    const season = num(get('season', 's', 'season_number', 'seasonId', 'sea'));
    const episode = num(get('episode', 'e', 'ep', 'episode_number', 'episodeId', 'epi'));
    if (season != null) out.season = season;
    if (episode != null) out.episode = episode;
    if (!out.type && out.season != null && (out.tmdbId || out.imdbId)) out.type = 'tv';
    return Object.keys(out).length ? out : null;
  }

  const GENERIC = /\b(watch|stream(ing)?|free|online|full|hd|movies?|tv|shows?|series|episodes?|anime|drama|subbed|dubbed|eng ?sub)\b/gi;

  function siteLabel(url) {
    try {
      const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
      return parts.length > 1 ? parts[parts.length - 2] : parts[0];
    } catch (e) {
      return '';
    }
  }

  // A title segment that is only the site's name or a slogan ("Watch Free Movies Online").
  function isNoise(seg, site) {
    const s = seg.trim();
    if (!s) return true;
    if (site && site.length >= 3 && s.toLowerCase().includes(site.toLowerCase())) return true;
    const words = s.split(/\s+/).length;
    const generic = (s.match(GENERIC) || []).length;
    return generic >= 2 && generic >= words - 1;
  }

  // "Show Name S01E02", "Show 1x02", "Show Season 1 Episode 2", "Show - Episode 3", "第3話", "3화"
  function fromTitle(title, url) {
    const t = String(title || '').trim();
    if (!t) return null;
    const site = url ? siteLabel(url) : '';
    const out = {};
    let m;
    let markerAt = -1;
    if ((m = /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,4})\b/i.exec(t)) || (m = /\b(\d{1,2})x(\d{2,3})\b/.exec(t))) {
      out.season = num(m[1]);
      out.episode = num(m[2]);
      markerAt = m.index;
    } else if ((m = /\bSeason\s*(\d{1,2})\b[^\d]{0,12}\bEp(?:isode)?\.?\s*(\d{1,4})\b/i.exec(t))) {
      out.season = num(m[1]);
      out.episode = num(m[2]);
      markerAt = m.index;
    } else if ((m = /\bEp(?:isode)?\.?\s*(\d{1,4})\b/i.exec(t)) || (m = /第\s*(\d{1,4})\s*[話话集]/.exec(t)) || (m = /(\d{1,4})\s*화/.exec(t))) {
      out.episode = num(m[1]);
      markerAt = m.index;
    }
    if (out.episode != null) out.type = 'tv';
    const y = /\((19\d{2}|20\d{2})\)/.exec(t);
    if (y) out.year = Number(y[1]);
    // The name: text before the episode marker, else the first segment that is not the site's name.
    let name = '';
    if (markerAt > 0) {
      const before = t.slice(0, markerAt).split(/\s[|·•—–]\s/);
      name = before[before.length - 1];
      if (isNoise(name, site)) name = '';
    }
    if (!name) {
      const segs = (markerAt >= 0 ? t.slice(0, markerAt) : t).split(/\s[|·•—–]\s|\s-\s/).filter((x) => !isNoise(x, site));
      name = segs[0] || '';
    }
    name = name.replace(/\((19|20)\d{2}\)/, '').replace(/^(watch|stream)\s+/i, '').replace(/\s+(online|free|full|hd)(\s.*)?$/i, '');
    name = name.replace(/[\s:,\-–|]+$/, '').trim();
    if (name && name.length <= 80 && !/^(home|watch|player|video|embed)$/i.test(name)) out.title = name;
    return Object.keys(out).length ? out : null;
  }

  // sources: [{ url, title }] most reliable first. Ids and numbers from addresses win over titles.
  function detect(sources) {
    const result = { type: null, tmdbId: null, imdbId: null, season: null, episode: null, title: '', year: null };
    const fill = (info, overwrite) => {
      if (!info) return;
      for (const k of Object.keys(result)) {
        if (info[k] == null || info[k] === '') continue;
        if (overwrite || result[k] == null || result[k] === '') result[k] = info[k];
      }
    };
    for (const s of sources) fill(fromUrl(s.url), false);
    for (const s of sources) fill(fromTitle(s.title, s.url), false);
    if (result.type === 'movie') {
      result.season = null;
      result.episode = null;
    }
    if (!result.type && (result.tmdbId || result.imdbId)) result.type = result.episode != null ? 'tv' : null;
    return result;
  }

  // Detection is "confident" when it names the exact movie or episode, which is what
  // automatic loading needs; anything else only pre-fills the search form.
  function confident(ep) {
    if (!ep || !(ep.tmdbId || ep.imdbId) || !ep.type) return false;
    return ep.type === 'movie' || (ep.season != null && ep.episode != null);
  }

  function key(ep, lang) {
    const id = ep.tmdbId ? 'tmdb' + ep.tmdbId : ep.imdbId ? ep.imdbId : 't:' + String(ep.title || '').toLowerCase();
    return [ep.type || '?', id, ep.season == null ? '' : ep.season, ep.episode == null ? '' : ep.episode, lang || ''].join('|');
  }

  function describe(ep) {
    if (!ep) return '';
    const name = ep.title || (ep.tmdbId ? 'TMDB ' + ep.tmdbId : ep.imdbId || 'Unknown');
    if (ep.type === 'tv' && ep.episode != null) {
      return `${name} · S${String(ep.season == null ? 1 : ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    }
    return name;
  }

  SG.episode = { detect, fromUrl, fromTitle, confident, key, describe };
})(typeof globalThis !== 'undefined' ? globalThis : this);
