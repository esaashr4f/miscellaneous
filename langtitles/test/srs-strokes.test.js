'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../extension/shared/srs.js');
require('../extension/shared/strokes.js');
const { schedule, preview, isMature, queue, counts } = globalThis.SG.srs;
const S = globalThis.SG.strokes;
const MIN = 60000;
const DAY = 86400000;

test('new cards go through learning steps, then reviews grow', () => {
  const now = 1e12;
  let c = schedule(null, 3, now);
  assert.equal(c.state, 'learning');
  assert.equal(c.due - now, 10 * MIN);
  c = schedule(c, 3, now);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 1);
  c = schedule(c, 3, now);
  assert.equal(c.interval, 3); // 1 * 2.5 rounded, at least +1
  c = schedule(c, 3, now);
  assert.equal(c.interval, 8);
  const lapsed = schedule(c, 1, now);
  assert.equal(lapsed.state, 'relearning');
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.ease < c.ease);
  const back = schedule(lapsed, 3, now);
  assert.equal(back.state, 'review');
  assert.equal(back.interval, lapsed.interval);
  assert.equal(schedule(null, 4, now).interval, 4);
  assert.deepEqual(preview(null, now), ['1 min', '2 min', '10 min', '4 d']);
  assert.ok(isMature({ state: 'review', interval: 21 }));
  assert.ok(!isMature({ state: 'review', interval: 20 }));
});

test('queue: due first, then a limited number of new cards', () => {
  const now = 5e12;
  const items = [
    { key: 'a', savedAt: 1 },
    { key: 'b', savedAt: 2 },
    { key: 'c', savedAt: 3, srs: { state: 'review', due: now - DAY } },
    { key: 'd', savedAt: 4, srs: { state: 'review', due: now + DAY } },
    { key: 'e', savedAt: 5, srs: { state: 'learning', due: now - MIN } },
  ];
  assert.deepEqual(queue(items, now, 1).map((x) => x.key), ['c', 'e', 'a']);
  assert.deepEqual(counts(items, now, 1), { due: 2, fresh: 1, total: 3 });
});

test('KanjiVG: strokes in order with their components', () => {
  const d = S.parseKanjiVG(fs.readFileSync(path.join(__dirname, 'fixtures/kanjivg-083dc.svg'), 'utf8'));
  assert.equal(d.strokes.length, 11);
  assert.equal(d.numbers.length, 11);
  assert.deepEqual(d.components.map((c) => c.element), ['艹', '采']);
  assert.ok(d.components[0].radical);
  assert.ok(d.components[1].phonetic);
  assert.deepEqual(d.components[0].strokes, [0, 1, 2]);
  assert.equal(d.components[1].strokes.length, 8);
  const lg = S.legend(d);
  assert.equal(lg[0].original, '艸');
  assert.match(lg[0].role, /radical/);
  assert.match(lg[1].role, /gives the sound/);
});

test('hanzi-writer data and URLs', () => {
  const d = S.parseHanziWriter(fs.readFileSync(path.join(__dirname, 'fixtures/hanzi-writer-8f66.json'), 'utf8'));
  assert.equal(d.strokes.length, 4);
  assert.equal(d.numbers[0].n, '1');
  assert.equal(S.kanjiVGUrl('菜'), 'https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg@master/kanji/083dc.svg');
  assert.equal(S.hanziWriterUrl('车'), 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/%E8%BD%A6.json');
});
