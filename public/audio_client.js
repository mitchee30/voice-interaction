// Browser side of the full-duplex voice controller (ES module, no build step).
//
//   import { VoiceAssistantClient } from '/voice/audio_client.js';
//   const client = new VoiceAssistantClient({ getCart, onCart, onAssistantReplyChunk, ... });
//   button.onclick = () => client.start();   // must start from a tap/click
//
//   listen    mic → Silero VAD (in the browser) → one WAV per utterance → server
//   speak     reply audio streams in sentence by sentence and is played in order
//   barge-in  the customer starts talking over the assistant → playback PAUSES at
//             once; the server checks what was said: an echo, a "嗯 / ok" or
//             nothing → playback continues where it stopped; a real request →
//             the old reply is dropped
//   idle      after a while without speech (or when the page is hidden) the mic
//             is released; start() turns it back on
//
// Listening settings (silence timeout, thresholds, ...) come from the server's
// config_data.js when the connection opens.

const CDN = {
  ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
  vad: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/',
};

const AUDIO_DEFAULTS = {
  speechThreshold: 0.5,
  silenceThreshold: 0.35,
  silenceTimeoutMs: 500,
  minUtteranceMs: 250,
  maxUtteranceMs: 12000,
  preSpeechPadMs: 300,
  bargeInThreshold: 0.7,
  bargeInMinMs: 400,
  idleStopMs: 90000,
  smartBargeIn: true,
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-voice-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.dataset.voiceSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Float32 samples (-1..1) → 16-bit mono WAV bytes. */
export function encodeWav(samples, sampleRate = 16000) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const zh = /[一-鿿]/.test(text);
    u.lang = zh ? 'zh-CN' : 'en-US';
    const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith(zh ? 'zh' : 'en'));
    if (voice) u.voice = voice;
    u.rate = 1.05;
    // some browsers never fire onend (e.g. no voices installed), so don't wait forever
    const timer = setTimeout(resolve, 2000 + text.length * 250);
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

/**
 * options:
 *   url              WebSocket URL (default: this host, /voice/ws)
 *   lang             'zh' | 'en'
 *   getCart()        current cart as lines [{id, itemId, qty, options, addons, note}]
 *   onCart(op)       apply a cart change: {op:'add'|'update', line} | {op:'remove', lineId}
 *   voice            false = typing only
 *   assets           {ort, vad} base URLs of the VAD files (default: jsDelivr)
 *   audio            override listening settings (see AUDIO_DEFAULTS)
 *   debug            log [VAD] [PLAYBACK] [BARGE_IN] lines to the console
 * callbacks:
 *   onStateChange(state)   'off' | 'connecting' | 'idle' | 'hearing' | 'waiting' | 'thinking' | 'speaking' | 'paused'
 *   onReady({provider, voice, tts, resumed})
 *   onUserSpeech(text, turnId, {replaces})  replaces = earlier turns merged into this one
 *   onAssistantReplyStart(turnId)
 *   onAssistantReplyChunk(turnId, text)      streamed text
 *   onAssistantReplyEnd(turnId, fullText)
 *   onBargeIn(turnId)                        the customer interrupted this reply
 *   onBargeInIgnored(turnId)                 talking over it was only "嗯"/echo/noise; it continues
 *   onPaused(reason)                         'idle' | 'hidden' | 'tap' — mic released, start() resumes
 *   onTiming({turn, asrMs, llmFirstMs, firstAudioMs, totalMs, responseMs})
 *   onError({code, message})
 */
export class VoiceAssistantClient {
  constructor(options = {}) {
    this.options = options;
    this.url = options.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice/ws`;
    this.lang = options.lang || 'zh';
    this.assets = { ...CDN, ...(options.assets || {}) };
    this.audio = { ...AUDIO_DEFAULTS, ...(options.audio || {}) };

    this.state = 'off';
    this.ws = null;
    this.running = false;
    this.server = null; // the 'ready' message
    this.sessionId = null;
    this.retries = 0;
    this.micCtx = null; // AudioContext for the VAD
    this.playCtx = null; // AudioContext for replies (suspended while held)
    this.micStream = null;
    this.micVad = null;
    this.vadLoading = null;
    this.maxTimer = null;
    this.idleTimer = null;
    this.lastActivity = 0;
    this.pausedReason = null;

    this.turnCounter = 0;
    this.currentTurn = 0; // the turn whose reply we wait for / play
    this.cancelledTurns = new Set();
    this.held = null; // {turn, heard}: reply paused because the customer started talking
    this.tentativeTurn = 0; // utterance sent while held; the server decides if it interrupts
    this.cartVersion = 0;
    this.replyText = '';
    this.replyStarted = false;
    this.utteranceSentAt = 0;

    this.playback = this._newPlayback(0);
    this._onVisibility = () => this._visibilityChanged();
  }

  // ---------- helpers ----------

  _log(stage, turnId, msg) {
    if (this.options.debug) console.log(`[voice] [${stage}] [turn=${turnId}] ${msg}`);
  }

  _call(name, ...args) {
    const fn = this.options[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (e) {
      console.error(e);
    }
  }

  _setState(s) {
    if (s === this.state) return;
    if (this.pausedReason != null && s !== 'paused' && s !== 'off') return; // stay "paused" until resumed
    this.state = s;
    if (this.micVad) this.micVad.setOptions(this._vadOptions(s === 'speaking'));
    this._call('onStateChange', s);
  }

  _busy() {
    return this.state === 'thinking' || this.state === 'speaking';
  }

  _vadOptions(strict) {
    const a = this.audio;
    return {
      positiveSpeechThreshold: strict ? a.bargeInThreshold : a.speechThreshold,
      negativeSpeechThreshold: a.silenceThreshold,
      redemptionMs: a.silenceTimeoutMs,
      minSpeechMs: strict ? a.bargeInMinMs : a.minUtteranceMs,
      preSpeechPadMs: a.preSpeechPadMs,
    };
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  _touch() {
    this.lastActivity = Date.now();
  }

  _resumePlayback() {
    if (this.playCtx && this.playCtx.state === 'suspended') this.playCtx.resume();
    if ('speechSynthesis' in window && speechSynthesis.paused) speechSynthesis.resume();
  }

  // ---------- turns ----------

  /** A new turn whose reply replaces whatever was playing. */
  _beginTurn(turnId) {
    if (this.currentTurn && this._busy()) this._cancelTurnHard('new input');
    this.currentTurn = turnId;
    this.replyText = '';
    this.replyStarted = false;
    this._clearPlayback(turnId);
  }

  /** Stop the current reply right now (typing, stop button, smart barge-in off). */
  _cancelTurnHard(reason) {
    const turnId = this.held ? this.held.turn : this.currentTurn;
    if (!turnId || this.cancelledTurns.has(turnId)) return;
    const heard = this.held ? this.held.heard : this._heardSeq();
    this.cancelledTurns.add(turnId);
    this._send({ type: 'cancel', turn: turnId, heard });
    this.held = null;
    this.tentativeTurn = 0;
    this._clearPlayback(0);
    this._resumePlayback();
    this._log('BARGE_IN', turnId, `${reason}; heard up to sentence ${heard}`);
    this._call('onBargeIn', turnId);
  }

  /** Pause the reply while we find out whether the customer is really interrupting. */
  _hold() {
    if (this.held || !this.currentTurn) return;
    const heard = this._heardSeq();
    this.held = { turn: this.currentTurn, heard };
    if (this.playCtx && this.playCtx.state === 'running') this.playCtx.suspend();
    if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.pause();
    this._log('BARGE_IN', this.currentTurn, `customer started talking, reply paused at sentence ${heard}`);
  }

  _unhold() {
    if (!this.held) return;
    const turnId = this.held.turn;
    this.held = null;
    this.tentativeTurn = 0;
    this._resumePlayback();
    const p = this.playback;
    if (p.sources.size || p.speakingBrowser) this._setState('speaking');
    else if (!p.ended) this._setState('thinking');
    else this._checkReplyDone(true);
    this._touch();
    return turnId;
  }

  /** The server says the utterance said over the reply is a real request. */
  _confirmBargeIn() {
    const old = this.held ? this.held.turn : 0;
    if (old) this.cancelledTurns.add(old);
    this.held = null;
    this.currentTurn = this.tentativeTurn;
    this.tentativeTurn = 0;
    this.replyText = '';
    this.replyStarted = false;
    this._clearPlayback(this.currentTurn);
    this._resumePlayback();
    if (old) {
      this._log('BARGE_IN', old, 'confirmed: reply dropped');
      this._call('onBargeIn', old);
    }
  }

  // ---------- speak: ordered (streamed) playback ----------

  _newPlayback(turn) {
    return {
      turn,
      items: new Map(), // seq → {kind: 'audio'|'speech'|null, text, chunks: [], done}
      next: 0,
      playhead: 0,
      sources: new Set(),
      schedule: [], // {seq, start} in playCtx time, to know what was heard
      gen: 0,
      busy: false,
      ended: false,
      total: 0,
      speakingBrowser: false,
      speakingSeq: -1,
      firstAudioAt: 0,
    };
  }

  _clearPlayback(turn) {
    const p = this.playback;
    for (const s of p.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {}
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    const gen = p.gen + 1;
    this.playback = this._newPlayback(turn);
    this.playback.gen = gen;
  }

  _item(seq) {
    const p = this.playback;
    let it = p.items.get(seq);
    if (!it) {
      it = { kind: null, text: '', chunks: [], done: false };
      p.items.set(seq, it);
    }
    return it;
  }

  /** Index of the sentence the customer is hearing right now (-1 = none yet). */
  _heardSeq() {
    const p = this.playback;
    if (p.speakingBrowser) return p.speakingSeq;
    if (!this.playCtx) return -1;
    const now = this.playCtx.currentTime;
    let heard = -1;
    for (const e of p.schedule) if (e.start <= now + 0.01) heard = Math.max(heard, e.seq);
    return heard;
  }

  _scheduleBuffer(seq, buffer) {
    const p = this.playback;
    const ctx = this.playCtx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // small lead on the first chunk (and after an underrun) so pieces join seamlessly
    const at = Math.max(ctx.currentTime + 0.05, p.playhead);
    src.start(at);
    p.playhead = at + buffer.duration;
    p.sources.add(src);
    if (!p.schedule.some((e) => e.seq === seq)) p.schedule.push({ seq, start: at });
    src.onended = () => {
      p.sources.delete(src);
      this._checkReplyDone();
    };
    if (!p.firstAudioAt) {
      p.firstAudioAt = performance.now() + Math.max(0, at - ctx.currentTime) * 1000;
      if (this.utteranceSentAt) this.responseMs = Math.round(p.firstAudioAt - this.utteranceSentAt + this.audio.silenceTimeoutMs);
    }
    this._setState(this.held ? this.state : 'speaking');
    this._touch();
  }

  _pcmToBuffer(bytes) {
    const rate = (this.server && this.server.audioFormat && this.server.audioFormat.sampleRate) || 24000;
    const n = bytes.byteLength >> 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buf = this.playCtx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    return buf;
  }

  async _playbackLoop() {
    const p = this.playback;
    if (p.busy) return;
    p.busy = true;
    const gen = p.gen;
    const pcm = this.server && this.server.audioFormat && this.server.audioFormat.type === 'pcm16';
    try {
      for (;;) {
        const seq = p.next;
        const item = p.items.get(seq);
        if (!item || !item.kind) break;
        if (item.kind === 'speech') {
          // browser speech: wait until queued audio has played
          while (this.playCtx && p.playhead > this.playCtx.currentTime + 0.02) {
            await new Promise((r) => setTimeout(r, 50));
            if (gen !== this.playback.gen) return;
          }
          p.speakingBrowser = true;
          p.speakingSeq = seq;
          this._setState(this.held ? this.state : 'speaking');
          await speakWithBrowser(item.text);
          if (gen !== this.playback.gen) return;
          p.speakingBrowser = false;
        } else if (pcm) {
          while (item.chunks.length) this._scheduleBuffer(seq, this._pcmToBuffer(item.chunks.shift()));
          if (!item.done) break; // more audio for this sentence is on the way
        } else {
          if (!item.done) break;
          const all = new Uint8Array(item.chunks.reduce((n, c) => n + c.byteLength, 0));
          let o = 0;
          for (const c of item.chunks) {
            all.set(c, o);
            o += c.byteLength;
          }
          let buf = null;
          try {
            buf = await this.playCtx.decodeAudioData(all.buffer);
          } catch {}
          if (gen !== this.playback.gen) return;
          if (buf) this._scheduleBuffer(seq, buf);
          else await speakWithBrowser(item.text);
          if (gen !== this.playback.gen) return;
        }
        p.items.delete(seq);
        p.next = seq + 1;
        this._log('PLAYBACK', p.turn, `sentence ${seq} queued`);
      }
    } finally {
      if (gen === this.playback.gen) p.busy = false;
    }
    this._checkReplyDone();
  }

  _checkReplyDone(force) {
    const p = this.playback;
    if (p.turn !== this.currentTurn || this.held) return;
    if (!p.ended || p.next < p.total) return;
    if (p.sources.size || p.speakingBrowser || p.busy) return;
    if (this.state === 'hearing') return; // the customer is already talking again
    if (force || this.state === 'speaking' || this.state === 'thinking') this._setState('idle');
    this._touch();
  }

  // ---------- server messages ----------

  _onMessage(ev) {
    if (typeof ev.data !== 'string') {
      const view = new DataView(ev.data);
      const turnId = view.getUint32(0);
      const seq = view.getUint32(4);
      if (turnId !== this.playback.turn || this.cancelledTurns.has(turnId)) {
        this._log('PLAYBACK', turnId, 'drop cancelled chunk');
        return;
      }
      const it = this._item(seq);
      if (!it.kind) it.kind = 'audio';
      it.chunks.push(new Uint8Array(ev.data, 8));
      this._playbackLoop();
      return;
    }
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'cart') {
      // cart changes always apply, even if the reply was interrupted
      this.cartVersion = m.version;
      const { type, turn, version, ...op } = m;
      this._call('onCart', op);
      return;
    }
    if (m.type === 'ready') return this._onReady(m);
    if (m.type === 'error' && !m.turn) return this._call('onError', m);
    if (m.type === 'resume') {
      if (this.held && m.turn === this.held.turn && m.dropped === this.tentativeTurn) {
        this._log('BARGE_IN', m.turn, 'not an interruption, reply continues');
        this._unhold();
        this._call('onBargeInIgnored', m.turn);
      }
      return;
    }
    if (this.tentativeTurn && m.turn === this.tentativeTurn) this._confirmBargeIn();
    if (m.turn !== this.currentTurn || this.cancelledTurns.has(m.turn)) return;

    switch (m.type) {
      case 'state':
        if (this.held) break;
        if (m.state === 'idle') this._setState('idle');
        else if (m.state === 'waiting') this._setState('waiting');
        else if (m.state === 'thinking' && this.state !== 'hearing') this._setState('thinking');
        break;
      case 'transcript':
        if (m.text) this._call('onUserSpeech', m.text, m.turn, { replaces: m.replaces || [] });
        break;
      case 'reply_delta':
        if (!this.replyStarted) {
          this.replyStarted = true;
          this._call('onAssistantReplyStart', m.turn);
        }
        this.replyText += m.text;
        this._call('onAssistantReplyChunk', m.turn, m.text);
        this._touch();
        break;
      case 'sentence': {
        const it = this._item(m.seq);
        it.text = m.text;
        it.kind = m.audio ? 'audio' : 'speech';
        this._playbackLoop();
        break;
      }
      case 'sentence_audio_end':
        this._item(m.seq).done = true;
        this._playbackLoop();
        break;
      case 'sentence_failed': {
        const it = this._item(m.seq);
        it.kind = 'speech';
        it.chunks = [];
        this._playbackLoop();
        break;
      }
      case 'reply_end':
        this.playback.ended = true;
        this.playback.total = m.sentences;
        this._call('onAssistantReplyEnd', m.turn, m.text);
        this._checkReplyDone(true);
        break;
      case 'timing':
        this._call('onTiming', { ...m, responseMs: this.responseMs || null });
        break;
      case 'error':
        this._call('onError', m);
        this._setState('idle');
        break;
    }
  }

  _onReady(m) {
    this.server = m;
    this.sessionId = m.sessionId || this.sessionId;
    this.cartVersion = m.cartVersion || 0;
    this.retries = 0;
    this.audio = { ...AUDIO_DEFAULTS, ...(m.audio || {}), ...(this.options.audio || {}) };
    const voice = !!(m.asr && this.options.voice !== false);
    this._call('onReady', { provider: m.provider, voice, tts: !!m.tts, resumed: !!m.resumed });
    if (this.state === 'connecting') this._setState('idle');
    if (voice && this.pausedReason == null) this._listen();
  }

  // ---------- connection ----------

  _connect() {
    return new Promise((resolve) => {
      this._setState('connecting');
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            lang: this.lang,
            sessionId: this.sessionId,
            cart: this.options.getCart ? this.options.getCart() : [],
          }),
        );
        resolve(true);
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onerror = () => resolve(false);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!this.running) return;
        this.held = null;
        this.tentativeTurn = 0;
        this.currentTurn = 0;
        this._clearPlayback(0);
        this._resumePlayback();
        if (this.retries >= 5) {
          this._call('onError', { code: 'disconnected', message: 'connection lost' });
          this.stop();
          return;
        }
        const delay = 500 * 2 ** this.retries++;
        this._setState('connecting');
        setTimeout(() => this.running && !this.ws && this._connect(), delay);
      };
    });
  }

  // ---------- listen: microphone + VAD ----------

  async _getMic() {
    const live = this.micStream && this.micStream.getAudioTracks().some((t) => t.readyState === 'live');
    if (!live) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    return this.micStream;
  }

  _releaseMic() {
    if (this.micVad) {
      this.micVad.destroy();
      this.micVad = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
  }

  async _listen() {
    if (this.micVad) {
      if (!this.micVad.listening) this.micVad.start();
      return;
    }
    if (this.vadLoading) return this.vadLoading;
    this.vadLoading = (async () => {
      try {
        await loadScript(this.assets.ort + 'ort.wasm.min.js');
        await loadScript(this.assets.vad + 'bundle.min.js');
        window.ort.env.wasm.numThreads = 1;
        const vad = await window.vad.MicVAD.new({
          ...this._vadOptions(this.state === 'speaking'),
          model: 'v5',
          baseAssetPath: this.assets.vad,
          onnxWASMBasePath: this.assets.ort,
          audioContext: this.micCtx,
          submitUserSpeechOnPause: true,
          // keep one mic stream for the whole session (pause/resume must not re-open it)
          getStream: () => this._getMic(),
          pauseStream: async () => {},
          resumeStream: () => this._getMic(),
          onSpeechStart: () => {
            if (!this._busy() && !this.held) this._setState('hearing');
          },
          onSpeechRealStart: () => {
            this._touch();
            if (this._busy() && !this.held) {
              if (this.audio.smartBargeIn) this._hold();
              else this._cancelTurnHard('customer started talking');
            }
            this._log('VAD', this.currentTurn, 'user started speaking');
            this._setState('hearing');
            clearTimeout(this.maxTimer);
            this.maxTimer = setTimeout(async () => {
              // very long utterance: send what we have and keep listening
              this._log('VAD', this.currentTurn, 'max utterance reached');
              await vad.pause();
              if (this.running && this.micVad === vad) vad.start();
            }, this.audio.maxUtteranceMs);
          },
          onVADMisfire: () => {
            clearTimeout(this.maxTimer);
            this._log('VAD', this.currentTurn, 'discarded short utterance');
            if (this.held && !this.tentativeTurn) {
              this._unhold(); // it was nothing: carry on talking
            } else if (this.state === 'hearing') {
              this._setState(this.tentativeTurn ? 'thinking' : 'idle');
            }
          },
          onSpeechEnd: (samples) => {
            clearTimeout(this.maxTimer);
            if (this.running) this._sendUtterance(samples);
          },
        });
        if (!this.running || this.pausedReason != null) {
          vad.destroy();
          return;
        }
        this.micVad = vad;
        vad.start();
        this._touch();
        this._log('VAD', 0, 'microphone opened');
      } catch (err) {
        this.micVad = null;
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        this._call('onError', {
          code: denied ? 'mic_denied' : 'mic',
          message: denied ? 'microphone permission denied' : String((err && err.message) || err),
        });
      } finally {
        this.vadLoading = null;
      }
    })();
    return this.vadLoading;
  }

  _sendUtterance(samples) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const turnId = ++this.turnCounter;
    let interrupts = 0;
    let heard = -1;
    if (this.held) {
      interrupts = this.held.turn;
      heard = this.held.heard;
      this.tentativeTurn = turnId; // the server decides whether this interrupts
    } else {
      this._beginTurn(turnId);
    }
    const wav = encodeWav(samples, 16000);
    const out = new Uint8Array(12 + wav.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, turnId);
    v.setUint32(4, interrupts);
    v.setInt32(8, heard);
    out.set(wav, 12);
    this.ws.send(out);
    this.utteranceSentAt = performance.now();
    this.responseMs = null;
    this._touch();
    this._log('VAD', turnId, `endpoint detected; duration_ms=${Math.round((samples.length / 16000) * 1000)}${interrupts ? ` (over turn ${interrupts})` : ''}`);
    if (!this.held) this._setState('thinking');
  }

  // ---------- idle / background ----------

  _idleCheck() {
    if (!this.running || !this.micVad || this.pausedReason != null) return;
    const limit = this.audio.idleStopMs;
    if (limit > 0 && this.state === 'idle' && Date.now() - this.lastActivity > limit) this.pause('idle');
  }

  _visibilityChanged() {
    if (!this.running) return;
    if (document.hidden) {
      if (this.micVad || this.vadLoading) this.pause('hidden');
    } else if (this.pausedReason === 'hidden') {
      this.resume().catch(() => {});
    }
  }

  // ---------- public API ----------

  /** Call from a tap/click: unlocks audio, asks for the mic, connects. Also wakes a paused session. */
  async start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.micCtx) this.micCtx = new AC();
    if (!this.playCtx) this.playCtx = new AC();
    // Must happen inside the tap, or iOS keeps audio muted.
    if (this.micCtx.state === 'suspended') this.micCtx.resume();
    if (this.playCtx.state === 'suspended' && !this.held) this.playCtx.resume();
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
    if (this.running) {
      if (this.pausedReason != null) await this.resume();
      return;
    }
    this.running = true;
    this.pausedReason = null;
    this._touch();
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => this._idleCheck(), 2000);
    document.addEventListener('visibilitychange', this._onVisibility);
    await this._connect();
  }

  /** Release the microphone but keep the conversation (start()/resume() continues). */
  pause(reason = 'idle') {
    if (!this.running || this.pausedReason != null) return;
    this.pausedReason = reason;
    clearTimeout(this.maxTimer);
    this._releaseMic();
    this._log('VAD', this.currentTurn, `microphone released (${reason})`);
    this._setState('paused');
    this._call('onPaused', reason);
  }

  async resume() {
    if (!this.running || this.pausedReason == null) return;
    this.pausedReason = null;
    this._touch();
    if (this.micCtx && this.micCtx.state === 'suspended') await this.micCtx.resume().catch(() => {});
    if (this.micCtx && this.micCtx.state !== 'running') {
      // the browser wants a tap before audio can run again (iOS after the app was in the background)
      this.pause('tap');
      return;
    }
    this._setState(this.ws && this.ws.readyState === 1 ? 'idle' : 'connecting');
    if (this.server && this.server.asr && this.options.voice !== false) await this._listen();
  }

  stop() {
    this.running = false;
    this.pausedReason = null;
    clearTimeout(this.maxTimer);
    clearInterval(this.idleTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.held = null;
    this.tentativeTurn = 0;
    this._clearPlayback(0);
    this._resumePlayback();
    this._releaseMic();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.currentTurn = 0;
    this._setState('off');
  }

  /** Send a typed message instead of speaking. */
  sendText(text) {
    text = String(text || '').trim();
    if (!text || !this.ws || this.ws.readyState !== 1) return false;
    if (this.held) this._cancelTurnHard('typed a message');
    const turnId = ++this.turnCounter;
    this._beginTurn(turnId);
    this._send({ type: 'text', turn: turnId, text });
    this.utteranceSentAt = 0;
    this._touch();
    this._setState('thinking');
    return true;
  }

  /** Call after the customer changes the cart by hand. */
  syncCart() {
    this._send({ type: 'cart_sync', cart: this.options.getCart ? this.options.getCart() : [], version: this.cartVersion });
  }

  setLang(lang) {
    this.lang = lang;
    this._send({ type: 'lang', lang });
  }

  /** Stop the assistant talking. */
  interrupt() {
    if (!this._busy() && !this.held) return;
    this._cancelTurnHard('stopped by button');
    this._setState('idle');
  }

  get activeTurnId() {
    return this.currentTurn;
  }

  get voiceEnabled() {
    return !!this.micVad;
  }

  get provider() {
    return this.server ? this.server.provider : null;
  }
}
