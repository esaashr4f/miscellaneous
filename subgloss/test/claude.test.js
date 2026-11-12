'use strict';
// Runs the extension's real Claude call path (bundled SDK + claude.js + main.js-free pieces)
// against a local server that speaks the Messages API streaming format.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ext = (p) => path.join(__dirname, '..', 'extension', p);
const store = {};
globalThis.browser = {
  storage: { local: {
    get: async (k) => ({ [k]: store[k] }),
    set: async (o) => Object.assign(store, o),
  } },
};
vm.runInThisContext(fs.readFileSync(ext('vendor/anthropic-sdk.js'), 'utf8'), { filename: 'anthropic-sdk.js' });
for (const f of ['shared/settings.js', 'background/prompt.js', 'background/claude.js']) require(ext(f));
const SG = globalThis.SG;

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function streamOf(text, stop = 'end_turn') {
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 40 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 10) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(10) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 50 } },
    { type: 'message_stop' },
  ];
}

const ANALYSIS = {
  lang: 'ja',
  lines: [{
    i: 0, tr: 'I ate an apple.', lit: 'I [topic] apple [object] ate', pat: '[topic] 私は · [object] りんごを · [predicate] 食べた', notes: [],
    w: [
      { s: '私', r: 'わたし', d: '私', pos: 'pronoun', m: 'I', p: [{ t: '私', g: 'I' }], c: 0, role: 'topic', n: '' },
      { s: 'は', r: 'わ', d: 'は', pos: 'particle', m: 'topic marker', p: [{ t: 'は', g: 'topic marker' }], c: 0, role: 'topic', n: '' },
    ],
  }],
};

test('analyzeLines sends the expected request and parses the reply', async (t) => {
  let seen = null;
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      if (mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      } else if (mode === 'cut') sse(res, streamOf('{"lang":"ja","li', 'max_tokens'));
      else sse(res, streamOf(JSON.stringify(ANALYSIS)));
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const settings = Object.assign({}, SG.DEFAULTS, { apiKey: 'sk-test', baseURL: `http://127.0.0.1:${server.address().port}`, nativeLang: 'English' });

  const out = await SG.claude.analyzeLines(settings, ['私はりんごを食べた', '♪'], ['前の行'], 'ja');
  assert.equal(out.length, 2);
  assert.equal(out[0].tr, 'I ate an apple.');
  assert.equal(out[0].w[1].m, 'topic marker');
  assert.equal(out[1], null);

  assert.match(seen.url, /^\/v1\/messages/);
  assert.ok(seen.headers['x-api-key'] === 'sk-test' || seen.headers.authorization === 'Bearer sk-test');
  assert.equal(seen.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(seen.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const b = seen.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.stream, true);
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.system[0].cache_control.type, 'ephemeral');
  assert.match(b.messages[0].content, /0: 私はりんごを食べた\n1: ♪/);
  assert.match(b.messages[0].content, /- 前の行/);
  assert.ok(!('thinking' in b) && !('temperature' in b));

  const usage = store.usage['claude-opus-5-5'];
  assert.equal(usage.requests, 1);
  assert.equal(usage.output, 50);

  mode = 'cut';
  await assert.rejects(SG.claude.analyzeLines(settings, ['x'], [], 'ja'), (e) => e.code === 'truncated');
  mode = 'auth';
  await assert.rejects(
    SG.claude.analyzeLines(Object.assign({}, settings, { apiKey: 'bad' }), ['x'], [], 'ja'),
    (e) => e.code === 'auth',
  );
  await assert.rejects(SG.claude.analyzeLines(Object.assign({}, settings, { apiKey: '' }), ['x'], [], 'ja'), (e) => e.code === 'no_key');
});

test('explainWord streams text', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => sse(res, streamOf('This is the topic marker, used to say what the sentence is about.')));
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const settings = Object.assign({}, SG.DEFAULTS, { apiKey: 'sk-test', baseURL: `http://127.0.0.1:${server.address().port}`, model: 'claude-haiku-5-5' });
  const deltas = [];
  const text = await SG.claude.explainWord(settings, { sentence: '私は', word: ANALYSIS.lines[0].w[1] }, (d) => deltas.push(d));
  assert.equal(deltas.length, 2);
  assert.equal(text, deltas.join(''));
});

test('schema contains only features structured outputs accept', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
    for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) assert.ok(!(bad in s), bad);
  };
  walk(SG.prompt.ANALYSIS_SCHEMA);
});
