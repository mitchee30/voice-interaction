'use strict';

// Cuts the model's streamed text into short pieces that go to TTS one by one,
// so the assistant starts talking after the first sentence instead of after
// the whole reply.
//
//  - hard breaks: config.sentenceDelimiters, plus "." followed by a space
//    ("$5.50" is not a break)
//  - once a piece is longer than config.softSplitLength, a comma also counts
//  - nothing is held back longer than config.maxPieceLength

const config = require('./config_data');

const SPEAKABLE = /[\p{L}\p{N}]/u;

class SentenceSplitter {
  constructor(opts = {}) {
    this.hard = new Set(opts.sentenceDelimiters || config.sentenceDelimiters);
    this.soft = new Set(opts.softDelimiters || config.softDelimiters);
    this.softLimit = opts.softSplitLength || config.softSplitLength;
    this.maxLimit = opts.maxPieceLength || config.maxPieceLength;
    this.buf = '';
  }

  /** Add streamed text; returns the pieces that are complete. */
  push(text) {
    if (!text) return [];
    this.buf += text;
    const out = [];
    for (;;) {
      const cut = this._findCut();
      if (cut <= 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (SPEAKABLE.test(piece)) out.push(piece); // skip pieces that are only punctuation
    }
    return out;
  }

  /** Whatever is left at the end of the reply. */
  flush() {
    const piece = this.buf.trim();
    this.buf = '';
    return SPEAKABLE.test(piece) ? [piece] : [];
  }

  _findCut() {
    const s = this.buf;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.hard.has(c) || c === '…') {
        // keep runs like "?!" or "……" together
        let j = i + 1;
        while (j < s.length && (this.hard.has(s[j]) || s[j] === '…') && s[j] !== '\n') j++;
        return j;
      }
      if (c === '.' && i + 1 < s.length && /\s/.test(s[i + 1])) return i + 1;
      if (i + 1 >= this.softLimit && this.soft.has(c)) return i + 1;
      if (i + 1 >= this.maxLimit) {
        const sp = s.lastIndexOf(' ', i);
        return sp > this.softLimit ? sp + 1 : i + 1;
      }
    }
    return -1;
  }
}

module.exports = { SentenceSplitter };
