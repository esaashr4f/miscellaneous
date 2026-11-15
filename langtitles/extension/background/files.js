// Reading downloaded subtitle files: zip archives (SubDL serves zips, Jimaku sometimes does)
// and the legacy encodings older subtitle files use (Shift_JIS, EUC-KR, GBK, Big5...).
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const SUB_EXT = /\.(srt|ass|ssa|vtt|ttml|dfxp|xml)$/i;

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  async function inflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Minimal zip reader: the central directory gives each file's name, method and offset.
  async function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a readable zip file');
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const names = new TextDecoder('utf-8');
    const files = [];
    for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) break;
      const method = view.getUint16(at + 10, true);
      const compSize = view.getUint32(at + 20, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const commentLen = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + compSize);
      files.push({ name, method, raw });
    }
    const out = [];
    for (const f of files) {
      if (f.method === 0) out.push({ name: f.name, data: f.raw });
      else if (f.method === 8) out.push({ name: f.name, data: await inflateRaw(f.raw) });
    }
    return out;
  }

  function countReplacement(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++;
    return n;
  }

  const LEGACY = {
    ja: ['shift_jis', 'euc-jp'],
    ko: ['euc-kr'],
    zh: ['gb18030', 'big5'],
    th: ['windows-874'],
    vi: ['windows-1258'],
    ru: ['windows-1251'],
    uk: ['windows-1251'],
    el: ['windows-1253'],
    tr: ['windows-1254'],
    he: ['windows-1255'],
    ar: ['windows-1256'],
    pl: ['windows-1250'],
    cs: ['windows-1250'],
    hu: ['windows-1250'],
    ro: ['windows-1250'],
  };

  function decodeText(bytes, lang) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    // UTF-16 without a byte order mark: every other byte is zero for ASCII text.
    let evenZero = 0;
    let oddZero = 0;
    const probe = Math.min(bytes.length, 2000);
    for (let i = 0; i < probe; i++) if (bytes[i] === 0) (i % 2 ? oddZero++ : evenZero++);
    if (oddZero > probe / 5) return new TextDecoder('utf-16le').decode(bytes);
    if (evenZero > probe / 5) return new TextDecoder('utf-16be').decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      /* not UTF-8; try the encodings usual for the language */
    }
    let best = null;
    let bestBad = Infinity;
    for (const enc of (LEGACY[lang] || []).concat(['shift_jis', 'euc-kr', 'gb18030', 'big5', 'windows-1252'])) {
      let text;
      try {
        text = new TextDecoder(enc).decode(bytes);
      } catch (e) {
        continue;
      }
      const bad = countReplacement(text);
      if (bad < bestBad) {
        best = text;
        bestBad = bad;
        if (bad === 0) break;
      }
    }
    return best == null ? new TextDecoder('utf-8').decode(bytes) : best;
  }

  // From a zip (or a single file), pick the subtitle for the wanted episode and parse it.
  async function readSubtitle(bytes, opts) {
    const lang = (opts && opts.lang) || '';
    const episode = opts && opts.episode != null ? Number(opts.episode) : null;
    let candidates;
    if (isZip(bytes)) {
      candidates = (await unzip(bytes)).filter((f) => SUB_EXT.test(f.name));
      if (!candidates.length) throw new Error('The archive has no subtitle file Langtitles can read');
      if (candidates.length > 1 && episode != null) {
        const re = new RegExp('(?:^|[^0-9])(?:e|ep|episode|第|-|_|\\s|x)?0*' + episode + '(?:[^0-9]|$)', 'i');
        const exact = candidates.filter((f) => new RegExp('e0*' + episode + '(?:[^0-9]|$)', 'i').test(f.name));
        const loose = candidates.filter((f) => re.test(f.name.replace(/\.[^.]+$/, '').replace(/\b(19|20)\d{2}\b|\b(480|720|1080|2160)p\b|x26[45]/gi, '')));
        candidates = exact.length ? exact : loose.length ? loose : candidates;
      }
      // Prefer text formats that keep more of the dialogue structure, then the largest file.
      const rank = (n) => (/\.ass$|\.ssa$/i.test(n) ? 2 : /\.srt$|\.vtt$/i.test(n) ? 1 : 0);
      candidates.sort((a, b) => rank(b.name) - rank(a.name) || b.data.length - a.data.length);
    } else {
      candidates = [{ name: (opts && opts.name) || '', data: bytes }];
    }
    for (const c of candidates) {
      const parsed = SG.subtitles.parseSubtitles(decodeText(c.data, lang));
      if (parsed.cues.length) return { name: c.name, format: parsed.format, cues: parsed.cues };
    }
    throw new Error('The downloaded file has no subtitles Langtitles can read');
  }

  SG.files = { unzip, decodeText, readSubtitle, isZip };
})(typeof globalThis !== 'undefined' ? globalThis : this);
