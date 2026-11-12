// Calls to the Claude API through the official SDK (vendor/anthropic-sdk.js).
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});
  const { Anthropic } = root.AnthropicSDK;

  // Models that can hand a declined request to another model inside the same call.
  const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']);

  class SubGlossError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  let client = null;
  let clientFor = '';

  function getClient(settings) {
    if (!settings.apiKey) throw new SubGlossError('no_key', 'Add your Anthropic API key in the SubGloss options.');
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
    if (err instanceof SubGlossError) return err;
    if (err instanceof Anthropic.AuthenticationError) {
      return new SubGlossError('auth', 'The Anthropic API key was rejected. Check it in the SubGloss options.');
    }
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
      return new SubGlossError('model', 'This API key cannot use the selected model. Pick another model in the SubGloss options.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new SubGlossError('rate_limit', 'Rate limited by the Anthropic API. SubGloss will keep retrying.');
    }
    if (err instanceof Anthropic.BadRequestError) {
      return new SubGlossError('bad_request', 'The Anthropic API rejected the request: ' + err.message);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new SubGlossError('network', 'Could not reach the Anthropic API. Check your connection.');
    }
    if (err instanceof Anthropic.APIError) {
      return new SubGlossError('api', `Anthropic API error ${err.status || ''}: ${err.message}`);
    }
    return new SubGlossError('unknown', String((err && err.message) || err));
  }

  function textOf(message) {
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  async function recordUsage(model, usage) {
    if (!usage) return;
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
  async function analyzeLines(settings, lines, context, langHint) {
    const { prompt } = SG;
    let message;
    try {
      const params = baseParams(settings, 32000);
      params.system = [
        { type: 'text', text: prompt.systemPrompt(settings.nativeLang), cache_control: { type: 'ephemeral' } },
      ];
      params.messages = [{ role: 'user', content: prompt.userMessage(lines, context, langHint) }];
      params.output_config.format = { type: 'json_schema', schema: prompt.ANALYSIS_SCHEMA };
      message = await getClient(settings).beta.messages.stream(params).finalMessage();
    } catch (err) {
      throw describeError(err);
    }
    recordUsage(message.model || settings.model, message.usage).catch(() => {});
    if (message.stop_reason === 'refusal') {
      throw new SubGlossError('refusal', 'Claude declined to annotate these lines.');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new SubGlossError('truncated', 'The annotation was cut off.');
    }
    let data;
    try {
      data = JSON.parse(textOf(message));
    } catch (e) {
      throw new SubGlossError('parse', 'Claude returned an annotation that could not be read.');
    }
    const out = new Array(lines.length).fill(null);
    for (const line of data.lines || []) {
      if (Number.isInteger(line.i) && line.i >= 0 && line.i < lines.length) {
        out[line.i] = { lang: data.lang, tr: line.tr, lit: line.lit, pat: line.pat, notes: line.notes || [], w: line.w || [] };
      }
    }
    return out;
  }

  // Streams a longer explanation of one word; onText receives each new piece of text.
  async function explainWord(settings, req, onText) {
    const { prompt } = SG;
    try {
      const params = baseParams(settings, 4000);
      params.system = prompt.deepSystemPrompt(settings.nativeLang);
      params.messages = [{ role: 'user', content: prompt.deepUserMessage(req) }];
      const stream = getClient(settings).beta.messages.stream(params);
      stream.on('text', (delta) => onText(delta));
      const message = await stream.finalMessage();
      recordUsage(message.model || settings.model, message.usage).catch(() => {});
      if (message.stop_reason === 'refusal') throw new SubGlossError('refusal', 'Claude declined to explain this word.');
      return textOf(message);
    } catch (err) {
      throw describeError(err);
    }
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

  SG.claude = { analyzeLines, explainWord, testKey, describeError, SubGlossError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
