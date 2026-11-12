// Settings shared by the background page, content script, popup and options page.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  // Prices are USD per million tokens and only feed the spend estimate shown in the popup.
  SG.MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', inPrice: 4, outPrice: 20, note: 'Accurate breakdowns. Default.' },
    { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', inPrice: 8, outPrice: 40, note: 'Most capable, slowest and most expensive.' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inPrice: 2, outPrice: 10, note: 'Faster, about half the cost of Opus.' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', inPrice: 0.1, outPrice: 0.5, note: 'Fastest and far cheaper; simpler explanations.' },
  ];

  SG.DEFAULTS = {
    enabled: true,
    disabledHosts: [],
    apiKey: '',
    baseURL: '', // advanced: an API-compatible proxy; empty means api.anthropic.com
    model: 'claude-opus-5-5',
    effort: 'low',
    nativeLang: 'English',
    learning: ['ja', 'ko', 'zh'],
    hostLang: {}, // hostname -> language code the user last picked there
    hostSelectors: {}, // hostname -> CSS selector of the caption element picked with "Pick on page"
    lookaheadMin: 10, // minutes of subtitles to prepare ahead of the playhead; 0 = whole video
    chunkSize: 8,
    concurrency: 3,
    showParts: true,
    showMeaning: true,
    showReading: true,
    showRoles: true,
    showTranslation: true,
    fontScale: 1,
    hoverPause: true,
    resumeOnLeave: true,
    autoDeep: true,
    hideNative: true,
    panelOpen: false,
  };

  // Everything the content script may see. The API key never leaves the background page.
  SG.publicSettings = function (s) {
    const out = Object.assign({}, s);
    out.hasKey = Boolean(s.apiKey);
    delete out.apiKey;
    delete out.baseURL;
    return out;
  };

  SG.loadSettings = async function () {
    const stored = await browser.storage.local.get('settings');
    return Object.assign({}, SG.DEFAULTS, stored.settings || {});
  };

  SG.saveSettings = async function (patch) {
    const next = Object.assign(await SG.loadSettings(), patch);
    await browser.storage.local.set({ settings: next });
    return next;
  };

  SG.hostEnabled = function (settings, hostname) {
    return Boolean(settings.enabled) && !(settings.disabledHosts || []).includes(hostname);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
