'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../extension/shared/subtitles.js');
require('../extension/shared/lang.js');
const { parseSubtitles, findCue, lineKey } = globalThis.SG.subtitles;
const { detectLang, langCode } = globalThis.SG.lang;

test('WebVTT with tags, settings and entities', () => {
  const vtt = `WEBVTT\n\nNOTE comment\n\n1\n00:00:01.000 --> 00:00:03.500 align:center line:90%\n<c.ja>私は</c><b>りんご</b>を&amp;\n食べた\n\n00:04.000 --> 00:05.000\n<v Taro>そうだね</v>\n`;
  const { format, cues } = parseSubtitles(vtt);
  assert.equal(format, 'vtt');
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: '私はりんごを& 食べた' },
    { start: 4, end: 5, text: 'そうだね' },
  ]);
});

test('SubRip with BOM and CRLF', () => {
  const srt = '﻿1\r\n00:00:01,250 --> 00:00:02,000\r\n<i>안녕하세요</i>\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,500\r\n학교에서 먹었어요\r\n';
  const { format, cues } = parseSubtitles(srt);
  assert.equal(format, 'srt');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '안녕하세요');
  assert.equal(cues[1].start, 60);
});

test('ASS keeps commas in text and skips drawings', () => {
  const ass = `[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}你好，世界, 朋友\\N再见\nDialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0\n`;
  const { format, cues } = parseSubtitles(ass);
  assert.equal(format, 'ass');
  assert.deepEqual(cues, [{ start: 1, end: 2.5, text: '你好，世界, 朋友 再见' }]);
});

test('TTML with ticks and clock times', () => {
  const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000"><body><div>
  <p begin="10000000t" end="25000000t">Guten<br/>Tag</p>
  <p begin="00:00:03.000" dur="1.5s"><span>Wie geht's?</span></p></div></body></tt>`;
  const { format, cues } = parseSubtitles(ttml);
  assert.equal(format, 'ttml');
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: 'Guten Tag' },
    { start: 3, end: 4.5, text: "Wie geht's?" },
  ]);
});

test('YouTube json3', () => {
  const j = JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: 'Hola ' }, { utf8: 'mundo' }] }, { tStartMs: 2000 }] });
  const { format, cues } = parseSubtitles(j);
  assert.equal(format, 'json3');
  assert.deepEqual(cues, [{ start: 0.5, end: 1.5, text: 'Hola mundo' }]);
});

test('rolling duplicates merge and non-subtitles are ignored', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:02.000 --> 00:00:03.000\nA\n\n00:00:03.500 --> 00:00:04.000\nB\n';
  assert.deepEqual(parseSubtitles(vtt).cues.map((c) => [c.start, c.end, c.text]), [[1, 3, 'A'], [3.5, 4, 'B']]);
  assert.equal(parseSubtitles('{"hello": 1}').cues.length, 0);
  assert.equal(parseSubtitles('<html><body>hi</body></html>').cues.length, 0);
});

test('findCue picks the line on screen', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 2.5, end: 6, text: 'b' }, { start: 3, end: 4, text: 'c' }];
  assert.equal(findCue(cues, 0.5), -1);
  assert.equal(findCue(cues, 1.5), 0);
  assert.equal(findCue(cues, 2.2), -1);
  assert.equal(findCue(cues, 3.5), 2);
  assert.equal(findCue(cues, 5), 1);
});

test('lineKey depends on the previous line', () => {
  assert.equal(lineKey('はい', 'x'), lineKey('はい', 'x'));
  assert.notEqual(lineKey('はい', 'x'), lineKey('はい', 'y'));
});

test('language detection', () => {
  assert.equal(detectLang('私はりんごを食べた。そうですね。'), 'ja');
  assert.equal(detectLang('안녕하세요 학교에서 먹었어요'), 'ko');
  assert.equal(detectLang('我们明天去北京吃饭吧'), 'zh');
  assert.equal(detectLang('I think that you are right and we should go there now'), 'en');
  assert.equal(detectLang('Ich weiß nicht, ob das die richtige Entscheidung ist, aber wir müssen es versuchen'), 'de');
  assert.equal(detectLang('No sé qué hacer, pero creo que es muy importante para todos'), 'es');
  assert.equal(langCode('Japanese'), 'ja');
  assert.equal(langCode('zh-Hans'), 'zh');
  assert.equal(langCode('Mandarin'), 'zh');
});
