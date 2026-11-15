'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../extension/shared/pitch.js');
const P = globalThis.SG.pitch;

test('morae keep small kana with the one before', () => {
  assert.deepEqual(P.morae('きょうと'), ['きょ', 'う', 'と']);
  assert.deepEqual(P.morae('がっこう'), ['が', 'っ', 'こ', 'う']);
});

test('patterns', () => {
  assert.deepEqual(P.pattern(2, 1), { marks: ['H', 'L'], particle: 'L', drop: 0 }); // 箸
  assert.deepEqual(P.pattern(2, 2), { marks: ['L', 'H'], particle: 'L', drop: 1 }); // 橋
  assert.deepEqual(P.pattern(3, 0), { marks: ['L', 'H', 'H'], particle: 'H', drop: -1 }); // 野菜
  assert.deepEqual(P.pattern(3, 2), { marks: ['L', 'H', 'L'], particle: 'L', drop: 1 }); // 食べる
  assert.equal(P.name(2, 2), 'odaka (drops after the word)');
});

test('Kanjium lookup picks the reading', () => {
  const map = P.parseKanjium(fs.readFileSync(path.join(__dirname, 'fixtures/kanjium-sample.txt'), 'utf8'));
  assert.deepEqual(P.lookup(map, '母', 'はは').a, [1]);
  assert.deepEqual(P.lookup(map, '箸', 'はし').a, [1]);
  assert.deepEqual(P.lookup(map, '橋', 'はし').a, [2]);
  assert.deepEqual(P.lookup(map, '野菜', '').a, [0]);
  assert.equal(P.lookup(map, '母', ''), null); // several readings and none given: do not guess
  assert.equal(P.lookup(map, '存在しない', 'x'), null);
});
