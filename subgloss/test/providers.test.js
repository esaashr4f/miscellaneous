'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
for (const f of ['shared/settings.js', 'shared/subtitles.js', 'shared/lang.js', 'shared/episode.js', 'background/files.js', 'background/providers.js']) {
  require('../extension/' + f);
}
const SG = globalThis.SG;

// A real zip file built by hand: local headers, deflated data, central directory.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const SRT = (text) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n\n2\n00:00:03,000 --> 00:00:04,000\n${text}2\n`;

test('zip: picks the file for the episode', async () => {
  const zip = makeZip([
    ['Show.S01E01.WEB.ja.srt', SRT('いち')],
    ['Show.S01E02.WEB.ja.srt', SRT('に')],
    ['Show.S01E12.WEB.ja.srt', SRT('じゅうに')],
    ['readme.txt', 'hi'],
  ]);
  const sub = await SG.files.readSubtitle(zip, { lang: 'ja', episode: 2 });
  assert.equal(sub.name, 'Show.S01E02.WEB.ja.srt');
  assert.equal(sub.cues[0].text, 'に');
});

test('legacy encodings and UTF-16', () => {
  const sjis = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]); // こんにちは
  assert.equal(SG.files.decodeText(sjis, 'ja'), 'こんにちは');
  const euckr = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7]); // 안녕
  assert.equal(SG.files.decodeText(euckr, 'ko'), '안녕');
  const u16 = new Uint8Array(Buffer.from('1\n00:00:01,000', 'utf16le'));
  assert.equal(SG.files.decodeText(u16, 'en'), '1\n00:00:01,000');
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('search across all three sites and download', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/subtitles')) {
      return json({ data: [
        { attributes: { language: 'ja', release: 'Show.S01E02.1080p.WEB-DL', download_count: 900, hearing_impaired: false, from_trusted: true,
          files: [{ file_id: 111, file_name: 'a.srt' }], feature_details: { parent_title: 'Show', season_number: 1, episode_number: 2 } } },
        { attributes: { language: 'zh-tw', release: 'Show.S01E02.BluRay', download_count: 5, hearing_impaired: true,
          files: [{ file_id: 222, file_name: 'b.srt' }], feature_details: { parent_title: 'Show', season_number: 1, episode_number: 2 } } },
      ] });
    }
    if (u.host === 'api.opensubtitles.com' && u.pathname.endsWith('/login')) return json({ token: 'jwt', base_url: 'vip-api.opensubtitles.com' });
    if (u.host === 'vip-api.opensubtitles.com' && u.pathname.endsWith('/download')) return json({ link: 'https://dl.example/file.srt', remaining: 19 });
    if (u.host === 'dl.example') return new Response(SRT('テスト'));
    if (u.host === 'api.subdl.com') {
      return json({ status: true, results: [{ name: 'Show', tmdb_id: 1399 }], subtitles: [
        { release_name: 'Show S01 pack', name: 'pack.zip', url: '/subtitle/1-2.zip', language: 'JA', season: 1, full_season: true, hi: false,
          unpack_files: [{ episode: 2, season: 1, name: 'Show.S01E02.srt', release_name: 'Show.S01E02.WEB', url: '/subtitle/1-2/f2' }] },
        { release_name: 'other', name: 'x.zip', url: '/subtitle/9.zip', language: 'EN', season: 1, episode: 2 },
      ] });
    }
    if (u.host === 'jimaku.cc' && u.pathname === '/api/entries/search') return json([{ id: 7, name: 'Show', english_name: 'Show', japanese_name: '番組', flags: {} }]);
    if (u.host === 'jimaku.cc' && u.pathname === '/api/entries/7/files') return json([{ name: '[Group] Show - 02.ass', url: 'https://jimaku.cc/entry/7/download/x.ass', size: 1 }, { name: 'notes.txt', url: 'z' }]);
    throw new Error('unexpected ' + url);
  };
  const settings = Object.assign({}, SG.DEFAULTS, { osApiKey: 'OSKEY', osUser: 'me', osPass: 'pw', subdlKey: 'SDKEY', jimakuKey: 'JMKEY' });
  const ep = { type: 'tv', tmdbId: '1399', season: 1, episode: 2, title: '' };
  const found = await SG.providers.search(settings, ep, ['ja', 'zh']);
  assert.deepEqual(found.providers, ['opensubtitles', 'subdl', 'jimaku']);
  assert.ok(Object.values(found.report).every((r) => r.ok));
  // English result filtered out; Chinese ranks below every Japanese one; season pack resolved to its episode file.
  assert.ok(found.results.every((r) => r.lang === 'ja' || r.lang === 'zh'));
  assert.equal(found.results[found.results.length - 1].lang, 'zh');
  const subdl = found.results.find((r) => r.provider === 'subdl');
  assert.equal(subdl.id, '/subtitle/1-2/f2');
  assert.equal(subdl.pack, false);
  assert.equal(subdl.episode, 2);
  const jimaku = found.results.find((r) => r.provider === 'jimaku');
  assert.equal(jimaku.name, '[Group] Show - 02.ass');

  const os = calls.find((c) => c.url.host === 'api.opensubtitles.com' && c.url.pathname.endsWith('/subtitles'));
  const keys = [...os.url.searchParams.keys()];
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(os.url.searchParams.get('parent_tmdb_id'), '1399');
  assert.equal(os.url.searchParams.get('languages'), 'ja,zh-cn,zh-tw');
  assert.equal(os.init.headers['Api-Key'], 'OSKEY');
  assert.equal(os.init.headers['X-User-Agent'], 'SubGloss v0.1');
  const sd = calls.find((c) => c.url.host === 'api.subdl.com');
  assert.equal(sd.url.searchParams.get('languages'), 'JA,ZH,ZH_BG');
  assert.equal(sd.url.searchParams.get('unpack'), '1');
  const jm = calls.find((c) => c.url.host === 'jimaku.cc');
  assert.equal(jm.url.searchParams.get('tmdb_id'), 'tv:1399');
  assert.equal(jm.init.headers.Authorization, 'JMKEY');

  const best = found.results.find((r) => r.provider === 'opensubtitles' && r.lang === 'ja');
  const got = await SG.providers.download(settings, best, ep);
  assert.equal(got.cues[0].text, 'テスト');
  assert.match(got.note, /19/);
  const dl = calls.find((c) => c.url.pathname.endsWith('/download'));
  assert.equal(dl.init.headers.Authorization, 'Bearer jwt');
  assert.equal(JSON.parse(dl.init.body).file_id, 111);
});

test('a site that fails does not stop the others', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.host === 'api.opensubtitles.com') return json({ message: 'You cannot consume this service' }, 403);
    if (u.host === 'api.subdl.com') return json({ status: false, error: 'can\'t find movie or tv' });
    throw new Error('unexpected ' + url);
  };
  const settings = Object.assign({}, SG.DEFAULTS, { osApiKey: 'bad', subdlKey: 'k' });
  const found = await SG.providers.search(settings, { type: 'movie', title: 'Nothing', tmdbId: null }, ['ko']);
  assert.equal(found.results.length, 0);
  assert.equal(found.report.opensubtitles.ok, false);
  assert.match(found.report.opensubtitles.message, /cannot consume/);
  assert.equal(found.report.subdl.ok, false);
});
