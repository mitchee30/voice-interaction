// Browser side of the full-duplex voice controller (ES module, no build step).
//
//   import { VoiceAssistantClient } from '/voice/audio_client.js';
//   const client = new VoiceAssistantClient({ getCart, onCart, onAssistantReplyChunk, ... });
//   button.onclick = () => client.start();   // must start from a tap/click
//
//   listen   mic → Silero VAD (in the browser) → one WAV per utterance → server
//   speak    reply sentences arrive one by one → played strictly in order
//   barge-in the customer starts talking while a reply is playing or being
//            prepared → playback stops at once and the server drops that turn
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
 *   onStateChange(state)   'off' | 'connecting' | 'idle' | 'hearing' | 'thinking' | 'speaking'
 *   onReady({provider, voice, tts})
 *   onUserSpeech(text, turnId)
 *   onAssistantReplyStart(turnId)
 *   onAssistantReplyChunk(turnId, text)      streamed text
 *   onAssistantReplyEnd(turnId, fullText)
 *   onBargeIn(turnId)                       the customer interrupted this reply
 *   onError({code, message})
 */
export class VoiceAssistantClient {
  constructor(options = {}) {
    this.options = options;
    this.url = options.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice/ws`;
    this.lang = options.lang || 'zh';
    this.assets = { ...CDN, ...(options.assets || {}) };
    this.audio = { ...AUDIO_DEFAULTS };

    this.state = 'off';
    this.ws = null;
    this.running = false;
    this.server = null; // capabilities from the 'ready' message
    this.retries = 0;
    this.ctx = null; // AudioContext (created on the user's tap)
    this.micVad = null;
    this.vadLoading = null;
    this.maxTimer = null;

    this.turnCounter = 0;
    this.activeTurnId = 0; // the turn whose reply we wait for / play
    this.cancelledTurns = new Set();
    this.cartVersion = 0;
    this.replyText = '';
    this.replyStarted = false;

    // playback queue: seq → {kind: 'wait'|'audio'|'speech', text, data}
    this.playback = { turn: 0, next: 0, queue: new Map(), sources: new Set(), playhead: 0, gen: 0, busy: false, ended: false, total: 0, speaking: false };
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

  // ---------- turns ----------

  _newTurnId() {
    if (this._busy()) this._cancelActiveTurn('new input');
    this.turnCounter += 1;
    this.activeTurnId = this.turnCounter;
    this.replyText = '';
    this.replyStarted = false;
    this._clearPlaybackQueue(this.activeTurnId);
    return this.activeTurnId;
  }

  _cancelActiveTurn(reason) {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.cancelledTurns.add(turnId);
    this._send({ type: 'cancel', turn: turnId });
    const dropped = this.playback.queue.size + this.playback.sources.size;
    this._clearPlaybackQueue(0);
    this._log('BARGE_IN', turnId, `${reason}; dropped ${dropped} queued chunks`);
    this._call('onBargeIn', turnId);
  }

  _isTurnCancelled(turnId) {
    return turnId !== this.activeTurnId || this.cancelledTurns.has(turnId);
  }

  // ---------- speak: ordered playback ----------

  _clearPlaybackQueue(turnId) {
    const p = this.playback;
    p.gen += 1;
    for (const s of p.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {}
    }
    p.sources.clear();
    p.queue.clear();
    Object.assign(p, { turn: turnId, next: 0, playhead: 0, busy: false, ended: false, total: 0, speaking: false });
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  async _playbackLoop() {
    const p = this.playback;
    if (p.busy) return;
    p.busy = true;
    const gen = p.gen;
    try {
      for (;;) {
        const item = p.queue.get(p.next);
        if (!item || item.kind === 'wait') break;
        p.queue.delete(p.next);
        const seq = p.next++;
        this._setState('speaking');
        if (item.kind === 'audio') {
          let buf = null;
          try {
            buf = await this.ctx.decodeAudioData(item.data.slice(0));
          } catch {}
          if (gen !== p.gen) return;
          if (!buf) {
            await speakWithBrowser(item.text);
            continue;
          }
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.ctx.destination);
          const at = Math.max(this.ctx.currentTime + 0.03, p.playhead);
          src.start(at);
          p.playhead = at + buf.duration;
          p.sources.add(src);
          src.onended = () => {
            p.sources.delete(src);
            this._checkReplyDone();
          };
          this._log('PLAYBACK', p.turn, `sentence ${seq} queued (${buf.duration.toFixed(1)}s)`);
        } else {
          // browser speech: wait for queued audio first
          const wait = Math.max(0, p.playhead - this.ctx.currentTime);
          if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
          if (gen !== p.gen) return;
          p.speaking = true;
          await speakWithBrowser(item.text);
          p.speaking = false;
          if (gen !== p.gen) return;
        }
      }
    } finally {
      if (gen === p.gen) p.busy = false;
    }
    this._checkReplyDone();
  }

  _checkReplyDone() {
    const p = this.playback;
    if (p.turn !== this.activeTurnId || !p.ended || p.next < p.total) return;
    if (p.sources.size || p.speaking || p.busy) return;
    this._setState('idle');
  }

  // ---------- server messages ----------

  _onMessage(ev) {
    if (typeof ev.data !== 'string') {
      const view = new DataView(ev.data);
      const turnId = view.getUint32(0);
      const seq = view.getUint32(4);
      if (turnId !== this.playback.turn || this._isTurnCancelled(turnId)) {
        this._log('PLAYBACK', turnId, 'drop cancelled chunk');
        return;
      }
      const prev = this.playback.queue.get(seq);
      this.playback.queue.set(seq, { kind: 'audio', data: ev.data.slice(8), text: prev ? prev.text : '' });
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
    if (this._isTurnCancelled(m.turn)) return;

    switch (m.type) {
      case 'state':
        if (m.state === 'idle') this._setState('idle');
        break;
      case 'transcript':
        if (m.text) this._call('onUserSpeech', m.text, m.turn);
        break;
      case 'reply_delta':
        if (!this.replyStarted) {
          this.replyStarted = true;
          this._call('onAssistantReplyStart', m.turn);
        }
        this.replyText += m.text;
        this._call('onAssistantReplyChunk', m.turn, m.text);
        break;
      case 'sentence': {
        const q = this.playback.queue;
        if (q.has(m.seq)) q.get(m.seq).text = m.text;
        else q.set(m.seq, m.audio ? { kind: 'wait', text: m.text } : { kind: 'speech', text: m.text });
        this._playbackLoop();
        break;
      }
      case 'sentence_failed': {
        const it = this.playback.queue.get(m.seq);
        this.playback.queue.set(m.seq, { kind: 'speech', text: it ? it.text : '' });
        this._playbackLoop();
        break;
      }
      case 'reply_end':
        this.playback.ended = true;
        this.playback.total = m.sentences;
        this._call('onAssistantReplyEnd', m.turn, m.text);
        this._checkReplyDone();
        break;
      case 'error':
        this._call('onError', m);
        this._setState('idle');
        break;
    }
  }

  _onReady(m) {
    this.server = m;
    this.cartVersion = m.cartVersion || 0;
    this.retries = 0;
    this.audio = { ...AUDIO_DEFAULTS, ...(m.audio || {}), ...(this.options.audio || {}) };
    const voice = !!(m.asr && this.options.voice !== false);
    this._call('onReady', { provider: m.provider, voice, tts: !!m.tts });
    if (this.state === 'connecting') this._setState('idle');
    if (voice) this._listen();
  }

  // ---------- connection ----------

  _connect() {
    return new Promise((resolve) => {
      this._setState('connecting');
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', lang: this.lang, cart: this.options.getCart ? this.options.getCart() : [] }));
        resolve(true);
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onerror = () => resolve(false);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!this.running) return;
        this._clearPlaybackQueue(0);
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
        const getStream = () =>
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        const vad = await window.vad.MicVAD.new({
          ...this._vadOptions(false),
          model: 'v5',
          baseAssetPath: this.assets.vad,
          onnxWASMBasePath: this.assets.ort,
          audioContext: this.ctx,
          submitUserSpeechOnPause: true,
          getStream,
          resumeStream: getStream,
          onSpeechStart: () => {
            if (!this._busy()) this._setState('hearing');
          },
          onSpeechRealStart: () => {
            if (this._busy()) this._cancelActiveTurn('detected user speech'); // barge-in
            this._log('VAD', this.activeTurnId, 'user started speaking');
            this._setState('hearing');
            clearTimeout(this.maxTimer);
            this.maxTimer = setTimeout(async () => {
              // very long utterance: send what we have and keep listening
              this._log('VAD', this.activeTurnId, 'max utterance reached');
              await vad.pause();
              if (this.running) vad.start();
            }, this.audio.maxUtteranceMs);
          },
          onVADMisfire: () => {
            clearTimeout(this.maxTimer);
            this._log('VAD', this.activeTurnId, 'discarded short utterance');
            if (this.state === 'hearing') this._setState('idle');
          },
          onSpeechEnd: (samples) => {
            clearTimeout(this.maxTimer);
            if (this.running) this._sendUtterance(samples);
          },
        });
        if (!this.running) {
          vad.destroy();
          return;
        }
        this.micVad = vad;
        vad.start();
        this._log('VAD', 0, 'microphone opened');
      } catch (err) {
        this.micVad = null;
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        this._call('onError', { code: denied ? 'mic_denied' : 'mic', message: denied ? 'microphone permission denied' : String((err && err.message) || err) });
      } finally {
        this.vadLoading = null;
      }
    })();
    return this.vadLoading;
  }

  _sendUtterance(samples) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const turnId = this._newTurnId();
    const wav = encodeWav(samples, 16000);
    const out = new Uint8Array(4 + wav.length);
    new DataView(out.buffer).setUint32(0, turnId);
    out.set(wav, 4);
    this.ws.send(out);
    this._log('VAD', turnId, `endpoint detected; duration_ms=${Math.round((samples.length / 16000) * 1000)}`);
    this._setState('thinking');
  }

  // ---------- public API ----------

  /** Call from a tap/click: unlocks audio, asks for the mic, connects. */
  async start() {
    if (this.running) return;
    this.running = true;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
    await this._connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.maxTimer);
    this._clearPlaybackQueue(0);
    if (this.micVad) {
      this.micVad.destroy();
      this.micVad = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.activeTurnId = 0;
    this._setState('off');
  }

  /** Send a typed message instead of speaking. */
  sendText(text) {
    text = String(text || '').trim();
    if (!text || !this.ws || this.ws.readyState !== 1) return false;
    const turnId = this._newTurnId();
    this._send({ type: 'text', turn: turnId, text });
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
    if (!this._busy()) return;
    this._cancelActiveTurn('stopped by button');
    this._setState('idle');
  }

  get voiceEnabled() {
    return !!this.micVad;
  }

  get provider() {
    return this.server ? this.server.provider : null;
  }
}
