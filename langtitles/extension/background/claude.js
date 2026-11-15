// Calls to the Claude API through the official SDK (vendor/anthropic-sdk.js).
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});
  const { Anthropic } = root.AnthropicSDK;

  // Models that can hand a declined request to another model inside the same call.
  const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']);

  class LangtitlesError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  let client = null;
  let clientFor = '';

  function getClient(settings) {
    if (!settings.apiKey) throw new LangtitlesError('no_key', 'Add your Anthropic API key in the Langtitles options.');
    const sig = settings.apiKey + '|' + (settings.baseURL || '');
    if (!client || clientFor !== sig) {
      const opts = { apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 };
      if (settings.baseURL) opts.baseURL = settings.baseURL;
      client = new Anthropic(opts);
      clientFor = sig;
    }
    return client;
  }

  function baseParams(settings, maxTokens) {
    const params = {
      model: settings.model,
      max_tokens: maxTokens,
      output_config: { effort: settings.effort || 'low' },
    };
    if (FALLBACK_MODELS.has(settings.model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return params;
  }

  // Turn SDK errors into something short enough to show over a video.
  function describeError(err) {
    if (err instanceof LangtitlesError) return err;
    if (err instanceof Anthropic.AuthenticationError) {
      return new LangtitlesError('auth', 'The Anthropic API key was rejected. Check it in the Langtitles options.');
    }
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
      return new LangtitlesError('model', 'This API key cannot use the selected model. Pick another model in the Langtitles options.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new LangtitlesError('rate_limit', 'Rate limited by the Anthropic API. Langtitles will keep retrying.');
    }
    if (err instanceof Anthropic.BadRequestError) {
      return new LangtitlesError('bad_request', 'The Anthropic API rejected the request: ' + err.message);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new LangtitlesError('network', 'Could not reach the Anthropic API. Check your connection.');
    }
    if (err instanceof Anthropic.APIError) {
      return new LangtitlesError('api', `Anthropic API error ${err.status || ''}: ${err.message}`);
    }
    return new LangtitlesError('unknown', String((err && err.message) || err));
  }

  function textOf(message) {
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  function monthKey(now) {
    const d = new Date(now || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Estimated cost of one response, from list prices (batch requests cost half).
  function costOf(model, usage, batch) {
    const m = SG.MODELS.find((x) => String(model).startsWith(x.id)) || SG.MODELS[0];
    const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
    const cost = (input * m.inPrice + (usage.output_tokens || 0) * m.outPrice) / 1e6;
    return batch ? cost / 2 : cost;
  }

  async function spentThisMonth() {
    const r = (await browser.storage.local.get('spend')).spend || {};
    return r[monthKey()] || 0;
  }

  // Refuses new requests once this month's estimated spend reaches the cap set in Options.
  async function capGuard(settings) {
    const cap = Number(settings.monthlyCap) || 0;
    if (cap <= 0) return;
    const spent = await spentThisMonth();
    if (spent >= cap) {
      throw new LangtitlesError('cap', `This month's spending cap ($${cap.toFixed(2)}) is reached (about $${spent.toFixed(2)} spent). Raise it in the Langtitles options to continue.`);
    }
  }

  async function recordUsage(model, usage, batch) {
    if (!usage) return;
    const spend = (await browser.storage.local.get('spend')).spend || {};
    const mk = monthKey();
    spend[mk] = (spend[mk] || 0) + costOf(model, usage, batch);
    await browser.storage.local.set({ spend });
    const stored = (await browser.storage.local.get('usage')).usage || {};
    const u = stored[model] || { input: 0, output: 0, cacheRead: 0, requests: 0 };
    u.input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    u.cacheRead += usage.cache_read_input_tokens || 0;
    u.output += usage.output_tokens || 0;
    u.requests += 1;
    stored[model] = u;
    await browser.storage.local.set({ usage: stored });
  }

  // lines: array of strings. Resolves to { lang, lines: analysis[] } aligned with the input
  // (an entry is null when the model returned nothing usable for that line).
  // The request for one batch of lines; also used for batch (season) jobs.
  function analysisParams(settings, lines, context, langHint) {
    const { prompt } = SG;
    const params = baseParams(settings, 32000);
    params.system = [
      { type: 'text', text: prompt.systemPrompt(settings.nativeLang), cache_control: { type: 'ephemeral' } },
    ];
    params.messages = [{ role: 'user', content: prompt.userMessage(lines, context, langHint) }];
    params.output_config.format = { type: 'json_schema', schema: prompt.ANALYSIS_SCHEMA };
    return params;
  }

  // Turns the model's JSON into one analysis per input line (null where nothing usable came back).
  function readAnalysis(text, count) {
    const data = JSON.parse(text);
    const out = new Array(count).fill(null);
    for (const line of data.lines || []) {
      if (Number.isInteger(line.i) && line.i >= 0 && line.i < count) {
        out[line.i] = { lang: data.lang, tr: line.tr, lit: line.lit, pat: line.pat, notes: line.notes || [], w: line.w || [] };
      }
    }
    return out;
  }

  async function analyzeLines(settings, lines, context, langHint) {
    await capGuard(settings);
    let message;
    try {
      message = await getClient(settings).beta.messages.stream(analysisParams(settings, lines, context, langHint)).finalMessage();
    } catch (err) {
      throw describeError(err);
    }
    recordUsage(message.model || settings.model, message.usage).catch(() => {});
    if (message.stop_reason === 'refusal') {
      throw new LangtitlesError('refusal', 'Claude declined to annotate these lines.');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LangtitlesError('truncated', 'The annotation was cut off.');
    }
    try {
      return readAnalysis(textOf(message), lines.length);
    } catch (e) {
      throw new LangtitlesError('parse', 'Claude returned an annotation that could not be read.');
    }
  }

  // Streams plain text; onText receives each new piece as it arrives.
  async function streamText(settings, system, user, maxTokens, effort, onText) {
    await capGuard(settings);
    try {
      const params = baseParams(settings, maxTokens);
      if (effort) params.output_config.effort = effort;
      params.system = system;
      params.messages = [{ role: 'user', content: user }];
      const stream = getClient(settings).beta.messages.stream(params);
      stream.on('text', (delta) => onText(delta));
      const message = await stream.finalMessage();
      recordUsage(message.model || settings.model, message.usage).catch(() => {});
      if (message.stop_reason === 'refusal') throw new LangtitlesError('refusal', 'Claude declined to explain this.');
      return textOf(message);
    } catch (err) {
      throw describeError(err);
    }
  }

  // A longer explanation of one word in its sentence.
  function explainWord(settings, req, onText) {
    const { prompt } = SG;
    return streamText(settings, prompt.deepSystemPrompt(settings.nativeLang), prompt.deepUserMessage(req), 4000, null, onText);
  }

  // A complete, reusable guide to a grammar form. Written once per form, so it gets more care.
  function explainForm(settings, req, onText) {
    const { prompt } = SG;
    const effort = settings.effort === 'low' ? 'medium' : settings.effort;
    return streamText(settings, prompt.guideSystemPrompt(settings.nativeLang), prompt.guideUserMessage(req), 12000, effort, onText);
  }

  // A complete, reusable guide to one word: meanings, how it is built, where it fits and where it doesn't.
  function explainWordGuide(settings, req, onText) {
    const { prompt } = SG;
    const effort = settings.effort === 'low' ? 'medium' : settings.effort;
    return streamText(settings, prompt.wordGuideSystemPrompt(settings.nativeLang), prompt.wordGuideUserMessage(req), 12000, effort, onText);
  }

  // A structured dictionary entry for one kanji or hanzi.
  async function charEntry(settings, req) {
    const { prompt } = SG;
    await capGuard(settings);
    let message;
    try {
      const params = baseParams(settings, 8000);
      params.system = prompt.charSystemPrompt(settings.nativeLang);
      params.messages = [{ role: 'user', content: prompt.charUserMessage(req) }];
      params.output_config.format = { type: 'json_schema', schema: prompt.CHAR_SCHEMA };
      message = await getClient(settings).beta.messages.stream(params).finalMessage();
    } catch (err) {
      throw describeError(err);
    }
    recordUsage(message.model || settings.model, message.usage).catch(() => {});
    if (message.stop_reason === 'refusal') throw new LangtitlesError('refusal', 'Claude declined to describe this character.');
    if (message.stop_reason === 'max_tokens') throw new LangtitlesError('truncated', 'The character entry was cut off.');
    try {
      return JSON.parse(textOf(message));
    } catch (e) {
      throw new LangtitlesError('parse', 'Claude returned a character entry that could not be read.');
    }
  }

  // A vocabulary list for a whole episode, from its numbered lines.
  async function episodeWords(settings, lines) {
    const { prompt } = SG;
    await capGuard(settings);
    let message;
    try {
      const params = baseParams(settings, 24000);
      params.system = prompt.wordsSystemPrompt(settings.nativeLang);
      params.messages = [{ role: 'user', content: lines.map((l, i) => `${i}: ${l}`).join('\n') }];
      params.output_config.format = { type: 'json_schema', schema: prompt.WORDS_SCHEMA };
      message = await getClient(settings).beta.messages.stream(params).finalMessage();
    } catch (err) {
      throw describeError(err);
    }
    recordUsage(message.model || settings.model, message.usage).catch(() => {});
    if (message.stop_reason === 'refusal') throw new LangtitlesError('refusal', 'Claude declined to list these words.');
    if (message.stop_reason === 'max_tokens') throw new LangtitlesError('truncated', 'The word list was cut off.');
    try {
      return JSON.parse(textOf(message)).words || [];
    } catch (e) {
      throw new LangtitlesError('parse', 'Claude returned a word list that could not be read.');
    }
  }

  // A tutor's answer to a question about one line, with the conversation so far.
  async function askLine(settings, req, onText) {
    const { prompt } = SG;
    await capGuard(settings);
    try {
      const params = baseParams(settings, 6000);
      params.system = prompt.askSystemPrompt(settings.nativeLang);
      params.messages = prompt.askMessages(req);
      const stream = getClient(settings).beta.messages.stream(params);
      stream.on('text', (delta) => onText(delta));
      const message = await stream.finalMessage();
      recordUsage(message.model || settings.model, message.usage).catch(() => {});
      if (message.stop_reason === 'refusal') throw new LangtitlesError('refusal', 'Claude declined to answer that.');
      return textOf(message);
    } catch (err) {
      throw describeError(err);
    }
  }

  // A fresh fill-in-the-blank question for reviewing a grammar form.
  async function grammarCloze(settings, req) {
    const { prompt } = SG;
    await capGuard(settings);
    let message;
    try {
      const params = baseParams(settings, 6000);
      params.output_config.effort = 'low';
      params.system = prompt.clozeSystemPrompt(settings.nativeLang);
      params.messages = [{ role: 'user', content: prompt.clozeUserMessage(req) }];
      params.output_config.format = { type: 'json_schema', schema: prompt.CLOZE_SCHEMA };
      message = await getClient(settings).beta.messages.stream(params).finalMessage();
    } catch (err) {
      throw describeError(err);
    }
    recordUsage(message.model || settings.model, message.usage).catch(() => {});
    if (message.stop_reason !== 'end_turn') throw new LangtitlesError('parse', 'Could not make a question for this form.');
    return JSON.parse(textOf(message));
  }

  // Message Batches: half price, results within 24 hours (usually under one). No streaming or fallbacks there.
  async function batchCreate(settings, requests) {
    await capGuard(settings);
    try {
      return await getClient(settings).messages.batches.create({ requests });
    } catch (err) {
      throw describeError(err);
    }
  }

  async function batchRetrieve(settings, id) {
    try {
      return await getClient(settings).messages.batches.retrieve(id);
    } catch (err) {
      throw describeError(err);
    }
  }

  // Calls onResult(custom_id, analyses-or-null) for each finished request.
  async function batchResults(settings, id, counts, onResult) {
    try {
      for await (const r of await getClient(settings).messages.batches.results(id)) {
        if (r.result.type !== 'succeeded') {
          onResult(r.custom_id, null);
          continue;
        }
        const msg = r.result.message;
        recordUsage(msg.model || settings.model, msg.usage, true).catch(() => {});
        let out = null;
        try {
          if (msg.stop_reason === 'end_turn') out = readAnalysis(textOf(msg), counts[r.custom_id] || 0);
        } catch (e) {
          out = null;
        }
        onResult(r.custom_id, out);
      }
    } catch (err) {
      throw describeError(err);
    }
  }

  // Batch requests take the plain request shape: no beta header and no fallbacks.
  function batchAnalysisParams(settings, lines, context, langHint) {
    const params = analysisParams(settings, lines, context, langHint);
    const plain = {};
    for (const k of Object.keys(params)) if (k !== 'betas' && k !== 'fallbacks') plain[k] = params[k];
    return plain;
  }

  // Cheapest possible round trip, used by the "Test key" button.
  async function testKey(settings) {
    try {
      const params = baseParams(settings, 64);
      params.messages = [{ role: 'user', content: 'Reply with the single word: ok' }];
      const message = await getClient(settings).beta.messages.create(params);
      return { ok: true, model: message.model };
    } catch (err) {
      return { ok: false, error: describeError(err).message };
    }
  }

  SG.claude = { spentThisMonth, monthKey, askLine, grammarCloze, batchCreate, batchRetrieve, batchResults, batchAnalysisParams, analyzeLines, explainWord, explainForm, explainWordGuide, charEntry, episodeWords, testKey, describeError, LangtitlesError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
