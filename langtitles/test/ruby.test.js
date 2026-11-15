'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../extension/shared/ruby.js');
const R = globalThis.SG.ruby;

test('derive furigana from a whole-word reading', () => {
  assert.deepEqual(R.deriveFurigana('食べさせられた', 'たべさせられた'), [{ t: '食', r: 'た' }, { t: 'べさせられた', r: '' }]);
  assert.deepEqual(R.deriveFurigana('昨日', 'きのう'), [{ t: '昨日', r: 'きのう' }]);
  assert.deepEqual(R.deriveFurigana('お母さん', 'おかあさん'), [{ t: 'お', r: '' }, { t: '母', r: 'かあ' }, { t: 'さん', r: '' }]);
  assert.deepEqual(R.deriveFurigana('取り扱い', 'とりあつかい'), [{ t: '取', r: 'と' }, { t: 'り', r: '' }, { t: '扱', r: 'あつか' }, { t: 'い', r: '' }]);
  assert.deepEqual(R.deriveFurigana('コーヒー', ''), [{ t: 'コーヒー', r: '' }]);
});

test('segmentsFor prefers a valid per-kanji split from Claude', () => {
  const w = { s: '野菜', r: 'やさい', f: [{ t: '野', r: 'や' }, { t: '菜', r: 'さい' }] };
  assert.deepEqual(R.segmentsFor(w, 'ja'), w.f);
  // A split that does not add up to the word falls back to deriving it.
  const bad = { s: '食べた', r: 'たべた', f: [{ t: '食', r: 'た' }] };
  assert.deepEqual(R.segmentsFor(bad, 'ja'), [{ t: '食', r: 'た' }, { t: 'べた', r: '' }]);
  assert.equal(R.segmentsFor({ s: 'ありがとう', r: '' }, 'ja'), null);
  assert.equal(R.segmentsFor({ s: '학교에서', r: '' }, 'ko'), null); // no romanization
  assert.deepEqual(R.segmentsFor({ s: '火车', r: 'huǒ chē' }, 'zh'), [{ t: '火', r: 'huǒ' }, { t: '车', r: 'chē' }]);
});

test('known kanji hide their readings', () => {
  const known = new Set(['食']);
  assert.equal(R.showReading({ t: '食', r: 'た' }, known), false);
  assert.equal(R.showReading({ t: '昨日', r: 'きのう' }, new Set(['昨'])), true);
  assert.equal(R.showReading({ t: '昨日', r: 'きのう' }, new Set(['昨', '日'])), false);
  assert.deepEqual(R.hanChars('お母さんと母'), ['母']);
});

test('Anki export', () => {
  assert.equal(R.ankiFurigana([{ t: '食', r: 'た' }, { t: 'べる', r: '' }]), '食[た]べる');
  assert.equal(R.ankiFurigana([{ t: 'お', r: '' }, { t: '母', r: 'かあ' }, { t: 'さん', r: '' }]), 'お 母[かあ]さん');
  const tsv = R.toAnkiTsv(['Word', 'Meaning'], [['食べる', 'to eat\tconsume\nline2']], 'langtitles');
  assert.equal(tsv, '#separator:tab\n#html:true\n#columns:Word\tMeaning\n#tags column:3\n食べる\tto eat consume<br>line2\tlangtitles\n');
});
