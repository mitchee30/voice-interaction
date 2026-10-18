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
function fakeProvider({ transcripts = {}, asrDelay = 0, chat, ttsDelay = () => 5, seen } = {}) {
  return {
    name: 'fake',
    capabilities: { asr: true, tts: true },
    async transcribe(wav) {
      await sleep(asrDelay);
      return transcripts[wav.readInt16LE(44)] ?? '';
    },
    async *chat({ messages, signal }) {
      if (seen) seen.push(messages);
      yield* chat(messages, signal);
    },
    async synthesize(text, { signal }) {
      await abortableSleep(ttsDelay(text), signal);
      return { audio: Buffer.from(`AUDIO:${text}`) };
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
  assert.match(end.text, /珍珠奶茶 ×2（少冰）/);
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
  const history = seen[seen.length - 1].map((m) => m.content).join('\n');
  assert.match(history, /interrupted by the customer/);
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
