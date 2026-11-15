'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../extension/shared/episode.js');
require('../extension/shared/sync.js');
const { detect, fromTitle, confident, key } = globalThis.SG.episode;
const { align } = globalThis.SG.sync;

test('donkey.to player frames and pages', () => {
  const ep = detect([
    { url: 'https://player.videasy.net/tv/1399/2/5?color=FFA500', title: '' },
    { url: 'https://donkey.to/watch-now?type=tv&id=1399', title: 'Donkey | Watch Free Movies Online' },
  ]);
  assert.deepEqual([ep.type, ep.tmdbId, ep.season, ep.episode], ['tv', '1399', 2, 5]);
  assert.equal(ep.title, ''); // "Donkey | Watch Free Movies Online" is the site, not the show
  assert.ok(confident(ep));
  const movie = detect([{ url: 'https://vidsrc.sh/embed/movie/tt0133093', title: '' }]);
  assert.deepEqual([movie.type, movie.imdbId, movie.season], ['movie', 'tt0133093', null]);
  assert.ok(confident(movie));
  const page = detect([{ url: 'https://donkey.to/watch-now?type=tv&id=1399&seasonId=3&episodeId=4', title: '' }]);
  assert.deepEqual([page.type, page.tmdbId, page.season, page.episode], ['tv', '1399', 3, 4]);
});

test('query-string players and titles', () => {
  const a = detect([{ url: 'https://example.net/embed/tv?tmdb=94605&season=1&episode=3', title: '' }]);
  assert.deepEqual([a.type, a.tmdbId, a.season, a.episode], ['tv', '94605', 1, 3]);
  const t = fromTitle('Frieren: Beyond Journey\'s End S01E07 - Watch Online | SomeSite');
  assert.deepEqual([t.title, t.season, t.episode], ["Frieren: Beyond Journey's End", 1, 7]);
  assert.equal(fromTitle('葬送のフリーレン 第12話').episode, 12);
  assert.equal(fromTitle('눈물의 여왕 5화').episode, 5);
  const byTitle = detect([{ url: 'https://random.site/video/abc', title: 'Some Show 2x05' }]);
  assert.equal(confident(byTitle), false); // no id: fills the search form but does not auto-download
  assert.equal(key({ type: 'tv', tmdbId: '1', season: 1, episode: 2 }, 'ja'), 'tv|tmdb1|1|2|ja');
});

function cuesAt(starts) {
  return starts.map((s, i) => ({ start: s, end: s + 2, text: 'line ' + i }));
}

test('align finds a constant shift', () => {
  const ref = [];
  let t = 5;
  for (let i = 0; i < 300; i++) {
    ref.push(t);
    t += 2 + ((i * 7919) % 50) / 10; // irregular gaps, like real dialogue
  }
  const shifted = ref.filter((_, i) => i % 5 !== 0).map((s, i) => s - 3.4 + ((i % 3) - 1) * 0.08);
  const r = align(cuesAt(ref), cuesAt(shifted));
  assert.ok(r.ok);
  assert.equal(r.scale, 1);
  assert.ok(Math.abs(r.offset - 3.4) < 0.15, String(r.offset));
});

test('align corrects a 25 fps file played at 23.976', () => {
  const ref = [];
  let t = 3;
  for (let i = 0; i < 400; i++) {
    ref.push(t);
    t += 2.5 + ((i * 104729) % 40) / 10;
  }
  const file = ref.map((s) => (s - 1.5) / (25 / 23.976));
  const r = align(cuesAt(ref), cuesAt(file));
  assert.ok(r.ok);
  assert.ok(Math.abs(r.scale - 25 / 23.976) < 1e-9);
  assert.ok(Math.abs(r.offset - 1.5) < 0.2, String(r.offset));
});

test('align is exact on sparse dialogue', () => {
  const ref = [0.6, 2.1, 3.0, 4.4, 6.2, 7.0, 8.9, 10.3, 11.2, 12.8, 14.5, 15.6, 17.0, 18.4, 19.9, 21.0, 22.7, 24.1, 25.0, 26.6];
  const r = align(cuesAt(ref), cuesAt(ref.map((s) => s - 2)));
  assert.ok(r.ok);
  assert.equal(r.offset, 2);
});

test('align refuses unrelated subtitles', () => {
  const a = cuesAt(Array.from({ length: 200 }, (_, i) => i * 7.3));
  const b = cuesAt(Array.from({ length: 200 }, (_, i) => i * 4.1 + Math.sin(i) * 3 + 1));
  assert.equal(align(a, b).ok, false);
});
