// Lightweight language guessing, used to choose which captured subtitle track to analyze
// and to avoid spending API calls on subtitles already in the viewer's own language.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const NAMES = {
    ja: 'Japanese', ko: 'Korean', zh: 'Chinese', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
    hi: 'Hindi', ar: 'Arabic', he: 'Hebrew', ru: 'Russian', uk: 'Ukrainian', el: 'Greek',
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
    nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish',
    tr: 'Turkish', cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', und: 'Unknown',
  };

  // Very common function words. Enough to tell major Latin-script languages apart
  // over a few dozen subtitle lines; anything unrecognized is reported as "und".
  const STOPWORDS = {
    en: 'the and you that was for are with his they this have from not but what all were when your can said there she which will would about them been',
    es: 'que los las por una con para como pero más este esta todo está muy también fue hay ahora algo estoy tengo qué sí bien aquí eso',
    fr: 'les des est pas que une pour dans qui sur avec vous nous mais elle tout plus fait être suis cette comme bien très ça oui quoi',
    de: 'der die und das nicht ist ich sie den mit ein eine auch auf für dem sich wir aber wie noch war nur was mir mich habe',
    it: 'che non per una sono con come più anche questo della sei cosa ma ho mi lo gli hai tutto bene perché questa era io',
    pt: 'que não uma com para como mais isso mas está você ele foi tem são muito também bem aqui só já quando meu ela eu',
    nl: 'het een van dat niet ik je en is op zijn voor met maar wat er ook als dit naar hij we ze heb ben nog',
    sv: 'och det att jag inte en har du är som för med på den till vi vad han var om men så kan här',
    pl: 'nie to się na jest że co jak do tak ale mnie za ty czy po ja mi go tym tylko jestem',
    tr: 'bir bu ne ve için ben çok var mı de da sen o evet ama değil daha gibi şey bana beni',
    id: 'yang dan di aku kau ini itu tidak dengan untuk kita akan ada dia apa saya kamu dari ke bisa',
    vi: 'là tôi của và có không anh em một cho đã này được người với sẽ gì ở đó ta',
  };
  const STOPSETS = {};
  for (const code of Object.keys(STOPWORDS)) STOPSETS[code] = new Set(STOPWORDS[code].split(' '));

  function countMatches(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  function detectLang(sample) {
    const text = String(sample || '').slice(0, 6000);
    const letters = countMatches(text, /\p{L}/gu);
    if (letters < 4) return 'und';
    const kana = countMatches(text, /[぀-ヿ]/g);
    const hangul = countMatches(text, /[가-힯ᄀ-ᇿ]/g);
    const han = countMatches(text, /[一-鿿㐀-䶿]/g);
    if (kana / letters > 0.08) return 'ja';
    if (hangul / letters > 0.2) return 'ko';
    if (han / letters > 0.3) return 'zh';
    const scripts = [
      ['th', /[฀-๿]/g], ['hi', /[ऀ-ॿ]/g], ['ar', /[؀-ۿ]/g],
      ['he', /[֐-׿]/g], ['el', /[Ͱ-Ͽ]/g],
    ];
    for (const [code, re] of scripts) if (countMatches(text, re) / letters > 0.3) return code;
    if (countMatches(text, /[Ѐ-ӿ]/g) / letters > 0.3) {
      return /[іїєґ]/i.test(text) ? 'uk' : 'ru';
    }
    const words = text.toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < 6) return 'und';
    let best = 'und';
    let bestScore = 0;
    for (const code of Object.keys(STOPSETS)) {
      let hits = 0;
      for (const w of words) if (STOPSETS[code].has(w)) hits++;
      const score = hits / words.length;
      if (score > bestScore) {
        bestScore = score;
        best = code;
      }
    }
    return bestScore >= 0.12 ? best : 'und';
  }

  function langName(code) {
    if (!code) return NAMES.und;
    return NAMES[String(code).toLowerCase().split('-')[0]] || code;
  }

  // "Japanese" / "ja" / "ja-JP" -> "ja"
  function langCode(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return 'und';
    for (const code of Object.keys(NAMES)) {
      if (v === code || v === NAMES[code].toLowerCase()) return code;
    }
    if (v === 'mandarin' || v === 'cantonese') return 'zh';
    return v.split(/[-_]/)[0];
  }

  SG.lang = { detectLang, langName, langCode, NAMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
