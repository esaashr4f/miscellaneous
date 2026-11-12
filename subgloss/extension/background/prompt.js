// The instructions and output schema for subtitle analysis.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  // Bump when the prompt or schema changes so cached analyses from the old version are not reused.
  const PROMPT_VERSION = 4;
  // Grammar guides are cached by form, separately from line analyses.
  const GUIDE_VERSION = 1;

  const ROLES = [
    'subject', 'topic', 'object', 'indirect_object', 'predicate', 'complement', 'modifier',
    'adverbial', 'time', 'place', 'connector', 'address', 'interjection', 'quote', 'other',
  ];

  const ANALYSIS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['lang', 'lines'],
    properties: {
      lang: { type: 'string', description: 'BCP-47 code of the language the subtitle lines are in, e.g. "ja", "ko", "zh", "de".' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['i', 'tr', 'lit', 'pat', 'notes', 'w'],
          properties: {
            i: { type: 'integer', description: 'The line number given in the request.' },
            tr: { type: 'string', description: 'Natural translation of the line.' },
            lit: { type: 'string', description: 'Literal rendering that keeps the original word order and makes the grammar visible.' },
            pat: { type: 'string', description: 'The sentence skeleton: its phrases in order, each labelled with the job it does.' },
            notes: { type: 'array', items: { type: 'string' }, description: 'Zero to three points worth knowing about this line.' },
            w: {
              type: 'array',
              description: 'Every word of the line in order, skipping only punctuation and symbols.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['s', 'r', 'd', 'pos', 'm', 'p', 'c', 'role', 'n', 'g'],
                properties: {
                  s: { type: 'string', description: 'The word exactly as it appears in the line.' },
                  r: { type: 'string', description: 'Pronunciation aid, or an empty string when the spelling already shows it.' },
                  d: { type: 'string', description: 'Dictionary form.' },
                  pos: { type: 'string', description: 'Part of speech and form, e.g. "verb, causative-passive, negative past".' },
                  m: { type: 'string', description: 'What the word means in this sentence.' },
                  p: {
                    type: 'array',
                    description: 'The pieces the word is built from, in order. Their t values concatenate to s.',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['t', 'g'],
                      properties: {
                        t: { type: 'string', description: 'The piece of the word.' },
                        g: { type: 'string', description: 'What this piece means or does.' },
                      },
                    },
                  },
                  c: { type: 'integer', description: 'Phrase number, starting at 0. Consecutive words in the same phrase share it.' },
                  role: { type: 'string', enum: ROLES, description: 'The job this word\'s phrase does in the sentence.' },
                  n: { type: 'string', description: 'One or two sentences shown when the learner hovers the word.' },
                  g: {
                    type: 'array',
                    description: 'Grammar forms this word carries that are worth studying, most important first.',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['k', 'name'],
                      properties: {
                        k: { type: 'string', description: 'Stable identifier: language code, a dot, English snake_case name of the form.' },
                        name: { type: 'string', description: 'Short label for the form, including the form itself.' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  function systemPrompt(nativeLang) {
    return `You annotate subtitle lines for a language learner who is watching a show. The learner reads ${nativeLang}; write every gloss, translation and note in ${nativeLang}.

Your output is drawn directly over the video. Above each word the learner sees the pieces it is built from joined with plus signs, with what each piece contributes, so they can see how the sentence actually works instead of memorising a one-word translation. Hovering a word shows your longer note. A side column shows the translation, the sentence skeleton and your notes for the line. The learner is watching in real time, so everything has to be readable at a glance and correct: they will trust it and build their understanding of the language on it.

For each numbered line, return:

tr: a natural translation, the way a good subtitler would put it.
lit: a literal rendering that follows the original word order and names the grammar where ${nativeLang} has no equivalent, for example "I [topic] apple [object] ate".
pat: the skeleton of the sentence: its phrases in order, each labelled with its job, for example "[topic] 私は · [object] りんごを · [predicate] 食べた".
notes: zero to three short points a teacher would stop and mention: a grammar pattern in play, an idiom and the image behind it, a dropped subject and who it is, register or politeness, a cultural reference. Leave the list empty when the line is plain.
w: every word in order.

For each word:

s: the word copied exactly from the line, so it can be found in the text. Cover the whole line; skip only punctuation and symbols.
p: the pieces of the word, in order, whose t values concatenate to exactly s. For each piece, g says what it means or what it does. Describe grammatical pieces by their function in plain words ("topic marker", "makes it causative", "past", "polite ending", "plural") instead of forcing a ${nativeLang} word onto them. Keep each g to a few words, since it is drawn above the piece. A word that does not decompose usefully gets a single piece: the whole word, with a gloss that says what it is.
m: what the word means here. Choose the sense that fits this sentence and this scene, not the first sense in a dictionary.
r: a pronunciation aid: hiragana for Japanese words containing kanji, pinyin with tone marks for Chinese, Revised Romanization for Korean, a romanization for other non-Latin scripts. Use an empty string when the spelling already tells the learner how to say it.
d: the dictionary form.
pos: part of speech and the form it is in.
c and role: group the words into phrases. Words in the same phrase share a phrase number c, counted from 0 in order, and share the role that phrase plays in the sentence. A noun and the particle or case ending that marks it belong to one phrase.
n: one or two sentences for the hover note: why this form is used here, the nuance against a near-synonym, the register, a common confusion, the literal image behind the expression. Say something the gloss does not already say.
g: the grammar forms this word carries that a learner would want to study, most important first. These open a full guide to the form, so list forms, not vocabulary: conjugations and auxiliaries (causative-passive, ～ている, conditional ～ば), particles and endings with a grammatical job (topic は, connective -아서/어서, aspect 了), and, for a pattern spread over several words (把 sentences, ～ば～ほど, 是…的), the word that carries it. Each has:
  k: a stable identifier made of the language code, a dot and an English snake_case name for the form, written the same way every time the form appears, in any word and any line (ja.causative_passive, ja.te_iru, ja.particle_wa, ko.connective_aseo, zh.ba_construction, de.konjunktiv_2). One identifier per form, not per use: the guide for a form covers all of its uses.
  name: a short label in ${nativeLang} that includes the form itself, for example "causative-passive させられる".
Leave g empty for words with nothing to study beyond their meaning, such as most nouns and plain dictionary-form words. Skip forms so basic they need no explanation for this word, such as a plain past tense when a rarer form in the same word is the point.

How to split words:

Japanese: keep an inflected verb or adjective together with its auxiliaries as one word and show the stem and each auxiliary as pieces (食べさせられなかった = 食べ + させ + られ + なかっ + た). Particles are their own words. Split a kanji compound into its kanji when their meanings add up to the word's meaning.
Korean: a word is one space-delimited unit; its pieces are the stem and each attached particle or ending (학교에서 = 학교 + 에서, 먹었어요 = 먹 + 었 + 어요).
Chinese: segment into words; the pieces of a compound are its characters when their meanings build the word (火车 = 火 + 车). Aspect and structural particles such as 了, 过, 着, 的 are their own words.
Other languages: words are the written words. Show prefixes, stems and endings as pieces when that explains the form (German gemacht = ge + mach + t, Spanish hablábamos = habl + ába + mos), and split clitics and contractions.

Subtitle lines are fragments of spoken dialogue. A sentence may run across several lines, subjects are often dropped, and names, slang and song lyrics appear. The context lines before the numbered lines are there so you can resolve who is speaking about what; do not annotate them. If a line contains no language to explain (music symbols, sound descriptions) or is already in ${nativeLang}, return it with an empty w list and an empty translation.`;
  }

  function userMessage(lines, context, langHint) {
    let msg = '';
    if (langHint && langHint !== 'und') msg += `Language of the subtitles (detected automatically, may be wrong): ${langHint}\n\n`;
    if (context && context.length) {
      msg += 'Context (the lines just before these, not to be annotated):\n';
      for (const c of context) msg += `- ${c}\n`;
      msg += '\n';
    }
    msg += 'Lines to annotate:\n';
    lines.forEach((l, i) => {
      msg += `${i}: ${l}\n`;
    });
    return msg;
  }

  function deepSystemPrompt(nativeLang) {
    return `A language learner watching a show has paused on one word in a subtitle line and wants to understand it properly. They read ${nativeLang}; answer in ${nativeLang}.

They can already see the word's pieces, its meaning in this sentence and a one-line note, which are included below. Go a level deeper than that. Cover whichever of these are useful for this particular word: how the form is built step by step from the dictionary form, why the speaker chose this form or this word here, how it differs from the near-synonym a learner would confuse it with, its register, and other common uses the learner will run into. End with one new, short example sentence that uses the word, with its translation.

The answer is shown in a small popup over the video, so write about 120 words of plain text in short paragraphs, with no markdown, headings or bullet symbols.`;
  }

  function deepUserMessage(req) {
    const w = req.word || {};
    const pieces = (w.p || []).map((p) => `${p.t} = ${p.g}`).join(' + ');
    return `Line: ${req.sentence}
Translation: ${req.translation || ''}
Word: ${w.s}${w.r ? ` (${w.r})` : ''}
Dictionary form: ${w.d || ''}
Form: ${w.pos || ''}
Meaning here: ${w.m || ''}
Pieces: ${pieces}
Note already shown: ${w.n || ''}`;
  }

  function guideSystemPrompt(nativeLang) {
    return `A language learner watching a show has just met a grammar form. They want to understand it completely, once, so that from now on they recognise it, know exactly what it adds, and know when to use it and when not to. They read ${nativeLang}; write in ${nativeLang}, quoting the language being learned, with a reading in brackets after anything a learner might not be able to pronounce.

Write a complete guide to the form under these headings, each on its own line starting with "## ":

## What it is
One or two sentences: what the form does, in plain words, and the core idea that ties its uses together.

## How to make it
The construction rules for every kind of word it attaches to, including irregular words and any sound or spelling changes, with a short example of each. Mention the contracted or casual versions heard in real dialogue, and how it combines with other common endings (negative, past, polite).

## When to use it
Every common use, one per list item. For each: what it adds to the meaning, and an example sentence with its translation.

## When it seems to fit but doesn't
The situations where a learner would reach for this form but the language uses something else. For each: the situation, what to use instead, why, and a pair of example sentences contrasting the two. Include the forms it is most often confused with and the line between them.

## Nuance and register
How it sounds: politeness, formality, emotional colour (for example resentment, regret, gratitude), spoken versus written use, and how speakers soften, strengthen or avoid it.

## Common mistakes
The mistakes learners actually make with it, each with the correction.

## Where you met it
Two or three sentences on what the form is doing in the line where the learner met it.

Formatting: plain text only, apart from the "## " headings. Start a line with "- " for a list item. Put each example sentence on its own line, followed by " — " and its translation. Be thorough without padding; most guides need 500 to 900 words. Accuracy matters more than coverage: state only rules you are sure of, and say so when usage varies between speakers or regions.`;
  }

  function guideUserMessage(req) {
    const f = req.form || {};
    return `Form: ${f.name || f.k}
Identifier: ${f.k}
Language: ${req.lang || 'unknown'}
Line where the learner met it: ${req.sentence || ''}
Word that carries it there: ${req.word || ''}`;
  }

  SG.prompt = { PROMPT_VERSION, GUIDE_VERSION, guideSystemPrompt, guideUserMessage, ROLES, ANALYSIS_SCHEMA, systemPrompt, userMessage, deepSystemPrompt, deepUserMessage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
