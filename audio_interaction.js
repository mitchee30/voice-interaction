'use strict';

// Full-duplex voice controller (server side). One instance per customer
// connection.
//
//   listen  (browser, public/audio_client.js)  mic → VAD → one WAV per utterance
//   think   (here)                             speech-to-text → order agent + cart tools
//   speak   (here → browser)                   sentence-by-sentence streaming TTS → ordered playback
//
// Turn taking:
//  - Every utterance is a numbered turn.
//  - Smart barge-in: when the customer talks over the assistant, the browser
//    only PAUSES playback and sends the new utterance marked "interrupts turn N,
//    heard up to sentence k". After speech recognition we decide: an echo of the
//    assistant, a "嗯 / 对 / ok", or nothing → `resume` (playback continues where
//    it stopped); anything else → turn N is aborted and its history is cut to
//    what the customer actually heard.
//  - Pauses are not new questions: a turn interrupted before it said or did
//    anything is merged into the next one, and an utterance that ends like
//    "…，还有" waits a moment for the rest.

const config = require('./config_data');
const { SentenceSplitter } = require('./sentence_splitter');
const { normalizeMenu, buildLine, sanitizeCart, applyOp, lineLabel, cartTotal, money } = require('./menu_store');
const { buildSystemPrompt, buildTools, asrHint, runAgent } = require('./order_agent');
const rules = require('./turn_rules');
const { sleep, Limiter, BufferedStream } = require('./async_utils');
const crypto = require('crypto');

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
    this.controller = new AbortController(); // aborted when the turn is dropped
    this.asrController = new AbortController(); // only aborted when the socket closes
    this.spoke = false; // sent at least one sentence
    this.acted = false; // changed the cart
    this.carried = false; // merged into a later turn
    this.done = false; // finished normally
    this.interrupted = false;
    this.heard = null; // index of the last sentence the customer heard (null = all)
    this.sentences = [];
    this.reply = '';
    this.actions = [];
    this.historyEntry = null;
    this.userText = '';
    this.textPromise = null;
    this.interrupts = null; // the turn this one may interrupt (decided after ASR)
    this.prevHeard = -1;
    this.carriedTurns = []; // turn ids whose words were merged into this one
    this.transcriptSent = false;
    this.timing = { received: Date.now() };
  }
}

class VoiceAssistantController {
  /**
   * options: provider, getMenu, shopName, instructions, log, logLevel, budget, ipBudget,
   *          sessions, maxTurnsPerMinute, maxAudioSeconds, maxTextChars, defaultLang,
   *          onUserSpeech(text, turnId), onAssistantReplyStart(turnId),
   *          onAssistantReplyChunk(turnId, text), onAssistantReplyEnd(turnId, text),
   *          onCartChange(op, cart)
   * client: { ip }
   */
  constructor(ws, options, client = {}) {
    this.ws = ws;
    this.options = options;
    this.provider = options.provider;
    this.ip = client.ip || 'unknown';
    this._log = makeLogger(options.logLevel || config.logLevel, options.log);
    this.lang = options.defaultLang || config.defaultLang;
    this.sessionId = null;

    this.cart = [];
    this.cartVersion = 0;
    this.opLog = []; // recent cart ops, replayed on top of client cart syncs
    this.history = [];

    this.lastTurnId = 0; // highest turn id seen (older ones are ignored)
    this.activeTask = null; // the turn whose reply is being made / played
    this.pendingTask = null; // a possible interruption still being checked
    this.turnTimes = [];
    this.closed = false;
    this.menuCache = null;
    this.ttsLimiter = new Limiter(options.ttsConcurrency || config.ttsConcurrency);

    ws.on('message', (data, isBinary) => {
      this._onMessage(data, isBinary).catch((err) => this._log('WS', this.lastTurnId, `message failed: ${err.message}`, 'error'));
    });
    ws.on('close', () => this.stop());
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    for (const t of [this.activeTask, this.pendingTask]) {
      if (!t) continue;
      t.controller.abort();
      t.asrController.abort();
    }
    if (this.options.sessions && this.sessionId && this.history.length) {
      this.options.sessions.save(this.sessionId, { history: this.history, lang: this.lang });
    }
    this._log('CTRL', this.lastTurnId, 'connection closed');
  }

  // ---------- sending ----------

  send(obj) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  _sendAudio(task, seq, audio) {
    if (this.closed || this.ws.readyState !== 1) return;
    if (!task.timing.firstAudio) task.timing.firstAudio = Date.now();
    const head = Buffer.alloc(8);
    head.writeUInt32BE(task.turnId, 0);
    head.writeUInt32BE(seq, 4);
    this.ws.send(Buffer.concat([head, audio]), { binary: true });
  }

  _audioFormat() {
    const c = this.provider.capabilities;
    if (!c.tts) return null;
    return c.ttsStream ? { type: 'pcm16', sampleRate: c.ttsSampleRate || 24000 } : { type: 'file' };
  }

  // ---------- bookkeeping ----------

  _isTurnCancelled(task) {
    return task.controller.signal.aborted || this.closed;
  }

  _rateLimited() {
    const now = Date.now();
    this.turnTimes = this.turnTimes.filter((x) => now - x < 60000);
    if (this.turnTimes.length >= (this.options.maxTurnsPerMinute || config.maxTurnsPerMinute)) return 'connection';
    if (this.options.ipBudget && !this.options.ipBudget.take(this.ip)) return 'ip';
    if (this.options.budget && !this.options.budget.take()) return 'daily';
    this.turnTimes.push(now);
    return null;
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
      // [u32 turn][u32 interrupts turn or 0][i32 last heard sentence or -1][WAV]
      const buf = Buffer.from(data);
      const maxBytes = 12 + 44 + config.sampleRate * 2 * (this.options.maxAudioSeconds || config.maxAudioSeconds);
      if (buf.length < 12 + 44 || buf.toString('ascii', 12, 16) !== 'RIFF') return this.send({ type: 'error', message: 'bad audio' });
      if (buf.length > maxBytes) return this.send({ type: 'error', message: 'audio too long' });
      const turnId = buf.readUInt32BE(0);
      const interrupts = buf.readUInt32BE(4);
      const heard = buf.readInt32BE(8);
      this._log('VAD', turnId, `utterance received, bytes=${buf.length - 12}${interrupts ? `, while turn ${interrupts} was playing` : ''}`);
      return this._startTurn(turnId, { audio: buf.subarray(12) }, { interrupts, heard });
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return this.send({ type: 'error', message: 'bad json' });
    }
    switch (msg.type) {
      case 'hello': {
        if (msg.lang === 'en' || msg.lang === 'zh') this.lang = msg.lang;
        const resumed = this._resumeSession(msg.sessionId);
        if (Array.isArray(msg.cart)) await this._syncCart(msg.cart, 0);
        return this.send({
          type: 'ready',
          provider: this.provider.name,
          asr: !!this.provider.capabilities.asr,
          tts: !!this.provider.capabilities.tts,
          audioFormat: this._audioFormat(),
          sessionId: this.sessionId,
          resumed,
          cartVersion: this.cartVersion,
          audio: clientAudioConfig(),
        });
      }
      case 'lang':
        if (msg.lang === 'en' || msg.lang === 'zh') this.lang = msg.lang;
        return;
      case 'cart_sync':
        return this._syncCart(msg.cart, Number(msg.version) || 0);
      case 'text': {
        const text = String(msg.text || '').trim().slice(0, this.options.maxTextChars || config.maxTextChars);
        if (text) this._startTurn(Number(msg.turn) >>> 0, { text }, {});
        return;
      }
      case 'cancel': {
        const t = this.activeTask;
        const turnId = Number(msg.turn) >>> 0;
        if (t && t.turnId === turnId) this._interrupt(t, Number.isInteger(msg.heard) ? msg.heard : null, 'stopped by the customer');
        return;
      }
      case 'ping':
        return this.send({ type: 'pong' });
      default:
        return this.send({ type: 'error', message: `unknown message ${msg.type}` });
    }
  }

  _resumeSession(id) {
    const store = this.options.sessions;
    if (store && typeof id === 'string') {
      const saved = store.take(id);
      if (saved) {
        this.sessionId = id;
        this.history = saved.history || [];
        this._log('CTRL', 0, `session resumed with ${this.history.length / 2} earlier exchanges`);
        return true;
      }
    }
    this.sessionId = crypto.randomBytes(12).toString('base64url');
    return false;
  }

  // The client's cart wins, but cart changes it had not seen yet (newer
  // versions) are replayed on top so nothing gets lost.
  async _syncCart(lines, version) {
    const menu = await this._menu();
    const cart = sanitizeCart(lines, menu);
    for (const { version: v, op } of this.opLog) if (v > version) applyOp(cart, op);
    this.cart = cart;
  }

  // ---------- turns ----------

  _startTurn(turnId, input, meta) {
    if (!turnId || turnId <= this.lastTurnId) return; // stale or replayed
    this.lastTurnId = turnId;
    const limited = this._rateLimited();
    if (limited) {
      this._log('CTRL', turnId, `rate limited (${limited})`, 'warn');
      const prev = this.activeTask;
      if (prev && meta.interrupts && meta.interrupts === prev.turnId) {
        // said over the reply but we won't process it: let the reply continue
        this.send({ type: 'resume', turn: prev.turnId, dropped: turnId });
        return this.send({ type: 'error', code: 'rate_limited', message: 'too many requests, please wait a moment' });
      }
      return this.send({ type: 'error', turn: turnId, code: 'rate_limited', message: 'too many requests, please wait a moment' });
    }

    const task = new TurnTask(turnId);
    const carries = [];
    const carry = (t, why) => {
      t.carried = true;
      t.controller.abort();
      carries.push(t.textPromise);
      task.carriedTurns.push(t.turnId, ...t.carriedTurns);
      this._log('CTRL', turnId, `continuing turn ${t.turnId} (${why})`);
    };

    // A possible interruption that is still being checked: same speaker, keep going.
    if (this.pendingTask) {
      carry(this.pendingTask, 'still talking');
      this.pendingTask = null;
    }
    const prev = this.activeTask;
    let tentative = false;
    if (prev && !prev.done && !prev.spoke && !prev.acted) {
      // the assistant had not said or done anything yet: one longer sentence
      carry(prev, 'customer paused mid-sentence');
      carries.unshift(carries.pop());
    } else if (prev && meta.interrupts && meta.interrupts === prev.turnId) {
      if (config.smartBargeIn) {
        tentative = true; // decide after speech recognition
        task.interrupts = prev;
        task.prevHeard = Number.isInteger(meta.heard) ? meta.heard : -1;
      } else {
        this._interrupt(prev, meta.heard, 'customer started talking');
      }
    } else if (prev && !prev.done) {
      this._interrupt(prev, null, 'new message');
    }

    const ownText = input.text != null ? Promise.resolve(input.text) : this.speechToText(input.audio, task);
    task.textPromise = Promise.all([...carries.map((p) => p.catch(() => '')), ownText.catch(() => '')]).then((parts) =>
      parts.filter((s) => s && s.trim()).join(' ').trim(),
    );
    if (tentative) this.pendingTask = task;
    else this.activeTask = task;

    this._processTurn(task, ownText, input).catch((err) => {
      if (this._isTurnCancelled(task) || task.carried) return;
      this._log('TURN', turnId, `failed: ${err.message}`, 'error');
      if (this.pendingTask === task) {
        // could not check the possible interruption: let the old reply continue
        this.pendingTask = null;
        this.send({ type: 'resume', turn: task.interrupts.turnId, dropped: turnId });
        return;
      }
      this.send({ type: 'error', turn: turnId, code: 'provider', message: 'the AI service had a problem, please try again' });
      this.send({ type: 'state', turn: turnId, state: 'idle' });
    });
  }

  /** Stops a turn the customer talked over and cuts its history to what they heard. */
  _interrupt(task, heard, reason) {
    if (task.interrupted) return;
    task.interrupted = true;
    if (Number.isInteger(heard)) task.heard = heard;
    if (!task.controller.signal.aborted) task.controller.abort();
    // Write history now (not when the aborted turn unwinds), so the next turn
    // already knows what the customer did and did not hear.
    if (task.historyEntry) task.historyEntry.content = this._interruptedReply(task);
    else if (!task.carried && (task.spoke || task.acted) && task.userText) {
      task.historyEntry = this._remember(task.userText, this._interruptedReply(task));
    }
    const where = task.heard == null ? '' : task.heard < 0 ? ' before any audio played' : ` during sentence ${task.heard + 1}/${task.sentences.length}`;
    this._log('BARGE_IN', task.turnId, `interrupted${where} (${reason})`, 'warn');
  }

  _actionNote(task) {
    return task.actions.length ? ` [cart changes made: ${task.actions.join('; ')}]` : '';
  }

  _interruptedReply(task) {
    const heardText = task.heard == null ? task.reply.trim() : task.sentences.slice(0, task.heard + 1).join('');
    const said = heardText
      ? `${heardText}… [the customer interrupted here and did not hear the rest]`
      : '[the customer interrupted before hearing this reply]';
    return said + this._actionNote(task);
  }

  /** Why an utterance said over the assistant is NOT a real interruption, or null. */
  _falseBargeIn(text, prev, heard) {
    if (!text) return 'nothing recognized';
    if (rules.isBackchannel(text)) return 'backchannel';
    if (heard >= 0) {
      const spoken = prev.sentences.slice(Math.max(0, heard - 1), heard + 2).join('');
      if (rules.isEcho(text, spoken)) return 'echo of the assistant';
    }
    return null;
  }

  async speechToText(wav, task) {
    const menu = await this._menu();
    const started = Date.now();
    let text = (await this.provider.transcribe(wav, { prompt: asrHint(menu), signal: task.asrController.signal, lang: this.lang })) || '';
    text = text.trim();
    if (text && rules.isHallucination(text)) {
      this._log('ASR', task.turnId, `ignored '${text}' (typical recognition of noise)`);
      text = '';
    }
    this._log('ASR', task.turnId, `text='${text}' (${Date.now() - started}ms)`);
    return text;
  }

  async _processTurn(task, ownText, input) {
    const { turnId } = task;
    const cancelled = () => this._isTurnCancelled(task);
    if (!task.interrupts) this.send({ type: 'state', turn: turnId, state: 'thinking' });

    try {
      await ownText;
    } catch (err) {
      if (cancelled() || task.carried) return;
      throw err;
    }
    const userText = await task.textPromise;
    task.timing.asrDone = Date.now();
    if (task.carried || cancelled()) return;

    if (task.interrupts) {
      if (this.pendingTask !== task) return;
      this.pendingTask = null;
      const prev = task.interrupts;
      const why = this._falseBargeIn(userText, prev, task.prevHeard);
      if (why) {
        task.done = true;
        this._log('BARGE_IN', prev.turnId, `not an interruption (${why}${userText ? `: '${userText}'` : ''}), resuming playback`);
        this.send({ type: 'resume', turn: prev.turnId, dropped: turnId });
        return;
      }
      this._interrupt(prev, task.prevHeard, 'customer started talking');
      this.activeTask = task;
      this.send({ type: 'state', turn: turnId, state: 'thinking' });
    }

    task.transcriptSent = true;
    task.userText = userText;
    this.send({ type: 'transcript', turn: turnId, text: userText, replaces: task.carriedTurns });
    if (!userText) {
      task.done = true;
      this._log('ASR', turnId, 'empty text, skip');
      this.send({ type: 'state', turn: turnId, state: 'idle' });
      return;
    }

    // "我要一杯珍珠奶茶，还有…" — give them a moment to finish before answering.
    const grace = this.options.incompleteGraceMs ?? config.incompleteGraceMs;
    if (input.audio && grace > 0 && rules.looksIncomplete(userText)) {
      this._log('VAD', turnId, `'${userText}' sounds unfinished, waiting ${grace}ms for the rest`);
      this.send({ type: 'state', turn: turnId, state: 'waiting' });
      try {
        await sleep(grace, task.controller.signal);
      } catch {
        return; // they kept talking; the next turn carries these words
      }
      this.send({ type: 'state', turn: turnId, state: 'thinking' });
    }

    if (this.options.onUserSpeech) this.options.onUserSpeech(userText, turnId);

    const menu = await this._menu();
    const format = this._audioFormat();
    const splitter = new SentenceSplitter();
    let seq = 0;
    let ttsChain = Promise.resolve();
    let started = false;

    // Each finished sentence: tell the client, start TTS right away (a few in
    // parallel), but deliver the audio strictly in order.
    const flushSentence = (sentence) => {
      if (cancelled()) return;
      const s = seq++;
      task.sentences.push(sentence);
      task.spoke = true;
      this.send({ type: 'sentence', turn: turnId, seq: s, text: sentence, audio: !!format });
      if (!format) return;
      const stream = new BufferedStream();
      this.ttsLimiter
        .run(async () => {
          if (cancelled()) return stream.end();
          const signal = task.controller.signal;
          if (format.type === 'pcm16') {
            for await (const chunk of this.provider.synthesizeStream(sentence, { signal })) stream.push(chunk);
          } else {
            const r = await this.provider.synthesize(sentence, { signal });
            if (r && r.audio) stream.push(r.audio);
          }
          stream.end();
        })
        .catch((err) => {
          if (!cancelled()) this._log('TTS', turnId, `failed: ${err.message}`, 'warn');
          stream.fail(err);
        });
      ttsChain = ttsChain.then(() => this._deliverAudio(task, s, stream, format));
    };

    const systemPrompt = () =>
      buildSystemPrompt({ menu, cart: this.cart, lang: this.lang, shopName: this.options.shopName, instructions: this.options.instructions });
    const messages = [{ role: 'system', content: systemPrompt() }, ...this.history, { role: 'user', content: userText }];

    const llmStarted = Date.now();
    try {
      await runAgent({
        provider: this.provider,
        messages,
        tools: buildTools(menu),
        signal: task.controller.signal,
        context: () => ({ menu, cart: this.cart, lang: this.lang }),
        refreshSystem: systemPrompt,
        runTool: (call) => this._runTool(task, call, menu),
        onText: (text) => {
          if (cancelled()) return;
          task.reply += text;
          if (!started) {
            started = true;
            task.timing.llmFirst = Date.now();
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
    const reply = task.reply.trim();

    if (task.carried) return; // the next turn records these words
    if (cancelled()) {
      if ((task.spoke || task.acted) && !task.historyEntry) task.historyEntry = this._remember(userText, this._interruptedReply(task));
      this._log('TURN', turnId, 'cancelled; skip assistant_end');
      return;
    }
    task.done = true;
    task.historyEntry = this._remember(userText, reply + this._actionNote(task));
    this.send({ type: 'reply_end', turn: turnId, text: reply, sentences: seq });
    if (this.options.onAssistantReplyEnd) this.options.onAssistantReplyEnd(turnId, reply);
    this._reportTiming(task);
    this._log('TURN', turnId, `completed: '${reply}'`);
  }

  /** Sends one sentence's audio as it arrives; PCM is sent in ~100-200 ms pieces. */
  async _deliverAudio(task, seq, stream, format) {
    const cancelled = () => this._isTurnCancelled(task);
    const pcm = format.type === 'pcm16';
    const bytesPerMs = (format.sampleRate || 24000) * 2 / 1000;
    let sent = 0;
    let pending = null;
    const flush = (all) => {
      if (!pending || !pending.length) return;
      const threshold = all ? 2 : sent === 0 ? 100 * bytesPerMs : 200 * bytesPerMs;
      if (pending.length < threshold) return;
      const n = pending.length - (pending.length % 2); // whole 16-bit samples only
      if (!n) return;
      this._sendAudio(task, seq, pending.subarray(0, n));
      sent += n;
      pending = pending.subarray(n);
    };
    try {
      for await (const chunk of stream) {
        if (cancelled()) return;
        if (!pcm) {
          this._sendAudio(task, seq, chunk);
          sent += chunk.length;
          continue;
        }
        pending = pending && pending.length ? Buffer.concat([pending, chunk]) : chunk;
        flush(false);
      }
    } catch {
      // logged by the producer; play whatever arrived
    }
    if (cancelled()) return;
    if (pcm) flush(true);
    if (sent === 0) this.send({ type: 'sentence_failed', turn: task.turnId, seq });
    else this.send({ type: 'sentence_audio_end', turn: task.turnId, seq });
  }

  _reportTiming(task) {
    const t = task.timing;
    const since = (x) => (x ? x - t.received : null);
    const timing = { asrMs: since(t.asrDone), llmFirstMs: since(t.llmFirst), firstAudioMs: since(t.firstAudio), totalMs: Date.now() - t.received };
    const fmt = (v) => (v == null ? '-' : `${v}ms`);
    this._log('TIMING', task.turnId, `asr=${fmt(timing.asrMs)} llm_first=${fmt(timing.llmFirstMs)} first_audio=${fmt(timing.firstAudioMs)} total=${fmt(timing.totalMs)}`);
    this.send({ type: 'timing', turn: task.turnId, ...timing });
  }

  _remember(user, assistant) {
    const entry = { role: 'assistant', content: assistant || '…' };
    this.history.push({ role: 'user', content: user }, entry);
    const max = this.options.maxHistoryMessages || config.maxHistoryMessages;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
    return entry;
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
    idleStopMs: config.idleStopMs,
    smartBargeIn: config.smartBargeIn,
  };
}

module.exports = { VoiceAssistantController, TurnTask, makeLogger, clientAudioConfig };
