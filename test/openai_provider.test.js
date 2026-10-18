'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startVoice, connect, fakeWav } = require('./helpers');
const { startFakeOpenAI } = require('./fake_openai');
const { createOpenAIProvider } = require('..');

// 0.5 s of 24 kHz 16-bit "audio"
const PCM = Buffer.alloc(24000);
for (let i = 0; i < PCM.length; i += 2) PCM.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i);

test('OpenAI provider: speech → order tool → spoken reply, with the right requests', async (t) => {
  const api = await startFakeOpenAI({ transcripts: ['一杯珍珠奶茶少冰'], speech: PCM });
  t.after(() => api.close());
  const provider = createOpenAIProvider({ apiKey: api.apiKey, baseURL: api.baseURL });
  const srv = await startVoice({ provider });
  t.after(() => srv.close());

  const c = await connect(srv.url);
  c.send({ type: 'hello', lang: 'zh', cart: [] });
  const ready = await c.waitFor((m) => m.type === 'ready');
  assert.equal(ready.provider, 'openai');
  assert.equal(ready.asr, true);
  assert.equal(ready.tts, true);

  c.sendAudio(1, fakeWav(500, 7));
  const tr = await c.waitFor((m) => m.type === 'transcript');
  assert.equal(tr.text, '一杯珍珠奶茶少冰');
  const cart = await c.waitFor((m) => m.type === 'cart');
  assert.equal(cart.op, 'add');
  assert.equal(cart.line.itemId, 'pearl-milk-tea');
  assert.equal(cart.line.options.ice, 'less');
  const end = await c.waitFor((m) => m.type === 'reply_end');
  assert.equal(end.text, '好的，加了珍珠奶茶（少冰）。还要别的吗？');
  // streamed PCM: every frame holds whole 16-bit samples, each sentence ends with a marker
  await c.waitFor((m) => m.type === 'timing');
  const audio = c.of('audio', 1);
  assert.ok(audio.length >= end.sentences);
  assert.ok(audio.every((a) => a.bytes.length % 2 === 0));
  const perSentence = new Map();
  for (const a of audio) perSentence.set(a.seq, Buffer.concat([perSentence.get(a.seq) || Buffer.alloc(0), a.bytes]));
  assert.equal(perSentence.get(0).length, PCM.length);
  assert.ok(perSentence.get(0).equals(PCM));
  assert.deepEqual(c.of('sentence_audio_end', 1).map((m) => m.seq), [...Array(end.sentences).keys()]);

  // transcription request
  const asr = api.calls.transcriptions[0];
  assert.equal(asr.model, 'gpt-transcribe');
  assert.equal(asr.filename, 'speech.wav');
  assert.equal(asr.bytes.toString('ascii', 0, 4), 'RIFF');
  assert.match(asr.prompt, /珍珠奶茶/);

  // chat requests: first with tools, second after the tool result
  assert.equal(api.calls.chat.length, 2);
  const first = api.calls.chat[0];
  assert.equal(first.model, 'gpt-4.1-mini');
  assert.equal(first.stream, true);
  assert.equal(first.tool_choice, 'auto');
  assert.equal(first.max_completion_tokens, 400);
  assert.deepEqual(first.tools.map((x) => x.function.name), ['add_to_cart', 'update_cart_line', 'remove_cart_line']);
  assert.equal(first.messages[0].role, 'system');
  const second = api.calls.chat[1];
  const toolMsg = second.messages[second.messages.length - 1];
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(JSON.parse(toolMsg.content).ok, true);
  assert.equal(second.messages[second.messages.length - 2].tool_calls[0].function.name, 'add_to_cart');
  assert.match(second.messages[0].content, /line_id=/, 'system prompt shows the updated cart');

  // speech requests
  assert.equal(api.calls.speech.length, end.sentences);
  assert.equal(api.calls.speech[0].model, 'gpt-4o-mini-tts');
  assert.equal(api.calls.speech[0].voice, 'marin');
  assert.equal(api.calls.speech[0].response_format, 'pcm');
  assert.ok(api.calls.speech[0].instructions);
  c.close();
});

test('OpenAI provider: file mode (mp3) sends one frame per sentence', async (t) => {
  const api = await startFakeOpenAI({ transcripts: ['hi'], speech: Buffer.from('FAKEMP3') });
  t.after(() => api.close());
  const provider = createOpenAIProvider({ apiKey: api.apiKey, baseURL: api.baseURL, ttsFormat: 'mp3' });
  assert.equal(provider.capabilities.ttsStream, false);
  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'hello' });
  const ready = await c.waitFor((m) => m.type === 'ready');
  assert.deepEqual(ready.audioFormat, { type: 'file' });
  c.send({ type: 'text', turn: 1, text: 'hello there' });
  await c.waitFor((m) => m.type === 'reply_end');
  await c.waitFor((m) => m.type === 'sentence_audio_end');
  assert.equal(String(c.of('audio', 1)[0].bytes), 'FAKEMP3');
  assert.equal(api.calls.speech[0].response_format, 'mp3');
  c.close();
});

test('OpenAI provider: a bad key becomes a clear error for the shop log and the browser', async (t) => {
  const api = await startFakeOpenAI();
  t.after(() => api.close());
  const provider = createOpenAIProvider({ apiKey: 'sk-wrong', baseURL: api.baseURL });
  await assert.rejects(provider.transcribe(fakeWav()), /transcription failed: HTTP 401 Incorrect API key/);

  const srv = await startVoice({ provider });
  t.after(() => srv.close());
  const c = await connect(srv.url);
  c.send({ type: 'text', turn: 1, text: 'hello' });
  assert.equal((await c.waitFor((m) => m.type === 'error')).code, 'provider');
  c.close();
});

test('OpenAI provider: requires a key', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => createOpenAIProvider({ apiKey: '' }), /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
