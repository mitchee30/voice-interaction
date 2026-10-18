'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startVoice, connect, fakeWav } = require('./helpers');
const { startFakeOpenAI } = require('./fake_openai');
const { createOpenAIProvider } = require('..');

test('OpenAI provider: speech → order tool → spoken reply, with the right requests', async (t) => {
  const api = await startFakeOpenAI({ transcripts: ['一杯珍珠奶茶少冰'] });
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
  const audio = c.of('audio', 1);
  assert.equal(audio.length, end.sentences);
  assert.equal(String(audio[0].bytes), 'FAKEAUDIO');

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
  assert.equal(api.calls.speech[0].response_format, 'mp3');
  assert.ok(api.calls.speech[0].instructions);
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
