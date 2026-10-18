'use strict';

// Small text rules that decide what a recognized utterance means for the
// conversation (not what the customer wants to order):
//
//   isBackchannel  "嗯" / "对" / "ok" said while the assistant is talking:
//                  the customer is listening, not interrupting
//   isEcho         the transcript is the assistant's own voice picked up by
//                  the microphone (speaker → mic)
//   looksIncomplete the customer stopped in the middle of a sentence
//                  ("我要一杯珍珠奶茶，还有"), so wait a moment for the rest
//   isHallucination speech-recognition models invent these on silence/noise

const BACKCHANNEL = new Set(
  [
    // Chinese
    '嗯', '嗯嗯', '嗯嗯嗯', '嗯哼', '哦', '哦哦', '噢', '喔', '啊', '呃', '额', '哈', '哈哈',
    '好', '好好', '好的', '好嘞', '好滴', '嗯好', '嗯对', '对', '对对', '对对对', '是', '是的', '是是',
    '行', '可以', '收到', '明白', '了解', '知道了', '谢谢', '嗯谢谢',
    // English (spaces removed)
    'ok', 'okay', 'kay', 'yeah', 'yep', 'yes', 'uhhuh', 'mhm', 'mm', 'mmhmm', 'hmm', 'um', 'uh', 'ah', 'oh',
    'right', 'sure', 'cool', 'gotit', 'alright', 'nice', 'great', 'thanks', 'thankyou', 'okthanks',
  ],
);

// Phrases speech recognition tends to invent from silence, music or noise.
const HALLUCINATIONS = [
  '谢谢观看', '感谢观看', '谢谢收看', '感谢收看', '谢谢大家', '请不吝点赞', '点赞订阅', '订阅转发', '打赏支持',
  '字幕由', '字幕志愿者', '中文字幕', '明镜与点点', '请订阅',
  'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe', 'likeandsubscribe', 'subtitlesby',
  'amaraorg', 'transcribedby', 'subtitledby',
];

const INCOMPLETE_ZH = /(还有|然后|和|跟|再|再来|再要|加|要|一杯|两杯|三杯|一个|那个|这个|就是|呃|嗯|额|还要|以及|或者|还是|的话|比如)$/;
const INCOMPLETE_EN = /\b(and|with|also|plus|um+|uh+|the|a|an|some|or|to|of|like|then|maybe|get|have|want)$/;

/** Lowercase, drop punctuation and spaces. */
function squash(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isBackchannel(text) {
  const s = squash(text);
  return s.length > 0 && BACKCHANNEL.has(s);
}

function isHallucination(text) {
  const s = squash(text);
  if (!s) return true; // only punctuation / symbols ("…", "♪")
  return HALLUCINATIONS.some((h) => s.includes(h));
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * True when `text` looks like the assistant's own words coming back through
 * the microphone. Short answers ("珍珠奶茶") never count as echo, because the
 * customer may be repeating an option the assistant just offered.
 */
function isEcho(text, spoken) {
  const t = squash(text);
  const s = squash(spoken);
  if (!t || !s) return false;
  const latin = /^[a-z0-9]+$/.test(t);
  if (t.length < (latin ? 12 : 5)) return false;
  if (s.includes(t)) return true;
  const grams = bigrams(t);
  if (!grams.length) return false;
  const hits = grams.filter((g) => s.includes(g)).length;
  return hits / grams.length >= 0.7;
}

/** The customer seems to have stopped mid-sentence. */
function looksIncomplete(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/[，,、:：]$/.test(raw) || /(\.\.\.|…)$/.test(raw)) return true;
  const core = raw.replace(/[\s。.!！?？]+$/u, '');
  if (/[。.!！?？]$/.test(raw) && !/(\.\.\.|…)$/.test(raw)) {
    // a sentence-final mark usually means done, unless it ends on a filler/connector
    return INCOMPLETE_ZH.test(core) && /(还有|然后|和|再|呃|嗯|额|以及|或者)$/.test(core);
  }
  return INCOMPLETE_ZH.test(core) || INCOMPLETE_EN.test(core.toLowerCase());
}

module.exports = { isBackchannel, isEcho, looksIncomplete, isHallucination, squash };
