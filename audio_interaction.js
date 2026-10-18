'use strict';

// Full-duplex voice controller (server side). One instance per customer
// connection.
//
//   listen  (browser, public/audio_client.js)  mic → VAD → one WAV per utterance
//   think   (here)                             speech-to-text → order agent + cart tools
//   speak   (here → browser)                   sentence-by-sentence TTS → ordered playback
//
// Every utterance is a numbered turn. When the customer starts talking again,
// the browser stops playback and sends `cancel`; here the turn's requests are
// aborted and nothing more is sent for it (barge-in). If the interrupted turn
// had not said or done anything yet, its words are carried into the next turn,
// so "一杯珍珠奶茶…… 少冰" with a pause in the middle is still one request.

const config = require('./config_data');
const { SentenceSplitter } = require('./sentence_splitter');
const { normalizeMenu, buildLine, sanitizeCart, applyOp, lineLabel, cartTotal, money } = require('./menu_store');
const { buildSystemPrompt, buildTools, asrHint, runAgent } = require('./order_agent');

const LEVELS = { info: 0, warn: 1, error: 2, silent: 3 };

function makeLogger(level, sink) {
  const min = LEVELS[level] ?? 0;
  return (stage, turnId, msg, lvl = 'info') => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const line = `[voice] [${stage}] [turn=${turnId}] ${msg}`;
    if (sink) return sink(lvl, line);
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  };
}

class TurnTask {
  constructor(turnId) {
    this.turnId = turnId;
    this.controller = new AbortController(); // aborted on barge-in
    this.asrController = new AbortController(); // only aborted when the socket closes
    this.spoke = false; // sent at least one sentence
    this.acted = false; // changed the cart
    this.carried = false; // merged into the next turn
    this.done = false; // finished normally
    this.actions = [];
    this.textPromise = null;
  }
}

class VoiceAssistantController {
  /**
   * options: provider, getMenu, shopName, instructions, log, budget,
   *          onUserSpeech(text, turnId), onAssistantReplyStart(turnId),
   *          onAssistantReplyChunk(turnId, text), onAssistantReplyEnd(turnId, text),
   *          onCartChange(op, cart)
   */
  constructor(ws, options) {
    this.ws = ws;
    this.options = options;
    this.provider = options.provider;
    this._log = makeLogger(options.logLevel || config.logLevel, options.log);
    this.lang = options.defaultLang || config.defaultLang;

    this.cart = [];
    this.cartVersion = 0;
    this.opLog = []; // recent cart ops, replayed on top of client cart syncs
    this.history = [];

    this.activeTurnId = 0;
    this.activeTask = null;
    this.turnTimes = [];
    this.closed = false;
    this.menuCache = null;

    ws.on('message', (data, isBinary) => {
      this._onMessage(data, isBinary).catch((err) => this._log('WS', this.activeTurnId, `message failed: ${err.message}`, 'error'));
    });
    ws.on('close', () => this.stop());
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    const t = this.activeTask;
    if (t) {
      t.controller.abort();
      t.asrController.abort();
    }
    this._log('CTRL', this.activeTurnId, 'connection closed');
  }

  // ---------- sending ----------

  send(obj) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  _sendAudio(turnId, seq, audio) {
    if (this.closed || this.ws.readyState !== 1) return;
    const head = Buffer.alloc(8);
    head.writeUInt32BE(turnId, 0);
    head.writeUInt32BE(seq, 4);
    this.ws.send(Buffer.concat([head, audio]), { binary: true });
  }

  // ---------- turn bookkeeping ----------

  _isTurnCancelled(task) {
    return task.controller.signal.aborted || this.closed;
  }

  _cancelTurn(turnId, reason) {
    const t = this.activeTask;
    if (t && t.turnId === turnId && !t.controller.signal.aborted) {
      t.controller.abort();
      this._log('BARGE_IN', turnId, `cancelled (${reason})`, 'warn');
    }
  }

  _rateLimited() {
    const now = Date.now();
    this.turnTimes = this.turnTimes.filter((x) => now - x < 60000);
    if (this.turnTimes.length >= (this.options.maxTurnsPerMinute || config.maxTurnsPerMinute)) return true;
    if (this.options.budget && !this.options.budget.take()) return true;
    this.turnTimes.push(now);
    return false;
  }

  async _menu() {
    const raw = await this.options.getMenu();
    const key = JSON.stringify(raw);
    if (!this.menuCache || this.menuCache.key !== key) this.menuCache = { key, menu: normalizeMenu(raw) };
    return this.menuCache.menu;
  }

  // ---------- incoming messages ----------

  async _onMessage(data, isBinary) {
    if (isBinary) {
      const buf = Buffer.from(data);
      const maxBytes = 4 + 44 + config.sampleRate * 2 * (this.options.maxAudioSeconds || config.maxAudioSeconds);
      if (buf.length < 4 + 44) return this.send({ type: 'error', message: 'audio too short' });
      if (buf.length > maxBytes) return this.send({ type: 'error', message: 'audio too long' });
      const turnId = buf.readUInt32BE(0);
      this._log('VAD', turnId, `utterance received, bytes=${buf.length - 4}`);
      return this._startTurn(turnId, { audio: buf.subarray(4) });
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return this.send({ type: 'error', message: 'bad json' });
    }
    switch (msg.type) {
      case 'hello':
        if (msg.lang === 'en' || msg.lang === 'zh') this.lang = msg.lang;
        if (Array.isArray(msg.cart)) await this._syncCart(msg.cart, 0);
        return this.send({
          type: 'ready',
          provider: this.provider.name,
          asr: !!this.provider.capabilities.asr,
          tts: !!this.provider.capabilities.tts,
          cartVersion: this.cartVersion,
          audio: clientAudioConfig(),
        });
      case 'lang':
        if (msg.lang === 'en' || msg.lang === 'zh') this.lang = msg.lang;
        return;
      case 'cart_sync':
        return this._syncCart(msg.cart, Number(msg.version) || 0);
      case 'text': {
        const text = String(msg.text || '').trim().slice(0, this.options.maxTextChars || config.maxTextChars);
        if (text) this._startTurn(Number(msg.turn) >>> 0, { text });
        return;
      }
      case 'cancel':
        return this._cancelTurn(Number(msg.turn) >>> 0, 'customer started talking');
      case 'ping':
        return this.send({ type: 'pong' });
      default:
        return this.send({ type: 'error', message: `unknown message ${msg.type}` });
    }
  }

  // The client's cart wins, but cart changes it had not seen yet (newer
  // versions) are replayed on top so nothing gets lost.
  async _syncCart(lines, version) {
    const menu = await this._menu();
    const cart = sanitizeCart(lines, menu);
    for (const { version: v, op } of this.opLog) if (v > version) applyOp(cart, op);
    this.cart = cart;
  }

  // ---------- one turn: speech → text → reply → speech ----------

  _startTurn(turnId, input) {
    if (!turnId || turnId <= this.activeTurnId) return; // stale or replayed
    if (this._rateLimited()) {
      this._log('CTRL', turnId, 'rate limited', 'warn');
      return this.send({ type: 'error', turn: turnId, code: 'rate_limited', message: 'too many requests, please wait a moment' });
    }
    const prev = this.activeTask;
    let carry = null;
    if (prev) {
      prev.controller.abort();
      if (!prev.done && !prev.spoke && !prev.acted) {
        prev.carried = true;
        carry = prev.textPromise;
        this._log('CTRL', turnId, `continuing turn ${prev.turnId} (customer paused mid-sentence)`);
      }
    }
    const task = new TurnTask(turnId);
    // Speech recognition is not tied to barge-in: if this turn is carried into
    // the next one, the next one still needs these words.
    const ownText = input.text != null ? Promise.resolve(input.text) : this.speechToText(input.audio, task);
    task.textPromise = Promise.all([carry || '', ownText.catch(() => '')]).then(([a, b]) =>
      [a, b].filter((s) => s && s.trim()).join(' ').trim(),
    );
    this.activeTurnId = turnId;
    this.activeTask = task;
    this._processTurn(task, ownText).catch((err) => {
      if (this._isTurnCancelled(task)) return;
      this._log('TURN', turnId, `failed: ${err.message}`, 'error');
      this.send({ type: 'error', turn: turnId, code: 'provider', message: 'the AI service had a problem, please try again' });
      this.send({ type: 'state', turn: turnId, state: 'idle' });
    });
  }

  async speechToText(wav, task) {
    const menu = await this._menu();
    const started = Date.now();
    const text = (await this.provider.transcribe(wav, { prompt: asrHint(menu), signal: task.asrController.signal, lang: this.lang })) || '';
    this._log('ASR', task.turnId, `text='${text}' (${Date.now() - started}ms)`);
    return text;
  }

  textToSpeech(text, task) {
    return this.provider.synthesize(text, { signal: task.controller.signal });
  }

  async _processTurn(task, ownText) {
    const { turnId } = task;
    const cancelled = () => this._isTurnCancelled(task);
    this.send({ type: 'state', turn: turnId, state: 'thinking' });

    try {
      await ownText;
    } catch (err) {
      if (cancelled()) return;
      throw err;
    }
    const userText = await task.textPromise;
    if (cancelled()) {
      this._log('ASR', turnId, 'discarded result due to cancel');
      return;
    }
    this.send({ type: 'transcript', turn: turnId, text: userText });
    if (!userText) {
      task.done = true;
      this._log('ASR', turnId, 'empty text, skip');
      this.send({ type: 'state', turn: turnId, state: 'idle' });
      return;
    }
    if (this.options.onUserSpeech) this.options.onUserSpeech(userText, turnId);

    const menu = await this._menu();
    const hasTTS = !!this.provider.capabilities.tts;
    const splitter = new SentenceSplitter();
    let seq = 0;
    let ttsChain = Promise.resolve();
    let started = false;

    // Each finished sentence: tell the client, start TTS right away, but
    // deliver the audio strictly in order.
    const flushSentence = (sentence) => {
      if (cancelled()) return;
      const s = seq++;
      task.spoke = true;
      this.send({ type: 'sentence', turn: turnId, seq: s, text: sentence, audio: hasTTS });
      if (!hasTTS) return;
      const job = this.textToSpeech(sentence, task).catch((err) => {
        if (!cancelled()) this._log('TTS', turnId, `failed: ${err.message}`, 'warn');
        return null;
      });
      ttsChain = ttsChain.then(async () => {
        const r = await job;
        if (cancelled()) {
          this._log('TTS', turnId, 'cancelled, dropping audio');
          return;
        }
        if (r && r.audio && r.audio.length) this._sendAudio(turnId, s, r.audio);
        else this.send({ type: 'sentence_failed', turn: turnId, seq: s });
      });
    };

    const systemPrompt = () =>
      buildSystemPrompt({ menu, cart: this.cart, lang: this.lang, shopName: this.options.shopName, instructions: this.options.instructions });
    const messages = [{ role: 'system', content: systemPrompt() }, ...this.history, { role: 'user', content: userText }];

    let reply = '';
    const llmStarted = Date.now();
    try {
      reply = await runAgent({
        provider: this.provider,
        messages,
        tools: buildTools(menu),
        signal: task.controller.signal,
        context: () => ({ menu, cart: this.cart, lang: this.lang }),
        refreshSystem: systemPrompt,
        runTool: (call) => this._runTool(task, call, menu),
        onText: (text) => {
          if (cancelled()) return;
          if (!started) {
            started = true;
            this._log('LLM', turnId, `streaming started (${Date.now() - llmStarted}ms)`);
            if (this.options.onAssistantReplyStart) this.options.onAssistantReplyStart(turnId);
          }
          this.send({ type: 'reply_delta', turn: turnId, text });
          if (this.options.onAssistantReplyChunk) this.options.onAssistantReplyChunk(turnId, text);
          for (const s of splitter.push(text)) flushSentence(s);
        },
      });
    } catch (err) {
      if (!cancelled()) throw err; // an aborted request just means we were interrupted
      this._log('LLM', turnId, 'stream cancelled');
    }

    if (!cancelled()) for (const s of splitter.flush()) flushSentence(s);
    await ttsChain;
    reply = reply.trim();

    if (task.carried) return; // the next turn records these words
    const actionNote = task.actions.length ? ` [cart changes: ${task.actions.join('; ')}]` : '';
    if (cancelled()) {
      if (task.spoke || task.acted) this._remember(userText, `${reply}… [interrupted by the customer]${actionNote}`);
      this._log('TURN', turnId, 'cancelled; skip assistant_end');
      return;
    }
    task.done = true;
    this._remember(userText, reply + actionNote);
    this.send({ type: 'reply_end', turn: turnId, text: reply, sentences: seq });
    if (this.options.onAssistantReplyEnd) this.options.onAssistantReplyEnd(turnId, reply);
    this._log('TURN', turnId, `completed: '${reply}'`);
  }

  _remember(user, assistant) {
    this.history.push({ role: 'user', content: user }, { role: 'assistant', content: assistant || '…' });
    const max = config.maxHistoryMessages;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  // ---------- cart tools ----------

  _runTool(task, call, menu) {
    let args;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return { ok: false, tool: call.name, error: 'arguments were not valid JSON' };
    }
    let op;
    let label;
    let removed = null;
    if (call.name === 'add_to_cart') {
      const r = buildLine({ itemId: args.item_id, qty: args.qty, options: args.options, addons: args.addons, note: args.note }, menu, null);
      if (!r.ok) return this._toolFailed(task, call, r.error);
      op = { op: 'add', line: r.line };
    } else if (call.name === 'update_cart_line') {
      const base = this.cart.find((l) => l.id === args.line_id);
      if (!base) return this._toolFailed(task, call, `no cart line ${args.line_id}`);
      const r = buildLine({ qty: args.qty, options: { ...base.options, ...(args.options || {}) }, addons: args.addons, note: args.note }, menu, base);
      if (!r.ok) return this._toolFailed(task, call, r.error);
      op = { op: 'update', line: r.line };
    } else if (call.name === 'remove_cart_line') {
      const base = this.cart.find((l) => l.id === args.line_id);
      if (!base) return this._toolFailed(task, call, `no cart line ${args.line_id}`);
      op = { op: 'remove', lineId: base.id };
      removed = base;
      label = lineLabel(base, menu, this.lang);
    } else {
      return this._toolFailed(task, call, `unknown tool ${call.name}`);
    }

    applyOp(this.cart, op);
    this.cartVersion += 1;
    this.opLog.push({ version: this.cartVersion, op });
    if (this.opLog.length > 50) this.opLog.shift();
    task.acted = true;
    label = label || lineLabel(op.line, menu, this.lang);
    task.actions.push(`${op.op} ${label}`);
    this._log('TOOL', task.turnId, `${call.name}: ${label}`);
    this.send({ type: 'cart', turn: task.turnId, version: this.cartVersion, ...op });
    if (this.options.onCartChange) this.options.onCartChange(op, this.cart);
    return {
      ok: true,
      tool: call.name,
      line_id: op.line ? op.line.id : op.lineId,
      label,
      line: op.line || removed,
      cart_total: money(cartTotal(this.cart, menu)),
    };
  }

  _toolFailed(task, call, error) {
    this._log('TOOL', task.turnId, `${call.name} refused: ${error}`, 'warn');
    return { ok: false, tool: call.name, error };
  }
}

/** The listening settings the browser needs (from config_data.js). */
function clientAudioConfig() {
  return {
    sampleRate: config.sampleRate,
    speechThreshold: config.speechThreshold,
    silenceThreshold: config.silenceThreshold,
    silenceTimeoutMs: config.silenceTimeoutMs,
    minUtteranceMs: config.minUtteranceMs,
    maxUtteranceMs: config.maxUtteranceMs,
    preSpeechPadMs: config.preSpeechPadMs,
    bargeInThreshold: config.bargeInThreshold,
    bargeInMinMs: config.bargeInMinMs,
  };
}

module.exports = { VoiceAssistantController, TurnTask, makeLogger, clientAudioConfig };
