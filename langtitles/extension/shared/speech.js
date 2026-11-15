// Reads words and lines aloud with the voices installed in the browser / operating system.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const LOCALES = { ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', hi: 'hi-IN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', ru: 'ru-RU', en: 'en-US' };

  function synth() {
    return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  }

  function voiceFor(lang) {
    const s = synth();
    if (!s) return null;
    const voices = s.getVoices();
    const want = (LOCALES[lang] || lang).toLowerCase();
    const prefix = String(lang).toLowerCase();
    return voices.find((v) => v.lang.toLowerCase() === want)
      || voices.find((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix + '-'))
      || voices.find((v) => v.lang.toLowerCase() === prefix)
      || null;
  }

  // Resolves to true once speaking starts, false when there is no voice for the language.
  function speak(text, lang, opts) {
    const s = synth();
    if (!s || !text) return Promise.resolve(false);
    const go = () => {
      const voice = voiceFor(lang);
      if (!voice) return false;
      s.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = (opts && opts.rate) || 0.9;
      s.speak(u);
      return true;
    };
    // Some browsers load the voice list a moment after the page.
    if (s.getVoices().length) return Promise.resolve(go());
    return new Promise((resolve) => {
      const done = () => resolve(go());
      s.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 800);
    });
  }

  function missingVoiceHelp(lang) {
    const name = SG.lang ? SG.lang.langName(lang) : lang;
    return `No ${name} voice is installed. Add one in your system's language or speech settings (Windows: Settings → Time & language → Speech; macOS: System Settings → Accessibility → Spoken Content), then restart Firefox.`;
  }

  SG.speech = { speak, voiceFor, missingVoiceHelp };
})(typeof globalThis !== 'undefined' ? globalThis : this);
