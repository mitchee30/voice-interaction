'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startVoice, connect, fakeWav, sleep } = require('./helpers');
const { createMockProvider, assetHandler } = require('..');

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });
}

/** Fake AI: ASR maps the WAV's first sample to a transcript, chat is scripted. */
function fakeProvider({ transcripts = {}, asrDelay = 0, chat, ttsDelay = () => 5, seen, stream = false, onTts } = {}) {
  return {
    name: 'fake',
    capabilities: { asr: true, tts: true, ttsStream: stream, ttsSampleRate: 24000 },
    async transcribe(wav) {
      await sleep(typeof asrDelay === 'function' ? asrDelay(wav.readInt16LE(44)) : asrDelay);
      return transcripts[wav.readInt16LE(44)] ?? '';
    },
    async *chat({ messages, signal }) {
      if (seen) seen.push(messages);
      yield* chat(messages, signal);
    },
    async synthesize(text, { signal }) {
      if (onTts) onTts(text, +1);
      try {
        await abortableSleep(ttsDelay(text), signal);
      } finally {
        if (onTts) onTts(text, -1);
      }
      return { audio: Buffer.from(`AUDIO:${text}`) };
    },
    async *synthesizeStream(text, { signal }) {
      // 3 pieces of 2401 bytes: odd sizes split 16-bit samples on purpose
      for (let i = 0; i < 3; i++) {
        await abortableSleep(ttsDelay(text), signal);
        yield Buffer.alloc(2401, i + 1);
      }
    },
  };
}

async function* say(text) {
  for (const ch of text.match(/.{1,4}/gsu)) yield { type: 'text', text: ch };
}

test('typed order with the demo provider updates the cart and replies', async (t) => {
  const srv = await startVoice({ provider: createMockProvider() });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello', lang: 'zh', cart: [] });
  const ready = await c.waitFor((m) => m.type === 'ready');
  assert.equal(ready.provider, 'mock');
  assert.equal(ready.asr, false);
  assert.equal(ready.audio.silenceTimeoutMs, 500);

  c.send({ type: 'text', turn: 1, text: '两杯珍珠奶茶少冰，一杯杨枝甘露' });
  const end = await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  const carts = c.of('cart', 1);
  assert.equal(carts.length, 2);
  assert.equal(carts[0].line.qty, 2);
  assert.equal(carts[0].line.options.ice, 'less');
  assert.match(end.text, /两杯珍珠奶茶，少冰/);
  assert.equal(c.of('sentence', 1).length, end.sentences);
  assert.ok(c.of('sentence', 1).every((s) => s.audio === false), 'browser speaks in demo mode');
  c.close();
});

test('TTS runs in parallel but audio arrives in sentence order', async (t) => {
  const provider = fakeProvider({
    chat: () => say('第一句话。第二句。第三句！'),
    ttsDelay: (text) => (text.startsWith('第一') ? 150 : 5),
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  await c.waitFor((m) => m.type === 'ready');
  c.send({ type: 'text', turn: 1, text: 'hi' });
  await c.waitFor((m) => m.type === 'reply_end');
  const audio = c.of('audio', 1);
  assert.deepEqual(audio.map((a) => a.seq), [0, 1, 2]);
  assert.equal(String(audio[0].bytes), 'AUDIO:第一句话。');
  assert.deepEqual(c.of('sentence', 1).map((s) => s.text), ['第一句话。', '第二句。', '第三句！']);
  c.close();
});

test('barge-in: cancel stops the turn and the next turn knows it was interrupted', async (t) => {
  let aborted = false;
  const seen = [];
  const provider = fakeProvider({
    seen,
    chat: async function* (messages, signal) {
      const last = messages[messages.length - 1].content;
      if (last === 'long story') {
        yield { type: 'text', text: '好的，我先说第一句。' };
        try {
          await abortableSleep(3000, signal);
        } catch (e) {
          aborted = true;
          throw e;
        }
        yield { type: 'text', text: '这句不应该出现。' };
      } else {
        yield* say('收到。');
      }
    },
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  await c.waitFor((m) => m.type === 'ready');

  c.send({ type: 'text', turn: 1, text: 'long story' });
  await c.waitFor((m) => m.type === 'audio' && m.turn === 1);
  c.send({ type: 'cancel', turn: 1 });
  await sleep(100);
  assert.ok(aborted, 'model request was aborted');
  assert.equal(c.of('sentence', 1).length, 1);
  assert.equal(c.of('reply_end', 1).length, 0);

  c.send({ type: 'text', turn: 2, text: 'next' });
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  const history = seen[seen.length - 1].slice(1).map((m) => m.content).join('\n');
  assert.match(history, /customer interrupted/);
  // nothing from turn 1 arrived after the cancel
  assert.equal(c.of('sentence', 1).length, 1);
  c.close();
});

test('a pause mid-sentence: the interrupted turn is merged into the next one', async (t) => {
  const provider = fakeProvider({
    transcripts: { 1: '一杯珍珠奶茶', 2: '少冰' },
    asrDelay: 150,
    chat: () => say('好的。'),
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  await c.waitFor((m) => m.type === 'ready');

  c.sendAudio(1, fakeWav(300, 1));
  await sleep(40);
  c.send({ type: 'cancel', turn: 1 }); // customer started talking again
  c.sendAudio(2, fakeWav(300, 2));
  const tr = await c.waitFor((m) => m.type === 'transcript' && m.turn === 2);
  assert.equal(tr.text, '一杯珍珠奶茶 少冰');
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  assert.equal(c.of('transcript', 1).length, 0);
  c.close();
});

test('a finished turn is not merged into the next one, and stale turns are ignored', async (t) => {
  const provider = fakeProvider({ transcripts: { 1: '一杯奶茶', 2: '谢谢' }, chat: () => say('好的。') });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  await c.waitFor((m) => m.type === 'ready');
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  c.sendAudio(2, fakeWav(300, 2));
  const tr = await c.waitFor((m) => m.type === 'transcript' && m.turn === 2);
  assert.equal(tr.text, '谢谢');
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  const before = c.msgs.length;
  c.send({ type: 'text', turn: 1, text: 'old' });
  await sleep(100);
  assert.equal(c.msgs.length, before, 'replayed old turn is ignored');
  c.close();
});

test('cart sync from the browser keeps server changes it had not seen yet', async (t) => {
  const srv = await startVoice({ provider: createMockProvider() });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello', cart: [] });
  await c.waitFor((m) => m.type === 'ready');
  c.send({ type: 'text', turn: 1, text: '一杯珍珠奶茶' });
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  // browser edits the cart by hand without having seen version 1
  c.send({ type: 'cart_sync', version: 0, cart: [{ id: 'x1', itemId: 'jasmine-green-tea', qty: 1 }] });
  c.send({ type: 'text', turn: 2, text: '一共多少钱' });
  const end = await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  assert.match(end.text, /\$10\.00/); // 5.50 + 4.50
  c.close();
});

test('limits: per-connection rate limit and daily budget', async (t) => {
  const srv = await startVoice({ provider: createMockProvider(), maxTurnsPerMinute: 2 });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  await c.waitFor((m) => m.type === 'ready');
  for (let i = 1; i <= 3; i++) c.send({ type: 'text', turn: i, text: '一共多少钱' });
  const err = await c.waitFor((m) => m.type === 'error' && m.turn === 3);
  assert.equal(err.code, 'rate_limited');
  c.close();

  const srv2 = await startVoice({ provider: createMockProvider(), maxTurnsPerDay: 1 });
  t.after(() => srv2.close());
  const a = await connect(srv2.url);
  const b = await connect(srv2.url);
  a.send({ type: 'text', turn: 1, text: '一共多少钱' });
  await a.waitFor((m) => m.type === 'reply_end');
  b.send({ type: 'text', turn: 1, text: '一共多少钱' });
  assert.equal((await b.waitFor((m) => m.type === 'error')).code, 'rate_limited');
  a.close();
  b.close();
});

test('provider failure is reported to the browser', async (t) => {
  const provider = fakeProvider({
    chat: async function* () {
      throw new Error('HTTP 401 bad key');
    },
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'text', turn: 1, text: 'hi' });
  const err = await c.waitFor((m) => m.type === 'error');
  assert.equal(err.code, 'provider');
  await c.waitFor((m) => m.type === 'state' && m.state === 'idle');
  c.close();
});

test('only pages from the same host may connect', async (t) => {
  const srv = await startVoice({ provider: createMockProvider() });
  t.after(() => srv.close());
  await assert.rejects(connect(srv.url, { Origin: 'https://evil.example' }), /403/);
  const ok = await connect(srv.url, { Origin: `http://127.0.0.1:${srv.port}` });
  ok.close();
});

test('asset handler serves only the listed browser files', async (t) => {
  const handler = assetHandler('/voice');
  const server = http.createServer((req, res) => handler(req, res, () => (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const js = await fetch(`${base}/voice/audio_client.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /class VoiceAssistantClient/);
  const wasm = await fetch(`${base}/voice/vendor/ort/ort-wasm-simd-threaded.wasm`, { method: 'HEAD' });
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  for (const p of ['/voice/../package.json', '/voice/%2e%2e/index.js', '/voice/index.js', '/package.json']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});


// ---------- smart barge-in, endpointing, sessions, limits ----------

async function ready(srv) {
  const c = await connect(srv.url);
  c.send({ type: 'hello', lang: 'zh', cart: [] });
  await c.waitFor((m) => m.type === 'ready');
  return c;
}

// A reply long enough to still be "playing" while the customer talks over it.
function slowReply(text, gapMs) {
  return async function* (messages, signal) {
    for (const piece of text.match(/[^。！？]+[。！？]/gu)) {
      yield { type: 'text', text: piece };
      await abortableSleep(gapMs, signal);
    }
  };
}

test('smart barge-in: "嗯" over the assistant does not stop it', async (t) => {
  const provider = fakeProvider({
    transcripts: { 1: '一杯珍珠奶茶', 2: '嗯嗯' },
    chat: slowReply('好的。我帮你加一杯珍珠奶茶。还要别的吗？', 80),
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'sentence' && m.turn === 1);
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 0 });
  const resume = await c.waitFor((m) => m.type === 'resume');
  assert.deepEqual([resume.turn, resume.dropped], [1, 2]);
  const end = await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  assert.equal(end.text, '好的。我帮你加一杯珍珠奶茶。还要别的吗？');
  assert.equal(c.msgs.filter((m) => m.turn === 2).length, 0, 'nothing is sent for the dropped turn');
  c.close();
});

test("smart barge-in: the assistant's own voice (echo) does not stop it", async (t) => {
  const provider = fakeProvider({
    transcripts: { 1: '一杯珍珠奶茶', 2: '我帮你加一杯珍珠奶茶' },
    chat: slowReply('好的。我帮你加一杯珍珠奶茶。还要别的吗？', 80),
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'sentence' && m.seq === 1);
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 1 });
  await c.waitFor((m) => m.type === 'resume');
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  c.close();
});

test('smart barge-in: a real request stops the old reply and history keeps only what was heard', async (t) => {
  const seen = [];
  const provider = fakeProvider({
    seen,
    transcripts: { 1: '一杯珍珠奶茶', 2: '换成燕麦奶' },
    chat: async function* (messages, signal) {
      const last = messages[messages.length - 1].content;
      if (last === '一杯珍珠奶茶') yield* slowReply('好的。第二句话。第三句话不该被听到。', 120)(messages, signal);
      else yield* say('好的，换成燕麦奶。');
    },
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'sentence' && m.seq === 1);
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 1 });
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  assert.equal(c.of('resume').length, 0);
  assert.equal(c.of('reply_end', 1).length, 0, 'old reply was stopped');
  const history = seen[seen.length - 1].slice(1).map((m) => m.content).join('\n');
  assert.match(history, /好的。第二句话。… \[the customer interrupted here/, history);
  assert.doesNotMatch(history, /第三句话/);
  c.close();
});

test('smart barge-in: interrupting a reply that already finished generating patches the history', async (t) => {
  const seen = [];
  const provider = fakeProvider({
    seen,
    transcripts: { 1: '一杯珍珠奶茶', 2: '不对，要芋泥的' },
    chat: async function* (messages) {
      const last = messages[messages.length - 1].content;
      yield* say(last === '一杯珍珠奶茶' ? '好的。一共5块5。还要别的吗？' : '好的。');
    },
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  // still playing sentence 0 in the browser when the customer talks
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 0 });
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  const history = seen[seen.length - 1].slice(1).map((m) => m.content).join('\n');
  assert.match(history, /好的。… \[the customer interrupted here/);
  assert.doesNotMatch(history, /5块5/);
  c.close();
});

test('smart barge-in: "嗯…" then a real request while still checking are merged into one turn', async (t) => {
  const provider = fakeProvider({
    transcripts: { 1: '一杯珍珠奶茶', 2: '嗯', 3: '换成燕麦奶' },
    asrDelay: (tag) => (tag === 2 ? 150 : 10),
    chat: async function* (messages, signal) {
      const last = messages[messages.length - 1].content;
      if (last === '一杯珍珠奶茶') yield* slowReply('好的。第二句。第三句。第四句。', 150)(messages, signal);
      else yield* say('好的。');
    },
  });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'sentence' && m.turn === 1);
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 0 });
  await sleep(30);
  c.sendAudio(3, fakeWav(300, 3), { interrupts: 1, heard: 0 });
  const tr = await c.waitFor((m) => m.type === 'transcript' && m.turn === 3);
  assert.equal(tr.text, '嗯 换成燕麦奶');
  assert.deepEqual(tr.replaces, [2]);
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 3);
  assert.equal(c.of('resume').length, 0);
  c.close();
});

test('endpointing: an unfinished sentence waits for the rest', async (t) => {
  const seen = [];
  const provider = fakeProvider({
    seen,
    transcripts: { 1: '我要一杯珍珠奶茶，还有', 2: '一杯芋泥波波' },
    chat: () => say('好的。'),
  });
  const srv = await startVoice({ provider, incompleteGraceMs: 400 });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'state' && m.state === 'waiting' && m.turn === 1);
  await sleep(100);
  c.sendAudio(2, fakeWav(300, 2));
  const tr = await c.waitFor((m) => m.type === 'transcript' && m.turn === 2);
  assert.equal(tr.text, '我要一杯珍珠奶茶，还有 一杯芋泥波波');
  assert.deepEqual(tr.replaces, [1]);
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 2);
  assert.equal(seen.length, 1, 'the model was asked only once');
  assert.equal(c.of('reply_end', 1).length, 0);

  // nobody continues: it answers after the grace period
  c.sendAudio(3, fakeWav(300, 1));
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 3, 3000);
  c.close();
});

test('speech recognition noise like "谢谢观看" is ignored', async (t) => {
  const seen = [];
  const provider = fakeProvider({ seen, transcripts: { 1: '谢谢观看！' }, chat: () => say('不应该回答。') });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.sendAudio(1, fakeWav(300, 1));
  const tr = await c.waitFor((m) => m.type === 'transcript');
  assert.equal(tr.text, '');
  await c.waitFor((m) => m.type === 'state' && m.state === 'idle');
  assert.equal(seen.length, 0);
  c.close();
});

test('streamed PCM: whole samples, in order, at most 3 TTS requests at once', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const provider = fakeProvider({
    stream: true,
    chat: () => say('一。二。三。四。五。六。'),
    ttsDelay: () => 15,
  });
  const orig = provider.synthesizeStream;
  provider.synthesizeStream = async function* (text, opts) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      yield* orig(text, opts);
    } finally {
      inFlight--;
    }
  };
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await ready(srv);
  assert.deepEqual(c.of('ready')[0].audioFormat, { type: 'pcm16', sampleRate: 24000 });
  c.send({ type: 'text', turn: 1, text: '数到六' });
  await c.waitFor((m) => m.type === 'timing');
  const audio = c.of('audio', 1);
  const seqs = audio.map((a) => a.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'frames arrive in sentence order');
  assert.ok(audio.every((a) => a.bytes.length % 2 === 0), 'no frame splits a sample');
  for (let s = 0; s < 6; s++) {
    const total = audio.filter((a) => a.seq === s).reduce((n, a) => n + a.bytes.length, 0);
    assert.equal(total, 7202, `sentence ${s}: 3×2401 bytes, last odd byte dropped`);
  }
  assert.deepEqual(c.of('sentence_audio_end', 1).map((m) => m.seq), [0, 1, 2, 3, 4, 5]);
  assert.ok(peak <= 3, `peak concurrent TTS ${peak}`);
  const timing = c.of('timing')[0];
  assert.ok(timing.firstAudioMs >= 0 && timing.totalMs >= timing.firstAudioMs);
  c.close();
});

test('reconnecting with the session id keeps the conversation', async (t) => {
  const seen = [];
  const provider = fakeProvider({ seen, chat: () => say('好的。') });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const a = await connect(srv.url);
  a.send({ type: 'hello' });
  const r1 = await a.waitFor((m) => m.type === 'ready');
  assert.equal(r1.resumed, false);
  a.send({ type: 'text', turn: 1, text: '记住我叫小明' });
  await a.waitFor((m) => m.type === 'reply_end');
  a.close();
  await sleep(50);

  const b = await connect(srv.url);
  b.send({ type: 'hello', sessionId: r1.sessionId });
  const r2 = await b.waitFor((m) => m.type === 'ready');
  assert.equal(r2.resumed, true);
  assert.equal(r2.sessionId, r1.sessionId);
  b.send({ type: 'text', turn: 1, text: '我叫什么' });
  await b.waitFor((m) => m.type === 'reply_end');
  assert.match(seen[seen.length - 1].map((m) => m.content).join('\n'), /记住我叫小明/);
  b.close();

  // an unknown id starts fresh
  const c = await connect(srv.url);
  c.send({ type: 'hello', sessionId: 'nope' });
  assert.equal((await c.waitFor((m) => m.type === 'ready')).resumed, false);
  c.close();
});

test('per-IP limits: turns per hour and open connections', async (t) => {
  const srv = await startVoice({ provider: createMockProvider(), maxTurnsPerIpPerHour: 2, maxConnectionsPerIp: 2 });
  t.after(() => srv.close());
  const a = await connect(srv.url);
  const b = await connect(srv.url);
  await assert.rejects(connect(srv.url), /429/);
  a.send({ type: 'text', turn: 1, text: '一共多少钱' });
  b.send({ type: 'text', turn: 1, text: '一共多少钱' });
  await a.waitFor((m) => m.type === 'reply_end');
  await b.waitFor((m) => m.type === 'reply_end');
  a.send({ type: 'text', turn: 2, text: '一共多少钱' });
  assert.equal((await a.waitFor((m) => m.type === 'error')).code, 'rate_limited');
  a.close();
  b.close();
});

test('behind a proxy the limit uses X-Forwarded-For', async (t) => {
  const srv = await startVoice({ provider: createMockProvider(), maxConnectionsPerIp: 1, trustProxy: true });
  t.after(() => srv.close());
  const a = await connect(srv.url, { 'X-Forwarded-For': '1.1.1.1' });
  const b = await connect(srv.url, { 'X-Forwarded-For': '2.2.2.2' }); // different customer: fine
  await assert.rejects(connect(srv.url, { 'X-Forwarded-For': '1.1.1.1, 10.0.0.1' }), /429/);
  a.close();
  b.close();
});


test('rate-limited while talking over a reply: the reply continues', async (t) => {
  const provider = fakeProvider({ transcripts: { 2: '换成燕麦奶' }, chat: slowReply('好的。第二句。第三句。', 100) });
  const srv = await startVoice({ provider, maxTurnsPerMinute: 1 });
  t.after(() => srv.close());
  const c = await ready(srv);
  c.send({ type: 'text', turn: 1, text: '一杯珍珠奶茶' });
  await c.waitFor((m) => m.type === 'sentence' && m.turn === 1);
  c.sendAudio(2, fakeWav(300, 2), { interrupts: 1, heard: 0 });
  const resume = await c.waitFor((m) => m.type === 'resume');
  assert.deepEqual([resume.turn, resume.dropped], [1, 2]);
  assert.equal((await c.waitFor((m) => m.type === 'error')).code, 'rate_limited');
  await c.waitFor((m) => m.type === 'reply_end' && m.turn === 1);
  c.close();
});
